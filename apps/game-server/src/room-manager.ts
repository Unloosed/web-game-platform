import { DEFAULT_GAME_ID, getGame } from "../../../packages/game-registry/src/index.js";
import type {
  AnyGameDefinition,
  AnyGameState,
  Snapshot,
} from "../../../packages/protocol/src/index.js";

export type RoomPhase = "waiting" | "running" | "completed";

export type RoomLifecycleApi = {
  markRunning(roomCode: string): Promise<void>;
  persistCompletion(
    roomCode: string,
    input: {
      winnerUserId: string | null;
      results: Array<{ userId: string; score: number }>;
    },
  ): Promise<void>;
  deleteAbandonedWaitingRoom(roomCode: string): Promise<void>;
  /** Archives a running room abandoned by all of its players. */
  archiveAbandonedRoom(roomCode: string): Promise<void>;
  persistReady(
    roomCode: string,
    userId: string,
    ready: boolean,
  ): Promise<void>;
};

export type PlayerConnection = {
  userId: string;
  displayName: string;
  spectator: boolean;
  host: boolean;
  socketId: string;
  /** Restored from durable membership when a player reconnects. */
  ready?: boolean;
};

type RoomInstance = {
  /** Resolved from the room's persisted game id, not from any client. */
  game: AnyGameDefinition;
  state: AnyGameState;
  hostUserId: string | null;
  /** Live socket ids per user; a user may hold several (multi-tab). */
  connectedSocketIdsByUser: Map<string, Set<string>>;
  timer: ReturnType<typeof setInterval>;
};

export type RoomManagerOptions = {
  reconnectGraceMs: number;
  tickMs?: number;
  matchMs?: number;
  onBroadcast(roomCode: string, snapshot: Snapshot): void;
  onLifecycleFailure?(operation: string, error: unknown): void;
  /** Observed wall-clock cost of one simulation tick, for latency metrics. */
  onTickSample?(tickDurationMs: number): void;
  api: RoomLifecycleApi;
};

export class RoomManager {
  private readonly rooms = new Map<string, RoomInstance>();
  private readonly pendingRemoval = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly tickMs: number;
  private readonly matchMs: number;

  constructor(private readonly options: RoomManagerOptions) {
    this.tickMs = options.tickMs ?? 50;
    this.matchMs = options.matchMs ?? 60_000;
  }

  connect(
    roomCode: string,
    connection: PlayerConnection,
    gameId: string = DEFAULT_GAME_ID,
  ): Snapshot {
    const room = this.getOrCreateRoom(roomCode, gameId);

    this.cancelPendingRemoval(roomCode, connection.userId);

    const sockets = room.connectedSocketIdsByUser.get(connection.userId);
    if (sockets) {
      sockets.add(connection.socketId);
    } else {
      room.connectedSocketIdsByUser.set(
        connection.userId,
        new Set([connection.socketId]),
      );
    }
    room.state = room.game.addPlayer(room.state, {
      userId: connection.userId,
      displayName: connection.displayName,
      spectator: connection.spectator,
      ready: connection.ready,
    });

    if (connection.host) {
      room.hostUserId = connection.userId;
    }

    return this.broadcast(roomCode);
  }

  disconnect(roomCode: string, userId: string, socketId?: string): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    const sockets = room.connectedSocketIdsByUser.get(userId);
    if (sockets) {
      if (socketId === undefined) {
        room.connectedSocketIdsByUser.delete(userId);
      } else {
        sockets.delete(socketId);
        // One of several live sockets (multi-tab) went away; the player only
        // enters reconnect grace once their last socket disconnects.
        if (sockets.size > 0) return;
        room.connectedSocketIdsByUser.delete(userId);
      }
    }

    const key = this.removalKey(roomCode, userId);
    const timer = setTimeout(() => {
      this.pendingRemoval.delete(key);

      const current = this.rooms.get(roomCode);
      if (!current || current.connectedSocketIdsByUser.has(userId)) {
        return;
      }

      current.state = current.game.removePlayer(current.state, userId);

      if (current.game.roster(current.state).length === 0) {
        this.discardRoom(roomCode, current);
        return;
      }

      this.broadcast(roomCode);
    }, this.options.reconnectGraceMs);

