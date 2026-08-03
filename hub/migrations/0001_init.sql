CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  banned INTEGER NOT NULL DEFAULT 0,
  quota_day TEXT,
  quota_used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE configs (
  id TEXT PRIMARY KEY,
  theme TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id),
  name TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  schema INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  downloads INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  assets_status TEXT NOT NULL DEFAULT 'none'
    CHECK (assets_status IN ('none','pending','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_configs_list ON configs(theme, status, downloads DESC);
CREATE INDEX idx_configs_new  ON configs(theme, status, created_at DESC);
CREATE UNIQUE INDEX idx_configs_dedup ON configs(theme, content_hash)
  WHERE status = 'active';
CREATE TABLE assets (
  config_id TEXT NOT NULL REFERENCES configs(id),
  kind TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved')),
  PRIMARY KEY (config_id, kind)
);
CREATE TABLE dl_dedup (
  config_id TEXT NOT NULL,
  device_hash TEXT NOT NULL,
  PRIMARY KEY (config_id, device_hash)
);
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  ip TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_reports_open ON reports(resolved, created_at DESC);
CREATE TABLE ip_counters (
  ip TEXT NOT NULL,
  bucket TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, bucket, day)
);
