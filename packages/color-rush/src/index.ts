import type { Direction, GameDefinition, GamePhase, Player } from "../../protocol/src/index.js";
import { directionSchema } from "../../protocol/src/index.js";
import { z } from "zod";

export const ARENA = 480,
  PLAYER_RADIUS = 12,
  SPEED = 175,
  DASH_MULT = 2.4,
  DASH_BOOST_MS = 450,
  DASH_COOLDOWN_MS = 3_000,
  COLLECT_DISTANCE = 22,
  /** Live orbs at once; collected orbs respawn from the candidate ring. */
  ORB_COUNT = 8,
  ORB_RESPAWN_MS = 1_200,
  /** Every STAR_EVERY-th respawn is a star orb worth STAR_POINTS. */
  STAR_EVERY = 3,
  STAR_POINTS = 3,
  MATCH_MS = 60_000,
  MIN_PLAYERS = 2,
  MAX_PLAYERS = 6;

export type Wall = { x: number; y: number; w: number; h: number };

export const WALLS: Wall[] = [
  { x: 60, y: 60, w: 70, h: 26 },
  { x: 350, y: 60, w: 70, h: 26 },
  { x: 60, y: 394, w: 70, h: 26 },
  { x: 350, y: 394, w: 70, h: 26 },
  { x: 210, y: 150, w: 60, h: 60 },
  { x: 227, y: 80, w: 26, h: 70 },
  { x: 227, y: 330, w: 26, h: 70 },
];

/** Deterministic respawn candidate ring; every point clears the walls. */
export const ORB_SPOTS: Array<{ x: number; y: number }> = [
  { x: 40, y: 40 },
  { x: 240, y: 40 },
  { x: 440, y: 40 },
  { x: 40, y: 240 },
  { x: 440, y: 240 },
  { x: 40, y: 440 },
  { x: 240, y: 440 },
  { x: 440, y: 440 },
  { x: 140, y: 140 },
  { x: 340, y: 140 },
  { x: 140, y: 340 },
  { x: 340, y: 340 },
  { x: 240, y: 240 },
  { x: 140, y: 240 },
  { x: 340, y: 240 },
  { x: 240, y: 140 },
  { x: 240, y: 340 },
  { x: 140, y: 40 },
  { x: 340, y: 40 },
  { x: 140, y: 440 },
  { x: 340, y: 440 },
  { x: 40, y: 140 },
  { x: 440, y: 140 },
  { x: 40, y: 340 },
  { x: 440, y: 340 },
];

export type RushPlayer = {
  id: string;
  name: string;
  x: number;
  y: number;
  color: string;
  score: number;
  /** Movement intent held from the latest input; cleared by `stop`. */
  dir: Direction | null;
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
  /** Star orbs are worth STAR_POINTS and rendered distinctly. */
  star: boolean;
  collected: boolean;
};
export type State = {
  phase: GamePhase;
  remainingMs: number;
  players: Record<string, RushPlayer>;
  orbs: Record<string, Orb>;
  /** Respawn countdowns (ms) for pending orb spawns. */
  respawnTimers: number[];
  /** Monotonic counter driving orb ids and star cadence. */
  spawnCounter: number;
  /** mulberry32 state; matches stay deterministic (no Math.random). */
  rngState: number;
};
export type RushView = {
  players: Array<{ id: string; x: number; y: number; color: string; dashing: boolean }>;
  orbs: Array<{ id: string; x: number; y: number; color: string; star: boolean }>;
  walls: Wall[];
};

/** Strict per-game input: the platform only validates the generic envelope;
 * this schema owns the rest. Movement is intent-based: `move` holds a
 * direction until `stop` (or a different `move`) replaces it. */
