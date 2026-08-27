# Deployment Guide

This guide covers deploying the Web Game Platform on a generic container
platform (single Docker host, Compose, Kubernetes-style schedulers). The
stack is: web client (nginx static), API (Fastify), game-server (Socket.IO),
PostgreSQL, Redis.

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | api | PostgreSQL connection string |
| `REDIS_URL` | api, game-server | Redis URL; when set on the game-server it also enables the Socket.IO Redis adapter |
| `PORT` / `GAME_PORT` | api / game-server | Listen ports (4000 / 4100) |
| `CORS_ORIGIN` | api, game-server | Exact browser origin allowed for credentialed requests and sockets |
| `GAME_SERVER_SECRET` | api, game-server | Shared secret for server-to-server internal routes; minimum 32 characters |
| `GAME_SERVER_URL` | api | Base URL of the game-server for moderation kick/close calls |
| `API_URL` | game-server | Base URL of the API for lifecycle and handshake verification calls |
| `NODE_ENV` | api | `production` enables secure cookies |
| `TRUST_PROXY` | api | `true` when behind a reverse proxy, so `req.ip` reflects `X-Forwarded-For` |
| `MODERATION_BANNED_WORDS` | api, game-server | Comma-separated banned chat terms |
| `ROOM_RECONNECT_GRACE_MS` | game-server | Reconnect grace before player state is dropped |
| `GAME_MATCH_MS` | game-server | Match duration for the sample tag game (60000); lower it in test environments for faster end-to-end runs |
| `MAX_SOCKETS_PER_USER` | game-server | Connection quota per account (4) |
| `MAX_SOCKETS_PER_IP` | game-server | Connection quota per client IP (16) |
| `EMPTY_ROOM_TTL_MS` | api | Cleanup age for never-joined waiting rooms |
| `SOCKET_TOKEN_TTL_MS` | api | Lifetime of one-time socket handshake tokens |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | api | Optional S3-compatible object storage credentials for `packages/storage` `S3Storage` (works with MinIO and other path-style endpoints) |

All secrets come from the environment; never commit them. Generate the
shared secret with `openssl rand -base64 48`.

### CSRF and origin policy

The API rejects state-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`)
that carry an `Origin` header outside `CORS_ORIGIN` (comma-separated list
allowed). Server-to-server callers and scripts send no `Origin` header and
are unaffected; browsers are protected against cross-site cookie use. Set
`CORS_ORIGIN` to the exact public web origin when deploying.

## Docker Compose

`docker-compose.prod.yml` builds multi-stage images (non-root `node` user
for API and game-server, nginx for static web) and wires healthchecks:

```bash
export PUBLIC_ORIGIN="https://games.example.com"
export PUBLIC_API_URL="https://api.games.example.com"
export PUBLIC_GAME_URL="https://realtime.games.example.com"
export POSTGRES_PASSWORD="$(openssl rand -base64 24)"
export GAME_SERVER_SECRET="$(openssl rand -base64 48)"
docker compose -f docker-compose.prod.yml up -d --build
```

For existing databases initialized before milestone 4, apply
`infra/migrations/002-milestone-4.sql` once. Databases initialized before
milestone 3.1 also need `infra/migrations/003-room-member-ready.sql`
(per-membership ready state), and milestone 4 adds
`infra/migrations/004-milestone-4-hardening.sql` (achievements, reports).

## Reverse proxy and WebSocket upgrades

Terminate TLS at your edge proxy and forward to the three services. The
game-server needs HTTP upgrade support and long timeouts:

```nginx
location / {
    proxy_pass http://game-server:4100;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 300s;
}
```

Caddy equivalent: `reverse_proxy game-server:4100` handles upgrades
automatically. Set `TRUST_PROXY=true` on the API when proxying so rate
limits see client IPs.

## Scaling notes

- **Socket.IO Redis adapter**: with `REDIS_URL` set, broadcasts fan out
  across game-server replicas.
- **Room ownership is process-local**: each room's authoritative simulation
  lives in exactly one game-server process. To run multiple replicas you
  must (a) route all sockets for a given room code to the same replica
  (sticky by room code, not only by session), and (b) direct the API's
  `GAME_SERVER_URL` moderation calls through that routing. Single-replica
  game-server with multiple API replicas is the simplest supported
  horizontal shape today.
- **Health/readiness**: `GET /health/ready` (API) checks Postgres and
  Redis; `GET /health` (both services) is a liveness probe.
- **Metrics**: `GET /metrics` on both API (4000) and game-server (4100)
  exposes Prometheus text format — requests, rate-limit rejections,
  moderation actions and rejections, active rooms, active matches,
  connected players, verified handshakes, protocol/quota rejections,
  snapshot broadcasts, tick latency, lifecycle failures, input/chat
  rejections, match completions. Any OpenTelemetry Collector with the
  Prometheus receiver can scrape these; add the OpenTelemetry trace SDK
  only when an operator runs a collector for distributed tracing.
- **Logs**: both services emit newline-delimited JSON structured logs.
  Correlation: the API honors/echoes `x-request-id` on every request.

## Object storage

`packages/storage` defines the `StorageAdapter` interface with two
implementations: a local filesystem adapter (sharded, traversal-safe,
content-hashed etags — mount a volume for single-node deployments) and an
S3-compatible adapter (`S3Storage`, path-style, AWS Signature V4, no SDK
dependency — works with S3, MinIO, and compatible stores via the
`S3_*` environment variables). Choose the adapter at startup; call sites
are unchanged either way.
