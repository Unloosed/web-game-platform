# Web Game Platform: Milestone Roadmap

This roadmap covers the reusable, self-hosted TypeScript Web Game Platform. It records completed work, identifies the active repair work, and defines the path to a production-ready, extensible platform.

## Status overview

| Milestone | Status | Primary outcome |
| --- | --- | --- |
| Milestone 1 | Completed | Monorepo, local infrastructure, API, realtime server, and two-browser movement vertical slice |
| Milestone 2 | Completed | Persistent dev users and sessions, lobby, persisted rooms, invite codes, and basic chat |
| Milestone 3 | Completed | Server-authoritative tag-game mechanics, score/timer UI, spectator baseline, and test scaffolding |
| Milestone 3.1 | Completed | Room lifecycle repair: lifecycle persistence boundaries, reconnect grace, server-authorized spectators, deterministic ready-gated startup, idempotent completion |
| Milestone 4 | Completed | Achievements, moderation reports, kick, connection quotas, protocol-version gating, CSRF policy, extended observability, S3-compatible storage |
| Milestone 5 | Completed | Formal game registry/plugin model (`packages/game-registry`, `rooms.game_id`), second game reference implementation (`packages/color-rush`), per-game leaderboard, and rewritten extension guide |

---

# Milestone 1: Platform vertical slice

**Status: Completed**

## Objective

Create a runnable foundation that proves the browser, HTTP API, realtime server, shared packages, Redis, and PostgreSQL can work together locally.

## Delivered

### Repository and developer tooling

- pnpm workspace monorepo and Turborepo task orchestration.
- Strict TypeScript base configuration.
- Shared ESLint, Prettier, and Vitest configuration foundations.
- Root commands for development, build, lint, formatting, and tests.
- Initial GitHub Actions CI workflow.

### Applications

- `apps/web`: React and Vite browser client with application shell and local room view.
- `apps/api`: Fastify application with environment validation, health routes, and DB/Redis connectivity checks.
- `apps/game-server`: Socket.IO realtime service with a server-side tick loop and in-memory local room.

### Shared packages

- `@webgame/core`: shared `GameDefinition`, room configuration, player identity, and room lifecycle concepts.
- `@webgame/protocol`: Zod-validated generic client/server events.
- `@webgame/ui`: initial design tokens plus shared card and button components.
- `@webgame/game-client`: Socket.IO client wrapper, keyboard input helper, and renderer-neutral render-state interface.
- `@webgame/game-server-sdk`: generic room wrapper and fixed-rate tick loop.
- `@webgame/sample-game`: basic top-down movement game used to validate the platform.

### Infrastructure

- Docker Compose services for PostgreSQL and Redis.
- Dockerfile foundations for API, game server, and web client.
- PostgreSQL initialization script.

## Acceptance criteria met

- A developer can run Postgres and Redis with Docker Compose.
- API health, database health, and Redis health endpoints respond locally.
- Two browser tabs can connect to a shared room and see authoritative server-synchronized movement.
- The project has clear app/package boundaries rather than a single tightly coupled game application.

## Deferred from Milestone 1

- Persistent identity.
- Room browser and invite codes.
- Durable room state.
- Real gameplay scoring and match outcomes.
- Production auth, rate limiting, observability, asset management, and engine-specific rendering.

---

# Milestone 2: Persistence, identity, lobby, and chat

**Status: Completed**

## Objective

Replace the purely in-memory local-room workflow with a persistent lobby and session-backed user experience while retaining the easy two-browser local multiplayer workflow.

## Delivered

### Persistent data model

- `users`: developer user records.
- `sessions`: server-side session records with expiry.
- `rooms`: persisted room metadata, visibility, invite code, host, capacity, and status.
- `room_members`: persistent player/host membership records.
- `chat_messages`: storage foundation for room chat history and future moderation.

### Developer authentication

- Development sign-in with a display name.
- Persistent user and session creation in PostgreSQL.
- HTTP-only `session_id` cookie.
- `GET /auth/me` to restore the browser session.

### Lobby and room API

- `GET /rooms` for public-room discovery.
- `POST /rooms` for room creation.
- `POST /rooms/join` for public and private invite-code entry.
- `GET /rooms/:code` for member-authorized room details.
- `POST /rooms/:code/start` as the initial host-only lifecycle operation.

