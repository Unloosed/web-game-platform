import { z } from "zod";
import type { GameDefinition, GamePhase, Player } from "../../protocol/src/index.js";
import {
  applyMove,
  hasMatingMaterial,
  inCheck,
  insufficientMaterial,
  initialPosition,
  kingSquare,
  legalMoves,
  positionKey,
  squareIndex,
  type PieceColor,
  type Position,
  type Promotion,
} from "./rules.js";

export {
  initialPosition,
  legalMoves,
  squareIndex,
  squareName,
  type Move,
  type PieceColor,
  type Position,
} from "./rules.js";

/** Win/loss/draw points; integers so match persistence stays `score integer`. */
export const WIN_POINTS = 2,
  DRAW_POINTS = 1,
  LOSS_POINTS = 0,
  MIN_PLAYERS = 2,
  MAX_PLAYERS = 2;

export type ChessPlayer = {
  id: string;
  name: string;
  /** Fixed on join: first participant is White, second is Black. */
  color: PieceColor | null;
  spectator: boolean;
  ready: boolean;
};

export type Outcome = "white" | "black" | "draw" | null;

export type State = {
  phase: GamePhase;
  /** Clock of the side that must move sooner: min(whiteMs, blackMs). */
  remainingMs: number;
  whiteMs: number;
  blackMs: number;
  pos: Position;
  players: Record<string, ChessPlayer>;
  whiteId: string | null;
  blackId: string | null;
  /** "checkmate" | "stalemate" | "resignation" | "timeout" | "forfeit" |
   * "fifty-move rule" | "threefold repetition" | "insufficient material" */
  status: string | null;
  outcome: Outcome;
  lastMove: { from: number; to: number } | null;
  /** Repetition counts keyed by position; drives threefold draws. */
  repetition: Record<string, number>;
};

export type ChessView = {
  board: string;
  turn: PieceColor;
  whiteUserId: string | null;
  blackUserId: string | null;
  whiteMs: number;
  blackMs: number;
  checkSquare: number | null;
  status: string | null;
  lastMove: { from: number; to: number } | null;
  /** Every legal move for the side to move, for client highlighting. */
  legal: Array<{ from: number; to: number; promotion?: Promotion }>;
  /** Scoreboard color dots: map each player id to their side color. */
  players: Array<{ id: string; color: string }>;
};

const squareSchema = z
  .string()
  .regex(/^[a-h][1-8]$/, "square must be algebraic like e4");
const promotionSchema = z.enum(["q", "r", "b", "n"]);

/** Strict per-game input: moves are intent (algebraic squares) validated
 * against the full legal-move list; `resign` concedes the match. */
export const chessInputSchema = z.discriminatedUnion("op", [
  z
    .object({
      type: z.literal("input"),
      seq: z.number().int().nonnegative(),
      op: z.literal("move"),
      from: squareSchema,
      to: squareSchema,
      promotion: promotionSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("input"),
      seq: z.number().int().nonnegative(),
      op: z.literal("resign"),
    })
    .strict(),
]);
export type ChessInput = z.infer<typeof chessInputSchema>;

export const initialState = (matchMs: number = 60_000): State => {
  const pos = initialPosition();
  return {
    phase: "waiting",
    remainingMs: matchMs,
    whiteMs: matchMs,
    blackMs: matchMs,
    pos,
    players: {},
    whiteId: null,
    blackId: null,
    status: null,
    outcome: null,
    lastMove: null,
    repetition: { [positionKey(pos)]: 1 },
  };
};

export function addPlayer(
  s: State,
  id: string,
  name: string,
  spectator: boolean,
  ready?: boolean,
): State {
  const existing = s.players[id];
  if (existing) {
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
  }
  // Colors bind in join order; further non-spectators (possible only when
  // room capacity was bypassed) sit out as colorless kibitzers.
  let whiteId = s.whiteId,
    blackId = s.blackId;
  let color: PieceColor | null = null;
  if (!spectator) {
    if (!whiteId) {
      whiteId = id;
      color = "w";
    } else if (!blackId) {
      blackId = id;
      color = "b";
    }
  }
  return {
    ...s,
    whiteId,
    blackId,
    players: {
      ...s.players,
      [id]: {
        id,
        name,
        color,
        spectator,
        ready: ready ?? false,
      },
    },
  };
}

