# Web Game Platform: Game Plugin and Integration Guide

This guide explains how to add a game to the Web Game Platform without coupling it to platform internals. It targets advanced TypeScript developers building a browser game that needs ordinary React UI, 2D rendering, optional multiplayer, and server-authoritative simulation.

The reference game is `@webgame/sample-game`, a top-down tag arena. A new game should follow the same package boundaries but must not copy its game-specific rules into API, room SDK, or generic client code.

---

# 1. Mental model

A platform game has five distinct layers.

| Layer | Responsibility | Must not own |
| --- | --- | --- |
| Game package | Rules, state, game-specific input, player views, assets, render view | Generic sessions, generic auth, direct DB access for platform data |
| Core package | Game-agnostic contracts such as `GameDefinition`, players, room phases | Tag rules, game-specific UI |
| Server SDK | Fixed tick loop, generic room/session helpers, snapshot lifecycle helpers | Game-specific collision and scoring |
| Game server app | Authenticates live connections, loads room/game definition, routes input, broadcasts snapshots | Individual game rules |
| Web app | App shell, lobby, settings, user/session UI, route selection | Authoritative state decisions |

The authoritative server accepts **intent** from clients, validates it, mutates state through a game definition, and emits a player-safe snapshot. A browser renders state but must never decide score, collisions, victory, or room membership.

```text
Browser input
  -> shared Zod validation
  -> game-server authorization and room membership check
  -> game-specific input schema validation
  -> GameDefinition.applyInput
  -> fixed tick GameDefinition.update
  -> player-safe snapshot
  -> browser rendering/UI
```

---

# 2. Package layout

A new internal game lives in `packages/<game-package-name>`.

```text
packages/color-rush/
├─ package.json
├─ tsconfig.json
├─ src/
│  ├─ index.ts
│  ├─ shared/
│  │  ├─ state.ts
│  │  ├─ input.ts
│  │  ├─ schemas.ts
│  │  └─ constants.ts
│  ├─ server/
│  │  ├─ definition.ts
│  │  ├─ rules.ts
│  │  └─ results.ts
│  ├─ client/
│  │  ├─ ColorRushGameView.tsx
│  │  ├─ renderModel.ts
│  │  └─ assets.ts
│  └─ test/
│     ├─ rules.test.ts
│     └─ definition.test.ts
└─ README.md
```

Use this separation deliberately:

- `shared/` may be imported by browser and server.
- `server/` must stay deterministic where practical and must not depend on the DOM or React.
- `client/` may use React, PixiJS, CSS, audio, browser APIs, and rendering adapters.
- Tests belong close to the game’s rules.

---

# 3. Create package metadata

Example `packages/color-rush/package.json`:

