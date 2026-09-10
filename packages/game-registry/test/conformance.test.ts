import { describe, expect, it } from "vitest";
import type {
  AnyGameDefinition,
  AnyGameState,
} from "../../protocol/src/index.js";
import { gameRegistry } from "../src/index.js";

/**
 * Platform-contract conformance, driven generically over every game in
 * the registry. These encode the "hard requirements" from
 * docs/web-game-platform-game-plugin-guide.md §3, so a game becomes
 * covered the moment it registers — per-game rules still get their own
 * tests in packages/<game>/test.
 */

/** Builds a waiting state with `players` ready-able participants and
 * `spectators` spectators, using only GameDefinition calls. */
function seed(
  game: AnyGameDefinition,
  players: number,
  spectators = 0,
): ReturnType<AnyGameDefinition["createState"]> {
  let state = game.createState(60_000);
  for (let i = 0; i < players; i++) {
    state = game.addPlayer(state, {
      userId: `p${i}`,
      displayName: `P${i}`,
      spectator: false,
    });
  }
  for (let i = 0; i < spectators; i++) {
    state = game.addPlayer(state, {
      userId: `s${i}`,
      displayName: `S${i}`,
      spectator: true,
    });
  }
  return state;
}

function readyAll(
  game: AnyGameDefinition,
  state: ReturnType<AnyGameDefinition["createState"]>,
): ReturnType<AnyGameDefinition["createState"]> {
  for (const row of game.roster(state)) {
    if (!row.spectator) state = game.setReady(state, row.id, true);
  }
  return state;
}

/** Advances a running match until the game completes (or the loop cap
 * trips, which fails the suite via the phase assertion). */
function runToCompletion(
  game: AnyGameDefinition,
  state: AnyGameState,
): AnyGameState {
  let next: AnyGameState = { ...state, phase: "running" };
  for (let i = 0; i < 400 && next.phase === "running"; i++) {
    next = game.tick(next, 0.5);
  }
  return next;
}

const ROSTER_KEYS = ["id", "name", "score", "spectator", "ready"].sort();

for (const [id, game] of Object.entries(gameRegistry)) {
  describe(`game contract: ${id}`, () => {
    it("seeds a waiting match honoring the requested match length", () => {
      const state = game.createState(30_000);
      expect(state.phase).toBe("waiting");
      expect(state.remainingMs).toBe(30_000);
    });

    it("returns a render payload object from view", () => {
      expect(game.view(seed(game, 1))).toBeTypeOf("object");
    });

    it("exposes generic roster rows keyed by userId", () => {
      const state = seed(game, 2, 1);
      const rows = game.roster(state);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(ROSTER_KEYS);
      }
      expect(rows.find((r) => r.id === "p1")?.name).toBe("P1");
      expect(rows.find((r) => r.id === "s0")?.spectator).toBe(true);
    });

    it("restores readiness without duplicating the player on reconnect", () => {
      let state = seed(game, 1);
      state = game.addPlayer(state, {
        userId: "p0",
        displayName: "P0-renamed",
        spectator: false,
        ready: true,
      });
      const rows = game.roster(state);
      expect(rows).toHaveLength(1);
      expect(rows[0].ready).toBe(true);
      expect(rows[0].name).toBe("P0-renamed");
    });

    it("never lets spectators become ready or count toward start", () => {
      const count = Math.max(1, game.metadata.minPlayers - 1);
      let state = readyAll(game, seed(game, count, 1));
      expect(game.roster(state).find((r) => r.id === "s0")?.ready).toBe(false);
      expect(game.canStartMatch(state)).toBe(false);

      // With the full cast ready, spectators no longer block the start.
      state = readyAll(game, seed(game, game.metadata.minPlayers, 1));
      expect(game.canStartMatch(state)).toBe(true);
    });

    it("toggles the spectator flag through setSpectator", () => {
      let state = seed(game, 1);
      state = game.setSpectator(state, "p0", true);
      expect(game.roster(state)[0].spectator).toBe(true);
      state = game.setSpectator(state, "p0", false);
      expect(game.roster(state)[0].spectator).toBe(false);
    });

    it("no-ops tick and applyInput outside the running phase", () => {
      const state = readyAll(game, seed(game, 2));
      const before = game.roster(state);

      const ticked = game.tick(state, 1);
      expect(ticked.phase).toBe("waiting");
      expect(ticked.remainingMs).toBe(state.remainingMs);

      const applied = game.applyInput(ticked, "p0", {}, 1);
      expect(game.roster(applied)).toEqual(before);
    });

    it("rejects input payloads with unknown fields", () => {
      expect(
        game.inputSchema.safeParse({ type: "input", seq: 0, cheat: 1 })
          .success,
      ).toBe(false);
    });

    it("completes on timer expiry with generic sorted results", () => {
      const withSpectator = seed(game, game.metadata.minPlayers, 1);
      const completed = runToCompletion(game, readyAll(game, withSpectator));
      expect(completed.phase).toBe("completed");

      const results = game.getResults(completed);
      expect(results.length).toBeGreaterThan(0);
      for (let i = 0; i < results.length; i++) {
        expect(results[i].spectator).toBe(false);
        expect(Object.keys(results[i]).sort()).toEqual(ROSTER_KEYS);
        if (i > 0) {
          expect(results[i - 1].score).toBeGreaterThanOrEqual(
            results[i].score,
          );
        }
      }
      // Spectators never appear in results.
      expect(results.some((r) => r.id.startsWith("s"))).toBe(false);
    });
  });
}
