// GET /api/pv?s=<siteId>&t=<title> — the visitor-counter pixel.
//
// Every generated site's beacon hits this on load. We upsert a per-site row
// in D1 and always return a 1x1 transparent GIF. Any error is swallowed so a
// counting hiccup can never break a client's live site. Permissive CORS +
// no-store since it's called cross-origin from sites on other domains.

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

export const onRequestGet = async ({ request, env }) => {
  try {
    const url = new URL(request.url);
    const s = (url.searchParams.get('s') || '').slice(0, 64);
    const t = (url.searchParams.get('t') || '').slice(0, 120);
    if (s && env.DB) {
      await env.DB.prepare(
        `INSERT INTO site_views (site_id, label, views, created_at, updated_at)
         VALUES (?1, ?2, 1, datetime('now'), datetime('now'))
         ON CONFLICT(site_id) DO UPDATE SET
           views = views + 1,
           updated_at = datetime('now'),
           label = CASE WHEN excluded.label <> '' THEN excluded.label ELSE site_views.label END`
      ).bind(s, t).run();
    }
  } catch (err) {
    // Analytics must never break a client's site — count is best-effort.
  }
  return pixel();
};
