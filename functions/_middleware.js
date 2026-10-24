// Password gate for the whole Forge app.
//
// Runs on every request. If FORGE_PASSWORD is NOT set, the gate is disabled and
// everything works as before (so Forge keeps running until you choose to lock
// it). Once you set FORGE_PASSWORD, anyone without a valid login cookie gets a
// login page — EXCEPT the public paths below, so the sites and preview links
// you share with clients keep working:
//   /preview/*   the view-only sites you send prospects/clients
//   /api/pv      the visitor-counter beacon fired by clients' live sites
//   /api/login   the login endpoint itself
//   /api/logout  clears the cookie
//
// The login page is fully self-contained (inline HTML/CSS/JS), so it doesn't
// depend on any gated asset to render.

import { verifyToken, parseCookies } from '../lib/auth.js';

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

export const onRequest = async (context) => {
  const { request, env, next } = context;
  const password = env.FORGE_PASSWORD;
  if (!password) return next(); // gate disabled until a password is set

  const url = new URL(request.url);
  if (isPublic(url.pathname)) return next();

  const cookies = parseCookies(request.headers.get('Cookie'));
  if (await verifyToken(password, cookies.forge_auth)) return next();

  // Not logged in.
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Not authorized — sign in to Forge first.' }), {
      status: 401, headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  return new Response(LOGIN_HTML, {
    status: 401,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
};
