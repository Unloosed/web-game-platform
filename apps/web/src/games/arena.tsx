import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Snap } from "../types";
import { lerpPositions, type Pt } from "./smooth";

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

/**
 * Positions that ease between the last two snapshots (20 Hz server ticks)
 * via requestAnimationFrame, instead of jumping every tick. Returns a map
 * keyed by player id; ids absent from the current view have no entry, so
 * callers should fall back to the raw view position.
 */
export function useSmoothedPositions(
  players: Array<{ id: string; x: number; y: number }>,
): Record<string, Pt> {
  const from = useRef<Record<string, Pt>>({});
  const to = useRef<Record<string, Pt>>({});
  const t0 = useRef(0);
  const dur = useRef(50);
  const arrived = useRef(0);
  const [out, setOut] = useState<Record<string, Pt>>({});

  useEffect(() => {
    const now = performance.now();
    const next: Record<string, Pt> = {};
    for (const p of players) next[p.id] = { x: p.x, y: p.y };
    from.current = to.current;
    to.current = next;
    t0.current = now;
    dur.current = arrived.current
      ? Math.max(16, Math.min(200, now - arrived.current))
      : 50;
    arrived.current = now;
  }, [players]);

  useEffect(() => {
    let raf = 0;
    const step = (now: number) => {
      const k = (now - t0.current) / dur.current;
      setOut(lerpPositions(from.current, to.current, k));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [players]);

  return out;
}

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

/**
 * Scales a fixed-logical-size arena down to its container width (never
 * up). Attach `ref` to the wrapper whose width is authoritative; position
 * the arena inside with `transform: scale(scale)`, origin top left.
 */
export function useFitScale(logicalWidth: number): {
  ref: (node: HTMLDivElement | null) => void;
  scale: number;
} {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!node || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setScale(Math.min(1, w / logicalWidth));
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [node, logicalWidth]);
  return { ref: setNode, scale };
}

function HoldButton({
  label,
  className,
  ariaLabel,
  repeat,
  onPress,
}: {
  label: string;
  className: string;
  ariaLabel: string;
  repeat: boolean;
  onPress: () => void;
}) {
  const timer = useRef<number | null>(null);
  const stop = () => {
    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  };
  const down = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    onPress();
    if (repeat) timer.current = window.setInterval(onPress, 120);
  };
  return (
    <button
      type="button"
      className={className}
      aria-label={ariaLabel}
      onPointerDown={down}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
    >
      {label}
    </button>
  );
}

/**
 * On-screen controls for touch devices (hidden on mouse pointers via CSS).
 * Direction buttons auto-repeat while held; the optional action button
 * (e.g. dash) fires once per tap.
 */
export function DPad({
  onDirection,
  action,
}: {
  onDirection: (d: string) => void;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <div className="dpad" data-testid="dpad">
      <HoldButton
        label="←"
        className="dpad-btn"
        ariaLabel="move left"
        repeat
        onPress={() => onDirection("left")}
      />
      <HoldButton
        label="↑"
        className="dpad-btn"
        ariaLabel="move up"
        repeat
        onPress={() => onDirection("up")}
      />
      <HoldButton
        label="↓"
        className="dpad-btn"
        ariaLabel="move down"
        repeat
        onPress={() => onDirection("down")}
      />
      <HoldButton
        label="→"
        className="dpad-btn"
        ariaLabel="move right"
        repeat
        onPress={() => onDirection("right")}
      />
      {action && (
        <HoldButton
          label={action.label}
          className="dpad-btn dpad-action"
          ariaLabel={action.label.toLowerCase()}
          repeat={false}
          onPress={action.onPress}
        />
      )}
    </div>
  );
}
