import { useEffect, useRef, type ComponentType } from "react";
import type { Snap } from "../types";

/**
 * Everything a game's arena view receives from the generic room chrome.
 * Arena components render `snap.view` (game-specific payload) and emit
 * schema-valid input intents through `sendInput`; scoring, collisions,
 * and completion stay server-side.
 */
export type ArenaProps = {
  snap: Snap;
  spectator: boolean;
  sendInput: (input: Record<string, unknown>) => void;
};

export type GameViewEntry = {
  component: ComponentType<ArenaProps>;
  controls: Array<{ keys: string; action: string }>;
};

export const useLatestSnap = (snap: Snap) => {
  const latest = useRef(snap);
  useEffect(() => {
    latest.current = snap;
  }, [snap]);
  return latest;
};

/** Shared WASD/arrow-key movement listener; arenas map directions to
 * their own input payloads via `onDirection`. */
export function useMovementKeys(
  spectator: boolean,
  sendInput: ArenaProps["sendInput"],
  onDirection: (direction: string) => void,
) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const d: Record<string, string> = {
        ArrowUp: "up",
        w: "up",
        ArrowDown: "down",
        s: "down",
        ArrowLeft: "left",
        a: "left",
        ArrowRight: "right",
        d: "right",
      };
      const direction = d[e.key];
      if (!direction) return;
      if (spectator) return;
      onDirection(direction);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [spectator, sendInput, onDirection]);
}
