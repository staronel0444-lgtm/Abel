// Shared "wiring" helpers used by both /api/generate (after the AI produces a
// page) and /api/rewire (which re-wires an already-generated page with no AI
// call at all — see functions/api/rewire.js). Keeping this logic in one place
// means both paths inject the exact same contact-form + analytics beacon.

import { injectForms } from './forminject.js';
import { injectGuard } from './guard.js';
import { injectAnalytics, registerSite, titleFromHtml, SITE_ID_RE } from './analytics.js';

// Deliberately strict about what may follow the @: this value ends up inside a
// script on someone's website.
const EMAIL_RE = /^[^@\s<>"'`\\]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// Every page's contact form gets a handler. With an owner email it is live:
// submissions are emailed to that address (see lib/forminject.js). Without
// one — every demo, until the owner says yes — it is wired in demo mode, so a
// prospect who tries the form on his own preview sees what it will do instead
// of a page reload. Setting the email later (/api/rewire) swaps demo for live.
export function wireForms(html, notifyEmail) {
  const email = typeof notifyEmail === 'string' ? notifyEmail.trim() : '';
  const to = EMAIL_RE.test(email) ? email : '';
  const business = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim().slice(0, 120);
  // Every wired page also gets the image guard (lib/guard.js).
  return injectForms(injectGuard(html), to, business);
}

// Bake the visitor-counter beacon in, pointed at this Forge origin so it keeps
// counting after the site is downloaded to the client's domain. An id that is
// not one of Forge's own shapes is dropped rather than written into a script.
export function wireAnalytics(html, siteId, origin) {
  const id = typeof siteId === 'string' ? siteId.trim() : '';
  if (!SITE_ID_RE.test(id)) return html;
  return injectAnalytics(html, id, origin);
}

// Tell the counter this site exists, so /api/pv will count it. Counting is a
// convenience: a database hiccup here must not cost a finished generation.
export async function registerWiredSite(db, html, siteId) {
  try {
    const id = typeof siteId === 'string' ? siteId.trim() : '';
    return await registerSite(db, id, titleFromHtml(html));
  } catch (err) {
    console.error('could not register site for counting:', err && err.message);
    return false;
  }
}
