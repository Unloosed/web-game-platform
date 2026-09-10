import { useEffect } from "react";
import { useLatestSnap, useMovementKeys, type ArenaProps } from "./arena";

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
  useMovementKeys(spectator, sendInput, (direction) => {
    if (latest.current.phase !== "running") return;
    sendInput({ type: "input", seq: Date.now(), op: "move", direction });
  });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== " ") return;
      e.preventDefault();
      if (spectator || latest.current.phase !== "running") return;
      sendInput({ type: "input", seq: Date.now(), op: "dash" });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [spectator, sendInput, latest]);
  const view = (snap.view ?? { players: [], orbs: [] }) as RushView;
  return (
    <div
      data-testid="color-rush-arena"
      style={{
        position: "relative",
        width: 480,
        height: 480,
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
            left: p.x - 11,
            top: p.y - 11,
            background: p.color,
            color: p.color,
          }}
        />
      ))}
    </div>
  );
}
