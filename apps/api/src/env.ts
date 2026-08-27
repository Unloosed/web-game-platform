import { z } from "zod";

export const env = z
  .object({
    DATABASE_URL: z
      .string()
      .default("postgres://webgame:webgame@localhost:5432/webgame"),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    PORT: z.coerce.number().default(4000),
    CORS_ORIGIN: z.string().default("http://localhost:5173"),
    GAME_SERVER_SECRET: z
      .string()
      .min(32, "GAME_SERVER_SECRET must be at least 32 characters"),
    GAME_SERVER_URL: z.string().default("http://localhost:4100"),
    EMPTY_ROOM_TTL_MS: z.coerce.number().default(600_000),
    NODE_ENV: z.enum(["development", "production"]).default("development"),
    TRUST_PROXY: z.coerce.boolean().default(false),
    MODERATION_BANNED_WORDS: z.string().default("spam,scam"),
    SOCKET_TOKEN_TTL_MS: z.coerce.number().default(60_000),
    LOGIN_RATE_LIMIT: z.coerce.number().default(10),
  })
  .parse(process.env);

export const isProduction = env.NODE_ENV === "production";
