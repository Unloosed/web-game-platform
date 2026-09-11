import { z } from "zod";
import type { Direction, GameDefinition, GamePhase, Player } from "../../protocol/src/index.js";
import { directionSchema } from "../../protocol/src/index.js";

export const ARENA = 400,
  PLAYER_RADIUS = 12,
  SPEED = 175,
  IT_SPEED_MULT = 1.08,
  DASH_MULT = 2.2,
  DASH_BOOST_MS = 400,
  DASH_COOLDOWN_MS = 3_500,
  TAG_DISTANCE = 26,
  /** After being tagged, the new IT cannot tag anyone for this long. */
  TAG_GRACE_MS = 2_500,
  /** A freshly tagged player is frozen briefly so overlap cannot ping-pong. */
  TAG_STUN_MS = 800,
  /** Points awarded per successful tag. */
  TAG_POINTS = 5,
  /** Survival points: +1 per SURVIVAL_SPAN_MS spent not-IT while running. */
  SURVIVAL_SPAN_MS = 5_000,
  MATCH_MS = 60_000,
  MIN_PLAYERS = 2,
  MAX_PLAYERS = 8;

/** Axis-aligned obstacles; players collide with them (circle vs box). */
export type Wall = { x: number; y: number; w: number; h: number };

export const WALLS: Wall[] = [
  { x: 170, y: 170, w: 60, h: 60 },
  { x: 180, y: 40, w: 40, h: 90 },
  { x: 180, y: 270, w: 40, h: 90 },
  { x: 40, y: 180, w: 90, h: 40 },
  { x: 270, y: 180, w: 90, h: 40 },
];

/** Deterministic spawn ring; every point clears the wall layout. */
export const SPAWNS: Array<{ x: number; y: number }> = [
  { x: 56, y: 56 },
  { x: 344, y: 56 },
  { x: 56, y: 344 },
  { x: 344, y: 344 },
  { x: 200, y: 56 },
  { x: 200, y: 344 },
  { x: 60, y: 120 },
  { x: 340, y: 280 },
];

export type TagPlayer = {
  id: string;
  name: string;
  x: number;
  y: number;
  color: string;
  tags: number;
  /** Milliseconds accumulated while not-IT and running; survival income. */
  survivalMs: number;
  /** Movement intent held from the latest input; cleared by `stop`. */
  dir: Direction | null;
  dashingMs: number;
  dashCooldownMs: number;
  /** Frozen after being tagged; decays in tick. */
  stunMs: number;
  /** Tag-back grace for the current IT holder; decays in tick. */
  graceMs: number;
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
  players: Array<{
    id: string;
    x: number;
    y: number;
    color: string;
    it: boolean;
    stunned: boolean;
    dashing: boolean;
    /** Tag-back grace active: this IT holder cannot tag yet. */
    grace: boolean;
  }>;
  walls: Wall[];
  itPlayerId: string | null;
};

/** Strict per-game input: the platform only validates the generic envelope;
 * this schema owns the rest. Movement is intent-based: `move` holds a
 * direction until `stop` (or a different `move`) replaces it. */
