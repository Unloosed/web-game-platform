import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, metrics, redis, requireGameServer, user } from "../context.js";
import { persistMatchRecord } from "../completion.js";

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  // Exchanges a one-time socket token for a verified room identity.
  // Consumes the token (GETDEL) so a leaked value cannot be replayed.
  app.post("/internal/socket/verify", async (request, reply) => {
    if (!requireGameServer(request, reply)) return;

    const body = z
      .object({
        token: z.string().min(20),
        roomCode: z.string().min(1).max(6),
      })
      .parse(request.body);

    const sessionId = await redis.getDel(`socktok:${body.token}`);
    if (!sessionId) {
      reply.code(401);
      return { error: "invalid_socket_token" };
    }

    const u = await user(request, sessionId);
    if (!u) {
      reply.code(401);
      return { error: "invalid_session" };
    }
    if (u.banned_until && u.banned_until > new Date()) {
      reply.code(403);
      return { error: "account_banned" };
    }

    const membership = await db.query<{ role: string; ready: boolean }>(
      `select m.role, m.ready
       from rooms r join room_members m on m.room_id = r.id
       where r.code = $1 and m.user_id = $2
       limit 1`,
      [body.roomCode, u.id],
    );
    const role = membership.rows[0]?.role;
    if (!role) {
      reply.code(403);
      return { error: "not_member" };
    }

    metrics.increment("socket_identities_verified_total");
    return {
      userId: u.id,
      displayName: u.display_name,
      spectator: role === "spectator",
      host: role === "host",
      muted: !!(u.muted_until && u.muted_until > new Date()),
      ready: role === "spectator" ? false : (membership.rows[0]?.ready ?? false),
    };
  });

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

    const client = await db.connect();
    try {
      await client.query("begin");

      const roomResult = await client.query<{ id: string }>(
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
        await client.query("rollback");
        reply.code(404);
        return { error: "room_not_found" };
      }

      if (body.status === "completed" && body.results && body.results.length > 0) {
        // Idempotent: a room keeps at most one durable match record.
        await persistMatchRecord(
          client,
          room.id,
          body.winnerUserId ?? null,
          body.results,
        );
      }

      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
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

  // Mirrors the in-memory ready toggle into durable membership so a
  // reconnecting player restores their readiness from the database.
  app.post("/internal/rooms/:code/ready", async (request, reply) => {
    if (!requireGameServer(request, reply)) return;

    const { code } = request.params as { code: string };
    const body = z
      .object({
        userId: z.string().uuid(),
        ready: z.boolean(),
      })
      .parse(request.body);

    const result = await db.query<{ user_id: string }>(
      `
      UPDATE room_members m
      SET ready = $3
      FROM rooms r
      WHERE r.id = m.room_id
        AND r.code = $1
        AND m.user_id = $2
        AND m.role <> 'spectator'
      RETURNING m.user_id
    `,
      [code, body.userId, body.ready],
    );

    if (!result.rows[0]) {
      reply.code(404);
      return { error: "membership_not_found" };
    }

    return { ok: true };
  });
}
