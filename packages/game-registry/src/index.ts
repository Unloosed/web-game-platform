import { z } from "zod";
import type { AnyGameDefinition, GameMetadata } from "../../protocol/src/index.js";
import { sampleTagGame } from "../../sample-game/src/index.js";
import { colorRushGame } from "../../color-rush/src/index.js";

/**
 * The server-side game registry: the single place a game package is
 * installed. The API validates room creation against it; the realtime
 * server resolves the definition from the room's persisted game id.
 * Registering a new game is an edit here plus the game package itself —
 * never a change to generic room/tick/protocol internals.
 */
export const DEFAULT_GAME_ID = sampleTagGame.metadata.id;

export const gameRegistry: Record<string, AnyGameDefinition> = {
  [sampleTagGame.metadata.id]: sampleTagGame,
  [colorRushGame.metadata.id]: colorRushGame,
};

/** Validates untrusted game ids at the API boundary. */
export const gameIdSchema = z
  .string()
  .refine((id) => id in gameRegistry, { message: "unknown_game" });

export function getGame(gameId: string): AnyGameDefinition | null {
  return gameRegistry[gameId] ?? null;
}

export function listGames(): GameMetadata[] {
  return Object.values(gameRegistry).map((game) => game.metadata);
}
