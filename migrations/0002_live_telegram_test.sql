-- Lead Database Manager / 0.1.2 — live Telegram account + monitoring test layer
-- Apply ONCE after 0001 (D1 -> SQL Console). ALTER TABLE cannot be re-run: a second run reports "duplicate column".
PRAGMA foreign_keys = ON;

-- Extra lead fields (core table from 0001 is kept, nothing is dropped or renamed)
ALTER TABLE leads ADD COLUMN phone TEXT;
ALTER TABLE leads ADD COLUMN source_title TEXT;
ALTER TABLE leads ADD COLUMN source_chat_id TEXT;
ALTER TABLE leads ADD COLUMN trigger_text TEXT;
ALTER TABLE leads ADD COLUMN trigger_keyword TEXT;
ALTER TABLE leads ADD COLUMN trigger_message_id INTEGER;
ALTER TABLE leads ADD COLUMN hits_count INTEGER NOT NULL DEFAULT 1;
-- Lower-cased (ru, ё=е) copy of the searchable fields: SQLite LIKE ignores case only for Latin letters.
ALTER TABLE leads ADD COLUMN search_norm TEXT;

-- One row per message that triggered the filter. PRIMARY KEY makes re-processing the same message harmless.
CREATE TABLE IF NOT EXISTS lead_hits (
  source_chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  telegram_id TEXT NOT NULL,
  keyword TEXT,
  message_text TEXT,
  message_date TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_hits_telegram ON lead_hits(telegram_id);

-- The connected Telegram account (single row). Secrets are stored encrypted by the Worker (AES-GCM, key from APP_SECRET).
CREATE TABLE IF NOT EXISTS tg_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  api_id_enc TEXT,
  api_hash_enc TEXT,
  session_enc TEXT,
  status TEXT NOT NULL DEFAULT 'logged_out',
  me_json TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Chats chosen for monitoring. For a channel, target_id is its linked discussion group (the comments live there).
CREATE TABLE IF NOT EXISTS monitor_sources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('group', 'supergroup', 'channel')),
  target_id TEXT,
  target_title TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  baseline_done INTEGER NOT NULL DEFAULT 0,
  last_message_id INTEGER NOT NULL DEFAULT 0,
  messages_seen INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS monitor_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  keywords TEXT NOT NULL DEFAULT '',
  match_any INTEGER NOT NULL DEFAULT 0,
  interval_seconds INTEGER NOT NULL DEFAULT 30,
  running INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS monitor_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL
);

INSERT OR IGNORE INTO tg_account (id) VALUES (1);
INSERT OR IGNORE INTO monitor_settings (id) VALUES (1);
INSERT OR IGNORE INTO schema_migrations(version) VALUES ('0002_live_telegram_test');
