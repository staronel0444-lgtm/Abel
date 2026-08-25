// Tracks how many Google Places searches have been run, so the Lead Finder can
// show a live count instead of leaving you to guess.
//
// Google gives 1,000 free Places calls per calendar month, and Forge makes
// exactly one call per search — so the monthly count IS the free-tier count.
// The daily number is a self-imposed pace, not a Google limit: staying under
// ~30 a day keeps a full month comfortably inside the free tier.
//
// Days are keyed by the user's LOCAL date, which the browser sends, so "today"
// resets at their midnight rather than UTC's.

// Google's free monthly allowance for the Places SKU Forge uses.
export const MONTH_FREE_LIMIT = 1000;
// A pace that lands under the monthly allowance even in a 31-day month.
export const DAY_TARGET = 30;

const ENSURE_TABLE = `CREATE TABLE IF NOT EXISTS places_usage (
  day      TEXT    PRIMARY KEY,
  searches INTEGER NOT NULL DEFAULT 0
)`;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function ensureUsageTable(db) {
  await db.prepare(ENSURE_TABLE).run();
}

// Falls back to the server's UTC date if the browser sends nothing usable.
export function cleanDay(value) {
  return typeof value === 'string' && DAY_RE.test(value)
    ? value
    : new Date().toISOString().slice(0, 10);
}

export async function recordSearch(db, day) {
  await ensureUsageTable(db);
  await db
    .prepare(
      `INSERT INTO places_usage (day, searches) VALUES (?1, 1)
       ON CONFLICT(day) DO UPDATE SET searches = searches + 1`
    )
    .bind(day)
    .run();
}

export async function readUsage(db, day) {
  await ensureUsageTable(db);
  const month = day.slice(0, 7);
  const [todayRow, monthRow] = await db.batch([
    db.prepare('SELECT COALESCE(searches, 0) AS n FROM places_usage WHERE day = ?1').bind(day),
    db.prepare(`SELECT COALESCE(SUM(searches), 0) AS n FROM places_usage WHERE day LIKE ?1`).bind(`${month}-%`),
  ]);
  const today = todayRow.results?.[0]?.n || 0;
  const monthTotal = monthRow.results?.[0]?.n || 0;
  return {
    today,
    dayTarget: DAY_TARGET,
    month: monthTotal,
    monthLimit: MONTH_FREE_LIMIT,
    monthRemaining: Math.max(0, MONTH_FREE_LIMIT - monthTotal),
  };
}
