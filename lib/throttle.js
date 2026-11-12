// Slows down password guessing on /api/login.
//
// Counted in D1 because a Pages Function keeps nothing in memory between
// requests. Two counters: one per IP address, and one shared by everyone
// (key '*') so that spreading guesses across many addresses still hits a wall.
// While a key is locked every attempt is refused before the password is even
// compared — including the right one — and refusals write nothing, so being
// locked out cannot be used to burn through the database's daily writes.

const ENSURE_TABLE = `CREATE TABLE IF NOT EXISTS login_attempts (
  key          TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
)`;

export const LOGIN_LIMITS = {
  perIp: 5,                 // wrong passwords from one address…
  everyone: 100,            // …or from all addresses together…
  windowMs: 15 * 60 * 1000, // …inside this window…
  lockMs: 15 * 60 * 1000,   // …locks that key for this long.
};

const GLOBAL_KEY = '*';

function ipKey(ip) {
  return 'ip:' + String(ip || 'unknown').slice(0, 64);
}

// Milliseconds until this address may try again; 0 when it is not locked.
export async function loginLockedFor(db, ip, now = Date.now()) {
  await db.prepare(ENSURE_TABLE).run();
  const { results } = await db
    .prepare('SELECT MAX(locked_until) AS until FROM login_attempts WHERE key IN (?1, ?2)')
    .bind(ipKey(ip), GLOBAL_KEY)
    .all();
  const until = Number(results?.[0]?.until) || 0;
  return until > now ? until - now : 0;
}

// One statement per key: restart the window if the old one has run out,
// otherwise add one, and set the lock the moment the count reaches the limit.
// (SQLite evaluates every right-hand side against the row as it was before the
// update, so `fails` below always means the count before this failure.)
const BUMP = `INSERT INTO login_attempts (key, fails, window_start, locked_until)
  VALUES (?1, 1, ?2, CASE WHEN ?4 <= 1 THEN ?2 + ?5 ELSE 0 END)
  ON CONFLICT(key) DO UPDATE SET
    fails = CASE WHEN ?2 - window_start > ?3 THEN 1 ELSE fails + 1 END,
    window_start = CASE WHEN ?2 - window_start > ?3 THEN ?2 ELSE window_start END,
    locked_until = CASE
      WHEN (CASE WHEN ?2 - window_start > ?3 THEN 1 ELSE fails + 1 END) >= ?4 THEN ?2 + ?5
      ELSE locked_until END`;

export async function recordLoginFailure(db, ip, now = Date.now()) {
  const { perIp, everyone, windowMs, lockMs } = LOGIN_LIMITS;
  await db.batch([
    db.prepare(BUMP).bind(ipKey(ip), now, windowMs, perIp, lockMs),
    db.prepare(BUMP).bind(GLOBAL_KEY, now, windowMs, everyone, lockMs),
  ]);
}

// A correct password clears this address, and sweeps out rows nobody needs.
export async function clearLoginFailures(db, ip, now = Date.now()) {
  await db.batch([
    db.prepare('DELETE FROM login_attempts WHERE key = ?1').bind(ipKey(ip)),
    db.prepare('DELETE FROM login_attempts WHERE window_start < ?1 AND locked_until < ?2')
      .bind(now - 24 * 60 * 60 * 1000, now),
  ]);
}
