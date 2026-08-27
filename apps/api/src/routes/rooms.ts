import { FastifyInstance } from "fastify";
import { randomBytes } from "crypto";
import { z } from "zod";
import {
  bannedWords,
  db,
  enforceRateLimit,
  env,
  metrics,
  required,
} from "../context.js";
import { isChatAllowed } from "../../../../packages/platform/src/index.js";
import { awardMatchAchievements } from "../achievements.js";

const code = () =>
  randomBytes(5)
    .toString("base64url")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);

export async function roomRoutes(app: FastifyInstance): Promise<void> {
  app.get("/rooms", async () => {
    const result = await db.query(
      `
      SELECT
        id,
        code,
        name,
        is_private AS "isPrivate",
        status,
        max_players AS "maxPlayers",
        host_user_id AS "hostUserId"
      FROM rooms
      WHERE is_private = false
        AND status IN ('waiting', 'running')
      ORDER BY created_at DESC
    `,
    );

    return {
      rooms: result.rows,
    };
  });

  app.post("/rooms", async (req, reply) => {
    const u = await required(req, reply);
    if (!u) return;
    if (!(await enforceRateLimit(req, reply, "room-create", u.id, 20, 3_600_000)))
      return;

    const parsed = z
      .object({
        name: z.string().trim().min(1).max(64),
        isPrivate: z.boolean().default(false),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      reply.code(400);
      return {
        error: "invalid_room",
        message:
          "Room name must contain between 1 and 64 non-whitespace characters.",
      };
    }

    const b = parsed.data;
    let r: any;
    for (let i = 0; i < 4 && !r; i++) {
      try {
        r = (
          await db.query(
            'insert into rooms(code,name,is_private,host_user_id) values($1,$2,$3,$4) returning id,code,name,is_private as "isPrivate",status,max_players as "maxPlayers",host_user_id as "hostUserId"',
            [code(), b.name, b.isPrivate, u.id],
          )
        ).rows[0];
      } catch {
        // retry with a different code
      }
    }
    if (!r) {
      reply.code(500);
      return { error: "code_generation_failed" };
    }
    await db.query(
      "insert into room_members(room_id,user_id,role) values($1,$2,'host')",
      [r.id, u.id],
    );
    reply.code(201);
    return { room: r };
  });

  app.post("/rooms/join", async (req, reply) => {
    const u = await required(req, reply);
    if (!u) return;
    if (!(await enforceRateLimit(req, reply, "room-join", u.id, 30, 60_000)))
      return;

    const b = z
      .object({
        code: z.string().trim().toUpperCase().length(6),
        spectator: z.boolean().default(false),
      })
      .parse(req.body);
    const r = (
      await db.query(
        'select id,code,name,is_private as "isPrivate",status,max_players as "maxPlayers",host_user_id as "hostUserId" from rooms where code=$1',
        [b.code],
      )
    ).rows[0];
    if (!r) {
      reply.code(404);
      return { error: "room_not_found" };
    }
    if (r.status === "archived") {
      reply.code(409);
      return { error: "room_closed" };
    }
    // Spectators never count toward player capacity.
    const count = (
      await db.query(
        "select count(*)::int as n from room_members where room_id=$1 and role <> 'spectator'",
        [r.id],
      )
    ).rows[0].n;
    if (!b.spectator && count >= r.maxPlayers) {
      reply.code(409);
      return { error: "room_full" };
    }
    await db.query(
      "insert into room_members(room_id,user_id,role) values($1,$2,$3) on conflict(room_id,user_id) do update set role=excluded.role",
      [
        r.id,
        u.id,
        b.spectator ? "spectator" : r.hostUserId === u.id ? "host" : "player",
      ],
    );
    // Keep the live socket session's authorization in sync with the
    // durable membership role so a mid-session spectator cannot keep
    // issuing gameplay input. Fire-and-forget; the game server ignores
    // unknown users/rooms.
    void fetch(`${env.GAME_SERVER_URL}/internal/users/${u.id}/spectator`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-game-server-secret": env.GAME_SERVER_SECRET,
      },
      body: JSON.stringify({ roomCode: r.code, spectator: b.spectator }),
    }).catch(() => {});
    return { room: r };
  });

  app.get("/rooms/:code", async (req, reply) => {
    const u = await required(req, reply);
    if (!u) return;
    const code = (req.params as any).code;
    const q = await db.query(
      'select r.id,r.code,r.name,r.status,r.is_private as "isPrivate",r.max_players as "maxPlayers",r.host_user_id as "hostUserId",m.role from rooms r join room_members m on m.room_id=r.id where r.code=$1 and m.user_id=$2',
      [code, u.id],
    );
    if (!q.rows[0]) {
      reply.code(404);
      return { error: "room_not_found" };
    }
    return { room: q.rows[0] };
  });

  app.post("/rooms/:code/start", async (req, reply) => {
    const u = await required(req, reply);
    if (!u) return;
    const c = (req.params as any).code;
    const q = await db.query<{ id: string }>(
      "select r.id from rooms r join room_members m on r.id=m.room_id where r.code=$1 and m.user_id=$2 and m.role='host'",
      [c, u.id],
    );
    if (!q.rows[0]) {
      reply.code(403);
      return { error: "not_host" };
    }
    // Mirror the game-server startup gate: enough participants and
    // every non-spectator member explicitly ready.
    const readiness = await db.query<{
      participants: number;
      unready: number;
    }>(
      `select
         count(*) filter (where role <> 'spectator')::int as participants,
         count(*) filter (where role <> 'spectator' and ready = false)::int as unready
       from room_members where room_id = $1`,
      [q.rows[0].id],
    );
    const { participants, unready } = readiness.rows[0];
    if (participants < 2) {
      reply.code(409);
      return { error: "insufficient_players" };
    }
    if (unready > 0) {
      reply.code(409);
      return { error: "not_everyone_ready" };
    }
    await db.query("update rooms set status='running',updated_at=now() where id=$1", [
      q.rows[0].id,
    ]);
    return { ok: true };
  });

  app.post("/rooms/:code/complete", async (req, reply) => {
    const u = await required(req, reply);
    if (!u) return;
    const c = (req.params as any).code;
    const b = z
      .object({
        results: z.array(
          z.object({ id: z.string().uuid(), tags: z.number() }),
        ),
        winnerUserId: z.string().nullable(),
      })
      .parse(req.body);
    const q = await db.query<{ id: string }>(
      "update rooms r set status='completed',updated_at=now() from room_members m where r.id=m.room_id and r.code=$1 and m.user_id=$2 and m.role='host' returning r.id",
      [c, u.id],
    );
    if (!q.rows[0]) {
      reply.code(403);
      return { error: "not_host" };
    }
    // Idempotent: a room keeps at most one durable match record, matching
    // the internal game-server lifecycle route.
    const existingMatch = await db.query(
      "select 1 from matches where room_id = $1 limit 1",
      [q.rows[0].id],
    );
    if (!existingMatch.rows[0]) {
      const inserted = await db.query<{ id: string }>(
        "insert into matches(room_id,winner_user_id,started_at,ended_at,results) values($1,$2,now(),now(),$3) returning id",
        [q.rows[0].id, b.winnerUserId, JSON.stringify(b.results)],
      );
      await awardMatchAchievements(
        db,
        inserted.rows[0].id,
        b.results,
        b.winnerUserId,
      );
    }
    return { ok: true };
  });

  app.post("/rooms/:code/chat", async (req, reply) => {
    const u = await required(req, reply);
    if (!u) return;
    if (!(await enforceRateLimit(req, reply, "chat", u.id, 20, 60_000)))
      return;

    const c = (req.params as any).code;

    const parsed = z
      .object({
        text: z.string().trim().min(1).max(500),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      reply.code(400);

      return {
        error: "invalid_chat_message",
        message:
          "Chat messages must contain 1 to 500 non-whitespace characters.",
      };
    }

    if (u.muted_until && u.muted_until > new Date()) {
      reply.code(403);
      return { error: "account_muted" };
    }

    if (!isChatAllowed(parsed.data.text, bannedWords)) {
      metrics.increment("moderation_rejected_total");
      reply.code(400);
      return { error: "chat_rejected_by_moderation" };
    }

    const b = parsed.data;

    const r = (
      await db.query(
        `
        select r.id
        from rooms r
        join room_members m on m.room_id = r.id
        where r.code = $1
          and m.user_id = $2
        limit 1
      `,
        [c, u.id],
      )
    ).rows[0];

    if (!r) {
      reply.code(403);
      return { error: "not_member" };
    }

    await db.query(
      "insert into chat_messages(room_id,user_id,content) values($1,$2,$3)",
      [r.id, u.id, b.text],
    );

    return { ok: true };
  });

  app.get("/rooms/:code/chat", async (req, reply) => {
    const u = await required(req, reply);
    if (!u) return;
    const c = (req.params as any).code;

    const membership = await db.query(
      `
      select 1
      from rooms r
      join room_members m on m.room_id = r.id
      where r.code = $1
        and m.user_id = $2
      limit 1
    `,
      [c, u.id],
    );

    if (!membership.rows[0]) {
      reply.code(403);
      return { error: "not_member" };
    }

    const history = await db.query(
      `
      select
        cm.id,
        u.display_name as "from",
        cm.content as text,
        (extract(epoch from cm.created_at) * 1000)::double precision as at
      from chat_messages cm
      join rooms r on r.id = cm.room_id
      join users u on u.id = cm.user_id
      where r.code = $1
      order by cm.created_at asc
      limit 100
    `,
      [c],
    );

    return {
      messages: history.rows,
    };
  });
}
