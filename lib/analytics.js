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
//
// /api/pv is public, so it must never be a way for a stranger to write to the
// database. Forge registers a site's id itself, at the moment it wires the
// beacon in (registerSite), and the public endpoint only ever adds one to a
// row that already exists (countView). An id Forge never issued does nothing.

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

// The ids Forge issues: crypto.randomUUID(), or the short fallback used where
// that is unavailable. Anything else was not made here.
export const SITE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

export const ENSURE_SITE_VIEWS = `CREATE TABLE IF NOT EXISTS site_views (
  site_id    TEXT PRIMARY KEY,
  label      TEXT    NOT NULL DEFAULT '',
  views      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
)`;

// The id baked into a page's beacon, or '' when the page has none.
export function siteIdFromHtml(html) {
  const m = /forge-analytics-start-->[\s\S]*?var S=("|')((?:\\.|[^"'\\])*?)\1/.exec(String(html || ''));
  return m && SITE_ID_RE.test(m[2]) ? m[2] : '';
}

export function titleFromHtml(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? m[1].trim().replace(/\s+/g, ' ').slice(0, 120) : '';
}

// Make a site countable. Safe to call again: the count is never touched, and
// a newer title replaces the old label.
export async function registerSite(db, siteId, label = '') {
  if (!db || !SITE_ID_RE.test(String(siteId || ''))) return false;
  await db.prepare(ENSURE_SITE_VIEWS).run();
  await db
    .prepare(
      `INSERT INTO site_views (site_id, label, views) VALUES (?1, ?2, 0)
       ON CONFLICT(site_id) DO UPDATE SET
         label = CASE WHEN excluded.label <> '' THEN excluded.label ELSE site_views.label END`
    )
    .bind(siteId, String(label || '').slice(0, 120))
    .run();
  return true;
}

// One visit, at most once every few seconds per site. The gap is far shorter
// than the time between two real visitors to a local business, and it means a
// request loop can neither inflate a count nor use up the daily write limit.
export const VIEW_GAP_SECONDS = 10;

export async function countView(db, siteId) {
  if (!db || !SITE_ID_RE.test(String(siteId || ''))) return false;
  const res = await db
    .prepare(
      `UPDATE site_views
          SET views = views + 1, updated_at = datetime('now')
        WHERE site_id = ?1
          AND (views = 0 OR updated_at <= datetime('now', ?2))`
    )
    .bind(siteId, `-${VIEW_GAP_SECONDS} seconds`)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
