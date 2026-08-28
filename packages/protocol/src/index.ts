import { z } from "zod";

/**
 * Wire-protocol version. Clients present it in their Socket.IO handshake;
 * the game server rejects mismatched clients so old builds fail fast
 * instead of misinterpreting snapshots.
 *
 * v2: snapshots became game-agnostic (game id + generic roster + a
 * game-specific `view` payload instead of tag-only fields).
 */
export const PROTOCOL_VERSION = 2;

/**
 * Game contract. A game package implements GameDefinition with pure
 * functions over its own state; the platform (RoomManager) drives the
 * lifecycle, transport, and persistence around it without knowing the
 * game's rules.
 */
export type GamePhase = "waiting" | "running" | "completed";

/** Lifecycle + timer fields every game state must expose. */
export type AnyGameState = {
  phase: GamePhase;
  remainingMs: number;
};

export type GameMetadata = {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
};

/** Generic roster row: everything the shared room UI (lobby chrome,
 * scoreboard, results) needs. Game-specific render data lives in the
 * snapshot's `view` payload, not here. */
export type Player = {
  id: string;
  name: string;
  score: number;
  spectator: boolean;
  ready: boolean;
};

export type GameDefinitionPlayer = {
  userId: string;
  displayName: string;
  spectator: boolean;
  /** Restored from durable membership when a player reconnects. */
  ready?: boolean;
};

export type GameDefinition<
  S extends AnyGameState = AnyGameState,
  I = unknown,
> = {
  metadata: GameMetadata;
  /** Strict schema for the game-specific input payload. The platform
   * validates the generic event envelope; the game validates the rest. */
  inputSchema: z.ZodType<I>;
  createState(matchMs: number): S;
  addPlayer(state: S, player: GameDefinitionPlayer): S;
  removePlayer(state: S, userId: string): S;
  setReady(state: S, userId: string, ready: boolean): S;
  setSpectator(state: S, userId: string, spectator: boolean): S;
  canStartMatch(state: S): boolean;
  applyInput(state: S, userId: string, input: I, dtSeconds: number): S;
  tick(state: S, dtSeconds: number): S;
  /** Generic roster rows (players + spectators) for the shared snapshot. */
  roster(state: S): Player[];
  /** Game-specific render payload carried as the snapshot's `view`. */
  view(state: S): unknown;
  /** Sorted, player-safe result rows (non-spectators only). */
  getResults(state: S): Player[];
};

/** Game definition with its concrete state/input types erased for storage
 * in the registry and RoomManager. */
export type AnyGameDefinition = GameDefinition<AnyGameState, unknown>;

export const directionSchema = z.enum(["up", "down", "left", "right"]);
export const tagInputSchema = z.object({
  type: z.literal("input"),
  seq: z.number().int().nonnegative(),
  direction: directionSchema,
});
export type TagInput = z.infer<typeof tagInputSchema>;

/**
 * Generic client-event envelope. `input` payloads are only shape-gated
 * here (must carry a type and seq); the room's game validates the full
 * payload through its own strict inputSchema.
 */
export const inputEnvelopeSchema = z
  .object({
    type: z.literal("input"),
    seq: z.number().int().nonnegative(),
  })
  .passthrough();
export const chatSchema = z.object({
  type: z.literal("chat"),
  text: z.string().trim().min(1).max(500),
});
export const readySchema = z.object({
  type: z.literal("ready"),
  ready: z.boolean(),
});
export const clientEventSchema = z.union([
  inputEnvelopeSchema,
  chatSchema,
  readySchema,
]);
export type ClientEvent = z.infer<typeof clientEventSchema>;
export type Direction = z.infer<typeof directionSchema>;

export type Snapshot = {
  type: "snapshot";
  roomCode: string;
  /** Registry id of the game hosting this room. */
  game: string;
  phase: GamePhase;
  remainingMs: number;
  /** Generic roster: scoreboard, readiness, spectators. */
  players: Player[];
  /** Game-specific render payload, typed per game on the client. */
  view?: unknown;
  /** Present once the match is completed; sorted by score. */
  results?: Player[];
};
