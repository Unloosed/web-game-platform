import { FastifyInstance } from "fastify";
import { randomBytes } from "crypto";
import { z } from "zod";
import {
  audit,
  clientIp,
  enforceRateLimit,
  env,
  isProduction,
  metrics,
  redis,
  required,
  user,
  db,
} from "../context.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/dev-login", async (req, reply) => {
    if (
      !(await enforceRateLimit(req, reply, "login", clientIp(req), 10, 10 * 60_000))
    )
      return;

    const b = z
      .object({ displayName: z.string().trim().min(1).max(50) })
      .parse(req.body);

    // First registered account becomes the platform admin so a fresh
    // self-hosted install has an operator without manual SQL.
    const existing = await db.query<{ n: number }>(
      "select count(*)::int as n from users",
    );
    const role = existing.rows[0].n === 0 ? "admin" : "player";

    const u = (
      await db.query<{ id: string; display_name: string; role: string }>(
        "insert into users(display_name,role) values($1,$2) returning id,display_name,role",
        [b.displayName, role],
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
      secure: isProduction,
    });
    if (role === "admin") {
      await audit(u.id, "bootstrap_admin", "user", u.id);
    }
    return { user: { id: u.id, displayName: u.display_name, role: u.role } };
  });

  app.get("/auth/me", async (req) => {
    const u = await user(req);
    return {
      user: u
        ? {
            id: u.id,
            displayName: u.display_name,
            role: u.role,
            banned: !!(u.banned_until && u.banned_until > new Date()),
            muted: !!(u.muted_until && u.muted_until > new Date()),
          }
        : null,
    };
  });

  // One-time, short-lived token the browser presents in its Socket.IO
  // handshake. The game server exchanges it for a verified identity via
  // /internal/socket/verify, so the browser can never assert a user id.
  app.post("/auth/socket-token", async (req, reply) => {
    const u = await required(req, reply);
    if (!u) return;
    if (
      !(await enforceRateLimit(req, reply, "socktok", u.id, 30, 60_000))
    )
      return;

    const token = randomBytes(32).toString("base64url");
    const sid = req.cookies.session_id!;
    await redis.set(`socktok:${token}`, sid, { PX: env.SOCKET_TOKEN_TTL_MS });
    metrics.increment("socket_tokens_issued_total");
    return { token, expiresInMs: env.SOCKET_TOKEN_TTL_MS };
  });
}
