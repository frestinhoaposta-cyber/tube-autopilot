CREATE TABLE IF NOT EXISTS autopilot_documents (
  name text PRIMARY KEY,
  payload text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS autopilot_sessions (
  sid varchar NOT NULL PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS autopilot_sessions_expire ON autopilot_sessions (expire);
