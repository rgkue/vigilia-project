CREATE TABLE IF NOT EXISTS asegurados (
  cedula TEXT PRIMARY KEY,
  nombre TEXT NOT NULL
)
;
CREATE TABLE IF NOT EXISTS polizas (
  numero TEXT PRIMARY KEY,
  cedula TEXT NOT NULL,
  plan TEXT,
  vigente_desde TEXT,
  vigente_hasta TEXT,
  estado_pago TEXT,
  carencia_dias INTEGER
)
;
CREATE TABLE IF NOT EXISTS preexistencias (
  id BIGSERIAL PRIMARY KEY,
  cedula TEXT NOT NULL,
  condicion TEXT,
  fecha_diagnostico TEXT
)
;
CREATE TABLE IF NOT EXISTS ingresos (
  evento_id TEXT PRIMARY KEY,
  cedula TEXT,
  hospital TEXT,
  motivo TEXT,
  veredicto TEXT,
  nivel_alerta TEXT,
  respuesta_json TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload_hash TEXT,
  estado TEXT NOT NULL DEFAULT 'COMPLETADO'
)
;
CREATE TABLE IF NOT EXISTS notificaciones (
  id BIGSERIAL PRIMARY KEY,
  evento_id TEXT NOT NULL,
  destino TEXT NOT NULL,
  canal TEXT NOT NULL,
  estado TEXT NOT NULL,
  mensaje TEXT NOT NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(evento_id, destino)
)
;
CREATE TABLE IF NOT EXISTS user_profiles (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  roles_json TEXT NOT NULL DEFAULT '[]',
  permissions_json TEXT NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  UNIQUE(issuer, email)
)
;
CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_subject_idx
  ON user_profiles(issuer, subject) WHERE subject IS NOT NULL
;
CREATE TABLE IF NOT EXISTS integration_configs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  endpoint_url TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT 'GET',
  lookup_parameter TEXT NOT NULL DEFAULT 'cedula',
  field_map_json TEXT NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  encrypted_secret TEXT,
  status TEXT NOT NULL DEFAULT 'not_configured',
  last_checked_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
)
;
CREATE TABLE IF NOT EXISTS api_credentials (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integration_configs(id),
  secret_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ
)
;
CREATE INDEX IF NOT EXISTS api_credentials_integration_idx ON api_credentials(integration_id, active)
;
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)
;
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at DESC)
;
CREATE TABLE IF NOT EXISTS review_actions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES ingresos(evento_id),
  classification_index INTEGER NOT NULL,
  original_relation TEXT NOT NULL,
  reviewed_relation TEXT NOT NULL,
  reason TEXT NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, classification_index)
)
;
