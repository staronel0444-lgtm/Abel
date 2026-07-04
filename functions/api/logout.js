// POST or GET /api/logout — clears the login cookie.

function clearCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return `forge_auth=; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=0`;
}

const done = (request) => new Response(JSON.stringify({ ok: true }), {
  status: 200,
  headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearCookie(request) },
});

export const onRequestPost = async ({ request }) => done(request);
export const onRequestGet = async ({ request }) => done(request);
