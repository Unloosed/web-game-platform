-- Milestone 4 migration for databases initialized with the original schema.
-- Run against the existing `webgame` database before deploying milestone 4.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role varchar(16) NOT NULL DEFAULT 'player'
    CHECK(role IN ('player','moderator','admin')),
  ADD COLUMN IF NOT EXISTS banned_until timestamptz,
  ADD COLUMN IF NOT EXISTS muted_until timestamptz;

CREATE TABLE IF NOT EXISTS match_players (
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tags integer NOT NULL DEFAULT 0,
  PRIMARY KEY(match_id, user_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  action varchar(64) NOT NULL,
  target_type varchar(32) NOT NULL,
  target_id varchar(64) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS match_players_user_idx ON match_players(user_id);
CREATE INDEX IF NOT EXISTS matches_room_idx ON matches(room_id);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at DESC);

-- Promote the earliest registered account to platform admin.
UPDATE users
SET role = 'admin'
WHERE id = (
  SELECT id FROM users ORDER BY created_at ASC LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');
