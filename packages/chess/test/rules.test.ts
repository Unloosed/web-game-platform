import { describe, expect, it } from "vitest";
import {
  chessGame,
  initialState,
  type State,
} from "../src/index.js";
import {
  START_BOARD,
  applyMove,
  hasMatingMaterial,
  inCheck,
  insufficientMaterial,
  initialPosition,
  legalMoves,
  positionKey,
  squareIndex,
  squareName,
  type Move,
  type Position,
} from "../src/rules.js";

/** Plays algebraic moves (e2e4), picking the queen promotion by default. */
function play(pos: Position, ...moves: Array<[string, string]>): Position {
  let current = pos;
  for (const [from, to] of moves) {
    const f = squareIndex(from);
    const t = squareIndex(to);
    const move: Move | undefined = legalMoves(current).find(
      (m) => m.from === f && m.to === t,
    );
    if (!move) throw new Error(`illegal test move ${from}-${to}`);
    current = applyMove(current, move);
  }
  return current;
}

const EMPTY_ROW = "........";
const emptyRows = (rows: number): string =>
  new Array(rows).fill(EMPTY_ROW).join("");

const custom = (
  board: string,
  turn: "w" | "b",
  extra: Partial<Position> = {},
): Position => ({
  board,
  turn,
  castling: "",
  ep: -1,
  halfmove: 0,
  fullmove: 1,
  ...extra,
});

describe("chess rules: board and notation", () => {
  it("round-trips algebraic squares", () => {
    for (let i = 0; i < 64; i++) {
      expect(squareIndex(squareName(i))).toBe(i);
    }
  });

  it("starts from the standard position with 20 first moves", () => {
    expect(START_BOARD).toHaveLength(64);
    expect(legalMoves(initialPosition())).toHaveLength(20);
  });
});

describe("chess rules: piece movement", () => {
  it("allows single and double pawn pushes but not through pieces", () => {
    const pos = play(initialPosition(), ["e2", "e4"], ["a7", "a6"]);
    const whiteMoves = legalMoves(pos);
    expect(
      whiteMoves.some(
        (m) => m.from === squareIndex("d2") && m.to === squareIndex("d4"),
      ),
    ).toBe(true);
    expect(
      whiteMoves.some(
        (m) => m.from === squareIndex("d2") && m.to === squareIndex("d3"),
      ),
    ).toBe(true);

    // A blocked pawn has no moves at all in this bare position.
    const blocked = custom(
      EMPTY_ROW + EMPTY_ROW + EMPTY_ROW + "....p..." + "....P..." + emptyRows(3),
      "w",
    );
    expect(legalMoves(blocked)).toHaveLength(0);
  });

  it("captures diagonally and promotes with all four pieces", () => {
    // White pawn d7; black rook d8 blocks the push, knights sit on c8/e8.
    const pos = custom(
      "..nrn..." + "...P...." + emptyRows(6),
      "w",
    );
    const moves = legalMoves(pos).filter((m) => m.from === squareIndex("d7"));
    const targets = moves
      .map((m) => `${squareName(m.to)}${m.promotion ?? ""}`)
      .sort();
    expect(targets).toEqual([
      "c8b",
      "c8n",
      "c8q",
      "c8r",
      "e8b",
      "e8n",
      "e8q",
      "e8r",
    ]);
  });

  it("supports en passant capture for exactly one move", () => {
    const pos = play(
      initialPosition(),
      ["e2", "e4"],
      ["a7", "a6"],
      ["e4", "e5"],
      ["d7", "d5"],
    );
    // White may capture the d5 pawn en passant: e5xd6.
    const ep = legalMoves(pos).find(
      (m) => m.from === squareIndex("e5") && m.to === squareIndex("d6"),
    );
    expect(ep).toBeDefined();
    const after = applyMove(pos, ep!);
    expect(after.board[squareIndex("d5")]).toBe(".");

    // One quiet pair of moves later the en-passant chance is gone.
    const later = play(pos, ["a2", "a3"], ["a8", "a7"]);
    expect(
      legalMoves(later).some(
        (m) => m.from === squareIndex("e5") && m.to === squareIndex("d6"),
      ),
    ).toBe(false);
  });

  it("castles kingside with rook relocation and right revocation", () => {
    const pos = play(
      initialPosition(),
      ["e2", "e4"],
      ["e7", "e5"],
      ["g1", "f3"],
      ["b8", "c6"],
      ["f1", "c4"],
      ["f8", "c5"],
    );
    expect(legalMoves(pos).some((m) => m.from === 60 && m.to === 62)).toBe(true);
    const castled = play(pos, ["e1", "g1"]);
    expect(castled.board[squareIndex("g1")]).toBe("K");
    expect(castled.board[squareIndex("f1")]).toBe("R");
    expect(castled.board[squareIndex("h1")]).toBe(".");
    // A king move surrenders both of White's castling rights.
    expect(castled.castling).toBe("kq");
  });

  it("refuses castling through an attacked square", () => {
    // A black rook on e8 checks the e1 king along the open e-file.
    const pos = custom(EMPTY_ROW + emptyRows(6) + "RNB.K.NR", "w", {
      castling: "KQ",
    });
    expect(legalMoves(pos).some((m) => m.from === 60 && m.to === 62)).toBe(false);
  });
});

