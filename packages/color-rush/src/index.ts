import type { Direction, GameDefinition, GamePhase, Player } from "../../protocol/src/index.js";
import { directionSchema } from "../../protocol/src/index.js";
import { z } from "zod";

export const ARENA = 480,
  SPEED = 150,
  DASH_MULT = 2.5,
  DASH_BOOST_MS = 500,
  DASH_COOLDOWN_MS = 3_000,
  COLLECT_DISTANCE = 22,
  ORB_COUNT = 8,
  MATCH_MS = 60_000,
  MIN_PLAYERS = 2,
  MAX_PLAYERS = 6;

export type RushPlayer = {
  id: string;
  name: string;
  x: number;
  y: number;
  color: string;
  score: number;
  spectator: boolean;
  ready: boolean;
  /** Remaining dash-boost time; movement speed is multiplied while above zero. */
  dashMs: number;
  /** Remaining dash cooldown; dashing is only allowed at zero. */
  cooldownMs: number;
};
export type Orb = {
  id: string;
  x: number;
  y: number;
  color: string;
  collected: boolean;
};
export type State = {
  phase: GamePhase;
  remainingMs: number;
  players: Record<string, RushPlayer>;
  orbs: Record<string, Orb>;
};
export type RushView = {
  players: Array<{ id: string; x: number; y: number; color: string; dashing: boolean }>;
  orbs: Array<{ id: string; x: number; y: number; color: string }>;
};

/** Strict per-game input: the platform only validates the generic envelope;
 * this schema owns the rest. */
export const colorRushInputSchema = z.discriminatedUnion("op", [
  z.object({
    type: z.literal("input"),
    seq: z.number().int().nonnegative(),
    op: z.literal("move"),
    direction: directionSchema,
  }),
  z.object({
    type: z.literal("input"),
    seq: z.number().int().nonnegative(),
    op: z.literal("dash"),
  }),
]);
export type RushInput = z.infer<typeof colorRushInputSchema>;

const colors = [
  "#f97316",
  "#22d3ee",
  "#a78bfa",
  "#4ade80",
  "#f472b6",
  "#facc15",
];
const orbColors = ["#e879f9", "#38bdf8", "#fb923c", "#34d399"];

/** Deterministic orb lattice: no randomness so matches are reproducible. */
function createOrbs(): Record<string, Orb> {
  const orbs: Record<string, Orb> = {};
  for (let i = 0; i < ORB_COUNT; i++) {
    orbs[`orb-${i}`] = {
      id: `orb-${i}`,
      x: 80 + (i % 4) * 105,
      y: i < 4 ? 140 : 340,
      color: orbColors[i % orbColors.length],
      collected: false,
    };
  }
  return orbs;
}

export const initialState = (matchMs: number = MATCH_MS): State => ({
  phase: "waiting",
  remainingMs: matchMs,
  players: {},
  orbs: createOrbs(),
});

export function addPlayer(
  s: State,
  id: string,
  name: string,
  spectator: boolean,
  ready?: boolean,
): State {
  const existing = s.players[id];
  if (existing)
    return {
      ...s,
      players: {
        ...s.players,
        [id]: {
          ...existing,
          name,
          spectator,
          ready: ready ?? existing.ready,
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
        x: 60 + n * 60,
        y: 240,
        color: colors[n % colors.length],
        score: 0,
        dashMs: 0,
        cooldownMs: 0,
      },
    },
  };
}

export function removePlayer(s: State, id: string): State {
  if (!s.players[id]) return s;
  const { [id]: _removed, ...remainingPlayers } = s.players;
  return { ...s, players: remainingPlayers };
}

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

export function setSpectator(s: State, id: string, spectator: boolean): State {
  const player = s.players[id];
  if (!player || player.spectator === spectator) return s;
  return {
    ...s,
    players: { ...s.players, [id]: { ...player, spectator } },
  };
}

/** Same deterministic startup rule as the platform default. */
export function canStartMatch(s: State): boolean {
  const participants = Object.values(s.players).filter((p) => !p.spectator);
  return (
    participants.length >= MIN_PLAYERS && participants.every((p) => p.ready)
  );
}