### Lobby and room UI

- Login screen.
- Public lobby list.
- Public/private room creation controls.
- Join-by-code flow.
- Room UI containing the movement arena and realtime chat panel.

### Realtime rooms

- Game server supports multiple room codes instead of only `local-room`.
- Each active room receives an independent server-side `Room` instance and `TickLoop`.
- Basic `chat_message` broadcast reaches room participants.
- Empty realtime rooms stop their tick loop and are removed from memory.

## Acceptance criteria met

- A user can sign in locally, create a public or private room, and receive a code.
- A second browser context can sign in and join the same room via that code.
- Both participants see movement synchronization and chat.
- Users, sessions, room records, and membership records persist through browser reloads and service restarts.

## Known limitations carried forward

- Development sign-in is not production OAuth/OIDC.
- Game-server Socket.IO authentication is not yet validated against API sessions.
- Chat broadcasting exists, but persistent read/write history, moderation, and rate limits are not complete.
- The API room lifecycle status is not yet fully coupled to realtime match lifecycle.

---

# Milestone 3: Complete reference tag game

**Status: Completed**

## Objective

Turn the movement proof-of-concept into a complete reference multiplayer game: a server-authoritative 2D tag arena for 2–8 players with scoring, timer, post-match results, spectators, reconnect behavior, and meaningful automated tests.

## Implemented

### Sample-game state and rules

- Player state includes position, color, tag score, spectator flag, and ready flag.
- Match state includes current `itPlayerId`, remaining match time, and completion state.
- Server-side fixed-step simulation applies movement.
- Server-side collision/proximity logic transfers the “IT” role and awards tag points.
- Timer expiry produces a completed game state.
- Match duration is configurable through `GAME_MATCH_MS` for test environments.

### Client presentation

- Arena renders player positions.
- Current “IT” player has a visual highlight.
- Scoreboard sorts players by tag score and marks spectators and readiness.
- Timer and completion indicators are available in room UI.
- Spectator mode is membership-based and server-authorized; the local client suppresses input and the server rejects gameplay input from spectators regardless.

### Testing foundations

- Sample-game rule unit tests (movement gating, timer, readiness, IT reassignment).
- Protocol validation unit tests.
- Room-manager unit tests covering lifecycle, reconnect grace, authorization, and idempotent completion.
- Playwright E2E suites for sign-in/room creation/join/movement/scoreboard and lifecycle behavior.

### Milestone completion items

All previously outstanding items are now delivered:

- Milestone 3.1 lifecycle repair is complete (see below).
- API room status and realtime game phase coordinate through the internal lifecycle API; the game server is authoritative for live phase and persists transitions to PostgreSQL.
- Ready-up workflow with minimum-player conditions gates match start on both the realtime path (`start_match`) and the HTTP path (`POST /rooms/:code/start`).
- Completed match results persist once (idempotent at both source transition guard and database sink) and the post-game result view renders from the completed snapshot.
- Socket.IO handshake identity is validated server-side via one-time session tokens; clients never assert their own user id.
- The spectator toggle maps to a durable `spectator` membership role resolved during handshake and enforced live (role changes propagate to active sessions).
- Reconnect preservation is explicit: configurable grace timeout, stable logical player identity (`userId` + room), connection rebinding without duplication, and expiry-based cleanup.
- Playwright E2E uses deterministic assertions (roles, test IDs, disabled/enabled states) rather than style locators or timing-only waits.

---

# Milestone 3.1: Room lifecycle repair

**Status: Completed**

## Objective

Repair the boundary between persistent room lifecycle and in-memory realtime lifecycle so every game can rely on explicit state transitions and predictable cleanup/recovery.

## Delivered

