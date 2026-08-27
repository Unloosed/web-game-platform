import { Pool } from "pg";
import { createClient } from "redis";
import type { FastifyReply, FastifyRequest } from "fastify";
import { rateLimit, MetricsRegistry, parseBannedWords } from "../../../packages/platform/src/index.js";
import { env } from "./env.js";

export { env, isProduction } from "./env.js";

export const db = new Pool({ connectionString: env.DATABASE_URL });

export const redis = createClient({ url: env.REDIS_URL });
redis.on("error", (error) => {
  console.error(
    JSON.stringify({ level: "error", component: "redis", error: error.message }),
  );
});

export const metrics = new MetricsRegistry();
metrics.counter("http_requests_total", "Total HTTP requests by method and status");
metrics.counter("rate_limited_total", "Requests rejected by rate limiting");
metrics.counter("moderation_rejected_total", "Chat messages rejected by moderation");
metrics.counter("moderation_actions_total", "Admin/moderation actions performed");
metrics.counter("socket_tokens_issued_total", "One-time socket tokens issued");
metrics.counter("socket_identities_verified_total", "Socket handshakes verified against a session");

export const bannedWords = parseBannedWords(env.MODERATION_BANNED_WORDS);

export type User = {
  id: string;
  display_name: string;
  role: "player" | "moderator" | "admin";
  banned_until: Date | null;
  muted_until: Date | null;
};

export async function user(
  req: FastifyRequest,
  sessionId = req.cookies.session_id,
): Promise<User | null> {
  const sid = sessionId;
  const q = await db.query<User>(
    `select u.id,u.display_name,u.role,u.banned_until,u.muted_until
     from sessions s join users u on u.id=s.user_id
     where s.id=$1 and s.expires_at>now()`,
    [sid],
  );
  return q.rows[0] ?? null;
}

export async function required(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<User | null> {
  const u = await user(req);
  if (!u) {
    reply.code(401);
    throw new Error("unauthorized");
  }
  if (u.banned_until && u.banned_until > new Date()) {
    reply.code(403);
    throw new Error("account_banned");
  }
  return u;
}

export function requireRole(
  u: User,
  minimum: "moderator" | "admin",
  reply: FastifyReply,
): void {
  const rank = { player: 0, moderator: 1, admin: 2 };
  if (rank[u.role] < rank[minimum]) {
    reply.code(403);
    throw new Error("forbidden");
  }
}

export function requireGameServer(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (request.headers["x-game-server-secret"] !== env.GAME_SERVER_SECRET) {
    reply.code(401).send({ error: "invalid_game_server_credentials" });
    return false;
  }
  return true;
}

/** Best-effort client IP for rate-limit bucketing; honours trustProxy. */
export function clientIp(req: FastifyRequest): string {
  return req.ip;
}

export async function enforceRateLimit(
  req: FastifyRequest,
  reply: FastifyReply,
  bucket: string,
  identity: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const decision = await rateLimit(redis, `${bucket}:${identity}`, limit, windowMs);
  if (decision.allowed) return true;
  metrics.increment("rate_limited_total", { bucket });
  reply
    .code(429)
    .header("retry-after", Math.ceil(decision.retryAfterMs / 1000))
    .send({
      error: "rate_limited",
      message: "Too many requests. Please retry shortly.",
    });
  return false;
}

export async function audit(
  actorUserId: string,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    "insert into audit_log(actor_user_id,action,target_type,target_id,details) values($1,$2,$3,$4,$5)",
    [actorUserId, action, targetType, targetId, JSON.stringify(details)],
  );
}
