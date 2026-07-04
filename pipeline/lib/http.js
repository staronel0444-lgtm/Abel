// Shared HTTP helpers for the Pipeline app's Pages Functions.

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

// Uniform error handling so every route returns JSON instead of an opaque 500.
export function handle(fn) {
  return async (context) => {
    try {
      return await fn(context);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error('Unhandled route error:', err && err.stack ? err.stack : err);
      return json({ error: 'Something went wrong on the server. Try again.' }, 500);
    }
  };
}

export function requireString(body, field, { max = 200000 } = {}) {
  const value = body?.[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `Missing required field: ${field}`);
  }
  if (value.length > max) {
    throw new HttpError(400, `Field too long: ${field} (max ${max} characters)`);
  }
  return value.trim();
}
