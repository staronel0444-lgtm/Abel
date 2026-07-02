// GET /preview/<id>            — single-page preview (raw HTML from D1)
// GET /preview/<id>/           — multi-page preview home (index.html)
// GET /preview/<id>/<page>.html — a specific page of a multi-page preview
//
// View-only, no branding, no expiration. Multi-page sites are served under a
// trailing-slash base so the pages' own relative links (href="about.html")
// resolve naturally — no HTML rewriting needed.

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  // Previews are shared drafts, not the business's real site — keep them
  // out of search indexes (invisible to the viewer).
  'X-Robots-Tag': 'noindex',
  'Cache-Control': 'public, max-age=60',
};

function page(html, status = 200) {
  return new Response(html, { status, headers: HTML_HEADERS });
}

function notFound() {
  return page(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Not found</title>
<style>body{font-family:Georgia,serif;background:#f7f5f0;color:#333;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center}</style>
</head><body><main><h1>Page not found</h1><p>This link may have been removed.</p></main></body></html>`,
    404
  );
}

export async function onRequestGet({ env, params, request }) {
  const segments = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const [id, ...rest] = segments;

  if (!id || !/^[a-z0-9]{6,32}$/.test(id) || rest.length > 1) return notFound();

  const row = await env.DB
    .prepare('SELECT kind, html_content FROM previews WHERE preview_id = ?1')
    .bind(id)
    .first();
  if (!row) return notFound();

  if (row.kind === 'single') {
    if (rest.length > 0) return notFound();
    return page(row.html_content);
  }

  // Multi-page: normalize to a trailing-slash base URL so relative links work.
  let pages;
  try {
    pages = JSON.parse(row.html_content);
  } catch {
    return notFound();
  }

  const url = new URL(request.url);
  if (rest.length === 0 && !url.pathname.endsWith('/')) {
    return Response.redirect(`${url.origin}/preview/${id}/`, 301);
  }

  const file = rest.length === 0 || rest[0] === '' || rest[0] === 'index.html' ? 'index.html' : rest[0];
  if (!/^[a-z0-9-]+\.html$/i.test(file) || !pages[file]) return notFound();
  return page(pages[file]);
}
