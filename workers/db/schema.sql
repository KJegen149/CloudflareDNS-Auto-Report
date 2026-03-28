-- Cloudflare DNS Auto-Report — D1 schema
-- Run once: wrangler d1 execute dns-reports --file=workers/db/schema.sql

CREATE TABLE IF NOT EXISTS credentials (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label           TEXT    NOT NULL,
  account_id      TEXT    NOT NULL,
  encrypted_token TEXT    NOT NULL,  -- AES-256-GCM: base64(iv):base64(tag):base64(ciphertext)
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS report_configs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  credential_id    INTEGER NOT NULL REFERENCES credentials(id) ON DELETE RESTRICT,
  label            TEXT    NOT NULL,
  zone_id          TEXT    NOT NULL,
  zone_name        TEXT    NOT NULL,
  frequency        TEXT    NOT NULL CHECK(frequency IN ('daily','weekly','monthly')),
  recipients       TEXT    NOT NULL,          -- JSON array: '["a@x.com","b@x.com"]'
  start_date       TEXT    NOT NULL DEFAULT (date('now')),  -- YYYY-MM-DD
  end_date         TEXT,                      -- YYYY-MM-DD or NULL = run forever
  enabled          INTEGER NOT NULL DEFAULT 1,
  subject_prefix   TEXT    NOT NULL DEFAULT '[DNS Report]',
  report_title     TEXT    NOT NULL DEFAULT 'DNS Report',
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS report_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  report_config_id INTEGER NOT NULL REFERENCES report_configs(id) ON DELETE CASCADE,
  zone_name        TEXT    NOT NULL,
  frequency        TEXT    NOT NULL,
  period_start     TEXT    NOT NULL,
  period_end       TEXT    NOT NULL,
  status           TEXT    NOT NULL CHECK(status IN ('sent','failed')),
  error_message    TEXT,
  sent_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runs_config  ON report_runs(report_config_id);
CREATE INDEX IF NOT EXISTS idx_configs_freq ON report_configs(frequency, enabled);