export function dash(s: State, id: string): State {
  const player = s.players[id];
  if (
    s.phase !== "running" ||
    !player ||
    player.spectator ||
    player.cooldownMs > 0
  )
    return s;
  return {
    ...s,
    players: {
      ...s.players,
      [id]: {
        ...player,
        dashMs: DASH_BOOST_MS,
        cooldownMs: DASH_COOLDOWN_MS,
      },
    },
  };
}

export function move(s: State, id: string, d: Direction, dt: number): State {
  const player = s.players[id];
  if (s.phase !== "running" || !player || player.spectator) return s;
  const speed = SPEED * (player.dashMs > 0 ? DASH_MULT : 1);
  let x = player.x,
    y = player.y;
  if (d === "up") y -= speed * dt;
  if (d === "down") y += speed * dt;
  if (d === "left") x -= speed * dt;
  if (d === "right") x += speed * dt;
  return {
    ...s,
    players: {
      ...s.players,
      [id]: {
        ...player,
        x: Math.max(12, Math.min(ARENA - 12, x)),
        y: Math.max(12, Math.min(ARENA - 12, y)),
      },
    },
  };
}

export function tick(s: State, dt: number): State {
  if (s.phase !== "running") return s;
  const players: Record<string, RushPlayer> = {};
  for (const [id, p] of Object.entries(s.players)) {
    players[id] = {
      ...p,
      dashMs: Math.max(0, p.dashMs - dt * 1000),
      cooldownMs: Math.max(0, p.cooldownMs - dt * 1000),
    };
  }
  const next: State = {
    ...s,
    players,
    remainingMs: Math.max(0, s.remainingMs - dt * 1000),
  };
  // Collection is server-derived: walking within range of an uncollected
  // orb scores. Input never asserts a collection.
  for (const orb of Object.values(next.orbs)) {
    if (orb.collected) continue;
    const collector = Object.values(next.players).find(
      (p) =>
        !p.spectator && Math.hypot(p.x - orb.x, p.y - orb.y) <= COLLECT_DISTANCE,
    );
    if (collector) {
      next.orbs = {
        ...next.orbs,
        [orb.id]: { ...orb, collected: true },
      };
      next.players = {
        ...next.players,
        [collector.id]: {
          ...next.players[collector.id],
          score: next.players[collector.id].score + 1,
        },
      };
    }
  }
  if (next.remainingMs === 0) next.phase = "completed";
  return next;
}

export const roster = (s: State): Player[] =>
  Object.values(s.players).map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score,
    spectator: p.spectator,
    ready: p.ready,
  }));

export const view = (s: State): RushView => ({
  players: Object.values(s.players).map((p) => ({
    id: p.id,
    x: p.x,
    y: p.y,
    color: p.color,
    dashing: p.dashMs > 0,
  })),
  orbs: Object.values(s.orbs)
    .filter((o) => !o.collected)
    .map((o) => ({ id: o.id, x: o.x, y: o.y, color: o.color })),
});

export const colorRushGame: GameDefinition<State, RushInput> = {
  metadata: {
    id: "color-rush",
    name: "Color Rush",
    description: "Collect orbs before time expires; dash to beat rivals to them.",
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
  },
  inputSchema: colorRushInputSchema,
  createState: (matchMs) => initialState(matchMs),
  addPlayer: (s, p) => addPlayer(s, p.userId, p.displayName, p.spectator, p.ready),
  removePlayer: (s, userId) => removePlayer(s, userId),
  setReady: (s, userId, ready) => setReady(s, userId, ready),
  setSpectator: (s, userId, spectator) => setSpectator(s, userId, spectator),
  canStartMatch: (s) => canStartMatch(s),
  applyInput: (s, userId, input, dtSeconds) =>
    input.op === "dash"
      ? dash(s, userId)
      : move(s, userId, input.direction, dtSeconds),
  tick: (s, dtSeconds) => tick(s, dtSeconds),
  roster: (s) => roster(s),
  view: (s) => view(s),
  getResults: (s) =>
    Object.values(s.players)
      .filter((p) => !p.spectator)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        spectator: false,
        ready: p.ready,
      })),
};
