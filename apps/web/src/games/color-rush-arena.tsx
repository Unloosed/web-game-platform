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

// Mirrors RushView from packages/color-rush.
type RushView = {
  players: Array<{
    id: string;
    x: number;
    y: number;
    color: string;
    dashing: boolean;
  }>;
  orbs: Array<{ id: string; x: number; y: number; color: string; star: boolean }>;
  walls: Array<{ x: number; y: number; w: number; h: number }>;
};

export function ColorRushArena({ snap, spectator, sendInput }: ArenaProps) {
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
  const view = (snap.view ?? { players: [], orbs: [], walls: [] }) as RushView;
  const pos = useSmoothedPositions(view.players);
  const { ref, scale } = useFitScale(480);
  return (
    <div>
      <div ref={ref} style={{ height: 480 * scale }}>
        <div
          data-testid="color-rush-arena"
          style={{
            position: "relative",
            width: 480,
            height: 480,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            background:
              "radial-gradient(ellipse at 50% 0%, #241636 0%, #0b1020 62%)",
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
          {view.orbs.map((o) => (
            <div
              key={o.id}
              className={"orb" + (o.star ? " orb-star" : "")}
              style={{
                width: 20,
                height: 20,
                left: o.x - 10,
                top: o.y - 10,
                background: o.color,
                color: o.color,
              }}
            >
              {o.star ? "★" : ""}
            </div>
          ))}
          {view.players.map((p) => (
            <div
              title={snap.players.find((r) => r.id === p.id)?.name ?? p.id}
              key={p.id}
              className={
                "player-dot is-round" + (p.dashing ? " is-dashing" : "")
              }
              style={{
                width: 22,
                height: 22,
                left: (pos[p.id]?.x ?? p.x) - 11,
                top: (pos[p.id]?.y ?? p.y) - 11,
                background: p.color,
                color: p.color,
              }}
            />
          ))}
        </div>
      </div>
      {!spectator && <DPad onDirection={move} action={{ label: "DASH", onPress: dash }} />}
    </div>
  );
}
