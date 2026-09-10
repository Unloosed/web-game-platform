import { useLatestSnap, useMovementKeys, type ArenaProps } from "./arena";

// Mirrors TagView from packages/sample-game.
type TagView = {
  players: Array<{ id: string; x: number; y: number; color: string }>;
  itPlayerId: string | null;
};

export function TagArena({ snap, spectator, sendInput }: ArenaProps) {
  const latest = useLatestSnap(snap);
  useMovementKeys(spectator, sendInput, (direction) => {
    if (latest.current.phase !== "running") return;
    sendInput({ type: "input", seq: Date.now(), direction });
  });
  const view = (snap.view ?? { players: [], itPlayerId: null }) as TagView;
  return (
    <div
      data-testid="tag-arena"
      style={{
        position: "relative",
        width: 400,
        height: 400,
        background:
          "radial-gradient(ellipse at 50% 0%, #16234a 0%, #071122 62%)",
      }}
    >
      {view.players.map((p) => (
        <div
          title={snap.players.find((r) => r.id === p.id)?.name ?? p.id}
          key={p.id}
          className={"player-dot" + (view.itPlayerId === p.id ? " is-it" : "")}
          style={{
            width: 24,
            height: 24,
            left: p.x,
            top: p.y,
            background: p.color,
            color: p.color,
          }}
        />
      ))}
    </div>
  );
}
