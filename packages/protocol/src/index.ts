import { z } from "zod";
export const directionSchema = z.enum(["up", "down", "left", "right", "none"]);
export const inputSchema = z.object({
  type: z.literal("input"),
  seq: z.number().int().nonnegative(),
  direction: directionSchema,
});
export const chatSchema = z.object({
  type: z.literal("chat"),
  text: z.string().trim().min(1).max(500),
});
export const readySchema = z.object({
  type: z.literal("ready"),
  ready: z.boolean(),
});
export const clientEventSchema = z.union([
  inputSchema,
  chatSchema,
  readySchema,
]);
export type Direction = z.infer<typeof directionSchema>;
export type ClientEvent = z.infer<typeof clientEventSchema>;
export type Player = {
  id: string;
  name: string;
  x: number;
  y: number;
  color: string;
  tags: number;
  spectator: boolean;
  ready: boolean;
};
export type Snapshot = {
  type: "snapshot";
  roomCode: string;
  phase: "waiting" | "running" | "completed";
  remainingMs: number;
  itPlayerId: string | null;
  players: Player[];
  results?: Player[];
};
