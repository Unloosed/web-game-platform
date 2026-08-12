import type { Direction, Player } from "../../protocol/src/index.js";
export const ARENA = 400,
  SPEED = 150,
  MATCH_MS = 60_000,
  TAG_DISTANCE = 26;
export type State = {
  players: Record<string, Player>;
  itPlayerId: string | null;
  remainingMs: number;
  phase: "waiting" | "running" | "completed";
};
const colors = [
  "#38bdf8",
  "#fb7185",
  "#a3e635",
  "#fbbf24",
  "#c084fc",
  "#2dd4bf",
];
export const initialState = (): State => ({
  players: {},
  itPlayerId: null,
  remainingMs: MATCH_MS,
  phase: "waiting",
});
export function addPlayer(
  s: State,
  id: string,
  name: string,
  spectator: boolean,
): State {
  if (s.players[id])
    return {
      ...s,
      players: { ...s.players, [id]: { ...s.players[id], name, spectator } },
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
        x: 60 + (n % 4) * 85,
        y: 60 + Math.floor(n / 4) * 85,
        color: colors[n % colors.length],
        tags: 0,
      },
    },
  };
}
export function move(s: State, id: string, d: Direction, dt: number): State {
  if (
    s.phase !== "running" ||
    d === "none" ||
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
  if (!n.itPlayerId) {
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
