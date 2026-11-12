// GET /api/pv?s=<siteId> — the visitor-counter pixel.
//
// Every generated site's beacon hits this on load. It always answers with a
// 1x1 transparent GIF, and any error is swallowed, so a counting hiccup can
// never break a client's live site. Permissive CORS + no-store since it's
// called cross-origin from sites on other domains.
//
// It is public, so it is deliberately narrow (see lib/analytics.js): it can
// add one to the count of a site Forge registered, at most once every few
// seconds, and it can do nothing else. It never creates a row and never takes
// text from the request. Your own visits while signed in are not counted.

import { countView, SITE_ID_RE } from '../../lib/analytics.js';
import { verifyToken, parseCookies, passwordProblem } from '../../lib/auth.js';

const GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02,
  0x44, 0x01, 0x00, 0x3b,
]);

function pixel() {
  return new Response(GIF, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function isOperator(request, env) {
  const password = env.FORGE_PASSWORD;
  if (passwordProblem(password)) return false;
  const cookies = parseCookies(request.headers.get('Cookie'));
  return Boolean(cookies.forge_auth) && verifyToken(password, cookies.forge_auth);
}

export const onRequestGet = async ({ request, env }) => {
  try {
    const s = new URL(request.url).searchParams.get('s') || '';
    if (env.DB && SITE_ID_RE.test(s) && !(await isOperator(request, env))) {
      await countView(env.DB, s);
    }
  } catch (err) {
    // Analytics must never break a client's site — count is best-effort.
  }
  return pixel();
};
