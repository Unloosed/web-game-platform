import type { ArenaProps, GameViewEntry } from "./arena";
import { ColorRushArena } from "./color-rush-arena";
import { TagArena } from "./tag-arena";

/** Shown when a room hosts a game with no client view registered — the
 * game works server-side; only its arena rendering is missing. */
function UnknownArena({ snap }: ArenaProps) {
  return (
    <div
      data-testid="unknown-arena"
      style={{
        width: 400,
        height: 400,
        display: "grid",
        placeItems: "center",
        textAlign: "center",
        padding: 24,
        color: "var(--text-dim)",
      }}
    >
      No arena view is registered for “{snap.game}”. Add one in
      apps/web/src/games.
    </div>
  );
}

/**
 * Client game registry: the web app's counterpart of the server-side
 * game registry. Adding a game to the UI means adding an entry here —
 * the room chrome (ready-up, start, timer, scoreboard, results, chat)
 * is generic and never changes per game.
 */
const gameViews: Record<string, GameViewEntry> = {
  "sample-tag": {
    component: TagArena,
    controls: [
      { keys: "WASD / ← ↑ → ↓", action: "move" },
      { keys: "Tag", action: "steal the crown" },
    ],
  },
  "color-rush": {
    component: ColorRushArena,
    controls: [
      { keys: "WASD / ← ↑ → ↓", action: "move" },
      { keys: "Space", action: "dash" },
    ],
  },
};

export function getGameView(gameId: string): GameViewEntry {
  return gameViews[gameId] ?? { component: UnknownArena, controls: [] };
}
