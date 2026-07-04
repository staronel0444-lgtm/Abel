// The single shared Claude path for every pipeline stage.
//
// Each stage supplies the agent's system prompt (held server-side, taken
// verbatim from .claude/agents/*.md) plus a short machine-format directive so
// the browser can pass output from one stage to the next. The API key lives
// only in ANTHROPIC_API_KEY, so this is never a general completion proxy.

import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from './http.js';

const DEFAULT_MODEL = 'claude-opus-4-8';

export async function callClaude(env, { system, user, maxTokens = 8000, retryMaxTokens = 16000 }) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpError(500, 'ANTHROPIC_API_KEY is not configured on the server.');
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  let max = maxTokens;

  for (let attempt = 0; attempt < 2; attempt++) {
    let message;
    try {
      message = await client.messages
        .stream({
          model,
          max_tokens: max,
          thinking: { type: 'adaptive' },
          system,
          messages: [{ role: 'user', content: user }],
        })
        .finalMessage();
    } catch (err) {
      throw mapAnthropicError(err);
    }

    if (message.stop_reason === 'refusal') {
      throw new HttpError(422, 'The model declined this request. Adjust the input and try again.');
    }
    // Never silently return truncated output — retry once bigger, then fail.
    if (message.stop_reason === 'max_tokens') {
      if (attempt === 0) {
        max = retryMaxTokens;
        continue;
      }
      throw new HttpError(502, 'Output was truncated twice even at maximum size. Simplify the input and try again.');
    }

    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    return {
      text,
      usage: { input: message.usage?.input_tokens ?? null, output: message.usage?.output_tokens ?? null },
      model: message.model,
    };
  }
  throw new HttpError(500, 'Generation failed unexpectedly.');
}

// Pull a clean HTML document out of a response, tolerating stray fences.
export function extractHtml(text) {
  let out = String(text).trim();
  const fence = out.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence && /<html/i.test(fence[1])) out = fence[1].trim();
  const start = out.search(/<!DOCTYPE html/i);
  if (start > 0) out = out.slice(start);
  if (!/<html/i.test(out)) throw new HttpError(502, 'The model did not return a valid HTML page. Try again.');
  return out;
}

// Pull a JSON value out of a response, tolerating prose or fences.
export function parseJson(text) {
  let c = String(text).trim();
  const fence = c.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) c = fence[1].trim();
  const s = c.indexOf('{');
  const e = c.lastIndexOf('}');
  if (s !== -1 && e > s) c = c.slice(s, e + 1);
  try {
    return JSON.parse(c);
  } catch {
    throw new HttpError(502, 'The model did not return valid JSON. Try again.');
  }
}

function mapAnthropicError(err) {
  if (err instanceof Anthropic.AuthenticationError)
    return new HttpError(500, "The server's Anthropic API key was rejected. Check ANTHROPIC_API_KEY.");
  if (err instanceof Anthropic.RateLimitError)
    return new HttpError(429, 'Rate limited by the Anthropic API. Wait a moment and try again.');
  if (err instanceof Anthropic.APIConnectionError)
    return new HttpError(502, 'Could not reach the Anthropic API. Try again.');
  if (err instanceof Anthropic.APIError) return new HttpError(502, `Anthropic API error (${err.status}): ${err.message}`);
  return err;
}
