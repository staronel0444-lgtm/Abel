// GET  /api/income — list every income entry (for the Money calendar).
// POST /api/income — add an entry { date: "YYYY-MM-DD", amount, note? }.
//
// The `income` table is created on demand so the feature works with no manual
// database setup.

import { handle, json, readJson, HttpError } from '../../../lib/http.js';

const ENSURE_TABLE = `CREATE TABLE IF NOT EXISTS income (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT    NOT NULL,
  amount     REAL    NOT NULL DEFAULT 0,
  note       TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
)`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const onRequestGet = handle(async ({ env }) => {
  if (!env.DB) return json({ entries: [] });
  await env.DB.prepare(ENSURE_TABLE).run();
  const { results } = await env.DB
    .prepare(`SELECT id, date, amount, note, created_at AS createdAt FROM income ORDER BY date ASC, id ASC`)
    .all();
  return json({ entries: results || [] });
});

export const onRequestPost = handle(async ({ request, env }) => {
  if (!env.DB) throw new HttpError(500, 'Database is not configured.');
  await env.DB.prepare(ENSURE_TABLE).run();

  const body = await readJson(request);
  const date = String(body.date || '').trim();
  if (!DATE_RE.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'amount must be a positive number');
  const note = String(body.note || '').trim().slice(0, 200);

  const res = await env.DB
    .prepare(`INSERT INTO income (date, amount, note) VALUES (?1, ?2, ?3)`)
    .bind(date, amount, note)
    .run();

  const id = res.meta?.last_row_id ?? null;
  return json({ entry: { id, date, amount, note } }, 201);
});