export const tagInputSchema = z.discriminatedUnion("op", [
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
export type TagInput = z.infer<typeof tagInputSchema>;

const colors = [
  "#38bdf8",
  "#fb7185",
  "#a3e635",
  "#fbbf24",
  "#c084fc",
  "#2dd4bf",
  "#f97316",
  "#4ade80",
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
  const spawn = SPAWNS[n % SPAWNS.length];
  return {
    ...s,
    players: {
      ...s.players,
      [id]: {
        id,
        name,
        spectator,
        ready: ready ?? false,
        x: spawn.x,
        y: spawn.y,
        color: colors[n % colors.length],
        tags: 0,
        survivalMs: 0,
        dir: null,
        dashingMs: 0,
        dashCooldownMs: 0,
        stunMs: 0,
        graceMs: 0,
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
    players: {
      ...s.players,
      [id]: {
        ...player,
        spectator,
        dir: spectator ? null : player.dir,
      },
    },
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
  // Overlap: push out through the nearer face on the moving axis only.
  const pushLow = Math.abs(px0 - (wx0 + ww));
  const pushHigh = Math.abs(px1 - wx0);
  return pushLow < pushHigh ? wx0 + ww + r : wx0 - r;
}

export function move(s: State, id: string, d: Direction, dt: number): State {
  const player = s.players[id];
  if (s.phase !== "running" || !player || player.spectator || player.stunMs > 0)
    return s;
  const itBoost = s.itPlayerId === id ? IT_SPEED_MULT : 1;
  const speed =
    SPEED * itBoost * (player.dashingMs > 0 ? DASH_MULT : 1);
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

/** Dash: a short burst with a cooldown; rejected while stunned or cooling. */
export function dash(s: State, id: string): State {
  const player = s.players[id];
  if (
    s.phase !== "running" ||
    !player ||
    player.spectator ||
    player.stunMs > 0 ||
    player.dashCooldownMs > 0
  )
    return s;
  return {
    ...s,
    players: {
      ...s.players,
      [id]: {
        ...player,
        dashingMs: DASH_BOOST_MS,
        dashCooldownMs: DASH_COOLDOWN_MS,
      },
    },
  };
}

/** Score combines tag points and survival income; higher is better. */
export const scoreOf = (p: TagPlayer): number =>
  p.tags * TAG_POINTS + Math.floor(p.survivalMs / SURVIVAL_SPAN_MS);

export function tick(s: State, dt: number): State {
  if (s.phase !== "running") return s;
  const dtMs = dt * 1000;

  let players: Record<string, TagPlayer> = {};
  for (const [id, p] of Object.entries(s.players)) {
    let next: TagPlayer = {
      ...p,
      dashingMs: Math.max(0, p.dashingMs - dtMs),
      dashCooldownMs: Math.max(0, p.dashCooldownMs - dtMs),
      stunMs: Math.max(0, p.stunMs - dtMs),
      graceMs: Math.max(0, p.graceMs - dtMs),
    };
    players[id] = next;
    // Movement is tick-driven from the held direction; inputs only set it.
    if (next.dir && next.stunMs === 0 && !next.spectator) {
      const moved = move({ ...s, players }, id, next.dir, dt);
      players[id] = moved.players[id];
      next = players[id];
    }
    // Survival income accrues only while running and not IT.
    if (!next.spectator && s.itPlayerId !== id) {
      players[id] = { ...next, survivalMs: next.survivalMs + dtMs };
    }
  }
  const n: State = {
    ...s,
    players,
    remainingMs: Math.max(0, s.remainingMs - dtMs),
  };

  if (!n.itPlayerId || n.players[n.itPlayerId]?.spectator) {
    const p = Object.values(n.players).find((x) => !x.spectator);
    n.itPlayerId = p?.id ?? null;
  }

  // Tagging: contact transfers IT, unless the IT holder is inside their
  // tag-back grace window. The tagged player is briefly stunned.
  const it = n.itPlayerId && n.players[n.itPlayerId];
  if (it && it.graceMs === 0 && it.stunMs === 0) {
    for (const p of Object.values(n.players)) {
      if (
        p.id !== it.id &&
        !p.spectator &&
        Math.hypot(p.x - it.x, p.y - it.y) <= TAG_DISTANCE
      ) {
        n.players = {
          ...n.players,
          [it.id]: { ...it, tags: it.tags + 1, graceMs: 0 },
          [p.id]: {
            ...p,
            stunMs: TAG_STUN_MS,
            graceMs: TAG_GRACE_MS,
          },
        };
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
    .sort(
      (a, b) =>
        scoreOf(b) - scoreOf(a) || b.tags - a.tags || a.id.localeCompare(b.id),
    );

/** Generic roster rows for the shared snapshot/scoreboard envelope. */
export const roster = (s: State): Player[] =>
  Object.values(s.players).map((p) => ({
    id: p.id,
    name: p.name,
    score: scoreOf(p),
    spectator: p.spectator,
    ready: p.ready,
  }));

export const view = (s: State): TagView => ({
  players: Object.values(s.players).map((p) => ({
    id: p.id,
    x: p.x,
    y: p.y,
    color: p.color,
    it: s.itPlayerId === p.id,
    stunned: p.stunMs > 0,
    dashing: p.dashingMs > 0,
    grace: p.graceMs > 0,
  })),
  walls: WALLS,
  itPlayerId: s.itPlayerId,
});

/** The registry-facing definition binding the pure rules to the platform contract. */
export const sampleTagGame: GameDefinition<State, TagInput> = {
  metadata: {
    id: "sample-tag",
    name: "Tag Arena",
    description:
      "Server-authoritative tag with dash, walls, and tag-back grace: tag for points, dodge for survival.",
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
  applyInput: (s, userId, input, _dtSeconds) => {
    const player = s.players[userId];
    if (s.phase !== "running" || !player || player.spectator) return s;
    if (input.op === "dash") return dash(s, userId);
    if (input.op === "stop") {
      return {
        ...s,
        players: {
          ...s.players,
          [userId]: { ...player, dir: null },
        },
      };
    }
    return {
      ...s,
      players: {
        ...s.players,
        [userId]: { ...player, dir: input.direction },
      },
    };
  },
  tick: (s, dtSeconds) => tick(s, dtSeconds),
  roster: (s) => roster(s),
  view: (s) => view(s),
  getResults: (s) =>
    results(s).map((p) => ({
      id: p.id,
      name: p.name,
      score: scoreOf(p),
      spectator: false,
      ready: p.ready,
    })),
};
