// Signed form tokens. A generated site's contact form carries an opaque
// token that encodes the destination email (and business name). It's
// HMAC-signed with a server-only secret so nobody can forge a token for an
// arbitrary address — this prevents the /api/contact endpoint from being
// used as an open email relay. No database needed.

function b64urlFromString(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function stringFromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacB64url(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  let bin = '';
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function signToken(secret, payload) {
  const p = b64urlFromString(JSON.stringify(payload));
  const sig = await hmacB64url(secret, p);
  return `${p}.${sig}`;
}

export async function verifyToken(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [p, sig] = token.split('.');
  if (!p || !sig) return null;
  const expected = await hmacB64url(secret, p);
  if (!timingEqual(sig, expected)) return null;
  try {
    return JSON.parse(stringFromB64url(p));
  } catch {
    return null;
  }
}
