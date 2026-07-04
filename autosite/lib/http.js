// Shared HTTP helpers for the AutoSite Pages Functions.
// Mirrors the Forge helper surface so route handlers stay tiny and every
// error comes back as JSON instead of an opaque 500 page.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

// Wraps a route handler with uniform error handling.
export function handle(fn) {
  return async (context) => {
    try {
      return await fn(context);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message }, err.status);
      }
      console.error('Unhandled route error:', err && err.stack ? err.stack : err);
      return json({ error: 'Something went wrong on the server. Try again.' }, 500);
    }
  };
}

export function requireString(body, field, { max = 10000 } = {}) {
  const value = body?.[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `Missing required field: ${field}`);
  }
  if (value.length > max) {
    throw new HttpError(400, `Field too long: ${field} (max ${max} characters)`);
  }
  return value.trim();
}
