import {
  awardMatchAchievements,
  type CompletionResult,
  type QueryRunner,
} from "./achievements.js";

/**
 * Writes one durable match (players + achievements) for a completed room.
 * Runs inside the caller's transaction alongside the room status update;
 * the existing-match guard keeps repeated calls idempotent so a room keeps
 * at most one match record. Shared by the internal game-server lifecycle
 * route and the legacy host-complete HTTP route.
 */
export async function persistMatchRecord(
  runner: QueryRunner,
  roomId: string,
  winnerUserId: string | null,
  results: CompletionResult[],
): Promise<void> {
  if (results.length === 0) return;

  const existingMatch = await runner.query(
    "select 1 from matches where room_id = $1 limit 1",
    [roomId],
  );
  if (existingMatch.rows[0]) return;

  const match = await runner.query(
    `insert into matches(room_id,winner_user_id,started_at,ended_at,results)
     values($1,$2,now(),now(),$3)
     returning id`,
    [roomId, winnerUserId, JSON.stringify(results)],
  );
  const matchId = match.rows[0].id as string;

  await runner.query(
    `insert into match_players(match_id,user_id,tags)
     select $1, r.id, r.tags
     from jsonb_to_recordset($2::jsonb) as r(id uuid, tags integer)
     on conflict do nothing`,
    [matchId, JSON.stringify(results)],
  );

  await awardMatchAchievements(runner, matchId, results, winnerUserId);
}
