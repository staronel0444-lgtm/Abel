// POST /api/rewire — (re)wire an already-generated page's contact-form email
// and/or its visitor-counter beacon, WITHOUT calling the AI. Free and instant.
//
// This exists for the common case of building a demo site before you know the
// prospect's email: generate it with the notify-email box empty, then once
// they say yes, come back, type their email in, and hit "Set contact email" —
// no credits spent, no regeneration, no waiting.
//
// Body: { html, notifyEmail?, siteId? }
// Response: { html }

import { handle, json, readJson, requireString } from '../../lib/http.js';
import { wireForms, wireAnalytics } from '../../lib/wire.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await readJson(request);
  const html = requireString(body, 'html', { max: 300000 });

  let wired = wireForms(html, body.notifyEmail);
  wired = wireAnalytics(wired, body.siteId, new URL(request.url).origin);
  return json({ html: wired });
});
