// GET  /api/prospects — list every prospect (the manual sales pipeline).
// POST /api/prospects — add one { businessName, niche?, phone?, notes?, status?, followUpDate? }.
//
// Independent of Lead Finder's Google-Place-ID-based history/dismissals —
// this tracks ANY lead however it was found, so it works with or without
// Lead Finder ever being turned on. The `prospects` table is created on
// demand, so there's no manual database step.

import { handle, json, readJson, HttpError } from '../../../lib/http.js';

const ENSURE_TABLE = `CREATE TABLE IF NOT EXISTS prospects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name   TEXT    NOT NULL,
  niche           TEXT    NOT NULL DEFAULT '',
  phone           TEXT    NOT NULL DEFAULT '',
  notes           TEXT    NOT NULL DEFAULT '',
  status          TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','follow_up','won','no')),
  follow_up_date  TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
)`;

const STATUSES = new Set(['new', 'contacted', 'follow_up', 'won', 'no']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function rowToJson(r) {
  return {
    id: r.id,
    businessName: r.business_name,
    niche: r.niche,
    phone: r.phone,
    notes: r.notes,
    status: r.status,
    followUpDate: r.follow_up_date,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const onRequestGet = handle(async ({ env }) => {
  if (!env.DB) return json({ prospects: [] });
  await env.DB.prepare(ENSURE_TABLE).run();
  const { results } = await env.DB
    .prepare(
      `SELECT * FROM prospects ORDER BY
         CASE status WHEN 'follow_up' THEN 0 WHEN 'contacted' THEN 1 WHEN 'new' THEN 2 WHEN 'won' THEN 3 ELSE 4 END,
         updated_at DESC`
    )
    .all();
  return json({ prospects: (results || []).map(rowToJson) });
});

export const onRequestPost = handle(async ({ request, env }) => {
  if (!env.DB) throw new HttpError(500, 'Database is not configured.');
  await env.DB.prepare(ENSURE_TABLE).run();

  const body = await readJson(request);
  const businessName = String(body.businessName || '').trim().slice(0, 200);
  if (!businessName) throw new HttpError(400, 'businessName is required');
  const niche = String(body.niche || '').trim().slice(0, 100);
  const phone = String(body.phone || '').trim().slice(0, 40);
  const notes = String(body.notes || '').trim().slice(0, 1000);
  const status = STATUSES.has(body.status) ? body.status : 'new';
  const followUpDate = DATE_RE.test(body.followUpDate || '') ? body.followUpDate : null;

  const res = await env.DB
    .prepare(
      `INSERT INTO prospects (business_name, niche, phone, notes, status, follow_up_date)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
    .bind(businessName, niche, phone, notes, status, followUpDate)
    .run();

  const id = res.meta?.last_row_id ?? null;
  return json({ prospect: { id, businessName, niche, phone, notes, status, followUpDate } }, 201);
});
