import { describe, expect, it, vi } from "vitest";
import {
  isChatAllowed,
  MetricsRegistry,
  parseBannedWords,
  rateLimit,
  type RateLimitStore,
} from "../src/index.js";

function fakeStore(): RateLimitStore & { data: Map<string, number> } {
  const data = new Map<string, number>();
  return {
    data,
    incr: async (key) => {
      const next = (data.get(key) ?? 0) + 1;
      data.set(key, next);
      return next;
    },
    pExpire: vi.fn(async () => 1),
  };
}

describe("rateLimit", () => {
  it("allows up to the limit and rejects beyond it", async () => {
    const store = fakeStore();
    const first = await rateLimit(store, "chat:user1", 2, 60_000);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(1);

    await rateLimit(store, "chat:user1", 2, 60_000);
    const third = await rateLimit(store, "chat:user1", 2, 60_000);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBe(60_000);
  });

  it("isolates buckets by key", async () => {
    const store = fakeStore();
    await rateLimit(store, "chat:a", 1, 60_000);
    const other = await rateLimit(store, "chat:b", 1, 60_000);
    expect(other.allowed).toBe(true);
  });

  it("sets the window TTL on the first hit only", async () => {
    const store = fakeStore();
    await rateLimit(store, "k", 5, 30_000);
    await rateLimit(store, "k", 5, 30_000);
    expect(store.pExpire).toHaveBeenCalledTimes(1);
  });
});

describe("MetricsRegistry", () => {
  it("renders counters and gauges in Prometheus text format", () => {
    const registry = new MetricsRegistry();
    registry.counter("requests_total", "Total requests");
    registry.gauge("rooms_active", "Active rooms");
    registry.increment("requests_total", { route: "/health" });
    registry.increment("requests_total", { route: "/health" });
    registry.set("rooms_active", 3);

    const text = registry.render();
    expect(text).toContain("# TYPE requests_total counter");
    expect(text).toContain('requests_total{route="/health"} 2');
    expect(text).toContain("rooms_active 3");
  });
});

describe("moderation filter", () => {
  const words = parseBannedWords("spam, badword");

  it("parses comma separated words ignoring blanks", () => {
    expect(parseBannedWords(" a , ,b ")).toEqual(["a", "b"]);
  });

  it("blocks banned whole words but not substrings", () => {
    expect(isChatAllowed("this is spam", words)).toBe(false);
    expect(isChatAllowed("SPAM!", words)).toBe(false);
    expect(isChatAllowed("spamburger is fine", words)).toBe(true);
    expect(isChatAllowed("hello world", words)).toBe(true);
  });

  it("matches punctuation-wrapped terms", () => {
    expect(isChatAllowed("nice (badword) there", words)).toBe(false);
  });
});
