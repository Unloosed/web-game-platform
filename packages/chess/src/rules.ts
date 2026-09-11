/**
 * Pure chess rules engine. No DOM, no I/O, no clocks — deterministic and
 * unit-testable in isolation. The game definition in index.ts layers the
 * platform contract (players, phases, clocks, scoring) on top.
 *
 * Board representation: a 64-char string, index 0 = a8 … 63 = h1.
 * Uppercase = white ("PNBRQK"), lowercase = black ("pnbrqk"), "." = empty.
 */

export type PieceColor = "w" | "b";
export type Promotion = "q" | "r" | "b" | "n";

export const START_BOARD =
  "rnbqkbnr" +
  "pppppppp" +
  "........" +
  "........" +
  "........" +
  "........" +
  "PPPPPPPP" +
  "RNBQKBNR";

export type Position = {
  board: string;
  turn: PieceColor;
  /** Remaining castling rights, subset of "KQkq"; "" when none. */
  castling: string;
  /** En-passant target square index, or -1. */
  ep: number;
  halfmove: number;
  fullmove: number;
};

export type Move = { from: number; to: number; promotion?: Promotion };

export const FILES = "abcdefgh";

export const squareName = (i: number): string =>
  `${FILES[i % 8]}${8 - Math.floor(i / 8)}`;

export const squareIndex = (name: string): number =>
  (8 - Number(name[1])) * 8 + (name.charCodeAt(0) - 97);

const fileOf = (i: number): number => i % 8;
const rankOf = (i: number): number => 8 - Math.floor(i / 8);

const isWhitePiece = (piece: string): boolean => piece === piece.toUpperCase();
export const colorOfPiece = (piece: string): PieceColor =>
  isWhitePiece(piece) ? "w" : "b";
const PROMOTION_PIECES: Promotion[] = ["q", "r", "b", "n"];

export const initialPosition = (): Position => ({
  board: START_BOARD,
  turn: "w",
  castling: "KQkq",
  ep: -1,
  halfmove: 0,
  fullmove: 1,
});

const onBoard = (f: number, r: number): boolean =>
  f >= 0 && f < 8 && r >= 1 && r <= 8;
const idx = (f: number, r: number): number => (8 - r) * 8 + f;

