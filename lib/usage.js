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

// ---- Spending caps ----------------------------------------------------------
// The counters above only report. These refuse. A bug that loops, a batch
// started by mistake, or a password that got out should cost a bounded amount,
// not whatever the account will bear.

function intFromEnv(value, fallback, { min = 1, max = 100000 } = {}) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// AI calls per UTC day. Forty covers a heavy day (a ten-site batch plus edits)
// with room to spare; DAILY_GENERATION_LIMIT raises or lowers it.
export const DEFAULT_DAILY_GENERATIONS = 40;

export function dailyGenerationLimit(env) {
  return intFromEnv(env?.DAILY_GENERATION_LIMIT, DEFAULT_DAILY_GENERATIONS, { max: 5000 });
}

const ENSURE_AI_TABLE = `CREATE TABLE IF NOT EXISTS ai_usage (
  day   TEXT    PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
)`;

// Take one call out of today's allowance. The check and the count are a single
// statement, so two requests arriving together cannot both take the last one.
export async function reserveGeneration(db, limit, day = utcDay()) {
  await db.prepare(ENSURE_AI_TABLE).run();
  const res = await db
    .prepare(
      `INSERT INTO ai_usage (day, calls) VALUES (?1, 1)
       ON CONFLICT(day) DO UPDATE SET calls = calls + 1 WHERE calls < ?2`
    )
    .bind(day, limit)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// Google gives 1,000 free searches a month and bills for every one after.
// Stopping short of that leaves a margin for the count drifting from Google's
// own. PLACES_MONTHLY_LIMIT moves it (set it above 1000 to allow paid searches).
export const DEFAULT_PLACES_MONTHLY = 950;

export function placesMonthlyLimit(env) {
  return intFromEnv(env?.PLACES_MONTHLY_LIMIT, DEFAULT_PLACES_MONTHLY, { max: 100000 });
}

export async function placesUsedThisMonth(db, date = new Date()) {
  await ensureUsageTable(db);
  const row = await db
    .prepare('SELECT COALESCE(SUM(searches), 0) AS n FROM places_usage WHERE day LIKE ?1')
    .bind(`${utcDay(date).slice(0, 7)}-%`)
    .first();
  return Number(row?.n) || 0;
}

// The browser names the day so "today" follows the user's clock, but a counter
// that guards money cannot be filed under any date the caller likes: anything
// further than a day from the server's own date is replaced with it.
export function trustedDay(value, date = new Date()) {
  const day = cleanDay(value);
  const drift = Math.abs(Date.parse(day + 'T00:00:00Z') - Date.parse(utcDay(date) + 'T00:00:00Z'));
  return drift <= 36 * 60 * 60 * 1000 ? day : utcDay(date);
}