describe("chess rules: game end", () => {
  it("detects fool's mate as checkmate", () => {
    const pos = play(
      initialPosition(),
      ["f2", "f3"],
      ["e7", "e5"],
      ["g2", "g4"],
      ["d8", "h4"],
    );
    expect(inCheck(pos, "w")).toBe(true);
    expect(legalMoves(pos)).toHaveLength(0);
  });

  it("detects stalemate (not check) as a dead position", () => {
    // Black king a8; white queen c7 and king b6: black to move, no check.
    const pos = custom(
      "k......." + "..Q....." + ".K......" + emptyRows(4) + EMPTY_ROW,
      "b",
    );
    expect(inCheck(pos, "b")).toBe(false);
    expect(legalMoves(pos)).toHaveLength(0);
  });

  it("counts a quiet move at halfmove 100 as the fifty-move draw", () => {
    const pos = custom(
      "....k..." + emptyRows(6) + "....K.N.",
      "w",
      { halfmove: 99 },
    );
    const quiet = play(pos, ["g1", "f3"]);
    expect(quiet.halfmove).toBe(100);
  });

  it("counts threefold repetition through knight shuffles", () => {
    let pos = initialPosition();
    const startKey = positionKey(pos);
    let repeats = 1;
    for (let round = 0; round < 2; round++) {
      for (const [from, to] of [
        ["g1", "f3"],
        ["g8", "f6"],
        ["f3", "g1"],
        ["f6", "g8"],
      ] as Array<[string, string]>) {
        pos = play(pos, [from, to]);
        if (positionKey(pos) === startKey) repeats += 1;
      }
    }
    expect(repeats).toBe(3);
  });

  it("classifies bare-kings and lone-minor endings as insufficient", () => {
    // King vs king.
    expect(insufficientMaterial("....k..." + emptyRows(6) + "....K...")).toBe(true);
    // King + knight vs king.
    expect(insufficientMaterial("....k..." + emptyRows(6) + "....K..N")).toBe(true);
    // Bishops on same-colored squares (c8 and f1 are both color 0).
    expect(
      insufficientMaterial("..b....." + emptyRows(6) + "....KB.."),
    ).toBe(true);
  });

  it("keeps rook endings and opposite-colored bishops playable", () => {
    expect(insufficientMaterial("....k..." + emptyRows(6) + "....K..R")).toBe(false);
    // b8 (color 1) and f1 (color 0) are opposite-colored bishops.
    expect(
      insufficientMaterial("kb......" + emptyRows(6) + "....KB.."),
    ).toBe(false);
  });

  it("flags mating material for clock-flag adjudication", () => {
    expect(hasMatingMaterial("....k..." + emptyRows(6) + "....K...", "w")).toBe(false);
    expect(hasMatingMaterial("....k..." + emptyRows(6) + "....K..N", "w")).toBe(false);
    expect(hasMatingMaterial("....k..." + emptyRows(6) + "....K.NN", "w")).toBe(true);
    expect(hasMatingMaterial("....k..." + emptyRows(6) + "....KP..", "w")).toBe(true);
  });
});

