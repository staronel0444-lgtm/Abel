// Shared "wiring" helpers used by both /api/generate (after the AI produces a
// page) and /api/rewire (which re-wires an already-generated page with no AI
// call at all — see functions/api/rewire.js). Keeping this logic in one place
// means both paths inject the exact same contact-form + analytics beacon.

import { injectForms } from './forminject.js';
import { injectAnalytics } from './analytics.js';

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
// counting after the site is downloaded to the client's domain.
export function wireAnalytics(html, siteId, origin) {
  const id = typeof siteId === 'string' ? siteId.trim().slice(0, 64) : '';
  if (!id) return html;
  return injectAnalytics(html, id, origin);
}
