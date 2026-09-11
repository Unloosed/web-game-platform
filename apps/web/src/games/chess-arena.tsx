import { useState } from "react";
import { useFitScale, type ArenaProps } from "./arena";
import { mmss } from "../ui";

// Mirrors ChessView from packages/chess.
type ChessView = {
  board: string;
  turn: "w" | "b";
  whiteUserId: string | null;
  blackUserId: string | null;
  whiteMs: number;
  blackMs: number;
  checkSquare: number | null;
  status: string | null;
  lastMove: { from: number; to: number } | null;
  legal: Array<{ from: number; to: number; promotion?: string }>;
  players: Array<{ id: string; color: string }>;
};

// Filled glyphs for both colors, tinted via CSS for crisp rendering.
const GLYPHS: Record<string, string> = {
  k: "♚",
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
  p: "♟",
};

const pieceGlyph = (piece: string): { glyph: string; white: boolean } | null => {
  if (piece === "." || piece === "") return null;
  const white = piece === piece.toUpperCase();
  return { glyph: GLYPHS[piece.toLowerCase()], white };
};

const squareNameOf = (i: number): string =>
  `${"abcdefgh"[i % 8]}${8 - Math.floor(i / 8)}`;

export function ChessArena({ snap, spectator, userId, sendInput }: ArenaProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const { ref, scale } = useFitScale(480);
  const view = (snap.view ?? null) as ChessView | null;

  if (!view) {
    return (
      <div data-testid="chess-arena" className="chess-board-empty">
        Waiting for match state…
      </div>
    );
  }

  const myColor =
    userId && view.whiteUserId === userId
      ? "w"
      : userId && view.blackUserId === userId
        ? "b"
        : null;
  const myTurn =
    !spectator && snap.phase === "running" && myColor === view.turn;
  const legalFromSelected = view.legal.filter((m) => m.from === selected);
  const destinations = new Set(legalFromSelected.map((m) => m.to));

  const clickSquare = (sq: number): void => {
    if (!myTurn) {
      setSelected(null);
      return;
    }
    if (selected !== null && destinations.has(sq)) {
      sendInput({
        type: "input",
        seq: Date.now(),
        op: "move",
        from: squareNameOf(selected),
        to: squareNameOf(sq),
        // Pawns auto-promote to queen from the client.
        ...(legalFromSelected.find((m) => m.to === sq)?.promotion
          ? { promotion: "q" }
          : {}),
      });
      setSelected(null);
      return;
    }
    const piece = view.board[sq];
    const pieceIsMine =
      piece !== "." &&
      ((myColor === "w") === (piece === piece.toUpperCase()));
    setSelected(pieceIsMine ? sq : null);
  };

  const resign = (): void => {
    if (snap.phase !== "running" || spectator || !myColor) return;
    sendInput({ type: "input", seq: Date.now(), op: "resign" });
  };

  // Black views the board from Black's side.
  const order = Array.from({ length: 64 }, (_, i) =>
    myColor === "b" ? 63 - i : i,
  );
  const turnLabel =
    snap.phase === "running"
      ? view.turn === "w"
        ? "White to move"
        : "Black to move"
      : (view.status ?? "");

  return (
    <div className="chess-wrap" data-testid="chess-arena">
      <div className="chess-clocks">
        <span
          className={
            "chess-clock" +
            (view.turn === "w" && snap.phase === "running" ? " is-active" : "")
          }
        >
          ♔ {mmss(view.whiteMs)}
        </span>
        <span className="chess-turn" data-testid="chess-turn">
          {turnLabel}
        </span>
        <span
          className={
            "chess-clock" +
            (view.turn === "b" && snap.phase === "running" ? " is-active" : "")
          }
        >
          {mmss(view.blackMs)} ♚
        </span>
      </div>
      <div ref={ref} style={{ height: 480 * scale }}>
        <div
          className="chess-board"
          style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}
        >
          {order.map((sq) => {
            const piece = pieceGlyph(view.board[sq]);
            const dark = (Math.floor(sq / 8) + (sq % 8)) % 2 === 1;
            const classes = [
              "chess-square",
              dark ? "is-dark" : "is-light",
              view.lastMove && (view.lastMove.from === sq || view.lastMove.to === sq)
                ? "is-last"
                : "",
              view.checkSquare === sq ? "is-check" : "",
              selected === sq ? "is-selected" : "",
              destinations.has(sq) ? "is-dest" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={sq}
                className={classes}
                data-square={squareNameOf(sq)}
                title={squareNameOf(sq)}
                onClick={() => clickSquare(sq)}
              >
                {piece && (
                  <span className={piece.white ? "pc-w" : "pc-b"}>
                    {piece.glyph}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {myColor && snap.phase === "running" && (
        <button type="button" className="btn btn-small btn-danger" onClick={resign}>
          Resign
        </button>
      )}
    </div>
  );
}
