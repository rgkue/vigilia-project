CREATE TABLE IF NOT EXISTS user_ai_configs (
  user_id TEXT NOT NULL REFERENCES user_profiles(id), provider TEXT NOT NULL,
  model TEXT NOT NULL, auth_mode TEXT NOT NULL, encrypted_secret TEXT,
  revision TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'untested', updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS user_ai_selection (
  user_id TEXT PRIMARY KEY REFERENCES user_profiles(id), provider TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_ai_oauth (
  user_id TEXT NOT NULL REFERENCES user_profiles(id), provider TEXT NOT NULL,
  flow_id TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL, status TEXT NOT NULL,
  expires_at DOUBLE PRECISION NOT NULL, method_index INTEGER NOT NULL DEFAULT 0,
  encrypted_authorization TEXT, PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS ai_integration_assignments (
  integration_id TEXT PRIMARY KEY REFERENCES integration_configs(id),
  user_id TEXT NOT NULL REFERENCES user_profiles(id), status TEXT NOT NULL,
  revision TEXT NOT NULL, proposed_by TEXT NOT NULL, updated_at TEXT NOT NULL
);
