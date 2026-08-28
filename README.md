# Web Game Platform — Milestone 5

Milestones 3, 3.1 (lifecycle repair), 4 (hardening), and 5 (game plugin architecture) are complete: cookie-backed dev login, public/private invite-code lobbies, persistent membership/chat/matches, an authoritative 20 Hz room loop, match timer/results, ready-up gating before start, server-authorized spectator mode, reconnect-grace state retention, idempotent completion with rematch, achievements, moderation reports with admin review, room-scoped kicks, connection quotas, protocol-version handshake validation, CSRF origin policy, Prometheus metrics, Vitest tests, and Playwright suites.

Since Milestone 5 the platform hosts **multiple games** through a formal plugin seam:

- `sample-tag` (Tag Arena) — the reference server-authoritative tag game.
- `color-rush` (Color Rush) — orb-collection race with dash boosts, added with **zero changes** to platform internals.

Games register in `packages/game-registry` (server) and the `gameViews` map in `apps/web/src/main.tsx` (client); rooms persist their game in `rooms.game_id`; the realtime server resolves each room's definition from that persisted id; the lobby's game selector, `GET /games`, and the per-game leaderboard (`GET /leaderboard?game=<gameId>`) are registry-driven. **To add a new game, follow `docs/web-game-platform-game-plugin-guide.md`** — it documents the `GameDefinition` contract, standards, testing requirements, and the author checklist.

## Run locally

Prerequisites: Node 20+, pnpm 9+, Docker.

```bash
pnpm install
pnpm exec playwright install chromium
pnpm db:reset   # fresh DB includes the Milestone 5 schema
pnpm dev
```

Existing databases need one migration applied manually: `infra/migrations/005-milestone-5-game-registry.sql` (adds `rooms.game_id`, renames `match_players.tags` to `score`).

Open `http://localhost:5173`. Create a room in one browser profile — pick the game in the create-room selector. Use another browser profile/incognito window to sign in as a second user and join using the displayed six-character code. Both players press **Ready up**; the host then presses **Start match** and both use arrow keys/WASD (Color Rush: Space dashes). Spectators can enable **Spectate only** at any time.

Set `GAME_MATCH_MS` (e.g. `8000`) in `.env` for quick matches while developing or running the lifecycle E2E suite; default is 60000.

## Test

```bash
pnpm test        # unit tests (no infra required)
pnpm typecheck
pnpm lint        # eslint
# E2E requires Docker infra (pnpm db:reset) and pnpm dev running:
pnpm test:e2e
```

E2E suites: `tests/e2e/multiplayer.spec.ts` (ready-up/start/movement), `tests/e2e/color-rush.spec.ts` (second game end to end), `tests/e2e/api-lifecycle.spec.ts` (authorization, chat persistence, lifecycle persistence, achievements), and `tests/e2e/room-lifecycle.spec.ts` (match completion/results/rematch, reconnect within grace via a reused browser session, spectator view).

## Scope notes

Authentication is development-grade sign-in, but socket identity is never trusted from the client: the browser exchanges its session for a one-time token (`POST /auth/socket-token`) and the game-server verifies it server-side at handshake — alongside the protocol version (v2), per-user/per-IP connection quotas, and the room's persisted game id. Production OAuth/OIDC and an OpenTelemetry trace SDK deployment remain the main operational follow-ups.
