import {
  DPad,
  useFitScale,
  useLatestSnap,
  useMovementKeys,
  useSmoothedPositions,
  type ArenaProps,
} from "./arena";

// Mirrors TagView from packages/sample-game.
type TagView = {
  players: Array<{ id: string; x: number; y: number; color: string }>;
  itPlayerId: string | null;
};

export function TagArena({ snap, spectator, sendInput }: ArenaProps) {
  const latest = useLatestSnap(snap);
  const move = (direction: string) => {
    if (latest.current.phase !== "running") return;
    sendInput({ type: "input", seq: Date.now(), direction });
  };
  useMovementKeys(spectator, sendInput, move);
  const view = (snap.view ?? { players: [], itPlayerId: null }) as TagView;
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
          {view.players.map((p) => (
            <div
              title={snap.players.find((r) => r.id === p.id)?.name ?? p.id}
              key={p.id}
              className={"player-dot" + (view.itPlayerId === p.id ? " is-it" : "")}
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
      {!spectator && <DPad onDirection={move} />}
    </div>
  );
}
