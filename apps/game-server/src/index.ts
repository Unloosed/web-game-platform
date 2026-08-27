import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { z } from "zod";
import { clientEventSchema, PROTOCOL_VERSION } from "../../../packages/protocol/src/index.js";
import {
  isChatAllowed,
  MetricsRegistry,
  parseBannedWords,
} from "../../../packages/platform/src/index.js";
import { RoomManager } from "./room-manager.js";

const env = z
  .object({
    GAME_PORT: z.coerce.number().default(4100),
    CORS_ORIGIN: z.string().default("http://localhost:5173"),
    REDIS_URL: z.string().optional(),
    ROOM_RECONNECT_GRACE_MS: z.coerce.number().default(15_000),
    GAME_MATCH_MS: z.coerce.number().int().positive().default(60_000),
    MAX_SOCKETS_PER_USER: z.coerce.number().int().positive().default(4),
    MAX_SOCKETS_PER_IP: z.coerce.number().int().positive().default(16),
    API_URL: z.string().default("http://localhost:4000"),
    GAME_SERVER_SECRET: z
      .string()
      .min(32, "GAME_SERVER_SECRET must be at least 32 characters"),
    MODERATION_BANNED_WORDS: z.string().default("spam,scam"),
  })
  .parse(process.env);

const bannedWords = parseBannedWords(env.MODERATION_BANNED_WORDS);

const metrics = new MetricsRegistry();
metrics.gauge("game_rooms_active", "Rooms with a live simulation");
metrics.gauge("game_players_connected", "Users with a live socket");
metrics.gauge("game_matches_active", "Rooms with a match currently running");
metrics.gauge("game_tick_latency_ms", "Wall-clock cost of the most recent simulation tick");
metrics.counter("game_socket_connects_total", "Verified socket connections");
metrics.counter("game_handshake_rejections_total", "Handshakes rejected by auth", );
metrics.counter("game_protocol_rejections_total", "Handshakes rejected by protocol version mismatch");
metrics.counter("game_connection_quota_rejections_total", "Connections rejected by per-user or per-IP quotas");
metrics.counter("game_inputs_rejected_total", "Gameplay inputs rejected by rate limit or phase");
metrics.counter("game_chat_rejected_total", "Chat messages rejected by rate limit or moderation");
metrics.counter("game_matches_completed_total", "Matches that reached completion");
metrics.counter("game_snapshots_total", "Room snapshots broadcast");
metrics.counter("game_lifecycle_failures_total", "Lifecycle persistence calls that failed");

const log = (level: string, event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, event, ...fields }));

function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 16_384) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function gameApi(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);

  headers.set("x-game-server-secret", env.GAME_SERVER_SECRET);

  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return fetch(`${env.API_URL}${path}`, { ...init, headers });
}

function deleteAbandonedWaitingRoom(roomCode: string): Promise<void> {
  return gameApi(
    `/internal/rooms/${encodeURIComponent(roomCode)}/abandoned-waiting-room`,
    { method: "DELETE" },
  ).then(() => undefined);
}

function persistReady(
  roomCode: string,
  userId: string,
  ready: boolean,
): Promise<void> {
  return gameApi(`/internal/rooms/${encodeURIComponent(roomCode)}/ready`, {
    method: "POST",
    body: JSON.stringify({ userId, ready }),
  }).then(() => undefined);
}

function reportLifecycleFailure(operation: string, error: unknown): void {
  metrics.increment("game_lifecycle_failures_total");
  log("error", "lifecycle_failure", {
    operation,
    error: error instanceof Error ? error.message : String(error),
  });
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"ok"}');
    return;
  }

  if (url.pathname === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(metrics.render());
    return;
  }

  if (url.pathname.startsWith("/internal/")) {
    // Internal moderation endpoints are authorized by the shared secret.
    if (req.headers["x-game-server-secret"] !== env.GAME_SERVER_SECRET) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"invalid_game_server_credentials"}');
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/internal/rooms/")) {
      const parts = url.pathname.split("/");
      const code = decodeURIComponent(parts[3] ?? "");
      const action = parts[4];
      if (code && action === "close") {
        io.in(code).disconnectSockets(true);
        roomManager.forceClose(code);
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
    }

    if (
      req.method === "POST" &&
      /^\/internal\/users\/[^/]+\/disconnect$/.test(url.pathname)
    ) {
      const userId = decodeURIComponent(url.pathname.split("/")[3]);
      const targets = socketsByUser.get(userId) ?? new Set<Socket>();
      for (const socket of targets) {
        socket.disconnect(true);
      }
      log("info", "internal_disconnect_user", { userId, sockets: targets.size });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }

    // Applies a durable membership role change to the live session so a
    // spectator cannot keep issuing gameplay input after toggling role.
    if (
      req.method === "POST" &&
      /^\/internal\/users\/[^/]+\/spectator$/.test(url.pathname)
    ) {
      const userId = decodeURIComponent(url.pathname.split("/")[3]);
      try {
        const body = z
          .object({
            roomCode: z.string().min(1).max(6),
            spectator: z.boolean(),
          })
          .parse(await readJson(req));

        roomManager.setSpectator(body.roomCode, userId, body.spectator);
        log("info", "internal_spectator_change", {
          userId,
          roomCode: body.roomCode,
          spectator: body.spectator,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":"invalid_spectator_request"}');
      }
      return;
    }

    // Room-scoped moderation kick: removes the player immediately (no
    // reconnect grace) and drops their sockets bound to this room.
    if (
      req.method === "POST" &&
      /^\/internal\/rooms\/[^/]+\/kick$/.test(url.pathname)
    ) {
      const code = decodeURIComponent(url.pathname.split("/")[3]);
      try {
        const body = z
          .object({ userId: z.string().uuid() })
          .parse(await readJson(req));

        roomManager.kick(code, body.userId);
        for (const socket of socketsByUser.get(body.userId) ?? []) {
          if (socket.data.roomCode === code) {
            socket.disconnect(true);
          }
        }
        log("info", "internal_kick", { roomCode: code, userId: body.userId });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":"invalid_kick_request"}');
      }
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not_found"}');
    return;
  }

  res.writeHead(404);
  res.end();
});

