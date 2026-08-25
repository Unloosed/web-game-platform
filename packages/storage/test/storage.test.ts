import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LocalDiskStorage } from "../src/index.js";

const root = await mkdtemp(join(tmpdir(), "webgame-storage-"));
const storage = new LocalDiskStorage(root);

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(root, { recursive: true, force: true });
});

describe("LocalDiskStorage", () => {
  it("round-trips objects with a stable etag", async () => {
    const { key, etag } = await storage.put(Buffer.from("asset-bytes"));
    const object = await storage.get(key);
    expect(object?.data.toString()).toBe("asset-bytes");
    expect(object?.etag).toBe(etag);
  });

  it("stores generated keys in sharded directories", async () => {
    const { key } = await storage.put(Buffer.from("x"));
    const shard = key.slice(0, 2);
    const raw = await readFile(join(root, shard, key));
    expect(raw.toString()).toBe("x");
  });

  it("returns null for missing objects and true/false for exists", async () => {
    expect(await storage.get("nope")).toBeNull();
    expect(await storage.exists("nope")).toBe(false);
    const { key } = await storage.put(Buffer.from("y"));
    expect(await storage.exists(key)).toBe(true);
    expect(await storage.delete(key)).toBe(true);
    expect(await storage.exists(key)).toBe(false);
    expect(await storage.delete(key)).toBe(false);
  });

  it("rejects path traversal keys", async () => {
    await expect(storage.get("../../etc/passwd")).rejects.toThrow(
      "invalid_storage_key",
    );
    await expect(
      storage.put(Buffer.from("z"), "..\\..\\secret"),
    ).rejects.toThrow("invalid_storage_key");
  });
});
