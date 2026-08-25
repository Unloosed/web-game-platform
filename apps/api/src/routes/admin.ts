import { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, db, env, required, requireRole } from "../context.js";

async function callGameServer(
  path: string,
  init: RequestInit = {},
): Promise<void> {
  const headers = new Headers(init.headers);
  headers.set("x-game-server-secret", env.GAME_SERVER_SECRET);
  const response = await fetch(`${env.GAME_SERVER_URL}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`game-server request failed: ${response.status} ${path}`);
  }
}

/** Fire-and-forget moderation propagation; failures are logged, not fatal. */
function propagateToGameServer(path: string, init: RequestInit = {}): void {
  callGameServer(path, init).catch((error: unknown) => {
    console.error(
      JSON.stringify({
        level: "error",
        event: "game_server_propagation_failed",
        path,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/users", async (req, reply) => {
    const u = await required(req, reply);
    if (!u) return;
    requireRole(u, "moderator", reply);
    const users = await db.query(
      `
      select
        id,
        display_name as "displayName",
        role,
        banned_until as "bannedUntil",
        muted_until as "mutedUntil",
        created_at as "createdAt"
      from users
      order by created_at desc
      limit 100
    `,
    );
    return { users: users.rows };
  });

  app.post("/admin/users/:id/role", async (req, reply) => {
    const u = await required(req, reply);
    if (!u) return;
    requireRole(u, "admin", reply);
    const targetId = (req.params as any).id;
    const b = z.object({ role: z.enum(["player", "moderator", "admin"]) }).parse(req.body);
    const q = await db.query(
      "update users set role=$2 where id=$1 returning id",
      [targetId, b.role],
    );
    if (!q.rows[0]) {
      reply.code(404);
      return { error: "user_not_found" };
    }
    await audit(u.id, "set_role", "user", targetId, { role: b.role });
    return { ok: true };
  });

  app.post("/admin/users/:id/ban", async (req, reply) => {
    const u = await required(req, reply);
    if (!u) return;
    requireRole(u, "moderator", reply);
    const targetId = (req.params as any).id;
    const b = z.object({ hours: z.number().min(0).max(24 * 365) }).parse(req.body);
    const until = b.hours === 0 ? null : new Date(Date.now() + b.hours * 3_600_000);
    const q = await db.query(
      "update users set banned_until=$2 where id=$1 returning id",
      [targetId, until],
    );
    if (!q.rows[0]) {
      reply.code(404);
      return { error: "user_not_found" };
    }
    // Invalidate existing sessions so a ban takes effect immediately.
    await db.query("delete from sessions where user_id=$1", [targetId]);
    await audit(u.id, until ? "ban" : "unban", "user", targetId, {
      hours: b.hours,
    });
    // game-server may be down; the ban is still durable
    propagateToGameServer(`/internal/users/${targetId}/disconnect`, {
      method: "POST",
    });
    return { ok: true };
  });

  app.post("/admin/users/:id/mute", async (req, reply) => {
    const u = await required(req, reply);
    if (!u) return;
    requireRole(u, "moderator", reply);
    const targetId = (req.params as any).id;
    const b = z.object({ minutes: z.number().min(0).max(24 * 60) }).parse(req.body);
    const until =
      b.minutes === 0 ? null : new Date(Date.now() + b.minutes * 60_000);
    const q = await db.query(
      "update users set muted_until=$2 where id=$1 returning id",
      [targetId, until],
    );
    if (!q.rows[0]) {
      reply.code(404);
      return { error: "user_not_found" };
    }
    await audit(u.id, until ? "mute" : "unmute", "user", targetId, {
      minutes: b.minutes,
    });
    return { ok: true };
  });

  app.get("/admin/rooms", async (req, reply) => {
    const u = await required(req, reply);
    if (!u) return;
    requireRole(u, "moderator", reply);
    const rooms = await db.query(
      `
      select
        r.id,
        r.code,
        r.name,
        r.status,
        r.is_private as "isPrivate",
        r.created_at as "createdAt",
        hu.display_name as "hostName",
        (select count(*)::int from room_members m where m.room_id = r.id) as members
      from rooms r
      join users hu on hu.id = r.host_user_id
      order by r.created_at desc
      limit 100
    `,
    );
    return { rooms: rooms.rows };
  });

  app.post("/admin/rooms/:code/close", async (req, reply) => {
    const u = await required(req, reply);
    if (!u) return;
    requireRole(u, "moderator", reply);
    const code = (req.params as any).code;
    const q = await db.query<{ id: string }>(
      "update rooms set status='archived',updated_at=now() where code=$1 returning id",
      [code],
    );
    if (!q.rows[0]) {
      reply.code(404);
      return { error: "room_not_found" };
    }
    await audit(u.id, "close_room", "room", code);
    // game-server may be down; archived status blocks rejoining anyway
    propagateToGameServer(
      `/internal/rooms/${encodeURIComponent(code)}/close`,
      { method: "POST" },
    );
    return { ok: true };
  });

  app.get("/admin/audit", async (req, reply) => {
    const u = await required(req, reply);
    if (!u) return;
    requireRole(u, "moderator", reply);
    const entries = await db.query(
      `
      select
        a.id,
        a.action,
        a.target_type as "targetType",
        a.target_id as "targetId",
        a.details,
        a.created_at as "createdAt",
        au.display_name as "actorName"
      from audit_log a
      join users au on au.id = a.actor_user_id
      order by a.created_at desc
      limit 100
    `,
    );
    return { entries: entries.rows };
  });
}
