// Tiny password gate for the Forge app. A signed, HttpOnly cookie proves the
// visitor logged in; the cookie is an HMAC over a fixed payload keyed by the
// FORGE_PASSWORD secret, so it can't be forged and it auto-invalidates if the
// password is ever changed. No database, no third-party service.

// Shorter than this and the lock is decoration: a short password falls to a
// word list long before the login throttle matters.
export const MIN_PASSWORD_LENGTH = 8;

// Why the configured password cannot protect anything, or null when it can.
export function passwordProblem(password) {
  if (typeof password !== 'string' || !password) return 'missing';
  if (password.length < MIN_PASSWORD_LENGTH) return 'short';
  return null;
}

// `npm run dev` on your own machine. Cloudflare routes production traffic by
// hostname, so a request can only arrive here as localhost on a dev server.
export function isLocalDev(url) {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return b64url(new Uint8Array(sig));
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// How long a login lasts. The cookie's Max-Age matches, but a cookie's age is
// only the browser's word for it — verifyToken() is what actually ends a session.
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

// A session token = "v1.<issuedMs>.<hmac(v1.<issuedMs>)>".
export async function makeToken(secret, now = Date.now()) {
  const payload = 'v1.' + now;
  return payload + '.' + (await hmac(secret, payload));
}

export async function verifyToken(secret, token, now = Date.now()) {
  if (!secret || typeof token !== 'string') return false;
  const i = token.lastIndexOf('.');
  if (i < 1) return false;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!timingSafeEqual(sig, await hmac(secret, payload))) return false;

  // The signature proves the token is ours. Its timestamp decides whether it
  // is still good: a copied cookie must stop working, not last for ever.
  const m = /^v1\.(\d{10,16})$/.exec(payload);
  if (!m) return false;
  const age = now - Number(m[1]);
  return age >= -60 * 1000 && age <= SESSION_MS; // a minute of clock drift allowed
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}