- **Authoritative lifecycle owner**: the API owns durable room metadata; the game server owns live simulation. The server persists `waiting -> running -> completed` transitions through secret-guarded internal routes (`POST /internal/rooms/:code/lifecycle`), and completion writes one durable match record inside a transaction with an existing-match guard.
- **Ready-up workflow**: readiness is a durable per-membership column (`room_members.ready`, migration `003-room-member-ready.sql`), toggled in-room via a validated `ready` client event, mirrored to PostgreSQL through `POST /internal/rooms/:code/ready`, restored on reconnect from handshake verification, and enforced as a startup gate (minimum 2 non-spectator participants, all non-spectators ready) on both `start_match` and `restart_match` plus the HTTP start route.
- **Presence vs membership separation**: persistent membership survives without a live socket; disconnection enters a configurable reconnect-grace state (`ROOM_RECONNECT_GRACE_MS`), reconnect cancels pending removal and rebinds the connection without duplicating player state, and expiry removes the player.
- **Server-authorized spectators**: role resolved at handshake from durable membership; gameplay input from spectators is rejected by game rules regardless of client behavior; mid-session role changes propagate from the API to the live session (`POST /internal/users/:id/spectator`); spectators never count toward capacity or ready requirements and cannot hold the IT role.
- **Deterministic match startup**: rooms begin in `waiting`; movement and scoring only occur while `running`; host authorization, phase, participant count, and readiness are validated before any transition.
- **Idempotent completion**: a single source-side phase-transition guard plus a database-side existing-match guard ensure repeated ticks or snapshots cannot create multiple result records. The legacy HTTP complete route shares the same guard.
- **Empty-room cleanup**: never-joined waiting rooms are removed by an API TTL sweeper (`EMPTY_ROOM_TTL_MS`) and immediately by the game server when the last occupant of a waiting room leaves; running rooms are retained through reconnect grace and archived once abandoned (an abandoned match can never complete), completed rooms are retained for results.

## Target lifecycle

```text
creating -> waiting -> ready -> running -> paused -> completed -> archived
```

For the sample tag game, the minimum required normal path is:

```text
creating -> waiting -> ready -> running -> completed -> archived
```

## Required repairs

### 1. Establish one authoritative lifecycle owner

The API owns durable room metadata; the game server owns live simulation. They must coordinate through a shared room lifecycle contract.

- Creation writes a room at `waiting` in PostgreSQL.
- Join/leave updates durable membership and live presence.
- Ready state is stored per membership and broadcast through the game server.
- Host start is permitted only when room phase and ready/min-player rules allow it.
- The game server transitions `running -> completed` after the match ends.
- Completion causes a durable result write and a room lifecycle update.
- Archived rooms are unavailable for normal joining.

### 2. Separate lobby presence from active match sessions

- A player may be a persistent room member without a live Socket.IO connection.
- A live connection has an ephemeral connection ID.
- A logical room player uses stable `userId` plus room ID.
- A reconnect replaces/rebinds an ephemeral connection without duplicating logical player state.
- Disconnection enters a reconnect-grace state instead of immediately deleting simulation state.

### 3. Implement server-authorized spectator sessions

- A spectator uses an explicit server-side `isSpectator` session flag.
- Spectators receive snapshots and allowed public chat.
- Spectators cannot issue gameplay input.
- Spectators do not count toward ready requirements or player capacity unless a game explicitly opts in.

### 4. Make match startup deterministic

- Rooms start in `waiting`.
- Members explicitly ready/unready.
- Host invokes start request.
- Server validates host role, phase, player count, ready state, and game-specific rules.
- Only after validation does game state initialize its match timer and phase become `running`.
- No player movement or scoring occurs while waiting/ready/completed.

### 5. Make completion durable and idempotent

- The simulation emits a single completion signal.
- Completion writes match data once using a transaction or an idempotency key.
- Repeated ticks/snapshots after completion cannot create multiple result records.
- Results snapshot contains winner/ranking data, reason for completion, and completed timestamp.

### 6. Correct empty-room cleanup

- An empty waiting room may be retained for a configured period.
- A running room with temporarily disconnected players remains alive through reconnect grace.
- A completed room remains available long enough for results/replay UI, then archives.
- Tick loops stop only when no simulation/reconnect/archive transition work remains.

## Definition of done — met

