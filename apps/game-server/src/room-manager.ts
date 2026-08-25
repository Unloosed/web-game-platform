import {
  addPlayer,
  canStartMatch,
  initialState,
  move,
  results,
  setReady as applyReady,
  setSpectator as applySpectator,
  tick,
  type State,
} from "../../../packages/sample-game/src/index.js";
import type { Snapshot } from "../../../packages/protocol/src/index.js";

export type RoomPhase = "waiting" | "running" | "completed";

export type RoomLifecycleApi = {
  markRunning(roomCode: string): Promise<void>;
  persistCompletion(
    roomCode: string,
    input: {
      winnerUserId: string | null;
      results: Array<{ id: string; tags: number }>;
    },
  ): Promise<void>;
  deleteAbandonedWaitingRoom(roomCode: string): Promise<void>;
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
  state: State;
  hostUserId: string | null;
  connectedSocketIdsByUser: Map<string, string>;
  timer: ReturnType<typeof setInterval>;
};

export type RoomManagerOptions = {
  reconnectGraceMs: number;
  tickMs?: number;
  matchMs?: number;
  onBroadcast(roomCode: string, snapshot: Snapshot): void;
  onLifecycleFailure?(operation: string, error: unknown): void;
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
    this.matchMs = options.matchMs ?? initialState().remainingMs;
  }

  connect(roomCode: string, connection: PlayerConnection): Snapshot {
    const room = this.getOrCreateRoom(roomCode);

    this.cancelPendingRemoval(roomCode, connection.userId);

    room.connectedSocketIdsByUser.set(connection.userId, connection.socketId);
    room.state = addPlayer(
      room.state,
      connection.userId,
      connection.displayName,
      connection.spectator,
      connection.ready,
    );

    if (connection.host) {
      room.hostUserId = connection.userId;
    }

    return this.broadcast(roomCode);
  }

  disconnect(roomCode: string, userId: string): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    room.connectedSocketIdsByUser.delete(userId);

    const key = this.removalKey(roomCode, userId);
    const timer = setTimeout(() => {
      this.pendingRemoval.delete(key);

      const current = this.rooms.get(roomCode);
      if (!current || current.connectedSocketIdsByUser.has(userId)) {
        return;
      }

      const { [userId]: _removed, ...remainingPlayers } = current.state.players;

      current.state = {
        ...current.state,
        players: remainingPlayers,
        itPlayerId:
          current.state.itPlayerId === userId ? null : current.state.itPlayerId,
      };

      if (Object.keys(current.state.players).length === 0) {
        clearInterval(current.timer);
        this.rooms.delete(roomCode);

        if (current.state.phase === "waiting") {
          void this.options.api
            .deleteAbandonedWaitingRoom(roomCode)
            .catch((error) => {
              this.options.onLifecycleFailure?.(
                "delete_abandoned_waiting_room",
                error,
              );
            });
        }

        return;
      }

      this.broadcast(roomCode);
    }, this.options.reconnectGraceMs);

    this.pendingRemoval.set(key, timer);
  }

  move(
    roomCode: string,
    userId: string,
    direction: "up" | "down" | "left" | "right",
  ): Snapshot | null {
    const room = this.rooms.get(roomCode);
    if (!room) return null;

    room.state = move(room.state, userId, direction, 1 / 20);
    return this.broadcast(roomCode);
  }

  startMatch(roomCode: string, userId: string): boolean {
    const room = this.rooms.get(roomCode);
    if (!room) return false;
    if (room.hostUserId !== userId || room.state.phase !== "waiting") {
      return false;
    }
    if (!canStartMatch(room.state)) {
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
    if (!canStartMatch(room.state)) {
      return false;
    }

    this.resetForMatch(roomCode, room);
    return true;
  }

  /** Explicit ready/unready toggle; rejected for spectators and mid-match. */
  setReady(roomCode: string, userId: string, ready: boolean): Snapshot | null {
    const room = this.rooms.get(roomCode);
    if (!room) return null;

    const previous = room.state.players[userId]?.ready ?? false;
    room.state = applyReady(room.state, userId, ready);

    if (room.state.players[userId]?.ready !== previous) {
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
    if (!room || !room.state.players[userId]) return false;

    room.state = applySpectator(room.state, userId, spectator);
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

  /** Immediately remove a player (moderation kick) without grace period. */
  kick(roomCode: string, userId: string): boolean {
    const room = this.rooms.get(roomCode);
    if (!room || !room.state.players[userId]) return false;

    this.cancelPendingRemoval(roomCode, userId);
    room.connectedSocketIdsByUser.delete(userId);
    const { [userId]: _removed, ...remainingPlayers } = room.state.players;
    room.state = {
      ...room.state,
      players: remainingPlayers,
      itPlayerId: room.state.itPlayerId === userId ? null : room.state.itPlayerId,
    };

    if (Object.keys(remainingPlayers).length === 0) {
      clearInterval(room.timer);
      this.rooms.delete(roomCode);
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

  private getOrCreateRoom(roomCode: string): RoomInstance {
    const existing = this.rooms.get(roomCode);
    if (existing) return existing;

    const room: RoomInstance = {
      state: initialState(this.matchMs),
      hostUserId: null,
      connectedSocketIdsByUser: new Map(),
      timer: setInterval(() => {
        const current = this.rooms.get(roomCode);
        if (!current) return;

        const previousPhase = current.state.phase;
        current.state = tick(current.state, this.tickMs / 1000);

        if (
          previousPhase !== "completed" &&
          current.state.phase === "completed"
        ) {
          const finalResults = results(current.state);

          void this.options.api
            .persistCompletion(roomCode, {
              winnerUserId: finalResults[0]?.id ?? null,
              results: finalResults.map((player) => ({
                id: player.id,
                tags: player.tags,
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
      }, this.tickMs),
    };

    this.rooms.set(roomCode, room);
    return room;
  }

  private resetForMatch(roomCode: string, room: RoomInstance): void {
    const priorPlayers = Object.values(room.state.players);

    room.state = initialState(this.matchMs);

    for (const player of priorPlayers) {
      room.state = addPlayer(
        room.state,
        player.id,
        player.name,
        player.spectator,
        player.ready,
      );
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
    return {
      type: "snapshot",
      roomCode,
      phase: room.state.phase,
      remainingMs: room.state.remainingMs,
      itPlayerId: room.state.itPlayerId,
      players: Object.values(room.state.players),
      ...(room.state.phase === "completed"
        ? { results: results(room.state) }
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