export function removePlayer(s: State, id: string): State {
  const player = s.players[id];
  if (!player) return s;
  const { [id]: _removed, ...remainingPlayers } = s.players;
  return {
    ...s,
    players: remainingPlayers,
    whiteId: s.whiteId === id ? null : s.whiteId,
    blackId: s.blackId === id ? null : s.blackId,
  };
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
  // A participant switching to spectator mid-match forfeits their seat.
  if (s.phase === "running" && player.color) {
    return completeForfeit({
      ...s,
      players: {
        ...s.players,
        [id]: { ...player, spectator, color: null },
      },
      whiteId: player.color === "w" ? null : s.whiteId,
      blackId: player.color === "b" ? null : s.blackId,
    });
  }
  if (s.phase === "running") return s;
  let color = player.color;
  let { whiteId, blackId } = s;
  // Returning to play in a waiting room reclaims an open seat.
  if (!spectator && !color) {
    if (!whiteId) {
      whiteId = id;
      color = "w";
    } else if (!blackId) {
      blackId = id;
      color = "b";
    }
  }
  return {
    ...s,
    whiteId: spectator ? (color === "w" ? null : whiteId) : whiteId,
    blackId: spectator ? (color === "b" ? null : blackId) : blackId,
    players: {
      ...s.players,
      [id]: { ...player, spectator, color: spectator ? null : color },
    },
  };
}

/** Exactly two seated participants, every one of them ready. */
export function canStartMatch(s: State): boolean {
  const seated = Object.values(s.players).filter((p) => p.color);
  return (
    seated.length === MIN_PLAYERS &&
    seated.every((p) => !p.spectator && p.ready) &&
    s.whiteId !== null &&
    s.blackId !== null
  );
}

const scoreFor = (state: State, color: PieceColor): number => {
  if (state.phase !== "completed" || !state.outcome) return 0;
  if (state.outcome === "draw") return DRAW_POINTS;
  return state.outcome === toOutcome(color) ? WIN_POINTS : LOSS_POINTS;
};

/** Maps a side color to its outcome label. */
const toOutcome = (color: PieceColor): "white" | "black" =>
  color === "w" ? "white" : "black";

/** Marks the match complete with the remaining seated player as winner. */
function completeForfeit(s: State): State {
  if (s.phase !== "running" || (!s.whiteId && !s.blackId)) return s;
  return {
    ...s,
    phase: "completed",
    status: "forfeit",
    outcome: s.whiteId ? "white" : "black",
    remainingMs: Math.min(s.whiteMs, s.blackMs),
  };
}

function completeOutcome(
  s: State,
  outcome: Exclude<Outcome, null>,
  status: string,
): State {
  return {
    ...s,
    phase: "completed",
    status,
    outcome,
    remainingMs: Math.min(s.whiteMs, s.blackMs),
  };
}

/** Timer expiry adjudication: the flagged side loses unless the opponent
 * lacks mating material, in which case the game is drawn. */
function adjudicateTimeout(s: State): State {
  const flagged = s.whiteMs <= 0 ? "w" : s.blackMs <= 0 ? "b" : null;
  if (!flagged) return s;
  const opponent = flagged === "w" ? "b" : "w";
  if (hasMatingMaterial(s.pos.board, opponent)) {
    return completeOutcome(s, toOutcome(opponent), "timeout");
  }
  return completeOutcome(s, "draw", "timeout");
}

export function tick(s: State, dt: number): State {
  if (s.phase !== "running") return s;
  const dtMs = dt * 1000;

  // A seated player leaving mid-match forfeits; the remaining holder wins.
  if (!s.whiteId || !s.blackId) {
    return completeForfeit(s);
  }

  let whiteMs = s.whiteMs,
    blackMs = s.blackMs;
  if (s.pos.turn === "w") whiteMs = Math.max(0, whiteMs - dtMs);
  else blackMs = Math.max(0, blackMs - dtMs);

  return adjudicateTimeout({
    ...s,
    whiteMs,
    blackMs,
    remainingMs: Math.min(whiteMs, blackMs),
  });
}