const io = new Server(http, {
  cors: {
    origin: env.CORS_ORIGIN,
    credentials: true,
  },
  maxHttpBufferSize: 16 * 1024,
});

let rateLimitRedis: ReturnType<typeof createClient> | null = null;

// Horizontal scaling: with REDIS_URL set, the Socket.IO Redis adapter
// broadcasts room events across replicas. Room simulation ownership still
// requires sticky routing per room (see docs/deployment.md).
if (env.REDIS_URL) {
  const pub = createClient({ url: env.REDIS_URL });
  const sub = pub.duplicate();
  pub.on("error", (e) => log("error", "redis_pub_error", { error: e.message }));
  sub.on("error", (e) => log("error", "redis_sub_error", { error: e.message }));
  await pub.connect();
  await sub.connect();
  io.adapter(createAdapter(pub, sub));
  rateLimitRedis = pub;
}

const roomManager = new RoomManager({
  reconnectGraceMs: env.ROOM_RECONNECT_GRACE_MS,
  matchMs: env.GAME_MATCH_MS,
  api: {
    markRunning: (roomCode) =>
      gameApi(`/internal/rooms/${encodeURIComponent(roomCode)}/lifecycle`, {
        method: "POST",
        body: JSON.stringify({ status: "running" }),
      }).then(() => undefined),

    persistCompletion: (roomCode, completion) =>
      gameApi(`/internal/rooms/${encodeURIComponent(roomCode)}/lifecycle`, {
        method: "POST",
        body: JSON.stringify({
          status: "completed",
          winnerUserId: completion.winnerUserId,
          results: completion.results,
        }),
      }).then(() => undefined),

    deleteAbandonedWaitingRoom,
    persistReady,
  },

  onBroadcast: (roomCode, snapshot) => {
    metrics.increment("game_snapshots_total");
    io.to(roomCode).emit("server_event", snapshot);
  },

  onLifecycleFailure: reportLifecycleFailure,

  onTickSample: (tickDurationMs) => {
    metrics.set("game_tick_latency_ms", Math.round(tickDurationMs * 100) / 100);
  },
});

const socketsByUser = new Map<string, Set<Socket>>();
const socketsByIp = new Map<string, Set<Socket>>();

function trackSocket(userId: string, socket: Socket): void {
  let set = socketsByUser.get(userId);
  if (!set) {
    set = new Set();
    socketsByUser.set(userId, set);
  }
  set.add(socket);
  metrics.set(
    "game_players_connected",
    [...socketsByUser.values()].reduce((n, s) => n + s.size, 0),
  );
}

function untrackSocket(userId: string, socket: Socket): void {
  const set = socketsByUser.get(userId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) socketsByUser.delete(userId);
  metrics.set(
    "game_players_connected",
    [...socketsByUser.values()].reduce((n, s) => n + s.size, 0),
  );
}

function trackIp(ip: string, socket: Socket): void {
  let set = socketsByIp.get(ip);
  if (!set) {
    set = new Set();
    socketsByIp.set(ip, set);
  }
  set.add(socket);
}

function untrackIp(ip: string, socket: Socket): void {
  const set = socketsByIp.get(ip);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) socketsByIp.delete(ip);
}

setInterval(() => {
  metrics.set("game_rooms_active", roomManager.roomCount());
  metrics.set("game_matches_active", roomManager.activeMatchCount());
}, 5_000).unref();

type VerifiedIdentity = {
  userId: string;
  displayName: string;
  spectator: boolean;
  host: boolean;
  muted: boolean;
};

async function verifyHandshake(
  roomCode: string,
  token: unknown,
): Promise<VerifiedIdentity | null> {
  const parsed = z.string().min(20).safeParse(token);
  if (!parsed.success) return null;

  try {
    const response = await gameApi("/internal/socket/verify", {
      method: "POST",
      body: JSON.stringify({ token: parsed.data, roomCode }),
    });
    if (!response.ok) return null;
    return (await response.json()) as VerifiedIdentity;
  } catch {
    return null;
  }
}

