-- Milestone 5: game registry.
-- 1. Rooms persist which game hosts them; existing rooms keep the default.
-- 2. match_players.score replaces the tag-specific "tags" column; the
--    platform stores a game-defined score for every game.

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS game_id varchar(64) NOT NULL DEFAULT 'sample-tag';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'match_players' AND column_name = 'tags'
  ) THEN
    ALTER TABLE match_players RENAME COLUMN tags TO score;
  END IF;
END $$;
