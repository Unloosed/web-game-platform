# Milestone 3.1: Room Lifecycle and Rematch Repair

**Status: Applied — complete.** The roadmap (`web-game-platform-milestone-roadmap.md`)
tracks this milestone as delivered; this document is preserved as the design record.

Implementation notes that differ from or extend the original patch sketch:

- The abandoned-room cleanup route is `DELETE /internal/rooms/:code/abandoned-waiting-room`
  (guarded to `status = 'waiting'`), not a bare room delete.
- Ready-up is fully implemented: durable `room_members.ready`
  (`infra/migrations/003-room-member-ready.sql`), a validated `ready` client event,
  persistence via `POST /internal/rooms/:code/ready`, restore-on-reconnect through
  handshake verification, and a startup gate (minimum two non-spectator participants,
  all non-spectators ready) shared by `start_match` and `restart_match`.
- Mid-session spectator changes propagate from the API to the live socket session
  through `POST /internal/users/:id/spectator`, so role is enforced server-side at all
  times, not only at handshake.
- Match duration is configurable via `GAME_MATCH_MS` (default 60000); lower it when
  running the completion/rematch E2E tests.
- Completion idempotency exists at both ends: a phase-transition guard in the tick loop
  and an existing-match guard inside the transactional lifecycle route.

Apply this patch on top of the Milestone 3 project. It addresses the following verified defects:

- A completed match has no in-room rematch flow.
- Game-server memory cleanup does not delete the persistent PostgreSQL room.
- Disconnected players are never removed from in-memory game state.
- The game server does not persist lifecycle changes (`waiting`, `running`, `completed`) to the API/database.
- Socket chat is live-only even though the schema includes persistent chat storage.
- The current reconnect cleanup can delete a room while a user reconnects.

## Lifecycle policy

| Event | Action |
| --- | --- |
| Host starts or rematches | Reset simulation state, retain connected participants and spectator role, set room `running` |
| Match timer ends | Emit final snapshot/results, persist `completed` and a match record |
| Socket disconnects | Retain player state during a 15-second reconnect grace period |
| Same user reconnects in grace period | Cancel their pending removal and preserve player state |
| Last player is removed | Delete in-memory simulation and persistent room; DB foreign-key cascades delete memberships/chat/matches |
| Room created but never joined | API cleanup task removes waiting rooms without active socket presence after 10 minutes |

## Required environment settings

Add these to the environment used by both API and game-server processes:

```powershell
$env:GAME_SERVER_SECRET = 'replace-this-with-a-long-random-local-secret'
$env:API_URL = 'http://localhost:4000'
$env:ROOM_RECONNECT_GRACE_MS = '15000'
$env:EMPTY_ROOM_TTL_MS = '600000'
```

For Docker later, move these settings into Compose secrets/environment configuration; do not commit production secrets.

## API additions

Add server-to-server routes protected with the `x-game-server-secret` header:

```ts
const GAME_SERVER_SECRET = z.string().min(24).parse(process.env.GAME_SERVER_SECRET);

function requireGameServer(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.headers['x-game-server-secret'] !== GAME_SERVER_SECRET) {
    reply.code(401).send({ error: 'invalid_game_server_credentials' });
    return false;
  }
  return true;
}
```

```ts
app.post('/internal/rooms/:code/lifecycle', async (request, reply) => {
  if (!requireGameServer(request, reply)) return;

  const { code } = request.params as { code: string };
  const body = z.object({
    status: z.enum(['waiting', 'running', 'completed']),
    results: z.array(z.object({ id: z.string().uuid(), tags: z.number().int().nonnegative() })).optional(),
    winnerUserId: z.string().uuid().nullable().optional()
  }).parse(request.body);

  const roomResult = await db.query<{ id: string }>(
    'UPDATE rooms SET status = $2, updated_at = now() WHERE code = $1 RETURNING id',
    [code, body.status]
  );

  const room = roomResult.rows[0];
  if (!room) {
    reply.code(404);
    return { error: 'room_not_found' };
  }

  if (body.status === 'completed' && body.results) {
    await db.query(
      `INSERT INTO matches (room_id, winner_user_id, started_at, ended_at, results)
       VALUES ($1, $2, now(), now(), $3::jsonb)`,
      [room.id, body.winnerUserId ?? null, JSON.stringify(body.results)]
    );
  }

  return { ok: true };
});

app.delete('/internal/rooms/:code', async (request, reply) => {
  if (!requireGameServer(request, reply)) return;

  const { code } = request.params as { code: string };
  const result = await db.query('DELETE FROM rooms WHERE code = $1 RETURNING id', [code]);
  if (!result.rows[0]) {
    reply.code(404);
    return { error: 'room_not_found' };
  }
  return { ok: true };
});
```

Add an API cleanup interval at startup. This catches rooms created through HTTP but never connected to a game-server socket:

```ts
const EMPTY_ROOM_TTL_MS = z.coerce.number().default(600_000).parse(process.env.EMPTY_ROOM_TTL_MS);

setInterval(() => {
  void db.query(
    `DELETE FROM rooms
     WHERE status = 'waiting'
       AND created_at < now() - ($1::bigint * interval '1 millisecond')`,
    [EMPTY_ROOM_TTL_MS]
  );
}, 60_000).unref();
```

## Game-server changes

Replace the existing disconnect logic with a **per-user grace timer**, rather than immediately considering a socket departure a player departure.

