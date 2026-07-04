// Tiny password gate for the Forge app. A signed, HttpOnly cookie proves the
// visitor logged in; the cookie is an HMAC over a fixed payload keyed by the
// FORGE_PASSWORD secret, so it can't be forged and it auto-invalidates if the
// password is ever changed. No database, no third-party service.

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

// A session token = "v1.<issuedMs>.<hmac(v1.<issuedMs>)>".
export async function makeToken(secret) {
  const payload = 'v1.' + Date.now();
  return payload + '.' + (await hmac(secret, payload));
}

export async function verifyToken(secret, token) {
  if (!secret || typeof token !== 'string') return false;
  const i = token.lastIndexOf('.');
  if (i < 1) return false;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  return timingSafeEqual(sig, await hmac(secret, payload));
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
