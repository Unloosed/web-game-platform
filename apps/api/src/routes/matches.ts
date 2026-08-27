import { FastifyInstance } from "fastify";
import { db } from "../context.js";

export async function matchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/users/:id/matches", async (req) => {
    const userId = (req.params as any).id;
    const history = await db.query(
      `
      select
        m.id,
        r.name as "roomName",
        r.code as "roomCode",
        m.winner_user_id as "winnerUserId",
        w.display_name as "winnerName",
        m.ended_at as "endedAt",
        mp.tags,
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

  app.get("/leaderboard", async () => {
    const board = await db.query(
      `
      select
        u.id,
        u.display_name as "displayName",
        count(*)::int as "matchesPlayed",
        coalesce(sum(mp.tags), 0)::int as "totalTags",
        count(*) filter (where m.winner_user_id = u.id)::int as "wins"
      from match_players mp
      join users u on u.id = mp.user_id
      join matches m on m.id = mp.match_id
      group by u.id, u.display_name
      order by "totalTags" desc, "wins" desc, u.display_name asc
      limit 25
    `,
    );
    return { leaderboard: board.rows };
  });
}
