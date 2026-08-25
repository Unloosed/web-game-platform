# Web Game Platform — Milestone 3/3.1

Milestone 3 (plus the 3.1 lifecycle repair) is a local, server-authoritative multiplayer tag arena: cookie-backed dev login, public/private invite-code lobbies, persistent membership/chat/matches, an authoritative 20 Hz room loop, scoring/tagging, match timer/results, ready-up gating before start, server-authorized spectator mode, reconnect-grace state retention, idempotent completion with rematch, Vitest tests, and Playwright suites.

## Run locally

Prerequisites: Node 20+, pnpm 9+, Docker.

```bash
pnpm install
pnpm exec playwright install chromium
pnpm db:reset
pnpm dev
```

Open `http://localhost:5173`. Create a room in one browser profile. Use another browser profile/incognito window to sign in as a second user and join using the displayed six-character code. Both players press **Ready up**; the host then presses **Start match** and both use arrow keys/WASD. Spectators can enable **Spectate only** at any time.

Set `GAME_MATCH_MS` (e.g. `8000`) in `.env` for quick matches while developing or running the lifecycle E2E suite; default is 60000.

## Test

```bash
pnpm test        # unit tests (no infra required)
pnpm lint        # eslint
# E2E requires Docker infra (pnpm db:reset) and pnpm dev running:
pnpm test:e2e
```

E2E suites: `tests/e2e/multiplayer.spec.ts` (ready-up/start/movement), `tests/e2e/api-lifecycle.spec.ts` (authorization, chat persistence, lifecycle persistence), and `tests/e2e/room-lifecycle.spec.ts` (match completion/results/rematch, reconnect within grace via a reused browser session, spectator view).

## Scope notes

Authentication is development-grade sign-in, but socket identity is no longer trusted from the client: the browser exchanges its session for a one-time token (`POST /auth/socket-token`) and the game-server verifies it server-side at handshake. Milestone 4 must add production OAuth/OIDC, Socket.IO Redis adapter rollout guidance beyond single-room sticky routing, payload/CSRF hardening defaults, and durable game-state persistence across restarts.
