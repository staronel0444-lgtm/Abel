// The Money tab's `income` table, plus the one helper that writes to it.
//
// Income arrives from two places: typed in by hand on the Money calendar, and
// logged automatically when a client pays (upfront or a monthly maintenance
// fee). Both go through logIncome so the Taxes/Forge/Save/You split always
// sees every dollar — money that only landed in the Clients tab used to be
// invisible to the tax set-aside.

export const ENSURE_INCOME_TABLE = `CREATE TABLE IF NOT EXISTS income (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT    NOT NULL,
  amount     REAL    NOT NULL DEFAULT 0,
  note       TEXT    NOT NULL DEFAULT '',
  method     TEXT    NOT NULL DEFAULT 'other',
  fee        REAL    NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
)`;

// Databases created before fee tracking already have an `income` table, so
// CREATE TABLE IF NOT EXISTS won't add these. See lib/migrate.js for why each
// ALTER runs on its own.
const INCOME_MIGRATIONS = [
  `ALTER TABLE income ADD COLUMN method TEXT NOT NULL DEFAULT 'other'`,
  `ALTER TABLE income ADD COLUMN fee REAL NOT NULL DEFAULT 0`,
];

export const PAYMENT_METHODS = new Set([
  'bank', 'cash', 'apple', 'cashapp', 'stripe', 'paypal', 'other',
]);

export async function ensureIncomeTable(db) {
  await db.prepare(ENSURE_INCOME_TABLE).run();
  for (const sql of INCOME_MIGRATIONS) {
    try {
      await db.prepare(sql).run();
    } catch {
      // Column already exists.
    }
  }
}

export function cleanMethod(value) {
  return PAYMENT_METHODS.has(value) ? value : 'other';
}

// A fee can never be negative or exceed the payment it came out of.
export function cleanFee(value, amount) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, amount) : 0;
}

export async function logIncome(db, { date, amount, note = '', method = 'other', fee = 0 }) {
  await ensureIncomeTable(db);
  const res = await db
    .prepare(`INSERT INTO income (date, amount, note, method, fee) VALUES (?1, ?2, ?3, ?4, ?5)`)
    .bind(date, amount, String(note).slice(0, 200), cleanMethod(method), cleanFee(fee, amount))
    .run();
  return res.meta?.last_row_id ?? null;
}
