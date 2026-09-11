import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Snap } from "../types";
import { lerpPositions, type Pt } from "./smooth";

/** Matches the game server's per-socket input throttle (50 ms). */
const INPUT_PACE_MS = 50;

/**
 * Everything a game's arena view receives from the generic room chrome.
 * Arena components render `snap.view` (game-specific payload) and emit
 * schema-valid input intents through `sendInput`; scoring, collisions,
 * and completion stay server-side. `userId` is the local viewer's id,
 * needed by asymmetric games (e.g. chess) to know which side they control.
 */
export type ArenaProps = {
  snap: Snap;
  spectator: boolean;
  userId: string;
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

/**
 * Shared WASD/arrow-key movement listener; arenas map intents to their own
 * input payloads via `onDirection`. Keys are tracked client-side so the
 * server receives one `move` when the pressed direction changes and one
 * `stop` (`onDirection(null)`) when all movement keys are released —
 * movement no longer depends on OS key-repeat timing. Window blur also
 * stops, so alt-tabbing never leaves a player running.
 */
export function useMovementKeys(
  spectator: boolean,
  sendInput: ArenaProps["sendInput"],
  onDirection: (direction: string | null) => void,
) {
  useEffect(() => {
    const held = new Map<string, string>();
    const directionFor = (key: string): string | undefined =>
      ({
        ArrowUp: "up",
        w: "up",
        ArrowDown: "down",
        s: "down",
        ArrowLeft: "left",
        a: "left",
        ArrowRight: "right",
        d: "right",
      })[key];

    const emit = (): void => {
      const directions = [...held.values()];
      onDirection(directions.length > 0 ? directions[directions.length - 1] : null);
    };

    const keydown = (e: KeyboardEvent) => {
      const direction = directionFor(e.key);
      if (!direction || spectator) return;
      const previous = [...held.values()].at(-1);
      held.set(e.key, direction);
      const current = [...held.values()].at(-1);
      if (current !== previous) onDirection(current ?? null);
    };
    const keyup = (e: KeyboardEvent) => {
      if (!directionFor(e.key) || spectator) return;
      if (!held.delete(e.key)) return;
      emit();
    };
    const blur = () => {
      if (held.size === 0) return;
      held.clear();
      emit();
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
    };
  }, [spectator, sendInput, onDirection]);
}

/**
 * Input sender that coalesces to the server's 50 ms per-socket input pace.
 * A burst of intents (tap, quick direction change) always delivers the
 * LATEST one after the throttle window instead of getting it rejected —
 * otherwise a fast tap's `stop` would be dropped and the player would run
 * on forever.
 */
export function useCoalescedInput(
  sendInput: ArenaProps["sendInput"],
): (payload: Record<string, unknown>) => void {
  const lastSentAt = useRef(0);
  const pending = useRef<Record<string, unknown> | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return (payload) => {
    const send = () => {
      lastSentAt.current = Date.now();
      sendInput(payload);
    };
    const gap = Date.now() - lastSentAt.current;
    if (gap >= INPUT_PACE_MS) {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      send();
      return;
    }
    pending.current = payload;
    if (timer.current === null) {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        if (pending.current) {
          const queued = pending.current;
          pending.current = null;
          lastSentAt.current = Date.now();
          sendInput(queued);
        }
      }, INPUT_PACE_MS - gap);
    }
  };
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
  onRelease,
}: {
  label: string;
  className: string;
  ariaLabel: string;
  repeat: boolean;
  onPress: () => void;
  onRelease?: () => void;
}) {
  const timer = useRef<number | null>(null);
  const stop = () => {
    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
    onRelease?.();
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
 * Direction buttons hold their direction while pressed (auto-repeat keeps
 * the intent fresh) and stop on release; the optional action button
 * (e.g. dash) fires once per tap.
 */
export function DPad({
  onDirection,
  action,
}: {
  onDirection: (d: string | null) => void;
  action?: { label: string; onPress: () => void };
}) {
  const direction = (d: string) => () => onDirection(d);
  const release = () => onDirection(null);
  const dirs: Array<[string, string]> = [
    ["←", "left"],
    ["↑", "up"],
    ["↓", "down"],
    ["→", "right"],
  ];
  return (
    <div className="dpad" data-testid="dpad">
      {dirs.map(([label, key]) => (
        <HoldButton
          key={key}
          label={label}
          className="dpad-btn"
          ariaLabel={`move ${key}`}
          repeat
          onPress={direction(key)}
          onRelease={release}
        />
      ))}
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
