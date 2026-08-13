import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { Pool } from "pg";
import { randomBytes } from "crypto";
import { z } from "zod";

const env = z
  .object({
    DATABASE_URL: z
      .string()
      .default("postgres://webgame:webgame@localhost:5432/webgame"),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    PORT: z.coerce.number().default(4000),
    CORS_ORIGIN: z.string().default("http://localhost:5173"),
    GAME_SERVER_SECRET: z
      .string()
      .min(32, "GAME_SERVER_SECRET must be at least 32 characters"),
    EMPTY_ROOM_TTL_MS: z.coerce.number().default(600_000),
  })
  .parse(process.env);

const db = new Pool({ connectionString: env.DATABASE_URL });
const app = Fastify({ logger: true });

await app.register(cors, { origin: env.CORS_ORIGIN, credentials: true });
await app.register(cookie);

const code = () =>
  randomBytes(5)
    .toString("base64url")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);

type User = { id: string; display_name: string };

async function user(req: any): Promise<User | null> {
  const sid = req.cookies.session_id;
  if (!sid) return null;
  const q = await db.query<User>(
    "select u.id,u.display_name from sessions s join users u on u.id=s.user_id where s.id=$1 and s.expires_at>now()",
    [sid],
  );
  return q.rows[0] ?? null;
}

async function required(req: any, reply: any) {
  const u = await user(req);
  if (!u) {
    reply.code(401);
    throw new Error("unauthorized");
  }
  return u;
}

function requireGameServer(request: any, reply: any): boolean {
  if (request.headers["x-game-server-secret"] !== env.GAME_SERVER_SECRET) {
    reply.code(401).send({ error: "invalid_game_server_credentials" });
    return false;
  }
  return true;
}

app.get("/health", async () => ({ status: "ok" }));

app.get("/health/db", async () => ({
  now: (await db.query("select now()")).rows[0].now,
}));

app.post("/auth/dev-login", async (req, reply) => {
  const b = z
    .object({ displayName: z.string().trim().min(1).max(50) })
    .parse(req.body);
  const u = (
    await db.query<User>(
      "insert into users(display_name) values($1) returning id,display_name",
      [b.displayName],
    )
  ).rows[0];
  const s = (
    await db.query<{ id: string }>(
      "insert into sessions(user_id,expires_at) values($1,now()+interval '7 days') returning id",
      [u.id],
    )
  ).rows[0];
  reply.setCookie("session_id", s.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: false,
  });
  return { user: { id: u.id, displayName: u.display_name } };
});

app.get("/auth/me", async (req) => {
  const u = await user(req);
  return { user: u ? { id: u.id, displayName: u.display_name } : null };
});

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
  const count = (
    await db.query(
      "select count(*)::int as n from room_members where room_id=$1",
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
  return { room: r };
});

app.get("/rooms/:code", async (req, reply) => {
  const u = await required(req, reply);
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
  const c = (req.params as any).code;
  const q = await db.query(
    "update rooms r set status='running',updated_at=now() from room_members m where r.id=m.room_id and r.code=$1 and m.user_id=$2 and m.role='host' returning r.id",
    [c, u.id],
  );
  if (!q.rows[0]) {
    reply.code(403);
    return { error: "not_host" };
  }
  return { ok: true };
});

app.post("/rooms/:code/complete", async (req, reply) => {
  const u = await required(req, reply);
  const c = (req.params as any).code;
  const b = z
    .object({
      results: z.array(z.object({ id: z.string(), tags: z.number() })),
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
  await db.query(
    "insert into matches(room_id,winner_user_id,started_at,ended_at,results) values($1,$2,now(),now(),$3)",
    [q.rows[0].id, b.winnerUserId, JSON.stringify(b.results)],
  );
  return { ok: true };
});

app.post("/rooms/:code/chat", async (req, reply) => {
  const u = await required(req, reply);
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
      message: "Chat messages must contain 1 to 500 non-whitespace characters.",
    };
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

// Internal lifecycle routes for game-server coordination

app.post("/internal/rooms/:code/lifecycle", async (request, reply) => {
  if (!requireGameServer(request, reply)) return;

  const { code } = request.params as { code: string };
  const body = z
    .object({
      status: z.enum(["waiting", "running", "completed"]),
      results: z
        .array(
          z.object({
            id: z.string().uuid(),
            tags: z.number().int().nonnegative(),
          }),
        )
        .optional(),
      winnerUserId: z.string().uuid().nullable().optional(),
    })
    .parse(request.body);

  const roomResult = await db.query<{ id: string }>(
    `
      update rooms
      set status = $2,
          updated_at = now()
      where code = $1
      returning id
    `,
    [code, body.status],
  );

  const room = roomResult.rows[0];

  if (!room) {
    reply.code(404);
    return { error: "room_not_found" };
  }

  if (body.status === "completed" && body.results && body.results.length > 0) {
    const existingMatch = await db.query(
      `
        select 1
        from matches
        where room_id = $1
        limit 1
      `,
      [room.id],
    );

    if (!existingMatch.rows[0]) {
      await db.query(
        `
          insert into matches(
            room_id,
            winner_user_id,
            started_at,
            ended_at,
            results
          )
          values($1,$2,now(),now(),$3)
        `,
        [room.id, body.winnerUserId ?? null, JSON.stringify(body.results)],
      );
    }
  }

  return { ok: true };
});

app.delete(
  "/internal/rooms/:code/abandoned-waiting-room",
  async (request, reply) => {
    if (!requireGameServer(request, reply)) return;

    const { code } = request.params as { code: string };

    const result = await db.query<{ id: string }>(
      `
        DELETE FROM rooms
        WHERE code = $1
          AND status = 'waiting'
        RETURNING id
      `,
      [code],
    );

    if (!result.rows[0]) {
      reply.code(409);
      return { error: "room_not_empty_or_not_waiting" };
    }

    return { ok: true };
  },
);

// Periodic cleanup of empty waiting rooms

setInterval(() => {
  void db.query(
    `
      delete from rooms r
      where r.status = 'waiting'
        and r.created_at < now() - ($1::bigint * interval '1 millisecond')
        and not exists (
          select 1
          from room_members rm
          where rm.room_id = r.id
        )
    `,
    [env.EMPTY_ROOM_TTL_MS],
  );
}, 60_000).unref();

await app.listen({ port: env.PORT, host: "0.0.0.0" });
