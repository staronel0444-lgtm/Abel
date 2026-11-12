// The Money tab's `income` table, plus the helpers that write to it.
//
// Income arrives from two places: typed in by hand on the Money calendar, and
// logged automatically when a client pays (upfront or a monthly maintenance
// fee). Both go through logIncome so the Taxes/Forge/Save/You split always
// sees every dollar — money that only landed in the Clients tab used to be
// invisible to the tax set-aside.
//
// A row logged for a client remembers which client and what it was for
// (`client_id`, `kind`, `month`). Without that link the row outlived whatever
// created it: deleting a client left their money in the totals, and marking a
// month paid, unmarking it and marking it again logged the payment twice.

import { addColumns } from './migrate.js';

export const ENSURE_INCOME_TABLE = `CREATE TABLE IF NOT EXISTS income (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT    NOT NULL,
  amount     REAL    NOT NULL DEFAULT 0,
  note       TEXT    NOT NULL DEFAULT '',
  method     TEXT    NOT NULL DEFAULT 'other',
  fee        REAL    NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  client_id  INTEGER,
  kind       TEXT    NOT NULL DEFAULT 'manual',
  month      TEXT
)`;

// Columns added after the table first shipped. 'manual' with no client is how
// every pre-existing row is treated, so their totals don't move.
const INCOME_COLUMNS = [
  `method TEXT NOT NULL DEFAULT 'other'`,
  `fee REAL NOT NULL DEFAULT 0`,
  `client_id INTEGER`,
  `kind TEXT NOT NULL DEFAULT 'manual'`,
  `month TEXT`,
];

export const PAYMENT_METHODS = new Set([
  'bank', 'cash', 'apple', 'cashapp', 'stripe', 'paypal', 'other',
]);

let tableReady = false;

export async function ensureIncomeTable(db) {
  if (!tableReady) {
    await db.prepare(ENSURE_INCOME_TABLE).run();
    tableReady = true;
  }
  await addColumns(db, 'income', INCOME_COLUMNS);
}

export function cleanMethod(value) {
  return PAYMENT_METHODS.has(value) ? value : 'other';
}

// A fee can never be negative or exceed the payment it came out of.
export function cleanFee(value, amount) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, amount) : 0;
}

// kind: 'manual' (typed in), 'upfront' (a client's setup fee) or 'monthly' (one
// month of maintenance, with `month` as YYYY-MM).
export async function logIncome(db, { date, amount, note = '', method = 'other', fee = 0, clientId = null, kind = 'manual', month = null }) {
  await ensureIncomeTable(db);
  const res = await db
    .prepare(
      `INSERT INTO income (date, amount, note, method, fee, client_id, kind, month)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
    .bind(date, amount, String(note).slice(0, 200), cleanMethod(method), cleanFee(fee, amount), clientId, kind, month)
    .run();
  return res.meta?.last_row_id ?? null;
}

// Unmarking a month takes its money back out of the log.
export async function removeMonthlyIncome(db, clientId, month) {
  await ensureIncomeTable(db);
  await db
    .prepare(`DELETE FROM income WHERE client_id = ?1 AND kind = 'monthly' AND month = ?2`)
    .bind(clientId, month)
    .run();
}

// Keep the one upfront row in step with the client record it came from: the
// amount, date, name or payment method may all have been edited.
export async function syncUpfrontIncome(db, client) {
  await ensureIncomeTable(db);
  const existing = await db
    .prepare(`SELECT id FROM income WHERE client_id = ?1 AND kind = 'upfront'`)
    .bind(client.id)
    .first();
  const amount = Number(client.amount_paid) || 0;
  const note = `${client.company_name} — upfront`;

  if (amount <= 0) {
    if (existing) await db.prepare('DELETE FROM income WHERE id = ?1').bind(existing.id).run();
    return;
  }
  if (!existing) {
    await logIncome(db, {
      date: client.close_date, amount, note,
      method: client.payment_method, fee: client.fee, clientId: client.id, kind: 'upfront',
    });
    return;
  }
  await db
    .prepare('UPDATE income SET date = ?1, amount = ?2, note = ?3, method = ?4, fee = ?5 WHERE id = ?6')
    .bind(client.close_date, amount, note.slice(0, 200), cleanMethod(client.payment_method), cleanFee(client.fee, amount), existing.id)
    .run();
}
