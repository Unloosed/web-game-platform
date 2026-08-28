# Web Game Platform: Game Plugin and Integration Guide

This guide explains how to add a game to the Web Game Platform without touching
generic room, tick, or protocol internals. It is written against the platform
**as it actually is** (Milestone 5): a pnpm workspace whose shared packages live
in `packages/` as plain source trees (no build step, imported by relative path),
a Fastify API (`apps/api`), a Socket.IO game server (`apps/game-server`), a
React web app (`apps/web`), and PostgreSQL accessed through raw parameterized
SQL on `pg.Pool` (no ORM).

The reference implementations are:

- `packages/sample-game` — **Tag Arena** (`sample-tag`), the original
  server-authoritative tag game.
- `packages/color-rush` — **Color Rush** (`color-rush`), the second reference
  game that proves the plugin contract: different state, inputs, scoring, and
  UI, registered and hosted with zero changes to platform internals.

A new game should follow the same package boundaries but must never copy its
game-specific rules into the API, room manager, protocol, or generic web
chrome.

---

# 1. Mental model

A platform game has four distinct layers.

| Layer | Owns | Must never own |
| --- | --- | --- |
| Game package (`packages/<game>`) | State types, pure rules, the `GameDefinition` adapter, per-game Zod input schema, the client arena view | Generic sessions/auth, DB access, sockets, tick loop |
| Core contract (`packages/protocol`) | `GameDefinition`, `Player`, `Snapshot`, phase types, generic event envelopes | Any specific game's rules or view payload |
| Registry (`packages/game-registry`) | The single `gameId → definition` mapping, the validated id schema, lobby metadata | Game logic |
| Platform (API, game server, web chrome) | Lifecycle, membership, transport, persistence, moderation, ready gating, scoreboard/results/chat UI | Game rules, game rendering |

The authoritative server accepts **intent** from clients, validates it
(envelope by the platform, payload by the game), mutates state through the
game definition on a fixed 20 Hz tick, and broadcasts a snapshot built from a
**generic roster** plus a **game-specific view payload**.

```text
Browser input
  -> generic client_event envelope (packages/protocol clientEventSchema)
  -> per-socket input throttle (50 ms)          [platform]
  -> room's game inputSchema.safeParse          [game]
  -> GameDefinition.applyInput(state, userId, input, dt)
  -> fixed tick GameDefinition.tick(state, dt)  [RoomManager]
  -> roster(state) + view(state) + results      [snapshot]
  -> browser: generic chrome + registered arena view
```

---

# 2. Package layout