```ts
const reconnectGraceMs = Number(process.env.ROOM_RECONNECT_GRACE_MS ?? 15_000);
const pendingRemoval = new Map<string, NodeJS.Timeout>();

function removalKey(roomCode: string, userId: string): string {
  return `${roomCode}:${userId}`;
}

function cancelPendingRemoval(roomCode: string, userId: string): void {
  const key = removalKey(roomCode, userId);
  const timer = pendingRemoval.get(key);
  if (timer) {
    clearTimeout(timer);
    pendingRemoval.delete(key);
  }
}
```

On connection:

```ts
cancelPendingRemoval(roomCode, userId);
room.connectedSocketIdsByUser.set(userId, socket.id);
room.state = addPlayer(room.state, userId, displayName, spectator);
```

On disconnect:

```ts
socket.on('disconnect', () => {
  const active = rooms.get(roomCode);
  if (!active) return;

  active.connectedSocketIdsByUser.delete(userId);
  const key = removalKey(roomCode, userId);

  const timer = setTimeout(() => {
    pendingRemoval.delete(key);
    const current = rooms.get(roomCode);
    if (!current || current.connectedSocketIdsByUser.has(userId)) return;

    const { [userId]: removed, ...remainingPlayers } = current.state.players;
    current.state = {
      ...current.state,
      players: remainingPlayers,
      itPlayerId: current.state.itPlayerId === userId ? null : current.state.itPlayerId
    };

    if (Object.keys(current.state.players).length === 0) {
      clearInterval(current.timer);
      rooms.delete(roomCode);
      void deletePersistentRoom(roomCode);
      return;
    }

    broadcast(roomCode);
  }, reconnectGraceMs);

  pendingRemoval.set(key, timer);
});
```

Use this internal API helper from the game server:

```ts
async function gameApi(path: string, init: RequestInit = {}): Promise<void> {
  const response = await fetch(`${process.env.API_URL ?? 'http://localhost:4000'}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-game-server-secret': process.env.GAME_SERVER_SECRET ?? '',
      ...(init.headers ?? {})
    }
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Game API request failed: ${response.status} ${path}`);
  }
}

function deletePersistentRoom(roomCode: string): Promise<void> {
  return gameApi(`/internal/rooms/${encodeURIComponent(roomCode)}`, { method: 'DELETE' });
}
```

### Rematch

Add a reusable reset function:

```ts
function resetForMatch(room: RoomInstance): void {
  const priorPlayers = Object.values(room.state.players);
  room.state = initialState();

  for (const player of priorPlayers) {
    room.state = addPlayer(room.state, player.id, player.name, player.spectator);
  }

  room.state.phase = 'running';
}
```

Handle both first start and rematch on the server. Only the host can invoke either:

```ts
socket.on('start_match', () => {
  if (userId !== room.hostUserId || room.state.phase !== 'waiting') return;
  resetForMatch(room);
  void gameApi(`/internal/rooms/${roomCode}/lifecycle`, {
    method: 'POST',
    body: JSON.stringify({ status: 'running' })
  });
  broadcast(roomCode);
});

socket.on('restart_match', () => {
  if (userId !== room.hostUserId || room.state.phase !== 'completed') return;
  resetForMatch(room);
  void gameApi(`/internal/rooms/${roomCode}/lifecycle`, {
    method: 'POST',
    body: JSON.stringify({ status: 'running' })
  });
  broadcast(roomCode);
});
```

When the simulation transitions to `completed`, persist results only once:

```ts
if (previousPhase !== 'completed' && room.state.phase === 'completed') {
  const finalResults = results(room.state);
  void gameApi(`/internal/rooms/${roomCode}/lifecycle`, {
    method: 'POST',
    body: JSON.stringify({
      status: 'completed',
      winnerUserId: finalResults[0]?.id ?? null,
      results: finalResults.map((player) => ({ id: player.id, tags: player.tags }))
    })
  });
}
```

## Web-client changes

Add a host-only rematch action beside completed results:

```tsx
{snap.phase === 'completed' && room.hostUserId === user.id && (
  <button type="button" onClick={() => socketRef.current?.emit('restart_match')}>
    Play again
  </button>
)}
```

Disable normal gameplay controls until the host starts the match:

```ts
if (snapshot.phase !== 'running' || spectator) {
  return;
}
```

Display explicit lifecycle text:

```tsx
<p data-testid="match-status">
  {snap.phase === 'waiting' && 'Waiting for host to start'}
  {snap.phase === 'running' && `Time remaining: ${Math.ceil(snap.remainingMs / 1000)}s`}
  {snap.phase === 'completed' && 'Match completed'}
</p>
```

## Additional test coverage

Add these tests before accepting the patch:

1. **Simulation**: a completed game reset starts at full duration with all connected players, zero tags, and no `itPlayerId`.
2. **Authorization**: non-host `restart_match` does not mutate a completed room.
3. **Reconnect**: reconnecting before 15 seconds cancels removal and preserves score/position.
4. **Cleanup**: after the final player remains disconnected past grace period, the game server stops the tick timer and its internal API request deletes the database room.
5. **E2E**: host creates room; second player joins; host starts; match completes using a configurable short duration in test mode; host presses **Play again**; both players see a new running match in the same room.

## Operational notes

Socket.IO disconnects automatically remove socket membership, but application cleanup—especially database records and tick loops—must still be implemented deliberately.[web:189] For deployment with multiple game-server replicas, move presence/room ownership to a Redis-backed coordination model and use a Socket.IO Redis adapter; otherwise a process-local room map is valid only for single-instance local development.[web:189][web:191]
