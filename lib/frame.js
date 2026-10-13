// Scene analysis for the Camera page (/camera). One Claude vision call per
// tap of the Frame button: the phone sends a small JPEG of what's on screen
// and gets back a crop box to aim at, a one-line tip, and a lighting read.
//
// Kept separate from lib/anthropic.js on purpose: that module's prompts and
// truncation/retry logic are built around multi-thousand-token HTML pages,
// while this is a tiny, latency-sensitive JSON answer.

import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from './http.js';

const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 4000;

const SYSTEM = `You are a photography composition coach looking through a phone's viewfinder.

You get one frame of the live camera view. Pick the single best photo that the person can get from where they're standing by aiming the phone and zooming in, and describe it as a crop box inside this frame.

Crop box rules:
- Coordinates are normalized to the frame: x and y are the top-left corner, w and h the size, all between 0 and 1.
- Keep the frame's aspect ratio, which in normalized units means w equals h.
- Size between 0.35 and 1. Use 1 (x=0, y=0) only when the frame is already well composed and any crop would make it worse.
- Compose deliberately: place the subject on a rule-of-thirds point or centered with intent, cut distracting clutter at the edges, keep horizons level and off-center, leave breathing room in front of faces and moving subjects, never crop through a person's joints.

tip: what to physically do, imperative, at most 12 words (e.g. "Step left and lower the phone to hide the trash can").
subject: what the box is framing, at most 4 words.

Lighting:
- level: how the scene is lit right now.
- ev: suggested exposure change in stops, from -2 (darken) to 2 (brighten); 0 if fine.
- warmth: color correction to apply afterwards, from -1 (cool it down) to 1 (warm it up); 0 if neutral.
- note: one short sentence about the light, at most 12 words (e.g. "Backlit window, faces will go dark — turn so light hits them").`;

const SCHEMA = {
  type: 'object',
  properties: {
    crop: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
      required: ['x', 'y', 'w', 'h'],
      additionalProperties: false,
    },
    subject: { type: 'string' },
    tip: { type: 'string' },
    lighting: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['dark', 'dim', 'good', 'bright', 'harsh'] },
        ev: { type: 'number' },
        warmth: { type: 'number' },
        note: { type: 'string' },
      },
      required: ['level', 'ev', 'warmth', 'note'],
      additionalProperties: false,
    },
  },
  required: ['crop', 'subject', 'tip', 'lighting'],
  additionalProperties: false,
};

// Server-side fallback on refusal is only accepted on these model families.
const FALLBACK_MODELS = /^claude-(opus-5|sonnet-5-5|fable-5)/;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0));
const short = (s, n) => String(s || '').trim().slice(0, n);

// The schema can't express ranges, so the numbers are clamped here: the
// client can trust x/y/w/h to describe a square-in-normalized-units box that
// sits fully inside the frame.
function sanitize(raw) {
  const c = raw.crop || {};
  const size = clamp(Math.max(c.w, c.h), 0.35, 1);
  const cx = clamp((c.x ?? 0) + (c.w ?? 1) / 2, 0, 1);
  const cy = clamp((c.y ?? 0) + (c.h ?? 1) / 2, 0, 1);
  const x = clamp(cx - size / 2, 0, 1 - size);
  const y = clamp(cy - size / 2, 0, 1 - size);
  const l = raw.lighting || {};
  return {
    crop: { x, y, w: size, h: size },
    subject: short(raw.subject, 60),
    tip: short(raw.tip, 120),
    lighting: {
      level: ['dark', 'dim', 'good', 'bright', 'harsh'].includes(l.level) ? l.level : 'good',
      ev: clamp(l.ev, -2, 2),
      warmth: clamp(l.warmth, -1, 1),
      note: short(l.note, 120),
    },
  };
}

export async function analyzeFrame(env, { image }) {
  if (env.MOCK_ANTHROPIC === '1') return mockAnalysis();

  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpError(500, 'ANTHROPIC_API_KEY is not configured on the server.');
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.CAMERA_MODEL || DEFAULT_MODEL;

  const params = {
    model,
    max_tokens: MAX_TOKENS,
    // Low effort: this sits between a tap and an on-screen guide, so speed
    // matters more than squeezing out the last bit of compositional nuance.
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
          { type: 'text', text: 'Frame this shot.' },
        ],
      },
    ],
  };

  let message;
  try {
    message = FALLBACK_MODELS.test(model)
      ? await client.beta.messages.create({
          ...params,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        })
      : await client.messages.create(params);
  } catch (err) {
    throw mapError(err);
  }

  if (message.stop_reason === 'refusal') {
    throw new HttpError(422, 'Claude declined to analyze this frame. Try a different shot.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new HttpError(502, 'The analysis was cut off. Try again.');
  }

  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(502, 'The analysis came back unreadable. Try again.');
  }
  return { ...sanitize(raw), model: message.model };
}

function mapError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return new HttpError(500, "The server's Anthropic API key was rejected. Check ANTHROPIC_API_KEY.");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new HttpError(429, 'Rate limited by the Anthropic API. Wait a moment and try again.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new HttpError(502, 'Could not reach the Anthropic API. Check your connection and try again.');
  }
  if (err instanceof Anthropic.APIError) {
    return new HttpError(502, `Anthropic API error (${err.status}): ${err.message}`);
  }
  return err;
}

// Dev-only (MOCK_ANTHROPIC=1): a fixed off-center box so the guide, the
// alignment detection, and the zoom can all be exercised without a key.
function mockAnalysis() {
  return {
    ...sanitize({
      crop: { x: 0.42, y: 0.12, w: 0.5, h: 0.5 },
      subject: 'mock subject',
      tip: 'Pan right and up a little',
      lighting: { level: 'dim', ev: 0.5, warmth: 0.2, note: 'Mock read: a little dim, slightly cool.' },
    }),
    model: 'mock',
  };
}
