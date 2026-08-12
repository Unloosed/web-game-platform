# Web Game Platform — Milestone 3

Milestone 3 is a local, server-authoritative multiplayer tag arena: cookie-backed dev login, public/private invite-code lobbies, persistent membership/chat/matches, an authoritative 20 Hz room loop, scoring/tagging, match timer/results, spectator mode, reconnect-grace state retention, Vitest tests, and a Playwright smoke test.

## Run locally

Prerequisites: Node 20+, pnpm 9+, Docker.

```bash
pnpm install
pnpm exec playwright install chromium
pnpm db:reset
pnpm dev
```

Open `http://localhost:5173`. Create a room in one browser profile. Use another browser profile/incognito window to sign in as a second user and join using the displayed six-character code. Host presses **Start match**; both players use arrow keys/WASD.

## Test

```bash
pnpm test
# with Docker infra and pnpm dev already running
pnpm test:e2e
```

## Scope notes

This is deliberately development-grade authentication. The game server trusts the browser-provided user identity, while the API validates room membership for HTTP APIs. Milestone 4 must add signed socket auth/session verification, Socket.IO Redis adapter, rate limits, production cookie settings, CSRF, and durable game-state persistence.
