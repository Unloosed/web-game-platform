import { createServer } from "node:http";
import { Server } from "socket.io";
import { z } from "zod";
import {
  clientEventSchema,
  type Snapshot,
} from "../../../packages/protocol/src/index.js";
import {
  addPlayer,
  initialState,
  move,
  results,
  tick,
  type State,
} from "../../../packages/sample-game/src/index.js";

const port = z.coerce.number().default(4100).parse(process.env.GAME_PORT);
const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const reconnectGraceMs = Number(process.env.ROOM_RECONNECT_GRACE_MS ?? 15_000);
const apiUrl = process.env.API_URL ?? "http://localhost:4000";
const gameServerSecret = z
  .string()
  .min(32, "GAME_SERVER_SECRET must be at least 32 characters")
  .parse(process.env.GAME_SERVER_SECRET);

type RoomInstance = {
  state: State;
  timer: NodeJS.Timeout;
  hostUserId: string | null;
  connectedSocketIdsByUser: Map<string, string>;
};

const rooms = new Map<string, RoomInstance>();
const pendingRemoval = new Map<string, NodeJS.Timeout>();

function removalKey(roomCode: string, userId: string): string {
  return `${roomCode}:${userId}`;
}

function cancelPendingRemoval(roomCode: string, userId: string): void {
  const key = removalKey(roomCode, userId);
  const timer = pendingRemoval.get(key);
  if (timer) {
    clearTimeout(timer);
    pendingRemoval.delete(key);
  }
}

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

function deletePersistentRoom(roomCode: string): Promise<void> {
  return gameApi(`/internal/rooms/${encodeURIComponent(roomCode)}`, {
    method: "DELETE",
  });
}

const http = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"ok"}');
  } else {
    res.writeHead(404);
    res.end();
  }
});

const io = new Server(http, {
  cors: {
    origin: corsOrigin,
    credentials: true,
  },
});

function getRoom(code: string): RoomInstance {
  let room = rooms.get(code);
  if (!room) {
    room = {
      state: initialState(),
      hostUserId: null,
      connectedSocketIdsByUser: new Map(),
      timer: setInterval(() => {
        const current = rooms.get(code);
        if (!current) return;
        const previousPhase = current.state.phase;
        current.state = tick(current.state, 0.05);

        if (
          previousPhase !== "completed" &&
          current.state.phase === "completed"
        ) {
          const finalResults = results(current.state);
          void gameApi(
            `/internal/rooms/${encodeURIComponent(code)}/lifecycle`,
            {
              method: "POST",
              body: JSON.stringify({
                status: "completed",
                winnerUserId: finalResults[0]?.id ?? null,
                results: finalResults.map((player) => ({
                  id: player.id,
                  tags: player.tags,
                })),
              }),
            },
          ).catch((error) =>
            reportLifecycleFailure("persist_match_completion", error),
          );
        }

        broadcast(code);
      }, 50),
    };
    rooms.set(code, room);
  }
  return room;
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

function resetForMatch(roomCode: string, room: RoomInstance): void {
  const priorPlayers = Object.values(room.state.players);
  room.state = initialState();

  for (const player of priorPlayers) {
    room.state = addPlayer(
      room.state,
      player.id,
      player.name,
      player.spectator,
    );
  }

  room.state.phase = "running";

  void gameApi(`/internal/rooms/${encodeURIComponent(roomCode)}/lifecycle`, {
    method: "POST",
    body: JSON.stringify({ status: "running" }),
  }).catch((error) => reportLifecycleFailure("mark_room_running", error));
}

function broadcast(code: string): void {
  const room = rooms.get(code);
  if (!room) return;

  const snap: Snapshot = {
    type: "snapshot",
    roomCode: code,
    phase: room.state.phase,
    remainingMs: room.state.remainingMs,
    itPlayerId: room.state.itPlayerId,
    players: Object.values(room.state.players),
    ...(room.state.phase === "completed"
      ? { results: results(room.state) }
      : {}),
  };

  io.to(code).emit("server_event", snap);
}

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
  const room = getRoom(roomCode);

  socket.join(roomCode);

  cancelPendingRemoval(roomCode, userId);

  room.connectedSocketIdsByUser.set(userId, socket.id);
  room.state = addPlayer(room.state, userId, displayName, spectator === "true");

  if (host === "true") {
    room.hostUserId = userId;
  }

  socket.on("client_event", (raw: unknown) => {
    const event = clientEventSchema.safeParse(raw);
    if (!event.success) return;

    if (event.data.type === "input") {
      room.state = move(room.state, userId, event.data.direction, 1 / 20);
    } else {
      io.to(roomCode).emit("chat_event", {
        from: displayName,
        text: event.data.text,
        at: Date.now(),
      });
    }
  });

  socket.on("start_match", () => {
    if (userId !== room.hostUserId || room.state.phase !== "waiting") return;

    resetForMatch(roomCode, room);
    broadcast(roomCode);
  });

  socket.on("restart_match", () => {
    if (userId !== room.hostUserId || room.state.phase !== "completed") return;

    resetForMatch(roomCode, room);
    broadcast(roomCode);
  });

  socket.on("disconnect", () => {
    const active = rooms.get(roomCode);
    if (!active) return;

    active.connectedSocketIdsByUser.delete(userId);
    const key = removalKey(roomCode, userId);

    const timer = setTimeout(() => {
      pendingRemoval.delete(key);
      const current = rooms.get(roomCode);
      if (!current || current.connectedSocketIdsByUser.has(userId)) return;

      const { [userId]: removed, ...remainingPlayers } = current.state.players;
      current.state = {
        ...current.state,
        players: remainingPlayers,
        itPlayerId:
          current.state.itPlayerId === userId ? null : current.state.itPlayerId,
      };

      if (Object.keys(current.state.players).length === 0) {
        clearInterval(current.timer);
        rooms.delete(roomCode);
        void deletePersistentRoom(roomCode).catch((error) =>
          reportLifecycleFailure("delete_empty_room", error),
        );
        return;
      }

      broadcast(roomCode);
    }, reconnectGraceMs);

    pendingRemoval.set(key, timer);
  });

  broadcast(roomCode);
});

http.listen(port, "0.0.0.0");
