// Password gate for the whole Forge app.
//
// Runs on every request. Everything needs a valid login cookie EXCEPT the
// public paths below, so the sites and preview links you share keep working:
//   /preview/*   the view-only sites you send prospects/clients
//   /api/pv      the visitor-counter beacon fired by clients' live sites
//   /api/login   the login endpoint itself
//   /api/logout  clears the cookie
//
// The gate fails CLOSED. If FORGE_PASSWORD is missing or too short, the app
// shows a setup page instead of opening up: an unlocked Forge lets anyone on
// the internet spend your AI credits and read your client list, and every
// preview link you send gives away the address. The one exception is a dev
// server on localhost, so `npm run dev` still works with no setup.
//
// The login and setup pages are fully self-contained (inline HTML/CSS/JS), so
// they don't depend on any gated asset to render.

import { verifyToken, parseCookies, passwordProblem, isLocalDev, MIN_PASSWORD_LENGTH } from '../lib/auth.js';

const PUBLIC_PREFIXES = ['/preview', '/api/pv', '/api/login', '/api/logout'];

function isPublic(pathname) {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

const LOGIN_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Forge — Sign in</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0c0f14;color:#e9edf4;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .card{width:min(92vw,360px);background:#141922;border:1px solid #262e3d;border-radius:16px;
    padding:32px 28px;text-align:center}
  .mark{font-size:2rem;color:#e8853c}
  h1{font-size:1.4rem;margin:6px 0 4px}
  p{color:#9aa5b8;margin:0 0 22px;font-size:0.92rem}
  input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #262e3d;background:#0c0f14;
    color:#e9edf4;font-size:1rem;margin-bottom:12px}
  input:focus{outline:none;border-color:#e8853c}
  button{width:100%;padding:12px 14px;border:0;border-radius:10px;background:#e8853c;color:#1a1005;
    font-size:1rem;font-weight:700;cursor:pointer}
  button:hover{background:#f29d5c}
  .err{color:#ff8f8f;font-size:0.88rem;min-height:20px;margin-top:10px}
</style></head><body>
  <div class="card">
    <div class="mark">⌁</div>
    <h1>Forge</h1>
    <p>Enter your password to continue.</p>
    <form id="f">
      <input id="pw" type="password" placeholder="Password" autocomplete="current-password" autofocus>
      <button type="submit">Sign in</button>
      <div class="err" id="err"></div>
    </form>
  </div>
  <script>
    var f=document.getElementById('f'),pw=document.getElementById('pw'),err=document.getElementById('err');
    f.addEventListener('submit',function(e){e.preventDefault();err.textContent='';
      var b=f.querySelector('button');b.disabled=true;b.textContent='Signing in…';
      fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw.value})})
        .then(function(r){return r.json().catch(function(){return{};});})
        .then(function(res){if(res&&res.ok){location.reload();}else{err.textContent=(res&&res.error)||'Wrong password';b.disabled=false;b.textContent='Sign in';pw.select();}})
        .catch(function(){err.textContent='Something went wrong. Try again.';b.disabled=false;b.textContent='Sign in';});
    });
  </script>
</body></html>`;

// Shown instead of the app when there is no usable password. Says exactly what
// to do, because the person reading it is the owner and nobody else can fix it.
function setupHtml(problem) {
  const why = problem === 'short'
    ? `The password that is set is shorter than ${MIN_PASSWORD_LENGTH} characters, which is too easy to guess.`
    : 'No password has been set yet, so Forge is keeping itself locked.';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Forge — locked</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
    background:#0c0f14;color:#e9edf4;font-family:Georgia,'Times New Roman',serif;line-height:1.55}
  .card{width:min(100%,560px);background:#141922;border:1px solid #262e3d;border-radius:14px;padding:30px 28px}
  h1{font-size:1.5rem;margin:0 0 6px}
  p{color:#b7c0d0;margin:0 0 16px}
  ol{margin:0 0 16px;padding-left:22px;color:#e9edf4}
  li{margin-bottom:8px}
  code{background:#0c0f14;border:1px solid #262e3d;border-radius:6px;padding:1px 6px;font-size:0.95em}
  .note{font-size:0.9rem;color:#8d98ab;margin:0}
</style></head><body>
  <div class="card">
    <h1>Forge is locked</h1>
    <p>${why} Your preview links and live client sites are not affected.</p>
    <ol>
      <li>Open the Cloudflare dashboard and go to <strong>Workers &amp; Pages</strong>, then this project.</li>
      <li>Open <strong>Settings</strong>, then <strong>Variables and Secrets</strong>.</li>
      <li>Add a secret named <code>FORGE_PASSWORD</code> for Production. Use at least ${MIN_PASSWORD_LENGTH} characters that are not a single word.</li>
      <li>Open <strong>Deployments</strong> and choose <strong>Retry deployment</strong> on the newest one, so the password takes effect.</li>
      <li>Reload this page and sign in.</li>
    </ol>
    <p class="note">Only the owner of this Cloudflare account can do this.</p>
  </div>
</body></html>`;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };

export const onRequest = async (context) => {
  const { request, env, next } = context;
  const url = new URL(request.url);
  if (isPublic(url.pathname)) return next();

  const password = env.FORGE_PASSWORD;
  const problem = passwordProblem(password);
  if (problem) {
    if (isLocalDev(url)) return next();
    if (url.pathname.startsWith('/api/')) {
      return new Response(
        JSON.stringify({ error: 'Forge is locked until FORGE_PASSWORD is set in Cloudflare. Open the app in a browser for the steps.' }),
        { status: 503, headers: JSON_HEADERS }
      );
    }
    return new Response(setupHtml(problem), { status: 503, headers: HTML_HEADERS });
  }

  const cookies = parseCookies(request.headers.get('Cookie'));
  if (await verifyToken(password, cookies.forge_auth)) return next();

  // Not logged in.
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Not authorized — sign in to Forge first.' }), {
      status: 401, headers: JSON_HEADERS,
    });
  }
  return new Response(LOGIN_HTML, { status: 401, headers: HTML_HEADERS });
};