- Lifecycle transitions are represented by shared types and validated by tests.
- API and game-server state cannot disagree without emitting a recoverable error/metric (lifecycle failures are logged and counted).
- One user reconnecting does not create a duplicate player entity (unit-tested and covered by E2E).
- Spectators cannot move or affect scores even if they manually emit input events (enforced in game rules; unit-tested).
- A match completes once, stores one outcome, broadcasts results, and becomes non-playable until a ready-gated rematch (unit-tested).
- Unit tests cover transitions, reconnect replacement, spectator authorization, start authorization, timeout, and idempotent completion (`apps/game-server/test/room-manager.test.ts`, `packages/sample-game/test/rules.test.ts`, `packages/protocol/test/protocol.test.ts`).
- Playwright coverage lives in `tests/e2e/`: `multiplayer.spec.ts` (ready-up/start), `api-lifecycle.spec.ts` (authorization, chat persistence, lifecycle persistence), and `room-lifecycle.spec.ts` (match completion/results/rematch, reconnect within grace using a reused browser session, spectator view).

---

# Milestone 4: Platform hardening and production operations

**Status: Completed**

## Objective

Add durable game outcomes, moderation, observability, abuse protection, production Docker/deployment artifacts, and operational controls.

## Delivered

### Persistent results and social features

- `matches`, `match_players` data models with history/leaderboard APIs and player profile views (`GET /users/:id/matches`, `GET /users/:id/achievements`, `GET /leaderboard`).
- Achievement contract (`packages/platform`): pure `MatchStats`-based evaluation with initial definitions (`first_match`, `first_win`, `sharpshooter`); awards persist in the `achievements` table inside the match-completion transaction and render in the lobby profile panel.
- Result write hook: `RoomLifecycleApi.persistCompletion` is the SDK-level hook the game server uses for every durable result write; the internal lifecycle route persists matches, players, and achievements atomically.

### Moderation and administration

