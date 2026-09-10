import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { storage } from "../context.js";

const CONTENT_TYPES: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  json: "application/json",
};

// Flat object keys only (storage adapter shards by key prefix); this also
// keeps the route surface simple for a public, read-only asset cache.
const keySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export async function assetRoutes(app: FastifyInstance): Promise<void> {
  app.get("/assets/:key", async (req, reply) => {
    const parsed = keySchema.safeParse((req.params as { key: string }).key);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_asset_key" };
    }

    const obj = await storage.get(parsed.data);
    if (!obj) {
      reply.code(404);
      return { error: "asset_not_found" };
    }

    const ext = parsed.data.split(".").pop() ?? "";
    reply
      .header("content-type", CONTENT_TYPES[ext] ?? "application/octet-stream")
      .header("cache-control", "public, max-age=86400");
    return reply.send(obj.data);
  });
}
