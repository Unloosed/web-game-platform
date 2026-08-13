import { createServer } from "node:http";
import { Server } from "socket.io";
import { z } from "zod";
import { clientEventSchema } from "../../../packages/protocol/src/index.js";
import { RoomManager } from "./room-manager.js";

const port = z.coerce.number().default(4100).parse(process.env.GAME_PORT);
const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const reconnectGraceMs = Number(process.env.ROOM_RECONNECT_GRACE_MS ?? 15_000);
const apiUrl = process.env.API_URL ?? "http://localhost:4000";

const gameServerSecret = z
  .string()
  .min(32, "GAME_SERVER_SECRET must be at least 32 characters")
  .parse(process.env.GAME_SERVER_SECRET);

async function gameApi(path: string, init: RequestInit = {}): Promise<void> {
  const headers = new Headers(init.headers);

  headers.set("x-game-server-secret", gameServerSecret);

  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Game API request failed: ${response.status} ${path}`);
  }
}

function deleteAbandonedWaitingRoom(roomCode: string): Promise<void> {
  return gameApi(
    `/internal/rooms/${encodeURIComponent(roomCode)}/abandoned-waiting-room`,
    {
      method: "DELETE",
    },
  );
}

function reportLifecycleFailure(operation: string, error: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      operation,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

const http = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"ok"}');
    return;
  }

  res.writeHead(404);
  res.end();
});

const io = new Server(http, {
  cors: {
    origin: corsOrigin,
    credentials: true,
  },
});

const roomManager = new RoomManager({
  reconnectGraceMs,
  api: {
    markRunning: (roomCode) =>
      gameApi(`/internal/rooms/${encodeURIComponent(roomCode)}/lifecycle`, {
        method: "POST",
        body: JSON.stringify({
          status: "running",
        }),
      }),

    persistCompletion: (roomCode, completion) =>
      gameApi(`/internal/rooms/${encodeURIComponent(roomCode)}/lifecycle`, {
        method: "POST",
        body: JSON.stringify({
          status: "completed",
          winnerUserId: completion.winnerUserId,
          results: completion.results,
        }),
      }),

    deleteAbandonedWaitingRoom,
  },

  onBroadcast: (roomCode, snapshot) => {
    io.to(roomCode).emit("server_event", snapshot);
  },

  onLifecycleFailure: reportLifecycleFailure,
});

io.on("connection", (socket) => {
  const parsed = z
    .object({
      roomCode: z.string().min(1),
      userId: z.string().uuid(),
      displayName: z.string().min(1).max(50),
      spectator: z.enum(["true", "false"]).default("false"),
      host: z.enum(["true", "false"]).default("false"),
    })
    .safeParse(socket.handshake.auth);

  if (!parsed.success) {
    socket.disconnect(true);
    return;
  }

  const { roomCode, userId, displayName, spectator, host } = parsed.data;

  socket.join(roomCode);

  roomManager.connect(roomCode, {
    userId,
    displayName,
    spectator: spectator === "true",
    host: host === "true",
    socketId: socket.id,
  });

  socket.on("request_snapshot", () => {
    const snapshot = roomManager.getSnapshot(roomCode);

    if (snapshot) {
      socket.emit("server_event", snapshot);
    }
  });

  socket.on("client_event", (raw: unknown) => {
    const event = clientEventSchema.safeParse(raw);

    if (!event.success) {
      return;
    }

    if (event.data.type === "input") {
      roomManager.move(roomCode, userId, event.data.direction);
      return;
    }

    io.to(roomCode).emit("chat_event", {
      from: displayName,
      text: event.data.text,
      at: Date.now(),
    });
  });

  socket.on("start_match", () => {
    roomManager.startMatch(roomCode, userId);
  });

  socket.on("restart_match", () => {
    roomManager.restartMatch(roomCode, userId);
  });

  socket.on("disconnect", () => {
    roomManager.disconnect(roomCode, userId);
  });
});

function shutdown(signal: string): void {
  console.info(
    JSON.stringify({
      level: "info",
      event: "game_server_shutdown",
      signal,
    }),
  );

  roomManager.dispose();

  io.close(() => {
    http.close(() => {
      process.exit(0);
    });
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

http.listen(port, "0.0.0.0", () => {
  console.info(
    JSON.stringify({
      level: "info",
      event: "game_server_listening",
      port,
    }),
  );
});
