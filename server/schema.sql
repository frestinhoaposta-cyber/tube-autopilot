CREATE SCHEMA IF NOT EXISTS tube_autopilot;

CREATE TABLE IF NOT EXISTS tube_autopilot.autopilot_documents (
  name text PRIMARY KEY,
  payload text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tube_autopilot.autopilot_sessions (
  sid VARCHAR(32) PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS autopilot_sessions_expire ON tube_autopilot.autopilot_sessions (expire);
