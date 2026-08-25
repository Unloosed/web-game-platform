-- Milestone 3.1 migration for databases initialized with an earlier schema.
-- Adds per-membership ready state used by the deterministic match startup flow.

ALTER TABLE room_members
  ADD COLUMN IF NOT EXISTS ready boolean NOT NULL DEFAULT false;
