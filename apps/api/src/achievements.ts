import {
  evaluateAchievements,
  type MatchStats,
} from "../../../packages/platform/src/index.js";

/**
 * Anything with pg's query surface: the connection Pool or a transaction
 * PoolClient. Achievement rows are written on the same connection as the
 * match insert so awards commit or roll back atomically with the result.
 */
type QueryRunner = {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};

export type CompletionResult = { id: string; tags: number };

export async function awardMatchAchievements(
  runner: QueryRunner,
  matchId: string,
  results: CompletionResult[],
  winnerUserId: string | null,
): Promise<void> {
  const stats: MatchStats = {
    winnerUserId,
    players: results.map((r) => ({ userId: r.id, tags: r.tags })),
  };

  for (const result of results) {
    for (const code of evaluateAchievements(stats, result.id)) {
      await runner.query(
        `insert into achievements(user_id, code, match_id)
         values ($1, $2, $3)
         on conflict (user_id, code) do nothing`,
        [result.id, code, matchId],
      );
    }
  }
}
