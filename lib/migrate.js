// Additive schema migrations that run on demand, so a database created by an
// older version of schema.sql upgrades itself on the next request instead of
// needing someone to run SQL by hand.
//
// SQLite has no "ADD COLUMN IF NOT EXISTS", so the table is asked which
// columns it already has and only the missing ones are added. Every column
// must have a DEFAULT (or allow NULL) so existing rows behave exactly as they
// did before. Each table is checked once per running instance, not on every
// request, and a real failure is raised rather than hidden — the old version
// ran every ALTER on every request and swallowed whatever came back.

const checked = new Set();

export async function addColumns(db, table, columnDefs) {
  const key = `${table}|${columnDefs.join('|')}`;
  if (checked.has(key)) return;

  const { results } = await db.prepare('SELECT name FROM pragma_table_info(?1)').bind(table).all();
  const have = new Set((results || []).map((r) => r.name));
  // No columns means no table: whoever creates it will create it complete.
  if (have.size === 0) return;

  for (const def of columnDefs) {
    const name = def.trim().split(/\s+/)[0];
    if (have.has(name)) continue;
    try {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${def}`).run();
    } catch (err) {
      // Two requests can race to add the same column; the loser is fine.
      if (!/duplicate column/i.test(String(err && err.message))) throw err;
    }
  }
  checked.add(key);
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
