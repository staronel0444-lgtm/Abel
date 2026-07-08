-- Forge D1 schema.
-- Apply locally:  npx wrangler d1 execute forge-db --local  --file=schema.sql
-- Apply remote:   npx wrangler d1 execute forge-db --remote --file=schema.sql
-- Statements are idempotent (IF NOT EXISTS) — safe to re-run.

-- Every business ever returned by a Lead Finder search, regardless of
-- decision. data_json holds the full shaped lead object so History can
-- re-render the complete card without re-running the search.
CREATE TABLE IF NOT EXISTS view_history (
  place_id        TEXT PRIMARY KEY,
  business_name   TEXT NOT NULL,
  niche_searched  TEXT NOT NULL,
  first_viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
  data_json       TEXT NOT NULL DEFAULT '{}'
);

-- Place IDs excluded from future search results. reason 'no' = permanently
-- dismissed lead; reason 'client' = converted to a client (also excluded).
CREATE TABLE IF NOT EXISTS dismissed_leads (
  place_id     TEXT PRIMARY KEY,
  dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
  reason       TEXT NOT NULL CHECK (reason IN ('no', 'client'))
);

CREATE TABLE IF NOT EXISTS clients (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id        TEXT,
  company_name    TEXT NOT NULL,
  owner_name      TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  address         TEXT NOT NULL DEFAULT '',
  amount_paid     REAL NOT NULL DEFAULT 0,   -- upfront fee, counted once
  monthly_fee     REAL NOT NULL DEFAULT 0,   -- current maintenance fee
  close_date      TEXT NOT NULL,             -- YYYY-MM-DD, editable
  last_paid_month TEXT,                      -- denormalized MAX(client_payments.month)
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Running list of paid months per client (not just the latest one), so
-- Revenue Dashboard windows further back than the current month add up
-- correctly. amount snapshots monthly_fee at the moment it was marked paid,
-- so later fee changes don't rewrite past revenue.
CREATE TABLE IF NOT EXISTS client_payments (
  client_id INTEGER NOT NULL,
  month     TEXT    NOT NULL,               -- YYYY-MM
  amount    REAL    NOT NULL DEFAULT 0,
  paid_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (client_id, month)
);

-- Generated sites served at /preview/<id>. kind 'single' stores raw HTML;
-- kind 'multi' stores a JSON object of {"index.html": "...", ...} pages.
CREATE TABLE IF NOT EXISTS previews (
  preview_id   TEXT PRIMARY KEY,
  place_id     TEXT,                        -- nullable: previews not tied to a lead
  kind         TEXT NOT NULL DEFAULT 'single' CHECK (kind IN ('single', 'multi')),
  title        TEXT NOT NULL DEFAULT '',
  html_content TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Visitor counter. Each generated site carries a tiny beacon that pings
-- /api/pv with its site_id on load; that endpoint upserts a row here. label
-- is the site's <title> so the Traffic tab is readable. One row per site,
-- counted across preview links AND the client's own hosted copy.
CREATE TABLE IF NOT EXISTS site_views (
  site_id    TEXT PRIMARY KEY,
  label      TEXT    NOT NULL DEFAULT '',
  views      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Money Tracker: a manual log of income the user earned (any source, incl.
-- cash), shown as a calendar. The app splits each month's total into fixed
-- buckets (40% taxes / 10% Forge / 35% save / 15% self) client-side.
CREATE TABLE IF NOT EXISTS income (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT    NOT NULL,               -- YYYY-MM-DD
  amount     REAL    NOT NULL DEFAULT 0,
  note       TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Manual sales pipeline: any lead however you found it (driving around, a
-- friend's tip, a web search) — NOT tied to a Google Place ID the way
-- view_history/dismissed_leads are, so it works with or without Lead Finder.
-- Tracked from first contact through follow-up until it's won (-> a client)
-- or a no.
CREATE TABLE IF NOT EXISTS prospects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name   TEXT    NOT NULL,
  niche           TEXT    NOT NULL DEFAULT '',
  phone           TEXT    NOT NULL DEFAULT '',
  notes           TEXT    NOT NULL DEFAULT '',
  status          TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','follow_up','won','no')),
  follow_up_date  TEXT,                       -- YYYY-MM-DD, optional
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_view_history_first_viewed ON view_history (first_viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_paid_at ON client_payments (paid_at);
CREATE INDEX IF NOT EXISTS idx_site_views_views ON site_views (views DESC);
CREATE INDEX IF NOT EXISTS idx_income_date ON income (date);
CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects (status);
CREATE INDEX IF NOT EXISTS idx_prospects_follow_up ON prospects (follow_up_date);
