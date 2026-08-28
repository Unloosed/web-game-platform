import { describe, expect, it } from "vitest";
import {
  DEFAULT_GAME_ID,
  gameIdSchema,
  getGame,
  gameRegistry,
  listGames,
} from "../src/index.js";

describe("game registry", () => {
  it("hosts at least the reference game and the second reference game", () => {
    expect(DEFAULT_GAME_ID).toBe("sample-tag");
    expect(Object.keys(gameRegistry).sort()).toEqual([
      "color-rush",
      "sample-tag",
    ]);
  });

  it("resolves definitions by id and returns null for unknown ids", () => {
    expect(getGame("sample-tag")?.metadata.id).toBe("sample-tag");
    expect(getGame("color-rush")?.metadata.id).toBe("color-rush");
    expect(getGame("does-not-exist")).toBeNull();
  });

  it("validates untrusted ids at the boundary", () => {
    expect(gameIdSchema.safeParse("sample-tag").success).toBe(true);
    expect(gameIdSchema.safeParse("nope").success).toBe(false);
    expect(gameIdSchema.safeParse(42).success).toBe(false);
  });

  it("lists metadata for the lobby without leaking definitions", () => {
    const games = listGames();
    expect(games.map((g) => g.id).sort()).toEqual(["color-rush", "sample-tag"]);
    for (const g of games) {
      expect(g.minPlayers).toBeGreaterThanOrEqual(2);
      expect(g.maxPlayers).toBeGreaterThanOrEqual(g.minPlayers);
      expect(g.name.length).toBeGreaterThan(0);
    }
  });

  it("keeps game ids unique across the registry", () => {
    const ids = listGames().map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [key, game] of Object.entries(gameRegistry)) {
      expect(game.metadata.id).toBe(key);
    }
  });
});
