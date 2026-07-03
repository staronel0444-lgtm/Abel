// Sends a lead-notification email via Resend (https://resend.com) when a
// generated site's contact form is submitted. Server-side only — the API
// key never reaches the browser.
//
// Env:
//   RESEND_API_KEY — from resend.com (free tier)
//   MAIL_FROM      — verified sender, e.g. "Leads <leads@yourdomain.com>".
//                    Defaults to Resend's onboarding sender (test only —
//                    can only deliver to your own Resend account email until
//                    you verify a domain).
//   MOCK_EMAIL=1   — dev only: skip the real send and return success.

import { HttpError } from './http.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function sendLeadEmail(env, { toEmail, businessName, fields }) {
  if (env.MOCK_EMAIL === '1') return { mock: true };
  if (!env.RESEND_API_KEY) throw new HttpError(500, 'Email is not configured on the server.');

  const from = env.MAIL_FROM || 'Forge Leads <onboarding@resend.dev>';
  const entries = Object.entries(fields).filter(([k]) => k && k[0] !== '_');
  const rows = entries
    .map(([k, v]) =>
      `<tr><td style="padding:4px 14px 4px 0;color:#666;text-transform:capitalize;vertical-align:top">${esc(k)}</td><td style="padding:4px 0"><strong>${esc(v)}</strong></td></tr>`)
    .join('');
  const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:520px">
    <h2 style="color:#c2410c;margin:0 0 12px">New website lead${businessName ? ` for ${esc(businessName)}` : ''}</h2>
    <table style="border-collapse:collapse">${rows}</table>
    <p style="color:#999;font-size:12px;margin-top:18px">Sent automatically from your website's contact form.</p>
  </div>`;
  const text = `New website lead${businessName ? ` for ${businessName}` : ''}\n\n` +
    entries.map(([k, v]) => `${k}: ${v}`).join('\n');

  const replyTo = fields.email && EMAIL_RE.test(fields.email) ? fields.email : undefined;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [toEmail],
      subject: `New lead${businessName ? ` — ${businessName}` : ''}`,
      html,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Resend error ${res.status}: ${body.slice(0, 300)}`);
    throw new HttpError(502, 'Could not send the notification email.');
  }
  return { ok: true };
}
