// Client domains. A sold site goes live by pointing the client's domain at this
// same Cloudflare Pages project and recording here which saved site it shows.
// functions/_middleware.js looks the hostname up on every request that does
// not arrive on the app's own address, and serves that site and nothing else.
//
// One project, no files to download and re-upload, and "Update the link" on a
// site changes what its domain shows too.

export const ENSURE_DOMAINS = `CREATE TABLE IF NOT EXISTS domains (
  host       TEXT PRIMARY KEY,
  preview_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

// The app's own addresses: a dev server, or the project's pages.dev name.
export function isAppHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.pages.dev');
}

// "https://www.RaysCollision.com/contact" -> "rayscollision.com". The www form
// is folded into the bare name so one entry answers for both. Returns '' for
// anything that is not a plain public domain name.
export function cleanHost(value) {
  let h = String(value || '').trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  h = h.replace(/^www\./, '');
  if (!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(h)) return '';
  if (isAppHost(h) || h.endsWith('.workers.dev')) return '';
  return h;
}

let tableReady = false;
export async function ensureDomains(db) {
  if (tableReady) return;
  await db.prepare(ENSURE_DOMAINS).run();
  tableReady = true;
}

// The saved site a hostname shows, or null.
export async function siteForHost(db, hostname) {
  const host = cleanHost(hostname);
  if (!host) return null;
  await ensureDomains(db);
  const row = await db.prepare('SELECT preview_id FROM domains WHERE host = ?1').bind(host).first();
  return row ? row.preview_id : null;
}

function notFound() {
  return new Response(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Not found</title>'
    + '<style>body{font-family:Georgia,serif;background:#f7f5f0;color:#333;display:grid;place-items:center;min-height:100vh;margin:0}</style>'
    + '</head><body><main><h1>Page not found</h1></main></body></html>',
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

// Serve a saved site at the root of its own domain. Unlike a preview link it
// is meant to be found, so there is no noindex header here.
export async function serveLiveSite(db, previewId, pathname) {
  const row = await db
    .prepare('SELECT kind, html_content FROM previews WHERE preview_id = ?1')
    .bind(previewId)
    .first();
  if (!row) return notFound();

  let html;
  if (row.kind === 'single') {
    if (pathname !== '/' && pathname !== '/index.html') return notFound();
    html = row.html_content;
  } else {
    let pages;
    try { pages = JSON.parse(row.html_content); } catch { return notFound(); }
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!/^[a-z0-9-]+\.html$/i.test(file) || !pages[file]) return notFound();
    html = pages[file];
  }
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
