// POST /api/login {password}  -> sets the login cookie if the password matches
// the FORGE_PASSWORD secret. POST /api/logout -> clears the cookie.

import { makeToken, timingSafeEqual, passwordProblem, isLocalDev, SESSION_MS } from '../../lib/auth.js';

const SESSION_SECONDS = Math.floor(SESSION_MS / 1000);

function cookieHeader(value, maxAge, request) {
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return `forge_auth=${value}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export const onRequestPost = async ({ request, env }) => {
  const password = env.FORGE_PASSWORD;
  // No usable password: a dev server on localhost runs open, everything else
  // stays locked (see functions/_middleware.js) and there is nothing to log in to.
  if (passwordProblem(password)) {
    if (isLocalDev(new URL(request.url))) {
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: false, error: 'Forge is locked until FORGE_PASSWORD is set in Cloudflare.' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }

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
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookieHeader(token, SESSION_SECONDS, request) },
  });
};
