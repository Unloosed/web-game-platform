import type { Direction, GameDefinition, GamePhase, Player } from "../../protocol/src/index.js";
import { tagInputSchema, type TagInput } from "../../protocol/src/index.js";

export const ARENA = 400,
  SPEED = 150,
  MATCH_MS = 60_000,
  TAG_DISTANCE = 26,
  MIN_PLAYERS = 2,
  MAX_PLAYERS = 8;
export type TagPlayer = {
  id: string;
  name: string;
  x: number;
  y: number;
  color: string;
  tags: number;
  spectator: boolean;
  ready: boolean;
};
export type State = {
  players: Record<string, TagPlayer>;
  itPlayerId: string | null;
  remainingMs: number;
  phase: GamePhase;
};
/** Game-specific render payload carried in the snapshot `view` field. */
export type TagView = {
  players: Array<{ id: string; x: number; y: number; color: string }>;
  itPlayerId: string | null;
};
const colors = [
  "#38bdf8",
  "#fb7185",
  "#a3e635",
  "#fbbf24",
  "#c084fc",
  "#2dd4bf",
];
export const initialState = (matchMs: number = MATCH_MS): State => ({
  players: {},
  itPlayerId: null,
  remainingMs: matchMs,
  phase: "waiting",
});
export function addPlayer(
  s: State,
  id: string,
  name: string,
  spectator: boolean,
  ready?: boolean,
): State {
  if (s.players[id])
    return {
      ...s,
      players: {
        ...s.players,
        [id]: {
          ...s.players[id],
          name,
          spectator,
          ready: ready ?? s.players[id].ready,
        },
      },
    };
  const n = Object.keys(s.players).length;
  return {
    ...s,
    players: {
      ...s.players,
      [id]: {
        id,
        name,
        spectator,
        ready: ready ?? false,
        x: 60 + (n % 4) * 85,
        y: 60 + Math.floor(n / 4) * 85,
        color: colors[n % colors.length],
        tags: 0,
      },
    },
  };
}
/** Removes a player and releases the IT role if they held it. */
export function removePlayer(s: State, id: string): State {
  if (!s.players[id]) return s;
  const { [id]: _removed, ...remainingPlayers } = s.players;
  return {
    ...s,
    players: remainingPlayers,
    itPlayerId: s.itPlayerId === id ? null : s.itPlayerId,
  };
}
/** Explicitly toggles a non-spectator player's readiness outside a live match. */
export function setReady(s: State, id: string, ready: boolean): State {
  const player = s.players[id];
  if (
    s.phase === "running" ||
    !player ||
    player.spectator ||
    player.ready === ready
  )
    return s;
  return {
    ...s,
    players: { ...s.players, [id]: { ...player, ready } },
  };
}

/**
 * Server-authorized spectator role change for a live participant.
 * A spectator leaving play releases the IT role immediately.
 */
export function setSpectator(s: State, id: string, spectator: boolean): State {
  const player = s.players[id];
  if (!player || player.spectator === spectator) return s;

  const next: State = {
    ...s,
    players: { ...s.players, [id]: { ...player, spectator } },
    itPlayerId: s.itPlayerId === id && spectator ? null : s.itPlayerId,
  };

  if (
    next.phase === "running" &&
    (!next.itPlayerId || !next.players[next.itPlayerId])
  ) {
    const replacement = Object.values(next.players).find((p) => !p.spectator);
    next.itPlayerId = replacement?.id ?? null;
  }

  return next;
}
/**
 * Deterministic startup rule shared by first start and rematch:
 * enough non-spectator players, and every one of them explicitly ready.
 */
export function canStartMatch(s: State): boolean {
  const participants = Object.values(s.players).filter((p) => !p.spectator);
  return (
    participants.length >= MIN_PLAYERS && participants.every((p) => p.ready)
  );
}
export function move(s: State, id: string, d: Direction, dt: number): State {
  if (
    s.phase !== "running" ||
    !s.players[id] ||
    s.players[id].spectator
  )
    return s;
  let x = s.players[id].x,
    y = s.players[id].y;
  if (d === "up") y -= SPEED * dt;
  if (d === "down") y += SPEED * dt;
  if (d === "left") x -= SPEED * dt;
  if (d === "right") x += SPEED * dt;
  return {
    ...s,
    players: {
      ...s.players,
      [id]: {
        ...s.players[id],
        x: Math.max(12, Math.min(ARENA - 12, x)),
        y: Math.max(12, Math.min(ARENA - 12, y)),
      },
    },
  };
}
export function tick(s: State, dt: number): State {
  if (s.phase !== "running") return s;
  let n = {
    ...s,
    players: { ...s.players },
    remainingMs: Math.max(0, s.remainingMs - dt * 1000),
  };
  if (!n.itPlayerId || n.players[n.itPlayerId]?.spectator) {
    const p = Object.values(n.players).find((x) => !x.spectator);
    n.itPlayerId = p?.id ?? null;
  }
  const it = n.itPlayerId && n.players[n.itPlayerId];
  if (it) {
    for (const p of Object.values(n.players)) {
      if (
        p.id !== it.id &&
        !p.spectator &&
        Math.hypot(p.x - it.x, p.y - it.y) <= TAG_DISTANCE
      ) {
        n.players[it.id] = { ...it, tags: it.tags + 1 };
        n.itPlayerId = p.id;
        break;
      }
    }
  }
  if (n.remainingMs === 0) n.phase = "completed";
  return n;
}
export const results = (s: State) =>
  Object.values(s.players)
    .filter((p) => !p.spectator)
    .sort((a, b) => b.tags - a.tags || a.id.localeCompare(b.id));

/** Generic roster rows for the shared snapshot/scoreboard envelope. */
export const roster = (s: State): Player[] =>
  Object.values(s.players).map((p) => ({
    id: p.id,
    name: p.name,
    score: p.tags,
    spectator: p.spectator,
    ready: p.ready,
  }));

export const view = (s: State): TagView => ({
  players: Object.values(s.players).map((p) => ({
    id: p.id,
    x: p.x,
    y: p.y,
    color: p.color,
  })),
  itPlayerId: s.itPlayerId,
});

/** The registry-facing definition binding the pure rules to the platform contract. */
export const sampleTagGame: GameDefinition<State, TagInput> = {
  metadata: {
    id: "sample-tag",
    name: "Tag Arena",
    description: "Server-authoritative tag: chase, tag, and dodge for points.",
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
  },
  inputSchema: tagInputSchema,
  createState: (matchMs) => initialState(matchMs),
  addPlayer: (s, p) => addPlayer(s, p.userId, p.displayName, p.spectator, p.ready),
  removePlayer: (s, userId) => removePlayer(s, userId),
  setReady: (s, userId, ready) => setReady(s, userId, ready),
  setSpectator: (s, userId, spectator) => setSpectator(s, userId, spectator),
  canStartMatch: (s) => canStartMatch(s),
  applyInput: (s, userId, input, dtSeconds) => move(s, userId, input.direction, dtSeconds),
  tick: (s, dtSeconds) => tick(s, dtSeconds),
  roster: (s) => roster(s),
  view: (s) => view(s),
  getResults: (s) =>
    results(s).map((p) => ({
      id: p.id,
      name: p.name,
      score: p.tags,
      spectator: false,
      ready: p.ready,
    })),
};
