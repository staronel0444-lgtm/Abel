// POST /api/contact — receives a website contact-form submission and emails
// the business owner. Called cross-origin from generated sites (which may be
// hosted on a client's own domain), so it sends permissive CORS headers.
//
// The destination email is read from the signed token, never from the
// request body — so this can't be used as an open relay to spam arbitrary
// addresses. A honeypot field silently drops bots.

import { json, readJson, HttpError } from '../../lib/http.js';
import { verifyToken } from '../../lib/token.js';
import { sendLeadEmail } from '../../lib/email.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function withCors(resp) {
  for (const [k, v] of Object.entries(CORS)) resp.headers.set(k, v);
  return resp;
}

export const onRequestOptions = async () => withCors(new Response(null, { status: 204 }));

export const onRequestPost = async ({ request, env }) => {
  try {
    const body = await readJson(request);

    // Honeypot: real users never fill a hidden field. Pretend success.
    if (body._hp) return withCors(json({ ok: true }));

    const secret = env.FORM_SIGNING_SECRET || env.RESEND_API_KEY;
    if (!secret) return withCors(json({ ok: false, error: 'Contact form is not configured.' }, 500));

    const payload = await verifyToken(secret, body.token);
    if (!payload || !payload.e) {
      return withCors(json({ ok: false, error: 'Invalid form token.' }, 400));
    }

    const fields = {};
    for (const [k, v] of Object.entries(body)) {
      if (k === 'token' || k === '_hp') continue;
      if (typeof v === 'string' && v.trim()) fields[k] = v.slice(0, 4000);
    }
    if (Object.keys(fields).length === 0) {
      return withCors(json({ ok: false, error: 'The form was empty.' }, 400));
    }

    await sendLeadEmail(env, { toEmail: payload.e, businessName: payload.b || '', fields });
    return withCors(json({ ok: true }));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    return withCors(json({ ok: false, error: err.message || 'Something went wrong.' }, status));
  }
};
