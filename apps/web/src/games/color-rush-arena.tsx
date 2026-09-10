import { useEffect } from "react";
import {
  DPad,
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
  orbs: Array<{ id: string; x: number; y: number; color: string }>;
};

export function ColorRushArena({ snap, spectator, sendInput }: ArenaProps) {
  const latest = useLatestSnap(snap);
  const move = (direction: string) => {
    if (latest.current.phase !== "running") return;
    sendInput({ type: "input", seq: Date.now(), op: "move", direction });
  };
  const dash = () => {
    if (spectator || latest.current.phase !== "running") return;
    sendInput({ type: "input", seq: Date.now(), op: "dash" });
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
  }, [spectator, sendInput, latest]);
  const view = (snap.view ?? { players: [], orbs: [] }) as RushView;
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
          {view.orbs.map((o) => (
            <div
              key={o.id}
              className="orb"
              style={{
                width: 20,
                height: 20,
                left: o.x - 10,
                top: o.y - 10,
                background: o.color,
                color: o.color,
              }}
            />
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
