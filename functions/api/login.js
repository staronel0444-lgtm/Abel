// POST /api/login {password}  -> sets the login cookie if the password matches
// the FORGE_PASSWORD secret. POST /api/logout -> clears the cookie.
//
// Wrong guesses are counted (lib/throttle.js): five from one address, or a
// hundred from anywhere, inside fifteen minutes and the door stays shut for
// fifteen more.

import { makeToken, timingSafeEqual, passwordProblem, isLocalDev, SESSION_MS } from '../../lib/auth.js';
import { loginLockedFor, recordLoginFailure, clearLoginFailures } from '../../lib/throttle.js';

const SESSION_SECONDS = Math.floor(SESSION_MS / 1000);

const reply = (body, status, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
});

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

  // The limiter must never be the reason the owner cannot get in: if the
  // database is unreachable, carry on without it rather than refuse everyone.
  const db = env.DB;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (db) {
    try {
      const lockedMs = await loginLockedFor(db, ip);
      if (lockedMs > 0) {
        const minutes = Math.max(1, Math.ceil(lockedMs / 60000));
        return reply(
          { ok: false, error: `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` },
          429,
          { 'Retry-After': String(Math.ceil(lockedMs / 1000)) }
        );
      }
    } catch (err) {
      console.error('login throttle check failed:', err && err.message);
    }
  }

  let body = {};
  try { body = await request.json(); } catch { /* ignore */ }
  const supplied = typeof body?.password === 'string' ? body.password : '';

  if (!timingSafeEqual(supplied, password)) {
    if (db) {
      try { await recordLoginFailure(db, ip); } catch (err) { console.error('login throttle write failed:', err && err.message); }
    }
    return reply({ ok: false, error: 'Wrong password' }, 401);
  }

  if (db) {
    try { await clearLoginFailures(db, ip); } catch { /* housekeeping only */ }
  }
  const token = await makeToken(password);
  return reply({ ok: true }, 200, { 'Set-Cookie': cookieHeader(token, SESSION_SECONDS, request) });
};
