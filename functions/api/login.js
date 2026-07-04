// POST /api/login {password}  -> sets the login cookie if the password matches
// the FORGE_PASSWORD secret. POST /api/logout -> clears the cookie.

import { makeToken, timingSafeEqual } from '../../lib/auth.js';

const THIRTY_DAYS = 60 * 60 * 24 * 30;

function cookieHeader(value, maxAge, request) {
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return `forge_auth=${value}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export const onRequestPost = async ({ request, env }) => {
  const password = env.FORGE_PASSWORD;
  // If no password is configured the gate is off — accept, nothing to protect.
  if (!password) return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });

  let body = {};
  try { body = await request.json(); } catch { /* ignore */ }
  const supplied = typeof body?.password === 'string' ? body.password : '';

  if (!timingSafeEqual(supplied, password)) {
    return new Response(JSON.stringify({ ok: false, error: 'Wrong password' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const token = await makeToken(password);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookieHeader(token, THIRTY_DAYS, request) },
  });
};
