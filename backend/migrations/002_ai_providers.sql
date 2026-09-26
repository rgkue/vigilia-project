CREATE TABLE IF NOT EXISTS ai_provider_configs (
  provider TEXT PRIMARY KEY, model TEXT NOT NULL, auth_mode TEXT NOT NULL,
  encrypted_secret TEXT, revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'untested', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_selection (
  id INTEGER PRIMARY KEY CHECK (id = 1), provider TEXT NOT NULL
);
