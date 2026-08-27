// Object storage abstraction for game assets and player-uploaded content.
// The interface is deliberately small (put/get/delete/exists) and keyed by
// opaque object keys, so a future S3-compatible implementation only has to
// swap the adapter chosen at startup. The local filesystem adapter is the
// default and is suitable for single-node self-hosting.

import { createHash, createHmac, randomUUID } from "node:crypto";
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

/**
 * AWS Signature Version 4 for S3 requests, with no SDK dependency.
 * Exported for known-answer testing against the AWS documentation vector.
 */
export type SigV4Input = {
  method: string;
  host: string;
  path: string;
  /** Canonical (already URI-encoded) query string, "" when absent. */
  query?: string;
  payload: Buffer;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  amzDate: string;
  /** Additional headers to sign, e.g. content-type or range. */
  headers?: Record<string, string>;
};

export function signS3Request(input: SigV4Input): Record<string, string> {
  const payloadHash = createHash("sha256").update(input.payload).digest("hex");
  const dateStamp = input.amzDate.slice(0, 8);

  const headerMap: Record<string, string> = {
    host: input.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": input.amzDate,
    ...Object.fromEntries(
      Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };
  const signedNames = Object.keys(headerMap).sort();
  const canonicalHeaders = signedNames
    .map((name) => `${name}:${headerMap[name].trim()}\n`)
    .join("");
  const signedHeaders = signedNames.join(";");

  const canonicalRequest = [
    input.method,
    input.path,
    input.query ?? "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  let key: Buffer = createHmac("sha256", `AWS4${input.secretAccessKey}`)
    .update(dateStamp)
    .digest();
  key = createHmac("sha256", key).update(input.region).digest();
  key = createHmac("sha256", key).update("s3").digest();
  key = createHmac("sha256", key).update("aws4_request").digest();
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");

  return {
    ...input.headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": input.amzDate,
  };
}

export type S3StorageOptions = {
  /** e.g. https://s3.us-east-1.amazonaws.com or an S3-compatible endpoint such as http://localhost:9000 */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/** S3-compatible adapter using path-style addressing (works with MinIO et al). */
export class S3Storage implements StorageAdapter {
  constructor(private readonly options: S3StorageOptions) {}

  async put(
    data: Buffer,
    key = randomUUID(),
  ): Promise<{ key: string; etag: string }> {
    const response = await this.request("PUT", key, data);
    if (!response.ok) {
      throw new Error(`s3_put_failed_${response.status}`);
    }
    return { key, etag: etagOf(data) };
  }

  async get(key: string): Promise<StorageObject | null> {
    const response = await this.request("GET", key);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`s3_get_failed_${response.status}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    return { key, data, etag: etagOf(data) };
  }

  async delete(key: string): Promise<boolean> {
    const response = await this.request("DELETE", key);
    return response.ok || response.status === 404;
  }

  async exists(key: string): Promise<boolean> {
    const response = await this.request("HEAD", key);
    return response.ok;
  }

  private request(
    method: string,
    key: string,
    payload: Buffer = Buffer.alloc(0),
  ): Promise<Response> {
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const path = `/${this.options.bucket}/${encodedKey}`;
    const host = new URL(this.options.endpoint).host;
    const amzDate = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");

    return fetch(`${this.options.endpoint}${path}`, {
      method,
      headers: signS3Request({
        method,
        host,
        path,
        payload,
        accessKeyId: this.options.accessKeyId,
        secretAccessKey: this.options.secretAccessKey,
        region: this.options.region,
        amzDate,
      }),
      body: method === "PUT" ? new Uint8Array(payload) : undefined,
    });
  }
}