export const colorRushInputSchema = z.discriminatedUnion("op", [
  z
    .object({
      type: z.literal("input"),
      seq: z.number().int().nonnegative(),
      op: z.literal("move"),
      direction: directionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("input"),
      seq: z.number().int().nonnegative(),
      op: z.literal("stop"),
    })
    .strict(),
  z
    .object({
      type: z.literal("input"),
      seq: z.number().int().nonnegative(),
      op: z.literal("dash"),
    })
    .strict(),
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

/** mulberry32: tiny deterministic PRNG so orb respawns are reproducible. */
function nextRandom(state: number): { value: number; state: number } {
  let t = (state + 0x6d2b79f5) | 0;
  let x = t;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return { value: ((x ^ (x >>> 14)) >>> 0) / 4294967296, state: t };
}

function makeOrb(id: string, x: number, y: number, star: boolean): Orb {
  return {
    id,
    x,
    y,
    color: star ? "#fbbf24" : orbColors[Math.floor(x + y) % orbColors.length],
    star,
    collected: false,
  };
}

/** Initial orb layout: spread across the ring, clear of walls and of the
 * player spawn row (y=240) so nobody spawns on top of an orb. */
const INITIAL_ORB_SPOTS = [
  { x: 40, y: 40 },
  { x: 240, y: 40 },
  { x: 440, y: 40 },
  { x: 40, y: 440 },
  { x: 440, y: 440 },
  { x: 140, y: 140 },
  { x: 340, y: 140 },
  { x: 340, y: 340 },
];

function createOrbs(): Record<string, Orb> {
  const orbs: Record<string, Orb> = {};
  for (let i = 0; i < ORB_COUNT; i++) {
    const spot = INITIAL_ORB_SPOTS[i];
    orbs[`orb-${i}`] = makeOrb(`orb-${i}`, spot.x, spot.y, false);
  }
  return orbs;
}

export const initialState = (matchMs: number = MATCH_MS): State => ({
  phase: "waiting",
  remainingMs: matchMs,
  players: {},
  orbs: createOrbs(),
  respawnTimers: [],
  spawnCounter: 0,
  rngState: 0x9e3779b9,
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
        dir: null,
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
    players: {
      ...s.players,
      [id]: { ...player, spectator, dir: spectator ? null : player.dir },
    },
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
  x = Math.max(PLAYER_RADIUS, Math.min(ARENA - PLAYER_RADIUS, x));
  y = Math.max(PLAYER_RADIUS, Math.min(ARENA - PLAYER_RADIUS, y));
  // Movement is single-direction, so only the moving axis can enter a wall;
  // resolving the stationary axis instead would eject the player sideways.
  if (d === "left" || d === "right") {
    for (const wall of WALLS) {
      x = resolveAxis(x, y, wall, true);
    }
  } else {
    for (const wall of WALLS) {
      y = resolveAxis(y, x, wall, false);
    }
  }
  return {
    ...s,
    players: { ...s.players, [id]: { ...player, x, y } },
  };
}

/** Resolves a circle (radius PLAYER_RADIUS) against one wall box after an
 * axis move; returns the corrected coordinate. Called per axis. */
function resolveAxis(
  pos: number,
  other: number,
  wall: Wall,
  horizontal: boolean,
): number {
  const r = PLAYER_RADIUS;
  const px0 = pos - r,
    px1 = pos + r,
    py0 = other - r,
    py1 = other + r;
  const wx0 = horizontal ? wall.x : wall.y,
    wy0 = horizontal ? wall.y : wall.x;
  const ww = horizontal ? wall.w : wall.h,
    wh = horizontal ? wall.h : wall.w;
  if (px1 <= wx0 || px0 >= wx0 + ww || py1 <= wy0 || py0 >= wy0 + wh) {
    return pos;
  }
  const pushLow = Math.abs(px0 - (wx0 + ww));
  const pushHigh = Math.abs(px1 - wx0);
  return pushLow < pushHigh ? wx0 + ww + r : wx0 - r;
}

/** Picks the next orb spawn from the candidate ring: advances the seeded
 * PRNG until a spot clears active orbs, so matches stay deterministic. */
export function nextSpawnSpot(
  rngState: number,
  orbs: Record<string, Orb>,
): { x: number; y: number; rngState: number } {
  let state = rngState;
  for (let attempt = 0; attempt < 32; attempt++) {
    const { value, state: next } = nextRandom(state);
    state = next;
    const spot = ORB_SPOTS[Math.floor(value * ORB_SPOTS.length) % ORB_SPOTS.length];
    const clearOfOrbs = Object.values(orbs)
      .filter((o) => !o.collected)
      .every((o) => Math.hypot(o.x - spot.x, o.y - spot.y) > 50);
    if (clearOfOrbs) return { x: spot.x, y: spot.y, rngState: state };
  }
  // rngState is int32 and can be negative; normalize the modulo so the
  // fallback index stays in range instead of reading `undefined`.
  const fallback =
    ORB_SPOTS[
      ((state % ORB_SPOTS.length) + ORB_SPOTS.length) % ORB_SPOTS.length
    ];
  return { x: fallback.x, y: fallback.y, rngState: state };
}

export function tick(s: State, dt: number): State {
  if (s.phase !== "running") return s;
  const dtMs = dt * 1000;

  const players: Record<string, RushPlayer> = {};
  for (const [id, p] of Object.entries(s.players)) {
    const next: RushPlayer = {
      ...p,
      dashMs: Math.max(0, p.dashMs - dtMs),
      cooldownMs: Math.max(0, p.cooldownMs - dtMs),
    };
    players[id] = next;
    // Movement is tick-driven from the held direction; inputs only set it.
    if (next.dir && !next.spectator) {
      const moved = move({ ...s, players }, id, next.dir, dt);
      players[id] = moved.players[id];
    }
  }
  const next: State = {
    ...s,
    players,
    remainingMs: Math.max(0, s.remainingMs - dtMs),
  };

  // Collection is server-derived: walking within range of an uncollected
  // orb scores. Input never asserts a collection. Collected orbs schedule
  // a deterministic respawn so the arena never runs dry.
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
          score: next.players[collector.id].score + (orb.star ? STAR_POINTS : 1),
        },
      };
      next.respawnTimers = [...next.respawnTimers, ORB_RESPAWN_MS];
    }
  }

  // Fire respawn timers, then spawn one orb per elapsed timer.
  if (next.respawnTimers.length > 0) {
    const remainingTimers: number[] = [];
    let rngState = next.rngState;
    let spawnCounter = next.spawnCounter;
    let orbs = { ...next.orbs };
    for (const timer of next.respawnTimers) {
      const left = timer - dtMs;
      if (left > 0) {
        remainingTimers.push(left);
        continue;
      }
      const spot = nextSpawnSpot(rngState, orbs);
      rngState = spot.rngState;
      spawnCounter += 1;
      const star = spawnCounter % STAR_EVERY === 0;
      orbs[`orb-r${spawnCounter}`] = makeOrb(
        `orb-r${spawnCounter}`,
        spot.x,
        spot.y,
        star,
      );
    }
    next.respawnTimers = remainingTimers;
    next.rngState = rngState;
    next.spawnCounter = spawnCounter;
    next.orbs = orbs;
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
    .map((o) => ({ id: o.id, x: o.x, y: o.y, color: o.color, star: o.star })),
  walls: WALLS,
});

export const colorRushGame: GameDefinition<State, RushInput> = {
  metadata: {
    id: "color-rush",
    name: "Color Rush",
    description:
      "Collect respawning orbs before time expires; dash past walls and rivals, and grab stars for triple points.",
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
  applyInput: (s, userId, input, _dtSeconds) => {
    const player = s.players[userId];
    if (s.phase !== "running" || !player || player.spectator) return s;
    if (input.op === "dash") return dash(s, userId);
    return {
      ...s,
      players: {
        ...s.players,
        [userId]: { ...player, dir: input.op === "move" ? input.direction : null },
      },
    };
  },
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
