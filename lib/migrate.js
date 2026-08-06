// Additive schema migrations that run on demand, so a database created by an
// older version of schema.sql upgrades itself on the next request instead of
// needing someone to run SQL by hand.
//
// SQLite has no "ADD COLUMN IF NOT EXISTS" and errors when the column is
// already there, so each ALTER runs on its own and its duplicate-column error
// is swallowed. Every column must have a DEFAULT that leaves existing rows
// behaving exactly as they did before.

export async function addColumns(db, table, columnDefs) {
  for (const def of columnDefs) {
    try {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${def}`).run();
    } catch {
      // Column already exists — nothing to do.
    }
  }
}

// Payment tracking, added when the Money tab learned about processing fees.
// 'other' / 0 means "no fee recorded", which is how every pre-existing row is
// treated — their totals don't move.
export const CLIENT_PAYMENT_COLUMNS = [
  `payment_method TEXT NOT NULL DEFAULT 'other'`,
  `fee REAL NOT NULL DEFAULT 0`,
];

// 'active' | 'ended'. Ending a client stops future maintenance billing but
// keeps every payment they ever made, so Revenue history stays intact.
export const CLIENT_STATUS_COLUMNS = [
  `status TEXT NOT NULL DEFAULT 'active'`,
];

export async function ensureClientColumns(db) {
  await addColumns(db, 'clients', [...CLIENT_PAYMENT_COLUMNS, ...CLIENT_STATUS_COLUMNS]);
  await addColumns(db, 'client_payments', CLIENT_PAYMENT_COLUMNS);
}
