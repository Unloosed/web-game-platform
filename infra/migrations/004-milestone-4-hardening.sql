-- Milestone 4 completion migration: achievements and moderation reports.
-- Run against databases initialized before these tables existed.

CREATE TABLE IF NOT EXISTS achievements (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code varchar(64) NOT NULL,
  match_id uuid REFERENCES matches(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, code)
);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  chat_message_id uuid REFERENCES chat_messages(id) ON DELETE SET NULL,
  room_code varchar(6),
  reason varchar(500) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','resolved','dismissed')),
  resolved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS achievements_user_idx ON achievements(user_id);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(status, created_at DESC);
