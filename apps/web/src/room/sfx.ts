import { useEffect, useRef } from "react";
import { API } from "../api";
import type { Snap } from "../types";

const CLIPS = {
  score: "sfx-score.wav",
  end: "sfx-match-end.wav",
} as const;

const MIN_GAP_MS = 150;

/**
 * Client-derived game sounds: any roster score increase plays the score
 * clip, running -> completed plays the end clip. No protocol changes —
 * everything is derived from snapshots the room already receives.
 */
export function useSfx(snap: Snap, enabled: boolean): void {
  const prev = useRef(snap);
  const lastPlayed = useRef(0);

  useEffect(() => {
    const before = prev.current;
    prev.current = snap;
    if (!enabled) return;

    let clip: string | null = null;
    if (before.phase === "running" && snap.phase === "completed") {
      clip = CLIPS.end;
    } else if (
      before.phase === "running" &&
      snap.players.some((p) => {
        const q = before.players.find((x) => x.id === p.id);
        return q !== undefined && p.score > q.score;
      })
    ) {
      clip = CLIPS.score;
    }
    if (!clip) return;

    const now = Date.now();
    if (now - lastPlayed.current < MIN_GAP_MS) return;
    lastPlayed.current = now;

    // Browsers may reject programmatic playback before a user gesture;
    // that is fine, the next event will try again.
    const audio = new Audio(`${API}/assets/${clip}`);
    audio.volume = 0.4;
    void audio.play().catch(() => {});
  }, [snap, enabled]);
}
