// Shared platform primitives used by apps/api and apps/game-server:
// Redis fixed-window rate limiting, a small Prometheus-style metrics
// registry, and chat moderation filtering.

/** Minimal async command surface of the redis v4 client used here. */
export type RateLimitStore = {
  incr(key: string): Promise<number>;
  pExpire(key: string, ms: number): Promise<unknown>;
};

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

/**
 * Fixed-window rate limit check. One Redis INCR per check; the first hit
 * of a window sets its TTL. Window boundaries can drift by up to one
 * window's worth of requests under races, which is acceptable for abuse
 * protection.
 */
export async function rateLimit(
  store: RateLimitStore,
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitDecision> {
  const redisKey = `rl:${key}`;
  const count = await store.incr(redisKey);
  if (count === 1) {
    await store.pExpire(redisKey, windowMs);
  }
  const allowed = count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - count),
    retryAfterMs: allowed ? 0 : windowMs,
  };
}

export type MetricsLabels = Record<string, string>;

type Metric = {
  help: string;
  type: "counter" | "gauge";
  values: Map<string, { labels: MetricsLabels; value: number }>;
};

/**
 * Minimal Prometheus text-exposition metrics registry. Counters only ever
 * increase; gauges are set to the latest observed value. Label sets are
 * keyed deterministically so scraping stays cheap for platform cardinality.
 */
export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();

  counter(name: string, help: string): void {
    this.ensure(name, help, "counter");
  }

  gauge(name: string, help: string): void {
    this.ensure(name, help, "gauge");
  }

  increment(name: string, labels: MetricsLabels = {}, by = 1): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== "counter") return;
    const entry = this.entry(metric, labels);
    entry.value += by;
  }

  set(name: string, value: number, labels: MetricsLabels = {}): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== "gauge") return;
    this.entry(metric, labels).value = value;
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, metric] of [...this.metrics.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`# HELP ${name} ${metric.help}`);
      lines.push(`# TYPE ${name} ${metric.type}`);
      for (const { labels, value } of [...metric.values.values()]
        .sort((a, b) =>
          labelKey(a.labels).localeCompare(labelKey(b.labels)),
        )) {
        lines.push(`${name}${renderLabels(labels)} ${value}`);
      }
    }
    return lines.join("\n") + "\n";
  }

  private ensure(
    name: string,
    help: string,
    type: "counter" | "gauge",
  ): void {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, { help, type, values: new Map() });
    }
  }

  private entry(metric: Metric, labels: MetricsLabels) {
    const key = labelKey(labels);
    let entry = metric.values.get(key);
    if (!entry) {
      entry = { labels, value: 0 };
      metric.values.set(key, entry);
    }
    return entry;
  }
}

function labelKey(labels: MetricsLabels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
}

function renderLabels(labels: MetricsLabels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${k}="${escapeLabel(labels[k])}"`).join(",")}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Chat moderation filter. Blocks messages containing any configured banned
 * term as a whole word (ASCII case-insensitive). The default list is a
 * small seed; operators extend it with MODERATION_BANNED_WORDS (comma
 * separated) in the environment.
 */
export function parseBannedWords(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length > 0);
}

export function isChatAllowed(
  message: string,
  bannedWords: string[],
): boolean {
  const normalized = message.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const terms = bannedWords.map((word) => word.replace(/[^a-z0-9]/g, ""));
  return terms.every(
    (term) =>
      term.length === 0 || !new RegExp(`\\b${escapeRegex(term)}\\b`).test(normalized),
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
