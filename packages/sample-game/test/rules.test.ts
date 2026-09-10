import { describe, expect, it } from "vitest";
import {
  ARENA,
  addPlayer,
  canStartMatch,
  initialState,
  move,
  removePlayer,
  roster,
  sampleTagGame,
  setReady,
  setSpectator,
  tick,
  view,
} from "../src/index.js";

const base = () =>
  addPlayer(addPlayer(initialState(), "a", "A", false), "b", "B", false);
const running = () => {
  const s = base();
  s.phase = "running";
  return s;
};

describe("tag rules", () => {
  it("moves only in the running phase and clamps to arena bounds", () => {
    const idle = base();
    expect(move(idle, "a", "right", 1).players.a.x).toBe(idle.players.a.x);

    let s = running();
    s = move(s, "a", "right", 100);
    expect(s.players.a.x).toBe(ARENA - 12);
  });

  it("keeps spectators from moving or being tagged", () => {
    let s = running();
    s = setSpectator(s, "a", true);
    const frozen = s.players.a;
    s = move(s, "a", "right", 1);
    expect(s.players.a).toEqual(frozen);
    s = tick(s, 0.001);
    expect(s.itPlayerId).not.toBe("a");
  });

  it("completes on timer expiry and ranks by tags", () => {
    let s = running();
    s.players.a.tags = 3;
    s.players.b.tags = 7;
    s.remainingMs = 1;
    s = tick(s, 1);
    expect(s.phase).toBe("completed");
    expect(sampleTagGame.getResults(s).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("removes players without side effects for unknown ids", () => {
    let s = running();
    s = removePlayer(s, "b");
    expect(s.players.b).toBeUndefined();
    expect(removePlayer(s, "ghost")).toBe(s);
  });
});

describe("ready rules", () => {
  it("toggles readiness for participants but not spectators", () => {
    let s = addPlayer(addPlayer(initialState(), "a", "A", false), "b", "B", true);
    s = setReady(s, "a", true);
    expect(s.players.a.ready).toBe(true);
    s = setReady(s, "b", true);
    expect(s.players.b.ready).toBe(false);
    s.phase = "running";
    s = setReady(s, "a", false);
    expect(s.players.a.ready).toBe(true);
  });

  it("gates match start on minimum players and full readiness", () => {
    let s = addPlayer(initialState(), "a", "A", false);
    expect(canStartMatch(s)).toBe(false);
    s = addPlayer(s, "b", "B", true);
    s = setReady(s, "a", true);
    expect(canStartMatch(s)).toBe(false);
    s = addPlayer(s, "c", "C", false);
    expect(canStartMatch(s)).toBe(false);
    s = setReady(s, "c", true);
    expect(canStartMatch(s)).toBe(true);
  });

  it("reassigns IT when the IT holder becomes a spectator mid-match", () => {
    let s = base();
    s.phase = "running";
    s = tick(s, 0.001);
    expect(s.itPlayerId).toBe("a");
    s = setSpectator(s, "a", true);
    expect(s.players.a.spectator).toBe(true);
    expect(s.itPlayerId).toBe("b");
    // A spectator cannot take or hold the IT role on later ticks either.
    s = tick(s, 0.001);
    expect(s.itPlayerId).toBe("b");
  });
});

describe("tag definition", () => {
  it("removes a player and releases the IT role", () => {
    let s = base();
    s.phase = "running";
    s = tick(s, 0.001);
    expect(s.itPlayerId).toBe("a");
    s = removePlayer(s, "a");
    expect(s.players.a).toBeUndefined();
    expect(s.itPlayerId).toBeNull();
  });

  it("maps generic roster rows and game-specific views", () => {
    const s = addPlayer(initialState(), "a", "A", false);
    expect(roster(s)).toEqual([
      { id: "a", name: "A", score: 0, spectator: false, ready: false },
    ]);
    expect(view(s).players).toEqual([
      {
        id: "a",
        x: s.players.a.x,
        y: s.players.a.y,
        color: s.players.a.color,
      },
    ]);
    expect(view(s).itPlayerId).toBeNull();
  });

  it("rejects input payloads that are not tag inputs", () => {
    expect(
      sampleTagGame.inputSchema.safeParse({ type: "input", seq: 0, direction: "up" })
        .success,
    ).toBe(true);
    expect(
      sampleTagGame.inputSchema.safeParse({ type: "input", seq: 0, op: "dash" })
        .success,
    ).toBe(false);
    expect(
      sampleTagGame.inputSchema.safeParse({
        type: "input",
        seq: 0,
        direction: "up",
        cheat: 1,
      }).success,
    ).toBe(false);
  });

  it("ignores input and keeps scores at zero outside the running phase", () => {
    let s = base();
    const x = s.players.a.x;
    s = sampleTagGame.applyInput(s, "a", { type: "input", seq: 1, direction: "right" }, 1);
    expect(s.players.a.x).toBe(x);
    expect(sampleTagGame.getResults(s).map((r) => r.score)).toEqual([0, 0]);
  });
});