describe("chess game definition", () => {
  const seeded = (): State => {
    let s = initialState(60_000);
    s = chessGame.addPlayer(s, {
      userId: "w1",
      displayName: "White",
      spectator: false,
    });
    s = chessGame.addPlayer(s, {
      userId: "b1",
      displayName: "Black",
      spectator: false,
    });
    return s;
  };
  const running = (): State => ({ ...seeded(), phase: "running" });

  const act = (
    s: State,
    from: string,
    to: string,
    promotion?: "q" | "r" | "b" | "n",
  ): State => {
    const mover = s.pos.turn === "w" ? s.whiteId! : s.blackId!;
    return chessGame.applyInput(
      s,
      mover,
      {
        type: "input",
        seq: 1,
        op: "move",
        from,
        to,
        ...(promotion ? { promotion } : {}),
      },
      0.05,
    );
  };

  it("binds colors in join order and gates start on both seats being ready", () => {
    const s = seeded();
    expect(s.whiteId).toBe("w1");
    expect(s.blackId).toBe("b1");
    expect(chessGame.canStartMatch(s)).toBe(false);
    const ready = chessGame.setReady(chessGame.setReady(s, "w1", true), "b1", true);
    expect(chessGame.canStartMatch(ready)).toBe(true);
    // A spectator never blocks or becomes ready.
    const withWatcher = chessGame.addPlayer(ready, {
      userId: "s0",
      displayName: "Watch",
      spectator: true,
    });
    expect(chessGame.setReady(withWatcher, "s0", true).players.s0.ready).toBe(false);
    expect(chessGame.canStartMatch(withWatcher)).toBe(true);
  });

  it("rejects out-of-turn and illegal moves without mutating state", () => {
    const s = running();
    const before = s;
    // Black tries to move while it is White's turn.
    const wrongTurn = chessGame.applyInput(
      s,
      "b1",
      { type: "input", seq: 1, op: "move", from: "e7", to: "e5" },
      0.05,
    );
    expect(wrongTurn).toBe(before);
    // White plays an illegal move.
    const illegal = chessGame.applyInput(
      s,
      "w1",
      { type: "input", seq: 2, op: "move", from: "e2", to: "e5" },
      0.05,
    );
    expect(illegal).toBe(before);
  });

  it("completes on checkmate with 2/0 integer scores", () => {
    let s = running();
    s = act(s, "f2", "f3");
    s = act(s, "e7", "e5");
    s = act(s, "g2", "g4");
    s = act(s, "d8", "h4");
    expect(s.phase).toBe("completed");
    expect(s.status).toBe("checkmate");
    expect(s.outcome).toBe("black");

    const results = chessGame.getResults(s);
    expect(results.map((r) => [r.id, r.score])).toEqual([
      ["b1", 2],
      ["w1", 0],
    ]);
    const rosterRows = chessGame.roster(s);
    expect(rosterRows.find((r) => r.id === "b1")?.score).toBe(2);
    // Scores stay integers for the match_players integer column.
    for (const row of results) expect(Number.isInteger(row.score)).toBe(true);
  });

  it("records resignation for the opposing side", () => {
    const s = chessGame.applyInput(
      running(),
      "b1",
      { type: "input", seq: 1, op: "resign" },
      0.05,
    );
    expect(s.phase).toBe("completed");
    expect(s.status).toBe("resignation");
    expect(s.outcome).toBe("white");
    expect(chessGame.getResults(s).map((r) => r.score)).toEqual([2, 0]);
  });

  it("completes a draw on the fifty-move rule through input", () => {
    const s = running();
    s.pos = custom("....k..." + emptyRows(6) + "....K.N.", "w", { halfmove: 99 });
    const next = act(s, "g1", "f3");
    expect(next.phase).toBe("completed");
    expect(next.status).toBe("fifty-move rule");
    expect(next.outcome).toBe("draw");
    expect(chessGame.getResults(next).map((r) => r.score)).toEqual([1, 1]);
  });

  it("completes a draw on threefold repetition through input", () => {
    let s = running();
    for (let round = 0; round < 2; round++) {
      for (const [from, to] of [
        ["g1", "f3"],
        ["g8", "f6"],
        ["f3", "g1"],
        ["f6", "g8"],
      ] as Array<[string, string]>) {
        s = act(s, from, to);
      }
    }
    expect(s.phase).toBe("completed");
    expect(s.status).toBe("threefold repetition");
  });

  it("adjudicates a clock flag by material and draws bare-kings flags", () => {
    const s = running();
    s.whiteMs = 0.05;
    const flagged = chessGame.tick(s, 0.1);
    expect(flagged.phase).toBe("completed");
    expect(flagged.status).toBe("timeout");
    expect(flagged.outcome).toBe("black");

    // Black holds only a bare king: the flag cannot award a win.
    const bare = running();
    bare.pos = custom("....k..." + emptyRows(6) + "....K.N.", "w");
    bare.whiteMs = 0.05;
    const drawn = chessGame.tick(bare, 0.1);
    expect(drawn.phase).toBe("completed");
    expect(drawn.outcome).toBe("draw");
  });

  it("forfeits when a seated player leaves or switches to spectator mid-match", () => {
    let s = chessGame.tick(running(), 0.05);
    s = chessGame.removePlayer(s, "b1");
    s = chessGame.tick(s, 0.05);
    expect(s.phase).toBe("completed");
    expect(s.status).toBe("forfeit");
    expect(s.outcome).toBe("white");

    const toggled = chessGame.setSpectator(running(), "b1", true);
    expect(toggled.phase).toBe("completed");
    expect(toggled.outcome).toBe("white");
    expect(toggled.players.b1.spectator).toBe(true);
  });

  it("auto-promotes to queen when the input omits a promotion piece", () => {
    const s = running();
    s.pos = custom(
      EMPTY_ROW + "..P....." + emptyRows(5) + "K......k",
      "w",
    );
    const next = act(s, "c7", "c8");
    expect(next.pos.board[squareIndex("c8")]).toBe("Q");
    expect(next.phase).toBe("running");
  });

  it("drains only the active side's clock and exposes both in the view", () => {
    let s = chessGame.tick(running(), 1);
    expect(s.whiteMs).toBe(59_000);
    expect(s.blackMs).toBe(60_000);
    expect(s.remainingMs).toBe(59_000);

    // The turn only changes through a move, not the clock tick.
    const v = chessGame.view(s) as import("../src/index.js").ChessView;
    expect(v.board).toHaveLength(64);
    expect(v.turn).toBe("w");
    expect(v.whiteUserId).toBe("w1");
    expect(v.blackUserId).toBe("b1");
    expect(v.legal.length).toBeGreaterThan(0);
    expect(v.players).toEqual([
      { id: "w1", color: "#f1f5f9" },
      { id: "b1", color: "#475569" },
    ]);
  });
});