A new internal game lives in `packages/<game-name>` as a plain source tree —
matching the existing repo convention (no `package.json`; packages are
imported by relative path and compiled by each app's tsconfig/vite).

```text
packages/color-rush/
├─ src/
│  └─ index.ts          # state types, constants, pure rules, GameDefinition
└─ test/
   └─ rules.test.ts     # vitest unit tests for the rules + definition
```

A larger game may split `src/` into `shared/` (importable by browser and
server), `server/` (deterministic rules, no DOM/React), and `client/`
(React/rendering). The two reference games keep everything in one `index.ts`
because the surface is small — do what fits your game, but keep the
server/browser split honest.

Rules of thumb:

- Server rule code must stay deterministic and must not depend on the DOM,
  React, sockets, or the database.
- Tests belong close to the game's rules (`packages/<game>/test`).
- The web app cannot import from `packages/` — mirror the view types locally
  in `apps/web/src/main.tsx` (see section 9).

---

# 3. The GameDefinition contract

Defined once in `packages/protocol/src/index.ts`. A definition is a plain
object of pure functions over your own state type.

```ts
type GameDefinition<S extends AnyGameState, I> = {
  metadata: GameMetadata;      // { id, name, description, minPlayers, maxPlayers }
  inputSchema: z.ZodType<I>;   // strict schema for your input payloads

  createState(matchMs: number): S;
  addPlayer(state: S, player: { userId; displayName; spectator; ready? }): S;
  removePlayer(state: S, userId: string): S;
  setReady(state: S, userId: string, ready: boolean): S;
  setSpectator(state: S, userId: string, spectator: boolean): S;
  canStartMatch(state: S): boolean;
  applyInput(state: S, userId: string, input: I, dtSeconds: number): S;
  tick(state: S, dtSeconds: number): S;
  roster(state: S): Player[];   // generic rows for scoreboard/chrome
  view(state: S): unknown;      // game-specific render payload
  getResults(state: S): Player[]; // sorted, non-spectators, on completion
};
```

### Hard requirements

1. **State must extend `AnyGameState`**: `{ phase: GamePhase; remainingMs:
   number }`. The platform reads exactly these two fields for lifecycle
   transitions, the timer UI, and completion detection.
2. **State must be serializable**: plain objects, arrays, strings, numbers,
   booleans. No functions, class instances, Dates, Maps, Sets, or sockets.
3. **Use the authenticated `userId` as the player key** — never the socket id.
4. **Methods are declared with method syntax in the interface on purpose**;
   keep your implementation assignable to `GameDefinition<AnyGameState,
   unknown>` (the registry erases your types).
5. **`tick` and `applyInput` must no-op outside `running`** — inputs and
   scoring never mutate waiting/completed games. Revisit `tick(state, 0)`
   safety for completed states.
6. **`applyInput` receives intents, never results.** A client may send
   `op: "dash"`; it may never send `score: 100` or a raw position.
7. **`roster(state)`** maps your internal players to the generic row
   `{ id, name, score, spectator, ready }`. `score` is game-defined (tags in
   sample-tag, orbs collected in color-rush).
8. **`view(state)`** carries everything only your arena renderer needs
   (positions, colors, orb list). It may filter hidden information per game
   later (per-player views are a future extension; today `view` is
   room-global, so do not leak hidden info through it).
9. **`getResults(state)`** returns non-spectator rows sorted best-first. The
   platform persists row 0 as the winner and every row as
   `{ userId, score }` in `match_players`.
10. **Spectator rules**: `setSpectator` marks the flag; your `move`/scoring
    code must ignore spectators. Spectators never count in `canStartMatch`.
11. **Ready rules**: mirror the platform gate — `canStartMatch` is true only
    with at least `metadata.minPlayers` non-spectators, all explicitly ready,
    and readiness is immutable while `running`.

---

# 4. Inputs: envelope vs payload

The platform validates only the generic envelope (`type: "input"`, integer
`seq ≥ 0`) plus the shared `chat` and `ready` events. Everything else in an
input belongs to your game and is validated by your own strict schema, which
the `RoomManager` runs via `inputSchema.safeParse` before `applyInput`.

Tag Arena — direction movement only:

```ts
tagInputSchema = z.object({
  type: z.literal("input"), seq: z.number().int().nonnegative(),
  direction: z.enum(["up", "down", "left", "right"]),
});
```

Color Rush — a discriminated union with a second action:

```ts
colorRushInputSchema = z.discriminatedUnion("op", [
  z.object({ type: z.literal("input"), seq: z.number().int().nonnegative(),
             op: z.literal("move"), direction: directionSchema }),
  z.object({ type: z.literal("input"), seq: z.number().int().nonnegative(),
             op: z.literal("dash") }),
]);
```

Standards:

- **Strict schemas**: unknown fields must fail. Do not `.passthrough()` your
  game schema.
- **Rate of inputs is capped by the platform** (one accepted input per 50 ms
  per socket, matching the 20 Hz tick) — do not design mechanics that need
  more.
- Movement advances on accepted input (`dt = 1/20 s`), and physics progression
  (cooldowns, boosts) decrements in `tick`. Color Rush's dash works exactly
  this way; copy that pattern for timed abilities.

---

# 5. Register the game

### 5.1 Server registry — `packages/game-registry/src/index.ts`

```ts
import { sampleTagGame } from "../../sample-game/src/index.js";
import { colorRushGame } from "../../color-rush/src/index.js";

export const gameRegistry: Record<string, AnyGameDefinition> = {
  [sampleTagGame.metadata.id]: sampleTagGame,
  [colorRushGame.metadata.id]: colorRushGame,
};

export const DEFAULT_GAME_ID = sampleTagGame.metadata.id;
export const gameIdSchema = z.string().refine((id) => id in gameRegistry);
export function getGame(id: string) { ... }
export function listGames(): GameMetadata[] { ... }
```

Add one import and one entry. This is the **only** platform-side edit needed
to install a game on the server.

### 5.2 Database

`rooms.game_id` (migration `005-milestone-5-game-registry.sql`) already
persists the game per room and defaults to `sample-tag`. No schema change is
needed for a new game: the id is validated against the registry, not an enum
in SQL.

### 5.3 API

Nothing to do. `POST /rooms` validates `gameId` with `gameIdSchema` (so an
unknown id is a 400), `GET /games` lists `listGames()` for the lobby, and the
socket-verify endpoint returns the room's persisted `gameId` to the game
server, which resolves the definition from the registry. **The realtime
server never trusts a game id from the client** — it only uses the value the
API read from PostgreSQL.

---

# 6. Web client view

The web app mirrors types locally (it deliberately does not import from
`packages/`) and keeps a client-side registry in `apps/web/src/main.tsx`:

```tsx
const gameViews: Record<string, React.ComponentType<ArenaProps>> = {
  "sample-tag": TagArena,
  "color-rush": ColorRushArena,
};
```

`ArenaProps` gives your component everything the game-specific UI needs:

```tsx
type ArenaProps = {
  snap: Snap;          // latest snapshot (players: generic roster, view: unknown)
  spectator: boolean;  // spectators get no input listeners
  sendInput: (input: Record<string, unknown>) => void;
};
```

Your arena component:

1. Casts `snap.view` to your local mirrored view type.
2. Adds its own keyboard/pointer listeners and calls `sendInput` with
   **schema-valid payloads** (the server re-validates everything).
3. Renders only; it never decides score, collisions, or completion.
4. Keeps a stable `data-testid` (e.g. `color-rush-arena`) for E2E.

The generic room chrome — invite code, spectator toggle, ready-up, start/
restart (host-only, readiness-gated), timer, scoreboard (sorted by `score`),
results, chat — is rendered by the platform for every game. Do not duplicate
it inside an arena view.

The lobby's game selector and the public-room list are registry-driven via
`GET /games`; they render new games automatically once the server registry
and the `gameViews` entry exist.

---

# 7. Lifecycle contract

The platform drives this exact flow for every game; your definition must make
it correct:

```text
create room (status=waiting, rooms.game_id persisted)
  -> players join (membership + handshake verified; reconnect restores ready)
  -> ready toggles (spectators rejected; mirrored to room_members.ready)
  -> host start (waiting + canStartMatch) -> phase=running, status=running
  -> 20 Hz tick loop; inputs applied between ticks
  -> your tick sets phase=completed exactly once
  -> platform persists {winnerUserId, results: [{userId, score}]}
     idempotently (one match row per room) and broadcasts results
  -> host rematch (completed + canStartMatch) -> fresh state, same rules
  -> empty waiting room deleted; abandoned running room archived;
     completed room kept for results
```

Answer these in your game README before registering:

- What ends the game (timer / score limit / other)? The platform's
  `GAME_MATCH_MS` env seeds `createState(matchMs)` — honor it (tests rely on
  short matches).
- Late join? (Current platform: joins close when the room is running; design
  `addPlayer` accordingly.)
- Spectators in each phase, reconnect behavior (grace window is platform
  config `ROOM_RECONNECT_GRACE_MS`), and what a rematch resets.

---

# 8. Persistence, achievements, leaderboard

- Completion writes one durable `matches` row plus `match_players(match_id,
  user_id, score)` — `score` is the game-defined number from your
  `getResults`/`roster` rows. A game never writes to the database itself.
- Achievements evaluate pure `MatchStats` (`{ winnerUserId, players:
  [{userId, score}] }`) inside the completion transaction. `sharpshooter`
  (score ≥ 5) is intentionally game-agnostic.
- `GET /leaderboard?game=<gameId>` scopes the board by `rooms.game_id`;
  without the parameter it aggregates across games. `GET
  /users/:id/matches` rows carry `gameId`.

---

# 9. Testing requirements

Three layers, matching the reference games:

1. **Rules unit tests** (`packages/<game>/test/rules.test.ts`, vitest). Cover
   at minimum: phase gating (no input/tick effect outside `running`), bounds,
   your scoring rule awards exactly once, spectator isolation, ready gating
   and `canStartMatch`, timer completion + ranking, schema rejects foreign
   payloads (a tag-style direction input must fail Color Rush's schema and
   vice versa), and `removePlayer` side effects.
2. **Room-manager integration** (`apps/game-server/test/room-manager.test.ts`).
   The existing suite drives the platform gates generically. Add one test
   that connects your game by id and asserts: snapshot `game` field, your
   `view` shape, per-game input acceptance/rejection, and completion rows
   shaped as `{userId, score}`.
3. **Browser E2E** (`tests/e2e/<game>.spec.ts`, Playwright). Follow
   `tests/e2e/color-rush.spec.ts`: sign in, select the game in the lobby,
   create, second context joins by code, deterministic ready-up (start
   disabled until all ready), start, assert your arena test id renders (and
   the other games' does not), scoreboard shows both players, one game
   action, timer visible.

Run: `pnpm test` (unit), `pnpm typecheck`, `pnpm lint`, and with infra
running `pnpm test:e2e` (needs `pnpm db:reset` + `pnpm dev`, and a low
`GAME_MATCH_MS` for completion specs).

---

# 10. Protocol versioning guidance

`PROTOCOL_VERSION` (in `packages/protocol`) is presented at every Socket.IO
handshake; mismatches are rejected and counted.

- **Bump the version when the generic contract changes**: the snapshot
  envelope fields (roster row shape, phase/timer semantics), the generic
  event envelopes, or handshake auth. Milestone 5 bumped 1 → 2 for exactly
  this reason (game-agnostic snapshots).
- **Do not bump for game view changes**: `view` payloads are consumed only by
  the matching client component, which deploys with the game package. Keep
  `view` additive (new optional fields) where you can.
- Adding a new game never bumps the version.
- When you bump: update the mirrored constant in `apps/web/src/main.tsx`,
  adjust protocol tests, and note the breaking change here.

---

# 11. Game author checklist

Before registering a game:

- [ ] Package lives in `packages/<name>` with rules in `src/` and vitest tests
      in `test/`; server code imports nothing from the DOM, React, sockets,
      or DB.
- [ ] State is serializable and keyed by authenticated `userId`.
- [ ] State extends `{ phase; remainingMs }`; `tick`/`applyInput` no-op
      outside `running`.
- [ ] Inputs are intents with a strict Zod schema; client never submits
      scores, positions, or target validity.
- [ ] `roster`/`getResults` emit generic `{id, name, score, spectator, ready}`
      rows; results sorted best-first, spectators excluded.
- [ ] Spectators cannot move or score; they never count toward start.
- [ ] Ready gating mirrors the platform rule; readiness frozen mid-match.
- [ ] Completion is a single `phase = "completed"` transition; `GAME_MATCH_MS`
      honored.
- [ ] Unit + room-manager + E2E tests added (see section 9).
- [ ] Registered in `packages/game-registry` and `gameViews` in the web app.
- [ ] Arena view has a `data-testid`, respects `spectator`, and leaves
      ready/start/timer/scoreboard/chat to the generic chrome.

If every box ticks, the total platform diff for a third game is: the game
package, one registry entry, one `gameViews` entry, and tests. Nothing in
`apps/api`, `apps/game-server/src`, or `packages/protocol` changes.

---

# 12. Common mistakes

| Mistake | Why it fails | Correct approach |
| --- | --- | --- |
| Socket id as player key | Reconnect changes socket id | Use the verified `userId` |
| Accepting positions/scores from the client | Cheating; state divergence | Client sends intents; server simulates |
| Forgetting `phase`/`remainingMs` in state | RoomManager cannot drive lifecycle or timer | Extend `AnyGameState` |
| Mutating state in place | Snapshot history, idempotency, and tests rely on returns | Return new state objects |
| Scoring from `applyInput` without re-validation | Macro/replay abuse; invalid targets | Derive scoring in `tick` (Color Rush collects by proximity) |
| Reading `snap.view` in generic chrome | View is game-private | Chrome uses `players`/`results` roster rows only |
| Trusting `gameId` from a socket client | Unauthorized routing | Resolve from `rooms.game_id` via the API verify call |
| Writing to Postgres in `tick` | Tick latency and DB load | Persist only at completion (platform does this) |
| Skipping the E2E spec for your game | Second-game regression net is the point of M5 | Copy `color-rush.spec.ts` |

---

# 13. Deployment notes

Games need no extra services or environment variables: both reference games
share `GAME_MATCH_MS`, `ROOM_RECONNECT_GRACE_MS`, moderation, metrics,
Redis-backed scaling, and the production Docker wiring. See
`docs/deployment.md` for the platform-level setup and
`docs/web-game-platform-milestone-roadmap.md` for the milestone history.
