CREATE TABLE IF NOT EXISTS ai_oauth_connections (
  provider TEXT PRIMARY KEY, flow_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  status TEXT NOT NULL, expires_at DOUBLE PRECISION NOT NULL,
  method_index INTEGER NOT NULL DEFAULT 0, encrypted_authorization TEXT
);
