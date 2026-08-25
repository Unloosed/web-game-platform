import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { randomUUID } from "crypto";
import { env } from "./env.js";
import { db, redis, metrics } from "./context.js";
import { authRoutes } from "./routes/auth.js";
import { roomRoutes } from "./routes/rooms.js";
import { matchRoutes } from "./routes/matches.js";
import { adminRoutes } from "./routes/admin.js";
import { internalRoutes } from "./routes/internal.js";

const app: FastifyInstance = Fastify({
  logger: true,
  // Correlation IDs: honour inbound x-request-id, else generate one.
  // Pino request logs carry this as reqId for end-to-end tracing.
  genReqId: () => randomUUID(),
  bodyLimit: 64 * 1024,
  trustProxy: env.TRUST_PROXY,
});

await app.register(cors, { origin: env.CORS_ORIGIN, credentials: true });
await app.register(cookie);

// Observability: correlation id propagation + request counters.
app.addHook("onRequest", async (req, reply) => {
  const inbound = req.headers["x-request-id"];
  if (typeof inbound === "string" && inbound.length <= 128) {
    req.id = inbound;
  }
  reply.header("x-request-id", req.id);
});
app.addHook("onResponse", async (req, reply) => {
  metrics.increment("http_requests_total", {
    method: req.method,
    status: String(reply.statusCode),
  });
});

app.get("/health", async () => ({ status: "ok" }));

app.get("/health/db", async () => ({
  now: (await db.query("select now()")).rows[0].now,
}));

app.get("/health/ready", async (_req, reply) => {
  const checks: Record<string, string> = {};
  let ready = true;
  try {
    await db.query("select 1");
    checks.database = "ok";
  } catch {
    checks.database = "unavailable";
    ready = false;
  }
  try {
    await redis.ping();
    checks.redis = "ok";
  } catch {
    checks.redis = "unavailable";
    ready = false;
  }
  if (!ready) reply.code(503);
  return { status: ready ? "ready" : "not_ready", checks };
});

app.get("/metrics", async (_req, reply) => {
  reply.header("content-type", "text/plain; version=0.0.4").send(
    metrics.render(),
  );
});

await app.register(authRoutes);
await app.register(roomRoutes);
await app.register(matchRoutes);
await app.register(adminRoutes);
await app.register(internalRoutes);

app.setErrorHandler((error: Error, req, reply) => {
  if (reply.statusCode < 400) {
    // Route handlers that pre-set a status (401/403/409/...) keep it;
    // everything else from route code (e.g. Zod parse failures) is a 400.
    reply.code(400);
  }
  if (reply.statusCode >= 500) {
    req.log.error({ err: error }, "request_failed");
    return reply.send({ error: "internal_error" });
  }
  return reply.send({ error: error.message });
});

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

await redis.connect();

const shutdown = (signal: string): void => {
  app.log.info({ signal }, "api_shutdown");
  void app.close().then(() => {
    void redis.quit().finally(() => process.exit(0));
  });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await app.listen({ port: env.PORT, host: "0.0.0.0" });
