// URL-safe random IDs for preview links.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randomId(length = 12) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}
