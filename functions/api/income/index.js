// GET  /api/income — list every income entry (for the Money calendar).
// POST /api/income — add an entry { date: "YYYY-MM-DD", amount, note?, method?, fee? }.
//
// The `income` table is created on demand so the feature works with no manual
// database setup.
//
// `amount` is the sticker price and `fee` is what the payment platform took
// off it. The client works the fee out from `method` and sends both, so the
// stored row keeps the fee that was actually charged even if a platform
// changes its rates later.

import { handle, json, readJson, HttpError } from '../../../lib/http.js';

const ENSURE_TABLE = `CREATE TABLE IF NOT EXISTS income (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT    NOT NULL,
  amount     REAL    NOT NULL DEFAULT 0,
  note       TEXT    NOT NULL DEFAULT '',
  method     TEXT    NOT NULL DEFAULT 'other',
  fee        REAL    NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
)`;

// Databases created before payment-method tracking existed already have an
// `income` table, so CREATE TABLE IF NOT EXISTS won't add the new columns.
// SQLite has no "ADD COLUMN IF NOT EXISTS" and errors when the column is
// already present, so each ALTER runs on its own and its duplicate-column
// error is swallowed. Existing rows default to 'other' / 0 fee, which leaves
// their totals exactly as they were.
const MIGRATIONS = [
  `ALTER TABLE income ADD COLUMN method TEXT NOT NULL DEFAULT 'other'`,
  `ALTER TABLE income ADD COLUMN fee REAL NOT NULL DEFAULT 0`,
];

const METHODS = new Set(['bank', 'cash', 'apple', 'cashapp', 'stripe', 'paypal', 'other']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function ensureTable(db) {
  await db.prepare(ENSURE_TABLE).run();
  for (const sql of MIGRATIONS) {
    try {
      await db.prepare(sql).run();
    } catch {
      // Column already exists — nothing to do.
    }
  }
}

export const onRequestGet = handle(async ({ env }) => {
  if (!env.DB) return json({ entries: [] });
  await ensureTable(env.DB);
  const { results } = await env.DB
    .prepare(
      `SELECT id, date, amount, note, method, fee, created_at AS createdAt
       FROM income ORDER BY date ASC, id ASC`
    )
    .all();
  return json({ entries: results || [] });
});

export const onRequestPost = handle(async ({ request, env }) => {
  if (!env.DB) throw new HttpError(500, 'Database is not configured.');
  await ensureTable(env.DB);

  const body = await readJson(request);
  const date = String(body.date || '').trim();
  if (!DATE_RE.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'amount must be a positive number');
  const note = String(body.note || '').trim().slice(0, 200);

  const method = METHODS.has(body.method) ? body.method : 'other';
  // A fee can never be negative or exceed what was actually charged.
  const rawFee = Number(body.fee);
  const fee = Number.isFinite(rawFee) && rawFee > 0 ? Math.min(rawFee, amount) : 0;

  const res = await env.DB
    .prepare(`INSERT INTO income (date, amount, note, method, fee) VALUES (?1, ?2, ?3, ?4, ?5)`)
    .bind(date, amount, note, method, fee)
    .run();

  const id = res.meta?.last_row_id ?? null;
  return json({ entry: { id, date, amount, note, method, fee } }, 201);
});
