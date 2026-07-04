// The single shared Claude path for every AutoSite agent.
//
// Unlike Forge (which only ever emits whole HTML documents), the automated
// pipeline has agents that reason and return structured JSON — so this is a
// general text/JSON caller rather than an HTML-only one. The API key is held
// server-side in ANTHROPIC_API_KEY and every agent goes through callClaude,
// so this endpoint can never be used as a general-purpose completion proxy:
// the system prompts are owned by the agent modules, not the caller.

import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from './http.js';

const DEFAULT_MODEL = 'claude-opus-4-8';

// Streaming avoids HTTP idle timeouts; adaptive thinking shares the token
// budget with the visible output, so budgets are generous.
export async function callClaude(env, opts) {
  const {
    system,
    user,
    maxTokens = 6000,
    retryMaxTokens = 12000,
    expectJson = false,
    mock,
  } = opts;

  // Dev-only: MOCK_ANTHROPIC=1 lets the whole pipeline run without a key or
  // spend. Each agent supplies its own canned result via `mock`.
  if (env.MOCK_ANTHROPIC === '1') {
    if (typeof mock === 'function') return mock();
    throw new HttpError(500, 'MOCK_ANTHROPIC is set but this call has no mock.');
  }

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
      throw new HttpError(422, 'The model declined this request. Rephrase the input and try again.');
    }

    // Never silently return truncated output — retry once bigger, then fail.
    if (message.stop_reason === 'max_tokens') {
      if (attempt === 0) {
        max = retryMaxTokens;
        continue;
      }
      throw new HttpError(
        502,
        'Model output was truncated twice even at the maximum size. Reduce the input (e.g. fewer/shorter reviews or competitors) and try again.'
      );
    }

    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    const usage = {
      input: message.usage?.input_tokens ?? null,
      output: message.usage?.output_tokens ?? null,
    };

    if (expectJson) {
      return { json: parseJson(text), text, usage, model: message.model };
    }
    return { text, usage, model: message.model };
  }
  throw new HttpError(500, 'Generation failed unexpectedly.');
}

// Pull a JSON object out of the model response, tolerating stray prose or
// markdown fences even though the system prompt asks for raw JSON.
export function parseJson(text) {
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) candidate = candidate.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new HttpError(502, 'The model did not return valid JSON. Try again.');
  }
}

function mapAnthropicError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return new HttpError(500, "The server's Anthropic API key was rejected. Check ANTHROPIC_API_KEY.");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new HttpError(429, 'Rate limited by the Anthropic API. Wait a moment and try again.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new HttpError(502, 'Could not reach the Anthropic API. Try again.');
  }
  if (err instanceof Anthropic.APIError) {
    return new HttpError(502, `Anthropic API error (${err.status}): ${err.message}`);
  }
  return err;
}
