// Shared "wiring" helpers used by both /api/generate (after the AI produces a
// page) and /api/rewire (which re-wires an already-generated page with no AI
// call at all — see functions/api/rewire.js). Keeping this logic in one place
// means both paths inject the exact same contact-form + analytics beacon.

import { injectForms } from './forminject.js';
import { injectAnalytics, registerSite, titleFromHtml, SITE_ID_RE } from './analytics.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// If the caller supplied a "notify email", wire the page's contact form(s) to
// that address with a self-contained mailto/FormSubmit handler. This needs no
// server, no database, and no third-party service to keep working, so the
// form keeps working after the site is downloaded and hosted on the client's
// own domain.
export function wireForms(html, notifyEmail) {
  const email = typeof notifyEmail === 'string' ? notifyEmail.trim() : '';
  if (!email || !EMAIL_RE.test(email)) return html;
  const business = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim().slice(0, 120);
  return injectForms(html, email, business);
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
