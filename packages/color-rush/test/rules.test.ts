import { describe, expect, it } from "vitest";
import {
  ARENA,
  COLLECT_DISTANCE,
  addPlayer,
  canStartMatch,
  colorRushGame,
  dash,
  initialState,
  move,
  removePlayer,
  roster,
  setReady,
  setSpectator,
  tick,
  view,
} from "../src/index.js";

const base = () => addPlayer(addPlayer(initialState(), "a", "A", false), "b", "B", false);
const running = () => {
  const s = base();
  s.phase = "running";
  return s;
};

describe("color rush rules", () => {
  it("moves only in the running phase and clamps to arena bounds", () => {
    const idle = base();
    expect(move(idle, "a", "right", 1).players.a.x).toBe(idle.players.a.x);

    let s = running();
    s = move(s, "a", "right", 100);
    expect(s.players.a.x).toBe(ARENA - 12);
  });

  it("multiplies movement speed while a dash boost is active", () => {
    let s = running();
    s = dash(s, "a");
    expect(s.players.a.dashMs).toBeGreaterThan(0);
    const dashed = move(s, "a", "right", 0.1);
    const plain = move(running(), "a", "right", 0.1);
    expect(dashed.players.a.x).toBeGreaterThan(plain.players.a.x);
  });

  it("blocks dashing while the dash cooldown is active", () => {
    let s = dash(running(), "a");
    // Let part of the boost and cooldown elapse.
    s = tick(s, 0.1);
    const boosted = s.players.a.dashMs;
    expect(boosted).toBeLessThan(500);
    // A rejected dash would reset the boost to full; it must stay elapsed.
    s = dash(s, "a");
    expect(s.players.a.dashMs).toBe(boosted);
  });

  it("collects an orb on proximity during tick and awards once", () => {
    let s = running();
    s = move(s, "a", "right", (80 - 60) / 150);
    s.players.a.x = 80;
    s.players.a.y = 140;
    s = tick(s, 0.05);
    expect(s.players.a.score).toBe(1);
    expect(s.orbs["orb-0"].collected).toBe(true);

    // Staying on the spot must not score the same orb twice.
    s = tick(s, 0.05);
    expect(s.players.a.score).toBe(1);
  });

  it("does not collect when nobody is within collection distance", () => {
    const s = running();
    const far = tick(s, 0.05);
    expect(far.players.a.score).toBe(0);
    expect(Object.values(far.orbs).every((o) => !o.collected)).toBe(true);
  });

  it("keeps spectators from moving, dashing, or collecting", () => {
    let s = addPlayer(setSpectator(running(), "a", true), "c", "C", false);
    const frozen = s.players.a;
    s = move(s, "a", "right", 1);
    s = dash(s, "a");
    expect(s.players.a).toEqual(frozen);

    s.players.a.x = 80;
    s.players.a.y = 140;
    s = tick(s, 0.05);
    expect(s.players.a.score).toBe(0);
  });

  it("gates start on minimum participants and full readiness", () => {
    let s = addPlayer(initialState(), "a", "A", false);
    expect(canStartMatch(s)).toBe(false);
    s = setReady(s, "a", true);
    expect(canStartMatch(s)).toBe(false);
    s = addPlayer(s, "w", "W", true);
    expect(canStartMatch(s)).toBe(false);
    s = addPlayer(s, "b", "B", false);
    expect(canStartMatch(s)).toBe(false);
    s = setReady(s, "b", true);
    expect(canStartMatch(s)).toBe(true);
  });

  it("completes on timer expiry and ranks by score", () => {
    let s = running();
    s.players.a.score = 2;
    s.players.b.score = 5;
    s.remainingMs = 1;
    s = tick(s, 1);
    expect(s.phase).toBe("completed");
    expect(colorRushGame.getResults(s).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("removes players from state without side effects", () => {
    let s = running();
    s = removePlayer(s, "b");
    expect(s.players.b).toBeUndefined();
    expect(removePlayer(s, "ghost")).toBe(s);
  });

  it("exposes generic roster rows and a filtered game view", () => {
    let s = running();
    s.players.a.x = 80;
    s.players.a.y = 140;
    s = tick(s, 0.05);
    expect(roster(s).map((p) => p.score)).toEqual([1, 0]);
    const v = view(s);
    expect(v.players.some((p) => p.dashing)).toBe(false);
    expect(v.orbs.length).toBe(7);
  });

  it("rejects payloads that are not color-rush inputs", () => {
    expect(
      colorRushGame.inputSchema.safeParse({ type: "input", seq: 0, op: "dash" })
        .success,
    ).toBe(true);
    expect(
      colorRushGame.inputSchema.safeParse({ type: "input", seq: 0, direction: "up" })
        .success,
    ).toBe(false);
    expect(
      colorRushGame.inputSchema.safeParse({ type: "input", seq: 0, op: "collect", orbId: "orb-0" })
        .success,
    ).toBe(false);
  });

  it("never lets inputs mutate a completed match", () => {
    let s = running();
    s.remainingMs = 0;
    s = tick(s, 0.05);
    expect(s.phase).toBe("completed");
    const frozen = s;
    s = colorRushGame.applyInput(s, "a", { type: "input", seq: 1, op: "dash" }, 1);
    s = colorRushGame.applyInput(s, "a", { type: "input", seq: 2, op: "move", direction: "right" }, 1);
    expect(s).toEqual(frozen);
  });

  it("spawns orbs further apart than the collection radius", () => {
    const orbs = Object.values(initialState().orbs);
    for (let i = 0; i < orbs.length; i++) {
      for (let j = i + 1; j < orbs.length; j++) {
        const d = Math.hypot(orbs[i].x - orbs[j].x, orbs[i].y - orbs[j].y);
        expect(d).toBeGreaterThan(COLLECT_DISTANCE * 2);
      }
    }
  });
});
