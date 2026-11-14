// DELETE /api/domains/:host — stop serving a site on a domain. The domain then
// shows nothing from Forge; remove it from Custom domains in Cloudflare too.

import { handle, json, HttpError } from '../../../lib/http.js';
import { cleanHost, ensureDomains } from '../../../lib/domains.js';

export const onRequestDelete = handle(async ({ env, params }) => {
  const host = cleanHost(decodeURIComponent(String(params.host || '')));
  if (!host) throw new HttpError(400, 'Invalid domain');
  await ensureDomains(env.DB);
  await env.DB.prepare('DELETE FROM domains WHERE host = ?1').bind(host).run();
  return json({ ok: true });
});