```json
{
  "name": "@webgame/color-rush",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src --ext .ts,.tsx",
    "test": "vitest",
    "format": "prettier --write src"
  },
  "dependencies": {
    "@webgame/core": "workspace:*",
    "@webgame/protocol": "workspace:*",
    "zod": "^3.23.0"
  },
  "peerDependencies": {
    "react": "^18.2.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

Example `packages/color-rush/tsconfig.json`:

```json
{
  "extends": "../config/tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Use `workspace:*` for internal packages where your package manager configuration supports it. It avoids publishing-version drift during local development.

---

# 4. Define game state and input

## 4.1 State types

State must be explicit, serializable, and suitable for snapshots. Prefer objects, arrays, strings, numbers, booleans, and stable identifiers. Avoid functions, class instances, Dates, Maps, Sets, sockets, database clients, and browser references inside authoritative state.

```ts
// packages/color-rush/src/shared/state.ts
export interface ColorRushPlayerState {
  id: string;
  displayName: string;
  x: number;
  y: number;
  color: string;
  score: number;
  connected: boolean;
}

export interface OrbState {
  id: string;
  x: number;
  y: number;
  color: string;
  collected: boolean;
}

export interface ColorRushGameState {
  phase: 'waiting' | 'running' | 'completed';
  players: Record<string, ColorRushPlayerState>;
  orbs: Record<string, OrbState>;
  roundNumber: number;
  remainingTimeMs: number;
  winnerPlayerId: string | null;
}

export interface ColorRushPlayerView {
  phase: ColorRushGameState['phase'];
  players: ColorRushPlayerState[];
  orbs: OrbState[];
  roundNumber: number;
  remainingTimeMs: number;
  winnerPlayerId: string | null;
}
```

### State design rules

- Use a stable logical player ID from the authenticated platform user, never socket ID, as the state key.
- Keep authoritative state small; send a view/delta rather than internal history.
- Store countdowns as a duration or tick count, not as browser-local timers.
- Prefer a single match clock controlled in `update` over independent client timers.
- Treat all fields visible to the client as public. Create a player-specific view if the game contains hidden information.

## 4.2 Input schema and type

Never cast `unknown` input straight into a game type. Define Zod schemas and use them at the game-server boundary.

```ts
// packages/color-rush/src/shared/input.ts
import { z } from 'zod';

export const movementDirectionSchema = z.enum(['up', 'down', 'left', 'right', 'none']);

export const colorRushInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('move'),
    direction: movementDirectionSchema
  }),
  z.object({
    type: z.literal('collect'),
    orbId: z.string().uuid()
  }),
  z.object({
    type: z.literal('noop')
  })
]);

export type ColorRushInput = z.infer<typeof colorRushInputSchema>;
```

Input is an **intent**, not a result. A client may request `collect` but the server checks that the orb exists, is uncollected, and is close enough to the player. The client never submits `score: 100`.

---

# 5. Implement a GameDefinition

`GameDefinition<TState, TPlayerView, TInput>` is the core game extension point.

```ts
interface GameDefinition<TState, TPlayerState, TInput> {
  metadata: GameMetadata;
  roomConfig: RoomConfig;
  initialState: () => TState;
  applyInput: (params: {
    state: TState;
    playerId: string;
    input: TInput;
    dt: number;
  }) => TState;
  update: (params: { state: TState; dt: number }) => TState;
  canPlayerJoin: (params: { state: TState; playerCount: number }) => boolean;
  getPlayerView: (params: { state: TState; playerId: string }) => TPlayerState;
}
```

A definition should be a mostly pure function collection. Each operation receives state and returns next state. This makes rule testing straightforward and makes future replay/debug tooling possible.

## 5.1 Constants and helpers

```ts
// packages/color-rush/src/shared/constants.ts
export const ARENA_WIDTH = 800;
export const ARENA_HEIGHT = 600;
export const PLAYER_RADIUS = 16;
export const PLAYER_SPEED = 180;
export const MATCH_DURATION_MS = 90_000;
export const COLLECT_DISTANCE = 28;
```

```ts
// packages/color-rush/src/server/rules.ts
import type { ColorRushPlayerState, OrbState } from '../shared/state';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  COLLECT_DISTANCE,
  PLAYER_RADIUS,
  PLAYER_SPEED
} from '../shared/constants';

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function movePlayer(
  player: ColorRushPlayerState,
  direction: 'up' | 'down' | 'left' | 'right' | 'none',
  dt: number,
): ColorRushPlayerState {
  let dx = 0;
  let dy = 0;

  if (direction === 'up') dy = -1;
  if (direction === 'down') dy = 1;
  if (direction === 'left') dx = -1;
  if (direction === 'right') dx = 1;

  return {
    ...player,
    x: clamp(player.x + dx * PLAYER_SPEED * dt, PLAYER_RADIUS, ARENA_WIDTH - PLAYER_RADIUS),
    y: clamp(player.y + dy * PLAYER_SPEED * dt, PLAYER_RADIUS, ARENA_HEIGHT - PLAYER_RADIUS)
  };
}

export function canCollect(player: ColorRushPlayerState, orb: OrbState): boolean {
  const dx = player.x - orb.x;
  const dy = player.y - orb.y;
  return dx * dx + dy * dy <= COLLECT_DISTANCE * COLLECT_DISTANCE;
}
```

## 5.2 Full definition example

```ts
// packages/color-rush/src/server/definition.ts
import type { GameDefinition } from '@webgame/core';
import type { ColorRushInput } from '../shared/input';
import {
  MATCH_DURATION_MS
} from '../shared/constants';
import type {
  ColorRushGameState,
  ColorRushPlayerState,
  ColorRushPlayerView
} from '../shared/state';
import { canCollect, movePlayer } from './rules';

function createPlayer(playerId: string): ColorRushPlayerState {
  return {
    id: playerId,
    displayName: playerId,
    x: 400,
    y: 300,
    color: '#60a5fa',
    score: 0,
    connected: true
  };
}

export const colorRushDefinition: GameDefinition<
  ColorRushGameState,
  ColorRushPlayerView,
  ColorRushInput
> = {
  metadata: {
    id: 'color-rush',
    name: 'Color Rush',
    description: 'Collect server-validated orbs before time expires.',
    version: '0.1.0'
  },

  roomConfig: {
    id: 'color-rush-default',
    maxPlayers: 4,
    minPlayersToStart: 2,
    tickRate: 30,
    allowSpectators: true,
    reconnectTimeoutMs: 15_000
  },

  initialState: () => ({
    phase: 'waiting',
    players: {},
    orbs: {},
    roundNumber: 1,
    remainingTimeMs: MATCH_DURATION_MS,
    winnerPlayerId: null
  }),

  applyInput: ({ state, playerId, input, dt }) => {
    if (state.phase !== 'running') {
      return state;
    }

    const player = state.players[playerId] ?? createPlayer(playerId);
    const players = { ...state.players, [playerId]: player };
    const orbs = { ...state.orbs };

    if (input.type === 'move') {
      players[playerId] = movePlayer(player, input.direction, dt);
    }

    if (input.type === 'collect') {
      const orb = orbs[input.orbId];
      if (orb && !orb.collected && canCollect(player, orb)) {
        orbs[input.orbId] = { ...orb, collected: true };
        players[playerId] = { ...player, score: player.score + 1 };
      }
    }

    return {
      ...state,
      players,
      orbs
    };
  },

  update: ({ state, dt }) => {
    if (state.phase !== 'running') {
      return state;
    }

    const remainingTimeMs = Math.max(0, state.remainingTimeMs - dt * 1000);
    if (remainingTimeMs > 0) {
      return { ...state, remainingTimeMs };
    }

    const ranked = Object.values(state.players).sort((a, b) => b.score - a.score);
    return {
      ...state,
      remainingTimeMs: 0,
      phase: 'completed',
      winnerPlayerId: ranked[0]?.id ?? null
    };
  },

  canPlayerJoin: ({ state, playerCount }) => {
    return state.phase === 'waiting' && playerCount < 4;
  },

  getPlayerView: ({ state }) => ({
    phase: state.phase,
    players: Object.values(state.players),
    orbs: Object.values(state.orbs).filter((orb) => !orb.collected),
    roundNumber: state.roundNumber,
    remainingTimeMs: state.remainingTimeMs,
    winnerPlayerId: state.winnerPlayerId
  })
};
```

The exact current `GameDefinition` contract may evolve during the room lifecycle repair. Keep game-specific code behind this adapter so platform contract changes are localized.

---

# 6. Register the game

A production-quality platform must use a registry, rather than a hard-coded `if` or room-code naming convention.

## 6.1 Registry contract

```ts
// apps/game-server/src/games/registry.ts
import type { GameDefinition } from '@webgame/core';
import { sampleGameDefinition } from '@webgame/sample-game';
import { colorRushDefinition } from '@webgame/color-rush';

export interface RegisteredGame {
  id: string;
  definition: GameDefinition<unknown, unknown, unknown>;
  inputSchema: {
    safeParse(value: unknown): { success: boolean; data?: unknown };
  };
}

export const gamesRegistry: Record<string, RegisteredGame> = {
  'sample-tag': {
    id: 'sample-tag',
    definition: sampleGameDefinition,
    inputSchema: {
      safeParse: (value) => ({ success: true, data: value })
    }
  },
  'color-rush': {
    id: 'color-rush',
    definition: colorRushDefinition,
    inputSchema: {
      safeParse: (value) => colorRushInputSchema.safeParse(value)
    }
  }
};

export function getRegisteredGame(gameId: string): RegisteredGame {
  const game = gamesRegistry[gameId];
  if (!game) {
    throw new Error(`Unsupported game: ${gameId}`);
  }
  return game;
}
```

In a later strongly typed version, use generic registration helpers so the registry preserves each game’s input and state type. The key design point is that API and realtime room routing choose a game from a trusted server-side registry.

## 6.2 Persist `gameId` on rooms

Add a `game_id` field to durable rooms.

```sql
ALTER TABLE rooms
ADD COLUMN game_id VARCHAR(64) NOT NULL DEFAULT 'sample-tag';
```

Update the Drizzle schema:

```ts
export const rooms = pgTable('rooms', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: varchar('code', { length: 8 }).notNull().unique(),
  gameId: varchar('game_id', { length: 64 }).notNull().default('sample-tag'),
  name: varchar('name', { length: 64 }).notNull(),
  // remaining existing fields
});
```

Validate room creation:

```ts
const createRoomBodySchema = z.object({
  name: z.string().min(1).max(64),
  gameId: z.enum(['sample-tag', 'color-rush']).default('sample-tag'),
  isPrivate: z.boolean().default(false),
  maxPlayers: z.number().int().min(2).max(16).default(8)
});
```

Do not trust `gameId` passed directly by the Socket.IO client. The realtime server should obtain a room’s persisted game ID through a trusted API/service lookup or a synchronized cache.

---

# 7. Realtime server integration

## 7.1 Authenticate before joining

The Socket.IO handshake should receive an API-issued session cookie or short-lived websocket token. The game server resolves the authenticated user before creating or reconnecting a room player.

```ts
interface AuthenticatedSocketContext {
  userId: string;
  displayName: string;
  role: 'guest' | 'player' | 'moderator' | 'admin';
}
```

The game server should then validate:

1. The room exists.
2. The user is permitted to view or join it.
3. The room is in a joinable phase.
4. The player count permits a non-spectator entrant.
5. The request is spectator-eligible if spectator mode is requested.

## 7.2 Validate game-specific input

Generic protocol validation proves that the message is an `input` envelope. The selected game’s input schema proves that the inner payload is valid.

```ts
socket.on('client_event', (raw: unknown) => {
  const envelopeResult = clientToServerBaseSchema.safeParse(raw);
  if (!envelopeResult.success) {
    socket.emit('server_event', {
      type: 'error',
      code: 'invalid_protocol',
      message: 'Malformed client event.'
    });
    return;
  }

  const event = envelopeResult.data;
  if (event.type !== 'input') {
    return;
  }

  if (session.isSpectator) {
    socket.emit('server_event', {
      type: 'error',
      code: 'spectator_input_forbidden',
      message: 'Spectators cannot send game input.'
    });
    return;
  }

  const parsedInput = room.registeredGame.inputSchema.safeParse(event.payload);
  if (!parsedInput.success) {
    socket.emit('server_event', {
      type: 'error',
      code: 'invalid_game_input',
      message: 'Input is invalid for this game.'
    });
    return;
  }

  room.applyInput(session.connectionId, parsedInput.data, room.fixedDtSeconds);
});
```

## 7.3 Lifecycle gating

The server SDK should reject game input if the room is not `running`.

```ts
if (room.phase !== 'running') {
  return;
}
```

Do not leave this entirely to game code. The platform owns permission and lifecycle gates; the game owns its gameplay semantics.

## 7.4 Snapshots

The server computes one state update at a fixed rate, then serializes a game-specific player view.

```ts
const playerView = room.game.getPlayerView({
  state: room.state,
  playerId: playerSession.player.userId
});

socket.emit('server_event', {
  type: 'snapshot',
  roomId: room.id,
  serverTime: Date.now(),
  state: playerView,
  lastInputSeq: playerSession.lastAcceptedInputSeq
});
```

For games with fog-of-war or hidden cards, call `getPlayerView` separately for each user. For games with universally visible state, generate once and broadcast to the room.

---

# 8. Browser client integration

The platform’s `GameClient` handles generic socket connection and event routing. A game client component turns its snapshot into UI and rendering state.

## 8.1 Basic React view

```tsx
// packages/color-rush/src/client/ColorRushGameView.tsx
import { useEffect, useRef, useState } from 'react';
import { GameClient, KeyboardInput } from '@webgame/game-client';
import type { ColorRushPlayerView } from '../shared/state';

interface Props {
  serverUrl: string;
  roomCode: string;
  user: { id: string; displayName: string };
  spectator: boolean;
}

export function ColorRushGameView({ serverUrl, roomCode, user, spectator }: Props): JSX.Element {
  const [view, setView] = useState<ColorRushPlayerView | null>(null);
  const clientRef = useRef<GameClient | null>(null);

  useEffect(() => {
    const client = new GameClient({
      serverUrl,
      roomId: roomCode,
      userId: user.id,
      displayName: user.displayName,
      spectator
    });

    client.onRender((snapshot) => {
      setView(snapshot as unknown as ColorRushPlayerView);
    });
    client.connect();
    clientRef.current = client;

    if (spectator) {
      return () => client.disconnect();
    }

    const input = new KeyboardInput();
    input.on(({ seq, direction }) => {
      client.sendInput({
        seq,
        direction
      });
    });

    return () => {
      input.dispose();
      client.disconnect();
    };
  }, [roomCode, serverUrl, spectator, user.displayName, user.id]);

  if (!view) {
    return <p>Connecting to game…</p>;
  }

  return (
    <section>
      <header>
        <h2>Color Rush — Round {view.roundNumber}</h2>
        <p>Time remaining: {Math.ceil(view.remainingTimeMs / 1000)} seconds</p>
      </header>
      <div role="application" aria-label="Color Rush arena">
        {view.players.map((player) => (
          <div key={player.id}>
            {player.displayName}: {player.score}
          </div>
        ))}
      </div>
      {view.phase === 'completed' && (
        <p>{view.winnerPlayerId === user.id ? 'You win!' : 'Match complete.'}</p>
      )}
    </section>
  );
}
```

This first version deliberately uses normal React DOM rendering. Use it to prove input, state, lifecycle, accessibility, and networking before adding rendering complexity.

## 8.2 PixiJS renderer adapter

When the game benefits from a canvas renderer, isolate PixiJS in the game package or an adapter package. Do not put Pixi-specific code in `@webgame/core`.

```ts
// packages/color-rush/src/client/pixiRenderer.ts
import { Application, Container, Graphics } from 'pixi.js';
import type { ColorRushPlayerView } from '../shared/state';

export class ColorRushPixiRenderer {
  private readonly app: Application;
  private readonly world = new Container();
  private readonly playerSprites = new Map<string, Graphics>();

  constructor(host: HTMLElement) {
    this.app = new Application();
    void this.app.init({ width: 800, height: 600, background: '#111827' }).then(() => {
      host.appendChild(this.app.canvas);
      this.app.stage.addChild(this.world);
    });
  }

  render(view: ColorRushPlayerView): void {
    for (const player of view.players) {
      let sprite = this.playerSprites.get(player.id);
      if (!sprite) {
        sprite = new Graphics();
        this.playerSprites.set(player.id, sprite);
        this.world.addChild(sprite);
      }
      sprite.clear();
      sprite.circle(0, 0, 16);
      sprite.fill(player.color);
      sprite.x = player.x;
      sprite.y = player.y;
    }
  }

  destroy(): void {
    this.app.destroy(true);
  }
}
```

Maintain the distinction:

- Authoritative position lives in server snapshot state.
- Render interpolation may create a smooth visual position client-side.
- Render interpolation must never be reported back as authoritative position.

---

# 9. Menus, settings, dashboards, and normal web UI

A game module does not need to place every screen inside a canvas. Use standard React pages and components for:

- Pre-match instructions and tutorials.
- Inventory and loadout selection.
- Social menus and friend/invite controls.
- Match settings.
- Accessibility controls.
- Scoreboards, chat, notifications, and results.
- Admin/moderation controls.

A game package can export route components:

```ts
export { ColorRushGameView } from './client/ColorRushGameView';
export { ColorRushInstructionsPage } from './client/ColorRushInstructionsPage';
export { colorRushDefinition } from './server/definition';
```

The platform web application chooses these components from the game registry.

```tsx
const gamePageById: Record<string, React.ComponentType<GameRoomProps>> = {
  'sample-tag': SampleTagRoomPage,
  'color-rush': ColorRushRoomPage
};
```

Keep global design tokens, buttons, modals, forms, toasts, focus management, reduced-motion behavior, and responsive layout in `@webgame/ui` or the host web app. That ensures all games have a consistent accessible application shell.

---

# 10. Single-player support

A single-player game should use the same `GameDefinition` and fixed-step simulation rules.

Recommended modes:

1. **Local/offline mode**: browser runs a local simulation adapter for a truly offline game. Use only where cheating does not matter or saves are validated later.
2. **Hosted single-player mode**: create a room with one player and run authoritative simulation on the server. This provides durable saves, anti-cheat validation, achievements, and consistent result storage.
3. **Practice mode**: use the hosted engine with bots or no opponents.

Do not fork your entire rule set for multiplayer vs single player. Structure the game definition so player count is a configuration/rules constraint:

```ts
roomConfig: {
  maxPlayers: 1,
  minPlayersToStart: 1,
  tickRate: 30,
  allowSpectators: false,
  reconnectTimeoutMs: 15_000
}
```

A game that supports both can define queue/room templates, for example `solo`, `duo`, and `public` modes, while retaining shared state and rules.

---

# 11. Persistence hooks

Do not write to PostgreSQL inside every `update` tick. Game simulation should remain fast and isolated from slow I/O.

Instead, define coarse-grained persistence events:

```ts
interface GamePersistenceHooks<TState, TResult> {
  onMatchStarted?(params: { roomId: string; state: TState }): Promise<void>;
  onMatchCompleted?(params: {
    roomId: string;
    state: TState;
    result: TResult;
  }): Promise<void>;
  saveCheckpoint?(params: { roomId: string; state: TState }): Promise<void>;
}
```

Use these at lifecycle boundaries:

- Match starts: create durable match record.
- Periodic checkpoint: persistent-world/save-game use case.
- Match completes: transactionally write rankings/results/achievements.
- Room archives: release volatile state after result save confirmation.

For deterministic games, a more advanced future option is event sourcing: save accepted input events and periodic snapshots. Do not adopt it until replay/audit requirements justify the complexity.

---

# 12. Assets

Each game should declare assets through a versioned manifest.

```ts
// packages/color-rush/src/client/assets.ts
export interface GameAssetManifest {
  gameId: string;
  version: string;
  assets: Array<{
    id: string;
    url: string;
    kind: 'image' | 'audio' | 'json' | 'font';
    integrity?: string;
  }>;
}

export const colorRushAssets: GameAssetManifest = {
  gameId: 'color-rush',
  version: '0.1.0',
  assets: [
    { id: 'orb-blue', url: '/games/color-rush/0.1.0/orb-blue.png', kind: 'image' },
    { id: 'collect', url: '/games/color-rush/0.1.0/collect.ogg', kind: 'audio' }
  ]
};
```

The web host should preload this manifest before entering the game screen and present an accessible loading state. Future object-storage integration should map these URLs through a storage abstraction and version them immutably.

For player-uploaded content, validate size, MIME type, format, authorization, and moderation policy before exposing assets. Do not allow arbitrary remote URLs in game manifests.

---

# 13. Lifecycle integration checklist

Every game must declare how it participates in lifecycle:

- What state represents `waiting`, `ready`, `running`, `paused`, and `completed`?
- Does the game allow new players only in waiting, or late join during running?
- Are spectators allowed in each phase?
- What minimum player count is required?
- Which players must ready before host start?
- What ends a game: timer, score threshold, surrender, all players disconnected, or host action?
- What output must be persisted at completion?
- Does the game support reconnect? For how long?

Example completion result shape:

```ts
export interface ColorRushResult {
  reason: 'timer_expired' | 'score_limit' | 'forfeit' | 'cancelled';
  winnerPlayerId: string | null;
  rankings: Array<{
    playerId: string;
    rank: number;
    score: number;
  }>;
}
```

The game server, not the browser, creates this result.

---

# 14. Testing requirements

## 14.1 Unit tests: rules first

```ts
// packages/color-rush/src/test/rules.test.ts
import { describe, expect, it } from 'vitest';
import { canCollect, movePlayer } from '../server/rules';

const player = {
  id: 'player-1',
  displayName: 'Player One',
  x: 100,
  y: 100,
  color: '#60a5fa',
  score: 0,
  connected: true
};

describe('Color Rush rules', () => {
  it('moves at the configured speed without exceeding bounds', () => {
    const moved = movePlayer(player, 'right', 1);
    expect(moved.x).toBeGreaterThan(player.x);
  });

  it('allows collection only inside collection distance', () => {
    expect(canCollect(player, {
      id: 'orb-1',
      x: 110,
      y: 100,
      color: '#3b82f6',
      collected: false
    })).toBe(true);
  });
});
```

Test at minimum:

- Input validation.
- Initial state.
- Movement/bounds/collision logic.
- Scoring and victory conditions.
- Timer expiry.
- Lifecycle gating: input must not mutate completed/waiting games.
- Spectator cannot alter state.
- Reconnect does not create duplicate logical player state.

## 14.2 Server integration tests

Test room manager behavior with controlled sockets or direct manager APIs:

- Valid member can join.
- Non-member cannot join private room.
- Correct game definition is loaded from `gameId`.
- Input schema rejection returns an error and does not mutate state.
- Start requires expected phase, host authorization, and readiness.
- Completion produces exactly one persistence call.

## 14.3 Browser E2E

Every game should own a Playwright happy path:

1. Sign in as host.
2. Create room configured for the game ID.
3. Open independent browser context and sign in as second player.
4. Join via code.
5. Ready/start game.
6. Execute recognizable game action.
7. Verify state/results in both browser views.
8. Verify spectator behavior if supported.

Avoid selectors tied to raw inline CSS or arbitrary DOM nesting. Add semantic labels and `data-testid` values where needed:

```tsx
<button data-testid="start-match">Start match</button>
<div data-testid="scoreboard">...</div>
<canvas data-testid="color-rush-canvas" />
```

---

# 15. Game author checklist

Before registering a game:

- [ ] Game package has no direct dependency on Fastify, Socket.IO server internals, or platform DB tables.
- [ ] Shared inputs use Zod schemas.
- [ ] Game state is serializable and avoids socket/browser/database objects.
- [ ] Score, collisions, win conditions, and timer are server-authoritative.
- [ ] `applyInput` does not trust client-provided positions, scores, target validity, or timestamps.
- [ ] `update` uses fixed `dt` and handles completed state safely.
- [ ] Player view contains only data the recipient is allowed to see.
- [ ] Room lifecycle behavior is documented.
- [ ] Spectator behavior is defined.
- [ ] Reconnect behavior is defined.
- [ ] Asset manifest is versioned.
- [ ] Unit, integration, and E2E tests exist.
- [ ] Accessibility requirements are considered for non-canvas controls and reduced-motion settings.

---

# 16. Common mistakes

| Mistake | Why it fails | Correct approach |
| --- | --- | --- |
| Use socket ID as player ID | Reconnect changes socket ID | Use stable authenticated user ID as logical player ID |
| Accept `x`, `y`, score, or hit result from client | Enables cheating | Client sends intent; server simulates and validates result |
| Query Postgres every tick | Tick latency and DB load grow rapidly | Persist lifecycle events/checkpoints, not each simulation step |
| Put PixiJS in core package | Locks platform to one renderer | Keep rendering adapter in game/client layer |
| Use client timer for win condition | Browser can pause/modify clock | Server decrements game clock in fixed update loop |
| Broadcast internal state to every player | Leaks hidden information | Generate a player-specific view/snapshot |
| Delete player immediately on disconnect | Breaks reconnect | Mark disconnected, preserve logical state during grace period |
| Trust `roomId` or `gameId` from handshake | Permits unauthorized routing | Validate room membership and load game ID from durable server data |

---

# 17. Recommended next implementation sequence

1. Complete the Milestone 3.1 lifecycle repair.
2. Introduce `game_id` in rooms and a server-side game registry.
3. Convert the existing sample tag game to use the registry and explicit lifecycle hooks.
4. Add `packages/color-rush` using this guide.
5. Add lobby game selection, room routing, and one E2E scenario for Color Rush.
6. Add match-result persistence and leaderboard adapters in Milestone 4.

Following this sequence ensures the second game validates stable platform contracts rather than forcing a premature, sample-game-specific architecture.
