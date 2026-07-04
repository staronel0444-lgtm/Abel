// Bakes a tiny, self-contained visitor-counter beacon into a generated site.
// On load the page fires a one-pixel GET to Forge's /api/pv with its site_id,
// which increments a per-site counter in D1. Counted once per browser session
// (sessionStorage guard) so the numbers read like "visits", not raw hits.
//
// The beacon points at an absolute Forge URL, so it keeps counting even after
// the site is downloaded and hosted on the client's own domain. If Forge is
// ever unreachable the image just fails silently — the client's site is
// unaffected. No cookies, no personal data — only a count.
//
// Wrapped in marker comments so it can be cleanly stripped/re-injected (e.g.
// across a refine) without stacking duplicates.

const START = '<!--forge-analytics-start-->';
const END = '<!--forge-analytics-end-->';
const BLOCK_RE = new RegExp(`${START}[\\s\\S]*?${END}`, 'g');

export function stripAnalytics(html) {
  return String(html || '').replace(BLOCK_RE, '');
}

export function injectAnalytics(html, siteId, origin) {
  const clean = stripAnalytics(html);
  const id = String(siteId || '').trim();
  const base = String(origin || '').replace(/\/+$/, '');
  if (!id || !base) return clean;
  const s = JSON.stringify(id);
  const b = JSON.stringify(base);
  const script =
    `${START}<script>(function(){try{var S=${s},B=${b},k='forge_pv_'+S;` +
    `try{if(sessionStorage.getItem(k))return;sessionStorage.setItem(k,'1');}catch(e){}` +
    `var i=new Image();i.referrerPolicy='no-referrer';` +
    `i.src=B+'/api/pv?s='+encodeURIComponent(S)+'&t='+encodeURIComponent((document.title||'').slice(0,80))+'&r='+Date.now();` +
    `}catch(e){}})();</script>${END}`;
  return clean.includes('</body>') ? clean.replace('</body>', `${script}</body>`) : clean + script;
}
