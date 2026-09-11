import { useEffect } from "react";
import {
  DPad,
  useCoalescedInput,
  useFitScale,
  useLatestSnap,
  useMovementKeys,
  useSmoothedPositions,
  type ArenaProps,
} from "./arena";

// Mirrors TagView from packages/sample-game.
type TagView = {
  players: Array<{
    id: string;
    x: number;
    y: number;
    color: string;
    it: boolean;
    stunned: boolean;
    dashing: boolean;
    grace: boolean;
  }>;
  walls: Array<{ x: number; y: number; w: number; h: number }>;
  itPlayerId: string | null;
};

export function TagArena({ snap, spectator, sendInput }: ArenaProps) {
  const latest = useLatestSnap(snap);
  const send = useCoalescedInput(sendInput);
  const move = (direction: string | null) => {
    if (latest.current.phase !== "running") return;
    send(
      direction === null
        ? { type: "input", seq: Date.now(), op: "stop" }
        : { type: "input", seq: Date.now(), op: "move", direction },
    );
  };
  const dash = () => {
    if (spectator || latest.current.phase !== "running") return;
    send({ type: "input", seq: Date.now(), op: "dash" });
  };
  useMovementKeys(spectator, sendInput, move);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== " ") return;
      e.preventDefault();
      dash();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const view = (snap.view ?? { players: [], walls: [], itPlayerId: null }) as TagView;
  const pos = useSmoothedPositions(view.players);
  const { ref, scale } = useFitScale(400);
  return (
    <div>
      <div ref={ref} style={{ height: 400 * scale }}>
        <div
          data-testid="tag-arena"
          style={{
            position: "relative",
            width: 400,
            height: 400,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            background:
              "radial-gradient(ellipse at 50% 0%, #16234a 0%, #071122 62%)",
          }}
        >
          {view.walls.map((w, i) => (
            <div
              key={`wall-${i}`}
              className="arena-wall"
              style={{
                left: w.x,
                top: w.y,
                width: w.w,
                height: w.h,
              }}
            />
          ))}
          {view.players.map((p) => (
            <div
              title={snap.players.find((r) => r.id === p.id)?.name ?? p.id}
              key={p.id}
              className={
                "player-dot" +
                (p.it ? " is-it" : "") +
                (p.stunned ? " is-stunned" : "") +
                (p.dashing ? " is-dashing" : "") +
                (p.it && p.grace ? " it-grace" : "")
              }
              style={{
                width: 24,
                height: 24,
                left: pos[p.id]?.x ?? p.x,
                top: pos[p.id]?.y ?? p.y,
                background: p.color,
                color: p.color,
              }}
            />
          ))}
        </div>
      </div>
      {!spectator && (
        <DPad onDirection={move} action={{ label: "DASH", onPress: dash }} />
      )}
    </div>
  );
}
