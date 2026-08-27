import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LocalDiskStorage, signS3Request } from "../src/index.js";

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

describe("S3 signing", () => {
  // Known-answer test from the AWS SigV4 documentation (GET Object example,
  // which signs host, range, x-amz-content-sha256, and x-amz-date).
  it("matches the AWS SigV4 documentation test vector", () => {
    const headers = signS3Request({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      payload: Buffer.alloc(0),
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      amzDate: "20130524T000000Z",
      headers: { Range: "bytes=0-9" },
    });

    expect(headers["x-amz-content-sha256"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 " +
        "Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
});