    this.pendingRemoval.set(key, timer);
  }

  /**
   * Validates and applies a game-specific input. The generic envelope was
   * already checked by the transport; the room's game owns the payload
   * schema. Returns null when the room or input is invalid.
   */
  input(
    roomCode: string,
    userId: string,
    raw: unknown,
  ): Snapshot | null {
    const room = this.rooms.get(roomCode);
    if (!room) return null;

    const parsed = room.game.inputSchema.safeParse(raw);
    if (!parsed.success) return null;

    room.state = room.game.applyInput(
      room.state,
      userId,
      parsed.data,
      this.tickMs / 1000,
    );
    return this.broadcast(roomCode);
  }

  startMatch(roomCode: string, userId: string): boolean {
    const room = this.rooms.get(roomCode);
    if (!room) return false;
    if (room.hostUserId !== userId || room.state.phase !== "waiting") {
      return false;
    }
    if (!room.game.canStartMatch(room.state)) {
      return false;
    }

    this.resetForMatch(roomCode, room);
    return true;
  }

  restartMatch(roomCode: string, userId: string): boolean {
    const room = this.rooms.get(roomCode);
    if (!room) return false;
    if (room.hostUserId !== userId || room.state.phase !== "completed") {
      return false;
    }
    if (!room.game.canStartMatch(room.state)) {
      return false;
    }

    this.resetForMatch(roomCode, room);
    return true;
  }

  /** Explicit ready/unready toggle; rejected for spectators and mid-match. */
  setReady(roomCode: string, userId: string, ready: boolean): Snapshot | null {
    const room = this.rooms.get(roomCode);
    if (!room) return null;

    const previous =
      room.game
        .roster(room.state)
        .find((p) => p.id === userId)?.ready ?? false;
    room.state = room.game.setReady(room.state, userId, ready);

    if (
      room.game
        .roster(room.state)
        .find((p) => p.id === userId)?.ready !== previous
    ) {
      void this.options.api
        .persistReady(roomCode, userId, ready)
        .catch((error) => {
          this.options.onLifecycleFailure?.("persist_ready_state", error);
        });
      return this.broadcast(roomCode);
    }

    return this.snapshot(roomCode, room);
  }

  /** Server-authorized spectator role change for a live participant. */
  setSpectator(roomCode: string, userId: string, spectator: boolean): boolean {
    const room = this.rooms.get(roomCode);
    if (
      !room ||
      !room.game.roster(room.state).some((p) => p.id === userId)
    ) {
      return false;
    }

    room.state = room.game.setSpectator(room.state, userId, spectator);
    this.broadcast(roomCode);
    return true;
  }

  getSnapshot(roomCode: string): Snapshot | null {
    const room = this.rooms.get(roomCode);
    return room ? this.snapshot(roomCode, room) : null;
  }

  hasRoom(roomCode: string): boolean {
    return this.rooms.has(roomCode);
  }

  roomCount(): number {
    return this.rooms.size;
  }

  /** Rooms whose authoritative simulation is currently mid-match. */
  activeMatchCount(): number {
    let count = 0;
    for (const room of this.rooms.values()) {
      if (room.state.phase === "running") count += 1;
    }
    return count;
  }

  /** Immediately remove a player (moderation kick) without grace period. */
  kick(roomCode: string, userId: string): boolean {
    const room = this.rooms.get(roomCode);
    if (
      !room ||
      !room.game.roster(room.state).some((p) => p.id === userId)
    ) {
      return false;
    }

    this.cancelPendingRemoval(roomCode, userId);
    room.connectedSocketIdsByUser.delete(userId);
    room.state = room.game.removePlayer(room.state, userId);

    if (room.game.roster(room.state).length === 0) {
      this.discardRoom(roomCode, room);
      return true;
    }

    this.broadcast(roomCode);
    return true;
  }

  /** Immediately tear down a room (moderation close), skipping grace. */
  forceClose(roomCode: string): boolean {
    const room = this.rooms.get(roomCode);
    if (!room) return false;

    clearInterval(room.timer);
    this.rooms.delete(roomCode);
    return true;
  }

  dispose(): void {
    for (const room of this.rooms.values()) {
      clearInterval(room.timer);
    }
    for (const timer of this.pendingRemoval.values()) {
      clearTimeout(timer);
    }
    this.rooms.clear();
    this.pendingRemoval.clear();
  }

  /**
   * Stops the loop and drops the live room. Abandonment is persisted by
   * phase: an empty waiting room is deleted, an abandoned running room is
   * archived (it can never complete without players), a completed room is
   * kept for its durable results.
   */
  private discardRoom(roomCode: string, room: RoomInstance): void {
    clearInterval(room.timer);
    this.rooms.delete(roomCode);

    if (room.state.phase === "waiting") {
      void this.options.api
        .deleteAbandonedWaitingRoom(roomCode)
        .catch((error) => {
          this.options.onLifecycleFailure?.(
            "delete_abandoned_waiting_room",
            error,
          );
        });
    } else if (room.state.phase === "running") {
      void this.options.api.archiveAbandonedRoom(roomCode).catch((error) => {
        this.options.onLifecycleFailure?.(
          "archive_abandoned_running_room",
          error,
        );
      });
    }
  }

  private getOrCreateRoom(
    roomCode: string,
    gameId: string,
  ): RoomInstance {
    const existing = this.rooms.get(roomCode);
    if (existing) return existing;

    const game = getGame(gameId);
    if (!game) {
      throw new Error(`Unknown game for room ${roomCode}: ${gameId}`);
    }

    const room: RoomInstance = {
      game,
      state: game.createState(this.matchMs),
      hostUserId: null,
      connectedSocketIdsByUser: new Map(),
      timer: setInterval(() => {
        const current = this.rooms.get(roomCode);
        if (!current) return;

        const tickStart = performance.now();
        const previousPhase = current.state.phase;
        current.state = current.game.tick(current.state, this.tickMs / 1000);

        if (
          previousPhase !== "completed" &&
          current.state.phase === "completed"
        ) {
          const finalResults = current.game.getResults(current.state);

          void this.options.api
            .persistCompletion(roomCode, {
              winnerUserId: finalResults[0]?.id ?? null,
              results: finalResults.map((row) => ({
                userId: row.id,
                score: row.score,
              })),
            })
            .catch((error) => {
              this.options.onLifecycleFailure?.(
                "persist_match_completion",
                error,
              );
            });
        }

        this.broadcast(roomCode);
        this.options.onTickSample?.(performance.now() - tickStart);
      }, this.tickMs),
    };

    this.rooms.set(roomCode, room);
    return room;
  }

  private resetForMatch(roomCode: string, room: RoomInstance): void {
    const priorPlayers = room.game.roster(room.state);

    room.state = room.game.createState(this.matchMs);

    for (const player of priorPlayers) {
      room.state = room.game.addPlayer(room.state, {
        userId: player.id,
        displayName: player.name,
        spectator: player.spectator,
        ready: player.ready,
      });
    }

    room.state.phase = "running";

    void this.options.api.markRunning(roomCode).catch((error) => {
      this.options.onLifecycleFailure?.("mark_room_running", error);
    });

    this.broadcast(roomCode);
  }

  private broadcast(roomCode: string): Snapshot {
    const room = this.rooms.get(roomCode);
    if (!room) {
      throw new Error(`Cannot broadcast unknown room ${roomCode}`);
    }

    const snapshot = this.snapshot(roomCode, room);
    this.options.onBroadcast(roomCode, snapshot);
    return snapshot;
  }

  private snapshot(roomCode: string, room: RoomInstance): Snapshot {
    const { state, game } = room;
    return {
      type: "snapshot",
      roomCode,
      game: game.metadata.id,
      phase: state.phase,
      remainingMs: state.remainingMs,
      players: game.roster(state),
      view: game.view(state),
      ...(state.phase === "completed"
        ? { results: game.getResults(state) }
        : {}),
    };
  }

  private cancelPendingRemoval(roomCode: string, userId: string): void {
    const key = this.removalKey(roomCode, userId);
    const timer = this.pendingRemoval.get(key);

    if (timer) {
      clearTimeout(timer);
      this.pendingRemoval.delete(key);
    }
  }

  private removalKey(roomCode: string, userId: string): string {
    return `${roomCode}:${userId}`;
  }
}