io.on("connection", (socket) => {
  const auth = socket.handshake.auth as Record<string, unknown>;

  const roomCode = z.string().min(1).max(6).safeParse(auth.roomCode);

  if (!roomCode.success) {
    socket.disconnect(true);
    return;
  }

  // Protocol-version gate: mismatched clients fail fast instead of
  // misinterpreting snapshots or events.
  if (auth.protocolVersion !== PROTOCOL_VERSION) {
    metrics.increment("game_protocol_rejections_total");
    metrics.increment("game_handshake_rejections_total");
    socket.emit("auth_error", { error: "protocol_mismatch" });
    socket.disconnect(true);
    return;
  }

  const token = auth.token;

  void (async () => {
    const identity = await verifyHandshake(roomCode.data, token);
    if (!identity) {
      metrics.increment("game_handshake_rejections_total");
      socket.emit("auth_error", { error: "handshake_rejected" });
      socket.disconnect(true);
      return;
    }

    const { userId, displayName, spectator, host } = identity;

    // Connection quotas per account and per IP bound abuse via reconnect
    // storms or tab farms.
    if (
      (socketsByUser.get(userId)?.size ?? 0) >= env.MAX_SOCKETS_PER_USER ||
      (socketsByIp.get(socket.handshake.address)?.size ?? 0) >=
        env.MAX_SOCKETS_PER_IP
    ) {
      metrics.increment("game_connection_quota_rejections_total");
      socket.emit("auth_error", { error: "connection_quota_exceeded" });
      socket.disconnect(true);
      return;
    }

    log("info", "socket_verified", {
      roomCode: roomCode.data,
      userId,
      spectator,
    });
    metrics.increment("game_socket_connects_total");

    socket.data.roomCode = roomCode.data;
    socket.join(roomCode.data);
    trackSocket(userId, socket);
    trackIp(socket.handshake.address, socket);

    roomManager.connect(roomCode.data, {
      userId,
      displayName,
      spectator,
      host,
      socketId: socket.id,
    });

    socket.on("request_snapshot", () => {
      const snapshot = roomManager.getSnapshot(roomCode.data);

      if (snapshot) {
        socket.emit("server_event", snapshot);
      }
    });

    // Per-socket gameplay input throttle: 40 inputs per rolling second.
    let inputWindowStart = Date.now();
    let inputCount = 0;

    socket.on("client_event", (raw: unknown) => {
      const event = clientEventSchema.safeParse(raw);

      if (!event.success) {
        metrics.increment("game_inputs_rejected_total");
        return;
      }

      if (event.data.type === "input") {
        if (event.data.direction === "none") return;
        const now = Date.now();
        if (now - inputWindowStart >= 1_000) {
          inputWindowStart = now;
          inputCount = 0;
        }
        inputCount += 1;
        if (inputCount > 40) {
          metrics.increment("game_inputs_rejected_total");
          return;
        }
        roomManager.move(roomCode.data, userId, event.data.direction);
        return;
      }

      if (event.data.type === "ready") {
        // Readiness is server-validated (spectators/mid-match are ignored)
        // and mirrored into durable membership via the internal API.
        roomManager.setReady(roomCode.data, userId, event.data.ready);
        return;
      }

      // Chat is broadcast-only; durable history is written via the HTTP API.
      const chatText = event.data.text;
      const broadcastChat = (): void => {
        io.to(roomCode.data).emit("chat_event", {
          from: displayName,
          text: chatText,
          at: Date.now(),
        });
      };
      if (identity.muted) {
        metrics.increment("game_chat_rejected_total");
        return;
      }
      if (!isChatAllowed(chatText, bannedWords)) {
        metrics.increment("game_chat_rejected_total");
        return;
      }
      const redisClient = rateLimitRedis;
      if (redisClient) {
        const key = `rl:chat-socket:${userId}`;
        void (async () => {
          try {
            const count = await redisClient.incr(key);
            if (count === 1) {
              await redisClient.pExpire(key, 10_000);
            }
            if (count > 5) {
              metrics.increment("game_chat_rejected_total");
              return;
            }
            broadcastChat();
          } catch {
            // Redis unavailable: fall back to broadcast without limit.
            broadcastChat();
          }
        })();
        return;
      }
      broadcastChat();
    });

    socket.on("start_match", () => {
      roomManager.startMatch(roomCode.data, userId);
    });

    socket.on("restart_match", () => {
      roomManager.restartMatch(roomCode.data, userId);
    });

    socket.on("disconnect", () => {
      untrackSocket(userId, socket);
      untrackIp(socket.handshake.address, socket);
      roomManager.disconnect(roomCode.data, userId);
    });
  })();
});

function shutdown(signal: string): void {
  log("info", "game_server_shutdown", { signal });

  roomManager.dispose();

  io.close(() => {
    http.close(() => {
      process.exit(0);
    });
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

http.listen(env.GAME_PORT, "0.0.0.0", () => {
  log("info", "game_server_listening", { port: env.GAME_PORT });
});
