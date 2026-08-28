import { FastifyInstance } from "fastify";
import { db } from "../context.js";
import { gameIdSchema } from "../../../../packages/game-registry/src/index.js";

export async function matchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/users/:id/matches", async (req) => {
    const userId = (req.params as any).id;
    const history = await db.query(
      `
      select
        m.id,
        r.name as "roomName",
        r.code as "roomCode",
        r.game_id as "gameId",
        m.winner_user_id as "winnerUserId",
        w.display_name as "winnerName",
        m.ended_at as "endedAt",
        mp.score,
        m.results
      from match_players mp
      join matches m on m.id = mp.match_id
      join rooms r on r.id = m.room_id
      left join users w on w.id = m.winner_user_id
      where mp.user_id = $1
      order by m.ended_at desc
      limit 20
    `,
      [userId],
    );
    return { matches: history.rows };
  });

  app.get("/users/:id/achievements", async (req) => {
    const userId = (req.params as any).id;
    const rows = await db.query(
      `
      select
        a.code,
        a.match_id as "matchId",
        a.granted_at as "grantedAt"
      from achievements a
      where a.user_id = $1
      order by a.granted_at desc
      limit 100
    `,
      [userId],
    );
    return { achievements: rows.rows };
  });

  // Per-game dimension: ?game=<gameId> scopes the board to one game;
  // without it the board aggregates across all games.
  app.get("/leaderboard", async (req, reply) => {
    const raw = (req.query as { game?: string }).game;
    const game = raw === undefined || raw === "" ? null : gameIdSchema.safeParse(raw);
    if (raw && !game?.success) {
      reply.code(400);
      return { error: "unknown_game" };
    }

    const board = await db.query(
      `
      select
        u.id,
        u.display_name as "displayName",
        count(*)::int as "matchesPlayed",
        coalesce(sum(mp.score), 0)::int as "totalScore",
        count(*) filter (where m.winner_user_id = u.id)::int as "wins"
      from match_players mp
      join users u on u.id = mp.user_id
      join matches m on m.id = mp.match_id
      join rooms r on r.id = m.room_id
      where ($1::text is null or r.game_id = $1)
      group by u.id, u.display_name
      order by "totalScore" desc, "wins" desc, u.display_name asc
      limit 25
    `,
      [game?.success ? game.data : null],
    );
    return { leaderboard: board.rows };
  });
}
