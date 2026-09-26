CREATE TABLE IF NOT EXISTS employees (
  user_id TEXT PRIMARY KEY REFERENCES user_profiles(id),
  employee_id TEXT NOT NULL UNIQUE,
  encrypted_totp_secret TEXT,
  credential_version INTEGER NOT NULL DEFAULT 0,
  last_totp_step BIGINT NOT NULL DEFAULT -1
);
CREATE TABLE IF NOT EXISTS auth_attempts (
  bucket TEXT PRIMARY KEY,
  window_start BIGINT NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
