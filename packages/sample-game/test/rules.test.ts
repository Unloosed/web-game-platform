import { describe, expect, it } from "vitest";
import {
  ARENA,
  DASH_MULT,
  PLAYER_RADIUS,
  SPEED,
  SURVIVAL_SPAN_MS,
  TAG_DISTANCE,
  TAG_GRACE_MS,
  TAG_STUN_MS,
  WALLS,
  addPlayer,
  canStartMatch,
  dash,
  initialState,
  move,
  removePlayer,
  roster,
  sampleTagGame,
  scoreOf,
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

describe("tag movement", () => {
  it("moves only in the running phase and clamps to arena bounds", () => {
    const idle = base();
    expect(move(idle, "a", "right", 1).players.a.x).toBe(idle.players.a.x);

    let s = running();
    s.players.a.x = ARENA - 20;
    s = move(s, "a", "right", 100);
    expect(s.players.a.x).toBe(ARENA - PLAYER_RADIUS);
  });

  it("moves from held direction during tick, and stop clears it", () => {
    const apply = sampleTagGame.applyInput;
    let s = running();
    const startX = s.players.a.x;
    s = apply(s, "a", { type: "input", seq: 1, op: "move", direction: "right" }, 0.05);
    const afterMove = tick(s, 0.1);
    expect(afterMove.players.a.x).toBeCloseTo(startX + SPEED * 0.1, 5);

    const stopped = apply(afterMove, "a", { type: "input", seq: 2, op: "stop" }, 0.05);
    const afterStop = tick(stopped, 0.1);
    expect(afterStop.players.a.x).toBe(afterMove.players.a.x);
  });

  it("blocks movement with walls (center block stops an upward run)", () => {
    let s = running();
    // Below the center block {x:170..230, y:170..230}; standing clears it.
    s.players.a.x = 200;
    s.players.a.y = 250;
    s = move(s, "a", "up", 0.2);
    // Pushed back to the wall face plus the player radius.
    expect(s.players.a.y).toBe(230 + PLAYER_RADIUS);
    expect(s.players.a.x).toBe(200);
  });

  it("keeps every deterministic spawn clear of the walls", () => {
    const s = base();
    for (const p of Object.values(s.players)) {
      for (const w of WALLS) {
        const clear =
          p.x + PLAYER_RADIUS <= w.x ||
          p.x - PLAYER_RADIUS >= w.x + w.w ||
          p.y + PLAYER_RADIUS <= w.y ||
          p.y - PLAYER_RADIUS >= w.y + w.h;
        expect(clear, `spawn (${p.x},${p.y}) overlaps wall ${JSON.stringify(w)}`).toBe(
          true,
        );
      }
    }
  });
});

describe("tag chase mechanics", () => {
  const adjacent = () => {
    const s = running();
    // Place the runner within tag range of the IT holder.
    s.players.a.x = 200;
    s.players.a.y = 200;
    s.players.b.x = 200 + TAG_DISTANCE - 1;
    s.players.b.y = 200;
    return tick(s, 0.001);
  };

  it("assigns IT to the first participant on the first tick", () => {
    const s = tick(running(), 0.001);
    expect(s.itPlayerId).toBe("a");
  });

  it("transfers IT on contact, awards tag points, and stuns the tagged player", () => {
    const s = adjacent();
    expect(s.itPlayerId).toBe("b");
    expect(s.players.a.tags).toBe(1);
    expect(s.players.b.stunMs).toBe(TAG_STUN_MS);
    expect(s.players.b.graceMs).toBe(TAG_GRACE_MS);
  });

  it("prevents instant tag-backs: grace blocks the new IT from tagging", () => {
    let s = adjacent();
    // a (now the runner) stays in contact with the fresh IT.
    s.players.a.x = s.players.b.x + TAG_DISTANCE - 1;
    // The grace window swallows the contact for its full duration.
    for (let i = 0; i < Math.floor(TAG_GRACE_MS / 100) - 1; i++) {
      s = tick(s, 0.1);
      expect(s.itPlayerId).toBe("b");
    }
    // One more tick crosses the grace expiry and the tag lands.
    s = tick(s, 0.1);
    expect(s.itPlayerId).toBe("a");
    expect(s.players.b.tags).toBe(1);
  });

  it("freezes a stunned player: movement input has no effect", () => {
    let s = adjacent();
    const frozen = { x: s.players.b.x, y: s.players.b.y };
    s = sampleTagGame.applyInput(
      s,
      "b",
      { type: "input", seq: 1, op: "move", direction: "right" },
      0.05,
    );
    s = tick(s, 0.1);
    expect(s.players.b.x).toBe(frozen.x);
    expect(s.players.b.y).toBe(frozen.y);
  });

  it("gives the IT a small speed edge over runners", () => {
    let s = running();
    s = tick(s, 0.001); // a becomes IT
    const itX = s.players.a.x;
    s = sampleTagGame.applyInput(s, "a", { type: "input", seq: 1, op: "move", direction: "right" }, 0.05);
    s = tick(s, 0.1);
    expect(s.players.a.x - itX).toBeCloseTo(SPEED * 1.08 * 0.1, 5);
  });

  it("dashes with a boost and rejects a second dash while cooling down", () => {
    let s = tick(running(), 0.001); // a is IT
    const startX = s.players.a.x;
    s = sampleTagGame.applyInput(s, "a", { type: "input", seq: 1, op: "move", direction: "right" }, 0.05);
    s = dash(s, "a");
    s = tick(s, 0.1);
    expect(s.players.a.x - startX).toBeCloseTo(SPEED * 1.08 * DASH_MULT * 0.1, 5);

    // Still cooling down: dash is a no-op and the boost keeps decaying.
    const boost = s.players.a.dashingMs;
    s = dash(s, "a");
    expect(s.players.a.dashingMs).toBe(boost);
  });

  it("keeps spectators from moving, tagging, or being tagged", () => {
    let s = running();
    s = setSpectator(s, "a", true);
    const frozen = s.players.a;
    s = move(s, "a", "right", 1);
    expect(s.players.a).toEqual(frozen);
    s = tick(s, 0.001);
    expect(s.itPlayerId).not.toBe("a");
  });

  it("completes on timer expiry and ranks by combined score", () => {
    let s = tick(running(), 0.001); // a becomes IT, b survives
    s = tick(s, 20); // b banks 4 survival points while a chases
    s.players.a.tags = 2; // 10 points from tags
    s.remainingMs = 1;
    s = tick(s, 1);
    expect(s.phase).toBe("completed");
    const results = sampleTagGame.getResults(s);
    expect(results.map((r) => r.id)).toEqual(["a", "b"]);
    expect(results[0].score).toBe(scoreOf(s.players.a));
    expect(results[0].score).toBe(10);
    expect(results[1].score).toBe(scoreOf(s.players.b));
  });

  it("removes players without side effects for unknown ids", () => {
    let s = running();
    s = removePlayer(s, "b");
    expect(s.players.b).toBeUndefined();
    expect(removePlayer(s, "ghost")).toBe(s);
  });
});

describe("tag scoring", () => {
  it("awards survival income only to non-IT players", () => {
    let s = tick(running(), 0.001); // a becomes IT
    s = tick(s, SURVIVAL_SPAN_MS / 1000);
    expect(scoreOf(s.players.b)).toBe(1);
    expect(scoreOf(s.players.a)).toBe(0);
    expect(s.players.b.survivalMs).toBeGreaterThan(s.players.a.survivalMs);
  });

  it("weights a tag at five survival spans", () => {
    const p = { ...running().players.a, tags: 2, survivalMs: 4_999 };
    expect(scoreOf(p)).toBe(10);
  });

  it("exposes combined scores through the generic roster", () => {
    let s = tick(running(), 0.001);
    s.players.a.tags = 1;
    s = tick(s, SURVIVAL_SPAN_MS / 1000);
    const rows = roster(s);
    expect(rows.find((r) => r.id === "a")?.score).toBe(5);
    expect(rows.find((r) => r.id === "b")?.score).toBe(1);
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
        it: false,
        stunned: false,
        dashing: false,
        grace: false,
      },
    ]);
    expect(view(s).itPlayerId).toBeNull();
    expect(view(s).walls.length).toBeGreaterThan(0);
  });

  it("rejects input payloads that are not tag inputs", () => {
    expect(
      sampleTagGame.inputSchema.safeParse({
        type: "input",
        seq: 0,
        op: "move",
        direction: "up",
      }).success,
    ).toBe(true);
    expect(
      sampleTagGame.inputSchema.safeParse({ type: "input", seq: 0, op: "stop" })
        .success,
    ).toBe(true);
    expect(
      sampleTagGame.inputSchema.safeParse({ type: "input", seq: 0, op: "dash" })
        .success,
    ).toBe(true);
    expect(
      sampleTagGame.inputSchema.safeParse({
        type: "input",
        seq: 0,
        direction: "up",
      }).success,
    ).toBe(false);
    expect(
      sampleTagGame.inputSchema.safeParse({
        type: "input",
        seq: 0,
        op: "move",
        direction: "up",
        cheat: 1,
      }).success,
    ).toBe(false);
  });

  it("ignores input and keeps scores at zero outside the running phase", () => {
    let s = base();
    const x = s.players.a.x;
    s = sampleTagGame.applyInput(
      s,
      "a",
      { type: "input", seq: 1, op: "move", direction: "right" },
      1,
    );
    expect(s.players.a.x).toBe(x);
    expect(sampleTagGame.getResults(s).map((r) => r.score)).toEqual([0, 0]);
  });
});
