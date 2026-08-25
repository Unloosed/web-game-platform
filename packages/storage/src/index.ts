// Object storage abstraction for game assets and player-uploaded content.
// The interface is deliberately small (put/get/delete/exists) and keyed by
// opaque object keys, so a future S3-compatible implementation only has to
// swap the adapter chosen at startup. The local filesystem adapter is the
// default and is suitable for single-node self-hosting.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export type StorageObject = {
  key: string;
  data: Buffer;
  etag: string;
};

export interface StorageAdapter {
  put(data: Buffer, key?: string): Promise<{ key: string; etag: string }>;
  get(key: string): Promise<StorageObject | null>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
}

/** Content-addressed fragment layout avoids one giant directory. */
function keyToPath(root: string, key: string): string {
  if (
    key.split(/[\\/]/).some((segment) => segment === ".." || segment.length === 0)
  ) {
    throw new Error("invalid_storage_key");
  }
  return resolve(join(root, key.slice(0, 2), key));
}

export class LocalDiskStorage implements StorageAdapter {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(
    data: Buffer,
    key = randomUUID(),
  ): Promise<{ key: string; etag: string }> {
    const path = keyToPath(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return { key, etag: etagOf(data) };
  }

  async get(key: string): Promise<StorageObject | null> {
    const path = this.assertKey(key);
    try {
      const data = await readFile(path);
      return { key, data, etag: etagOf(data) };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<boolean> {
    const path = this.assertKey(key);
    try {
      await rm(path);
      return true;
    } catch {
      return false;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  private assertKey(key: string): string {
    const path = keyToPath(this.root, key);
    if (!path.startsWith(this.root + sep) && path !== this.root) {
      throw new Error("invalid_storage_key");
    }
    return path;
  }
}

function etagOf(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 32);
}