export function applyInput(
  s: State,
  userId: string,
  input: ChessInput,
): State {
  if (s.phase !== "running") return s;
  const player = s.players[userId];
  if (!player || player.spectator || !player.color) return s;

  // Resignation is honored on either side's clock.
  if (input.op === "resign") {
    return completeOutcome(s, player.color === "w" ? "black" : "white", "resignation");
  }
  if (player.color !== s.pos.turn) return s;

  const from = squareIndex(input.from);
  const to = squareIndex(input.to);
  const wantedPromotion = input.promotion ?? "q";
  const move = legalMoves(s.pos).find(
    (m) => m.from === from && m.to === to && (m.promotion ?? "q") === wantedPromotion,
  );
  if (!move) return s;

  const pos = applyMove(s.pos, move);
  const key = positionKey(pos);
  const repetition = { ...s.repetition, [key]: (s.repetition[key] ?? 0) + 1 };
  const next: State = {
    ...s,
    pos,
    repetition,
    lastMove: { from: move.from, to: move.to },
    whiteMs: s.whiteMs,
    blackMs: s.blackMs,
    remainingMs: Math.min(s.whiteMs, s.blackMs),
  };

  // Terminal positions, in priority order.
  const replies = legalMoves(pos);
  if (replies.length === 0) {
    if (inCheck(pos, pos.turn)) {
      return completeOutcome(next, pos.turn === "w" ? "black" : "white", "checkmate");
    }
    return completeOutcome(next, "draw", "stalemate");
  }
  if (pos.halfmove >= 100) {
    return completeOutcome(next, "draw", "fifty-move rule");
  }
  if (repetition[key] >= 3) {
    return completeOutcome(next, "draw", "threefold repetition");
  }
  if (insufficientMaterial(pos.board)) {
    return completeOutcome(next, "draw", "insufficient material");
  }
  return next;
}

export const roster = (s: State): Player[] =>
  Object.values(s.players).map((p) => ({
    id: p.id,
    name: p.name,
    score: p.color ? scoreFor(s, p.color) : 0,
    spectator: p.spectator,
    ready: p.ready,
  }));

const SIDE_DOT_COLORS: Record<PieceColor, string> = {
  w: "#f1f5f9",
  b: "#475569",
};

export const view = (s: State): ChessView => {
  const checked = inCheck(s.pos, s.pos.turn)
    ? kingSquare(s.pos.board, s.pos.turn)
    : -1;
  return {
    board: s.pos.board,
    turn: s.pos.turn,
    whiteUserId: s.whiteId,
    blackUserId: s.blackId,
    whiteMs: s.whiteMs,
    blackMs: s.blackMs,
    checkSquare: checked >= 0 ? checked : null,
    status: s.status,
    lastMove: s.lastMove,
    legal: legalMoves(s.pos).map((m) => ({
      from: m.from,
      to: m.to,
      ...(m.promotion ? { promotion: m.promotion } : {}),
    })),
    players: [
      ...(s.whiteId ? [{ id: s.whiteId, color: SIDE_DOT_COLORS.w }] : []),
      ...(s.blackId ? [{ id: s.blackId, color: SIDE_DOT_COLORS.b }] : []),
    ],
  };
};

/** The registry-facing definition binding the rules to the platform contract. */
export const chessGame: GameDefinition<State, ChessInput> = {
  metadata: {
    id: "chess",
    name: "Chess",
    description:
      "Classical chess with clocks: full rules, checkmate and draws, resign any time.",
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
  },
  inputSchema: chessInputSchema,
  createState: (matchMs) => initialState(matchMs),
  addPlayer: (s, p) => addPlayer(s, p.userId, p.displayName, p.spectator, p.ready),
  removePlayer: (s, userId) => removePlayer(s, userId),
  setReady: (s, userId, ready) => setReady(s, userId, ready),
  setSpectator: (s, userId, spectator) => setSpectator(s, userId, spectator),
  canStartMatch: (s) => canStartMatch(s),
  applyInput: (s, userId, input) => applyInput(s, userId, input),
  tick: (s, dtSeconds) => tick(s, dtSeconds),
  roster: (s) => roster(s),
  view: (s) => view(s),
  getResults: (s) =>
    Object.values(s.players)
      .filter((p) => p.color)
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: scoreFor(s, p.color as PieceColor),
        spectator: false,
        ready: p.ready,
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)),
};