- Durable roles: player, moderator, admin (guests join rooms as spectators, the platform's guest equivalent).
- Admin dashboard: users (ban/mute/role), rooms (close/kick), reports (resolve/dismiss), audit log.
- Audit-log records for every sensitive action; `moderation_actions_total` metric per action type.
- Chat moderation pipeline: synchronous word-list classifier (`isChatAllowed`, operator-extendable via `MODERATION_BANNED_WORDS`) plus `POST /reports` and `GET /admin/reports` for manual review.
- Mute, ban, room close, and room-scoped kick with permission checks and live-session enforcement on the game server.

### Abuse protection

- Redis-backed rate limits for login, room creation, room join, chat (HTTP and socket), socket tokens, reports, and gameplay inputs.
- Connection quotas per account and per IP (`MAX_SOCKETS_PER_USER`, `MAX_SOCKETS_PER_IP`) enforced at handshake.
- Protocol-version validation: clients present `PROTOCOL_VERSION` at handshake; mismatches are rejected and counted.
- Payload-size limits (Fastify `bodyLimit`, Socket.IO `maxHttpBufferSize`), trusted-proxy support, CORS allowlist, secure cookies in production, and a CSRF policy that rejects state-changing requests carrying a non-allowlisted `Origin`.

### Observability

- Structured JSON logs on both services; API request correlation IDs via `x-request-id`.
- Metrics: active rooms, active matches, connected players, snapshot broadcast rate, tick latency, match completions, input/chat rejections, connection quota and protocol rejections, lifecycle failures, moderation actions, rate-limit rejections, HTTP request counts.
- Health (`/health`), DB/Redis readiness (`/health/ready`), and Prometheus `/metrics` endpoints on both services; any OTLP Collector with a Prometheus receiver can scrape them.

### Deployment

- Multi-stage production Dockerfiles with non-root users (`infra/*.Dockerfile`, `apps/web/Dockerfile`) and Compose production wiring.
- Generic deployment guide (`docs/deployment.md`) covering env vars, reverse proxy/WebSocket upgrades, sticky room routing, and health/metrics.
- Redis-backed Socket.IO adapter and documented room-routing strategy.
- Object storage abstraction (`packages/storage`): local filesystem adapter plus a dependency-free S3-compatible adapter (`S3Storage`) with AWS Signature V4 verified against the AWS documentation test vector.

## Definition of done — met

- Completed matches appear in history and contribute to the leaderboard (plus achievements).
- Every admin/moderation action is authorized by role and written to the audit log.
- Rate-limit violations are observable (`rate_limited_total` per bucket) and safely rejected with `retry-after`.
- A container-platform operator can deploy API, game server, Postgres, Redis, and object storage using documented environment variables and reverse-proxy configuration.

## Deferred with rationale

- OpenTelemetry span tracing: the Prometheus exposition is already OTLP-Collector compatible; introducing the full trace SDK is deferred until an operator actually runs a collector, since the metric set already covers the M4 diagnostic targets. Upgrade path: add `@opentelemetry/sdk-node` with auto-instrumentations in both services, exported via `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Season/rule-scoped leaderboard variants arrive with the Milestone 5 game registry (`rooms.game_id`), which is the natural keying dimension.

---

# Milestone 5: Formal game plugin architecture

**Status: Completed**

## Objective

Prove that a second game can be added without modifying platform internals, and publish the extension contract as stable developer documentation.

## Delivered

### Game registry

- `GameDefinition` contract in `packages/protocol`: a game is a plain object of pure functions (`createState`, `addPlayer`, `removePlayer`, `setReady`, `setSpectator`, `canStartMatch`, `applyInput`, `tick`, `roster`, `view`, `getResults`) plus a strict Zod input schema and lobby metadata. States must expose `phase` and `remainingMs`; snapshots became game-agnostic (generic `Player` roster rows `{id, name, score, spectator, ready}` plus a game-specific `view` payload), which is the `PROTOCOL_VERSION` 1 → 2 bump.
- `packages/game-registry`: the single `gameId → definition` mapping with `getGame`, `listGames`, a boundary-validating `gameIdSchema`, and `DEFAULT_GAME_ID`.
- `rooms.game_id` persisted in PostgreSQL (init schema + idempotent migration `005-milestone-5-game-registry.sql`).
- API room creation accepts and validates a registered game id (`POST /rooms`), the lobby lists games via `GET /games`, and room reads/joins return `gameId`.
- The realtime server resolves each room's definition from the **persisted** room game id, delivered by the trusted `POST /internal/socket/verify` response — never from a client-supplied query or handshake field.
- `match_players.tags` renamed to the game-agnostic `match_players.score`; completion persists `{userId, score}` rows for every game; achievements evaluate game-agnostic `MatchStats.score`; `GET /leaderboard?game=<gameId>` adds the per-game leaderboard dimension.

### Second game reference

- `packages/color-rush` (Color Rush, `color-rush`): independently implemented orb-collection race with dash boosts — different state (orbs, dash/cooldown timers), inputs (move + dash discriminated union), scoring (orbs collected, server-derived by proximity in `tick`), and UI (its own arena renderer) from sample tag.
- Uses only the stable contracts: no edits to `RoomManager`, protocol envelopes, API lifecycle, moderation, or observability were needed to host it.
- Unit tests (`packages/color-rush/test/rules.test.ts`), room-manager integration tests hosting both games side by side, and a Playwright E2E happy path (`tests/e2e/color-rush.spec.ts`) demonstrate the platform carries no sample-tag-specific internals. The web app dispatches arena rendering through its client-side `gameViews` registry while the room chrome (ready-up, start, timer, scoreboard, results, chat) stays generic.

### Extension documentation

- `docs/web-game-platform-game-plugin-guide.md` rewritten against the real architecture: layer model, `GameDefinition` reference, envelope-vs-payload input rules, registration steps (one registry entry + one client view entry), lifecycle contract, persistence/achievements/leaderboard integration, testing requirements, protocol-versioning policy, game author checklist, common mistakes, and deployment notes.

## Definition of done — met

- A new game package can be created, registered (one `packages/game-registry` entry), selected in the lobby (`GET /games` + game selector), hosted in a room (definition resolved from `rooms.game_id`), and tested without editing generic room/tick/protocol internals.
- The second game uses the same persistence (idempotent match records, per-game leaderboard), moderation, observability, lifecycle (ready gates, reconnect grace, spectator authorization, archived abandonment), and deployment facilities as the reference game.

---

# Suggested execution order

1. Milestones 3, 3.1, 4, and 5 are complete; do not add new features that bypass the repaired lifecycle, the hardening gates, or the game registry seam.
2. New games enter through `packages/game-registry` and the web `gameViews` registry only; the guide's checklist is the acceptance bar.
3. Per-game leaderboard dimensions shipped with Milestone 5 (`rooms.game_id`); season/rule-scoped variants can build on the same key if demand appears.
4. If horizontal scaling arrives, introduce the OpenTelemetry trace SDK alongside a collector so room-routing failures can be traced.