const KNIGHT_DELTAS: Array<[number, number]> = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const KING_DELTAS: Array<[number, number]> = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const ROOK_RAYS: Array<[number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
];
const BISHOP_RAYS: Array<[number, number]> = [
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** Is `sq` attacked by any piece of color `by`? */
export function isAttacked(board: string, sq: number, by: PieceColor): boolean {
  const f = fileOf(sq),
    r = rankOf(sq);
  // Pawns: a white pawn attacks from one rank below; black from one above.
  const pawn = by === "w" ? "P" : "p";
  const pawnRank = by === "w" ? r - 1 : r + 1;
  for (const df of [-1, 1]) {
    if (onBoard(f + df, pawnRank) && board[idx(f + df, pawnRank)] === pawn) {
      return true;
    }
  }
  const knight = by === "w" ? "N" : "n";
  for (const [df, dr] of KNIGHT_DELTAS) {
    if (onBoard(f + df, r + dr) && board[idx(f + df, r + dr)] === knight) {
      return true;
    }
  }
  const king = by === "w" ? "K" : "k";
  for (const [df, dr] of KING_DELTAS) {
    if (onBoard(f + df, r + dr) && board[idx(f + df, r + dr)] === king) {
      return true;
    }
  }
  const slide = (deltas: Array<[number, number]>, pieces: string): boolean => {
    for (const [df, dr] of deltas) {
      let cf = f + df,
        cr = r + dr;
      while (onBoard(cf, cr)) {
        const piece = board[idx(cf, cr)];
        if (piece !== ".") {
          if (pieces.includes(piece)) return true;
          break;
        }
        cf += df;
        cr += dr;
      }
    }
    return false;
  };
  return (
    slide(ROOK_RAYS, by === "w" ? "RQ" : "rq") ||
    slide(BISHOP_RAYS, by === "w" ? "BQ" : "bq")
  );
}

export function kingSquare(board: string, color: PieceColor): number {
  const king = color === "w" ? "K" : "k";
  return board.indexOf(king);
}

export function inCheck(pos: Position, color: PieceColor): boolean {
  const ks = kingSquare(pos.board, color);
  return ks >= 0 && isAttacked(pos.board, ks, color === "w" ? "b" : "w");
}

function pushPawnMoves(pos: Position, from: number, out: Move[]): void {
  const board = pos.board;
  const color = colorOfPiece(board[from]);
  const dir = color === "w" ? 1 : -1;
  const startRank = color === "w" ? 2 : 7;
  const lastRank = color === "w" ? 8 : 1;
  const f = fileOf(from),
    r = rankOf(from);

  const one = onBoard(f, r + dir) ? idx(f, r + dir) : -1;
  if (one >= 0 && board[one] === ".") {
    if (r + dir === lastRank) {
      for (const promotion of PROMOTION_PIECES) out.push({ from, to: one, promotion });
    } else {
      out.push({ from, to: one });
      const two = onBoard(f, r + 2 * dir) ? idx(f, r + 2 * dir) : -1;
      if (r === startRank && two >= 0 && board[two] === ".") {
        out.push({ from, to: two });
      }
    }
  }
  for (const df of [-1, 1]) {
    if (!onBoard(f + df, r + dir)) continue;
    const to = idx(f + df, r + dir);
    const target = board[to];
    if (target !== "." && colorOfPiece(target) !== color) {
      if (r + dir === lastRank) {
        for (const promotion of PROMOTION_PIECES) out.push({ from, to, promotion });
      } else {
        out.push({ from, to });
      }
    } else if (target === "." && to === pos.ep) {
      out.push({ from, to });
    }
  }
}

function pushCastlingMoves(pos: Position, out: Move[]): void {
  const board = pos.board;
  if (pos.turn === "w") {
    if (
      pos.castling.includes("K") &&
      board[61] === "." &&
      board[62] === "." &&
      board[63] === "R" &&
      !isAttacked(board, 60, "b") &&
      !isAttacked(board, 61, "b") &&
      !isAttacked(board, 62, "b")
    ) {
      out.push({ from: 60, to: 62 });
    }
    if (
      pos.castling.includes("Q") &&
      board[57] === "." &&
      board[58] === "." &&
      board[59] === "." &&
      board[56] === "R" &&
      !isAttacked(board, 60, "b") &&
      !isAttacked(board, 59, "b") &&
      !isAttacked(board, 58, "b")
    ) {
      out.push({ from: 60, to: 58 });
    }
  } else {
    if (
      pos.castling.includes("k") &&
      board[5] === "." &&
      board[6] === "." &&
      board[7] === "r" &&
      !isAttacked(board, 4, "w") &&
      !isAttacked(board, 5, "w") &&
      !isAttacked(board, 6, "w")
    ) {
      out.push({ from: 4, to: 6 });
    }
    if (
      pos.castling.includes("q") &&
      board[1] === "." &&
      board[2] === "." &&
      board[3] === "." &&
      board[0] === "r" &&
      !isAttacked(board, 4, "w") &&
      !isAttacked(board, 3, "w") &&
      !isAttacked(board, 2, "w")
    ) {
      out.push({ from: 4, to: 2 });
    }
  }
}

/** All pseudo-legal moves for the side to move (king safety unchecked). */
function pseudoMoves(pos: Position): Move[] {
  const out: Move[] = [];
  const board = pos.board;
  const white = pos.turn === "w";
  for (let from = 0; from < 64; from++) {
    const piece = board[from];
    if (piece === "." || isWhitePiece(piece) !== white) continue;
    const kind = piece.toLowerCase();
    const f = fileOf(from),
      r = rankOf(from);
    if (kind === "p") {
      pushPawnMoves(pos, from, out);
      continue;
    }
    if (kind === "n" || kind === "k") {
      const deltas = kind === "n" ? KNIGHT_DELTAS : KING_DELTAS;
      for (const [df, dr] of deltas) {
        if (!onBoard(f + df, r + dr)) continue;
        const to = idx(f + df, r + dr);
        const target = board[to];
        if (target === "." || colorOfPiece(target) !== pos.turn) {
          out.push({ from, to });
        }
      }
      continue;
    }
    const rays =
      kind === "r" ? ROOK_RAYS : kind === "b" ? BISHOP_RAYS : [...ROOK_RAYS, ...BISHOP_RAYS];
    for (const [df, dr] of rays) {
      let cf = f + df,
        cr = r + dr;
      while (onBoard(cf, cr)) {
        const to = idx(cf, cr);
        const target = board[to];
        if (target === ".") {
          out.push({ from, to });
        } else {
          if (colorOfPiece(target) !== pos.turn) out.push({ from, to });
          break;
        }
        cf += df;
        cr += dr;
      }
    }
  }
  pushCastlingMoves(pos, out);
  return out;
}

/** Applies a move without legality checking (the caller picks from
 * legalMoves). Returns the successor position. */
export function applyMove(pos: Position, move: Move): Position {
  const board = pos.board.split("");
  const piece = board[move.from];
  const color = colorOfPiece(piece);
  board[move.from] = ".";
  let placed = piece;
  if (move.promotion) {
    placed = color === "w" ? move.promotion.toUpperCase() : move.promotion;
  }
  board[move.to] = placed;

  // En passant: the captured pawn is not on the destination square.
  if ((piece === "P" || piece === "p") && move.to === pos.ep) {
    const capturedAt = color === "w" ? move.to + 8 : move.to - 8;
    board[capturedAt] = ".";
  }

  // Castling: the rook relocates around its king.
  if (piece === "K" && move.from === 60) {
    if (move.to === 62) {
      board[63] = ".";
      board[61] = "R";
    }
    if (move.to === 58) {
      board[56] = ".";
      board[59] = "R";
    }
  }
  if (piece === "k" && move.from === 4) {
    if (move.to === 6) {
      board[7] = ".";
      board[5] = "r";
    }
    if (move.to === 2) {
      board[0] = ".";
      board[3] = "r";
    }
  }

  // Castling rights fall when the king or a corner rook moves or dies.
  let castling = pos.castling;
  const drop = (chars: string): void => {
    for (const c of chars) castling = castling.replace(c, "");
  };
  if (piece === "K") drop("KQ");
  if (piece === "k") drop("kq");
  if (move.from === 63 || move.to === 63) drop("K");
  if (move.from === 56 || move.to === 56) drop("Q");
  if (move.from === 7 || move.to === 7) drop("k");
  if (move.from === 0 || move.to === 0) drop("q");

  // En-passant target exists only immediately after a double pawn push.
  let ep = -1;
  if (piece === "P" && move.to - move.from === -16) ep = move.from - 8;
  if (piece === "p" && move.to - move.from === 16) ep = move.from + 8;

  const isCapture = pos.board[move.to] !== ".";
  const isPawn = piece === "P" || piece === "p";
  return {
    board: board.join(""),
    turn: color === "w" ? "b" : "w",
    castling,
    ep,
    halfmove: isPawn || isCapture ? 0 : pos.halfmove + 1,
    fullmove: color === "b" ? pos.fullmove + 1 : pos.fullmove,
  };
}

/** All legal moves for the side to move (own king may not be left in check). */
export function legalMoves(pos: Position): Move[] {
  const color = pos.turn;
  return pseudoMoves(pos).filter((move) => {
    const next = applyMove(pos, move);
    return !inCheck(next, color);
  });
}

/** Repetition key: position, side to move, castling rights, ep square. */
export const positionKey = (pos: Position): string =>
  `${pos.board}|${pos.turn}|${pos.castling}|${pos.ep}`;

/**
 * Can `color` deliver mate with the material left on the board? Used to
 * adjudicate a clock flag: a flag fall against bare kings (or king plus a
 * single minor) is a draw, not a loss.
 */
export function hasMatingMaterial(board: string, color: PieceColor): boolean {
  let minors = 0;
  for (const piece of board) {
    if (piece === ".") continue;
    if (colorOfPiece(piece) !== color || piece.toLowerCase() === "k") continue;
    const kind = piece.toLowerCase();
    if (kind === "p" || kind === "r" || kind === "q") return true;
    minors += 1;
  }
  return minors >= 2;
}

/** Dead position with no possible mate for either side. */
export function insufficientMaterial(board: string): boolean {
  const pieces: Array<{ kind: string; squareColor: number }> = [];
  for (let i = 0; i < 64; i++) {
    const piece = board[i];
    if (piece === "." || piece.toLowerCase() === "k") continue;
    pieces.push({
      kind: piece.toLowerCase(),
      squareColor: (fileOf(i) + rankOf(i)) % 2,
    });
  }
  if (pieces.length === 0) return true;
  if (pieces.length === 1 && (pieces[0].kind === "b" || pieces[0].kind === "n")) {
    return true;
  }
  return (
    pieces.every((p) => p.kind === "b") &&
    new Set(pieces.map((p) => p.squareColor)).size === 1
  );
}
