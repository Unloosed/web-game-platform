import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io, Socket } from "socket.io-client";
type User = { id: string; displayName: string; role?: string };
type Room = {
  id: string;
  code: string;
  name: string;
  gameId: string;
  isPrivate: boolean;
  status: string;
  hostUserId: string;
  role?: string;
};
type GameMeta = {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
};
// Generic roster row mirrored from packages/protocol Snapshot.
type P = {
  id: string;
  name: string;
  score: number;
  spectator: boolean;
  ready: boolean;
};
type Snap = {
  game: string;
  phase: string;
  remainingMs: number;
  players: P[];
  view?: unknown;
  results?: P[];
};
// Per-game view payloads, mirrored from each game package.
type TagView = {
  players: Array<{ id: string; x: number; y: number; color: string }>;
  itPlayerId: string | null;
};
type RushView = {
  players: Array<{
    id: string;
    x: number;
    y: number;
    color: string;
    dashing: boolean;
  }>;
  orbs: Array<{ id: string; x: number; y: number; color: string }>;
};
type LeaderboardRow = {
  id: string;
  displayName: string;
  matchesPlayed: number;
  totalScore: number;
  wins: number;
};
type MatchRow = {
  id: string;
  roomName: string;
  gameId: string;
  winnerName: string | null;
  endedAt: string;
  score: number;
};
type AdminUser = {
  id: string;
  displayName: string;
  role: string;
  bannedUntil: string | null;
  mutedUntil: string | null;
};
type AdminRoom = {
  code: string;
  name: string;
  status: string;
  hostName: string;
  members: number;
};
type AuditEntry = {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  actorName: string;
  createdAt: string;
};
type Achievement = { code: string; grantedAt: string };
type AdminReport = {
  id: string;
  reason: string;
  status: string;
  roomCode: string | null;
  chatMessageId: string | null;
  reporterName: string;
  targetName: string | null;
  createdAt: string;
};
// Mirrors PROTOCOL_VERSION in packages/protocol; the web app keeps its
// dependency-free local type mirrors, so the constant is mirrored too.
const PROTOCOL_VERSION = 2;
const API = import.meta.env.VITE_API_URL ?? "http://localhost:4000",
  GAME = import.meta.env.VITE_GAME_URL ?? "http://localhost:4100";
const fetchApi = async (path: string, opts: RequestInit = {}) => {
  const r = await fetch(API + path, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    ...opts,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? "request_failed");
  return d;
};

/**
 * Client game registry: the web app's counterpart of the server-side
 * game registry. Adding a game to the UI means adding an entry here —
 * the room chrome (ready-up, start, timer, scoreboard, results, chat)
 * is generic and never changes per game.
 */
type ArenaProps = {
  snap: Snap;
  spectator: boolean;
  sendInput: (input: Record<string, unknown>) => void;
};

const useLatestSnap = (snap: Snap) => {
  const latest = useRef(snap);
  useEffect(() => {
    latest.current = snap;
  }, [snap]);
  return latest;
};

function useMovementKeys(
  spectator: boolean,
  sendInput: ArenaProps["sendInput"],
  onDirection: (direction: string, key: string) => void,
) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const d: Record<string, string> = {
        ArrowUp: "up",
        w: "up",
        ArrowDown: "down",
        s: "down",
        ArrowLeft: "left",
        a: "left",
        ArrowRight: "right",
        d: "right",
      };
      const direction = d[e.key];
      if (!direction) return;
      if (spectator) return;
      onDirection(direction, e.key);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [spectator, sendInput, onDirection]);
}

function TagArena({ snap, spectator, sendInput }: ArenaProps) {
  const latest = useLatestSnap(snap);
  useMovementKeys(spectator, sendInput, (direction) => {
    if (latest.current.phase !== "running") return;
    sendInput({ type: "input", seq: Date.now(), direction });
  });
  const view = (snap.view ?? { players: [], itPlayerId: null }) as TagView;
  return (
    <div
      data-testid="tag-arena"
      style={{
        position: "relative",
        width: 400,
        height: 400,
        border: "2px solid #94a3b8",
        background: "#071122",
      }}
    >
      {view.players.map((p) => (
        <div
          title={snap.players.find((r) => r.id === p.id)?.name ?? p.id}
          key={p.id}
          style={{
            position: "absolute",
            width: 24,
            height: 24,
            left: p.x,
            top: p.y,
            background: p.color,
            borderRadius: 6,
            outline: view.itPlayerId === p.id ? "3px solid gold" : "none",
          }}
        />
      ))}
    </div>
  );
}

function ColorRushArena({ snap, spectator, sendInput }: ArenaProps) {
  const latest = useLatestSnap(snap);
  useMovementKeys(spectator, sendInput, (direction) => {
    if (latest.current.phase !== "running") return;
    sendInput({ type: "input", seq: Date.now(), op: "move", direction });
  });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== " ") return;
      e.preventDefault();
      if (spectator || latest.current.phase !== "running") return;
      sendInput({ type: "input", seq: Date.now(), op: "dash" });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [spectator, sendInput, latest]);
  const view = (snap.view ?? { players: [], orbs: [] }) as RushView;
  return (
    <div
      data-testid="color-rush-arena"
      style={{
        position: "relative",
        width: 480,
        height: 480,
        border: "2px solid #94a3b8",
        background: "#0b1020",
      }}
    >
      {view.orbs.map((o) => (
        <div
          key={o.id}
          style={{
            position: "absolute",
            width: 20,
            height: 20,
            left: o.x - 10,
            top: o.y - 10,
            background: o.color,
            borderRadius: "50%",
            boxShadow: "0 0 8px " + o.color,
          }}
        />
      ))}
      {view.players.map((p) => (
        <div
          title={snap.players.find((r) => r.id === p.id)?.name ?? p.id}
          key={p.id}
          style={{
            position: "absolute",
            width: 22,
            height: 22,
            left: p.x - 11,
            top: p.y - 11,
            background: p.color,
            borderRadius: "50%",
            outline: p.dashing ? "3px solid white" : "none",
          }}
        />
      ))}
    </div>
  );
}

const gameViews: Record<string, React.ComponentType<ArenaProps>> = {
  "sample-tag": TagArena,
  "color-rush": ColorRushArena,
};

function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [n, setN] = useState("");
  const [err, setErr] = useState("");
  return (
    <section>
      <h1>Web Game Platform</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setErr("");
            onLogin(
              (
                await fetchApi("/auth/dev-login", {
                  method: "POST",
                  body: JSON.stringify({ displayName: n }),
                })
              ).user,
            );
          } catch (error) {
            setErr(
              error instanceof Error ? error.message : "Could not sign in",
            );
          }
        }}
      >
        <input
          aria-label="Display name"
          placeholder="Display name"
          value={n}
          onChange={(e) => setN(e.target.value)}
        />
        <button>Sign in</button>
      </form>
      {err && (
        <p role="alert">
          {err === "rate_limited"
            ? "Too many sign-in attempts. Please retry shortly."
            : err}
        </p>
      )}
    </section>
  );
}

function useGames() {
  const [games, setGames] = useState<GameMeta[]>([]);
  useEffect(() => {
    void fetchApi("/games")
      .then((r) => setGames(r.games as GameMeta[]))
      .catch(() => setGames([]));
  }, []);
  return games;
}

function Leaderboard({ games }: { games: GameMeta[] }) {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [game, setGame] = useState("");
  useEffect(() => {
    void fetchApi(`/leaderboard${game ? `?game=${game}` : ""}`)
      .then((r) => setRows(r.leaderboard))
      .catch(() => setRows([]));
  }, [game]);
  if (!rows) return <p>Loading leaderboard…</p>;
  if (rows.length === 0) return <p>No completed matches yet.</p>;
  return (
    <>
      {games.length > 0 && (
        <select
          aria-label="Leaderboard game"
          data-testid="leaderboard-game"
          value={game}
          onChange={(e) => setGame(e.target.value)}
        >
          <option value="">All games</option>
          {games.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      )}
      <table data-testid="leaderboard">
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>Score</th>
            <th>Wins</th>
            <th>Matches</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id}>
              <td>{i + 1}</td>
              <td>{r.displayName}</td>
              <td>{r.totalScore}</td>
              <td>{r.wins}</td>
              <td>{r.matchesPlayed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function MyMatches({ userId }: { userId: string }) {
  const [rows, setRows] = useState<MatchRow[] | null>(null);
  useEffect(() => {
    void fetchApi(`/users/${userId}/matches`)
      .then((r) => setRows(r.matches))
      .catch(() => setRows([]));
  }, [userId]);
  if (!rows || rows.length === 0) return null;
  return (
    <section>
      <h2>My recent matches</h2>
      <ul>
        {rows.slice(0, 5).map((m) => (
          <li key={m.id}>
            {m.roomName} ({m.gameId}) — {m.score} pts — winner:{" "}
            {m.winnerName ?? "none"}
          </li>
        ))}
      </ul>
    </section>
  );
}

function MyAchievements({ userId }: { userId: string }) {
  const [rows, setRows] = useState<Achievement[] | null>(null);
  useEffect(() => {
    void fetchApi(`/users/${userId}/achievements`)
      .then((r) => setRows(r.achievements))
      .catch(() => setRows([]));
  }, [userId]);
  if (!rows || rows.length === 0) return null;
  return (
    <section>
      <h2>Achievements</h2>
      <ul data-testid="achievements">
        {rows.map((a) => (
          <li key={a.code}>
            {a.code} — {new Date(a.grantedAt).toLocaleDateString()}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Lobby({
  user,
  enter,
}: {
  user: User;
  enter: (room: Room) => void;
}) {
  const games = useGames();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [name, setName] = useState("");
  const [gameId, setGameId] = useState("sample-tag");
  const [priv, setPriv] = useState(false);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");

  const loadRooms = async (): Promise<void> => {
    try {
      const response = await fetchApi("/rooms");
      setRooms(response.rooms as Room[]);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Could not load rooms");
    }
  };

  useEffect(() => {
    void loadRooms();
  }, []);

  const createRoom = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    const roomName = name.trim() || "New Arena";

    try {
      setErr("");

      const response = await fetchApi("/rooms", {
        method: "POST",
        body: JSON.stringify({
          name: roomName,
          gameId,
          isPrivate: priv,
        }),
      });

      enter(response.room as Room);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Could not create room");
    }
  };

  const joinRoom = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    try {
      setErr("");

      const response = await fetchApi("/rooms/join", {
        method: "POST",
        body: JSON.stringify({
          code: code.trim().toUpperCase(),
        }),
      });

      enter(response.room as Room);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Could not join room");
    }
  };

  const gameName = (id: string): string =>
    games.find((g) => g.id === id)?.name ?? id;

  return (
    <section>
      <h1>Lobby</h1>

      <p>Signed in as {user.displayName}</p>

      <h2>Create room</h2>

      <form onSubmit={(event) => void createRoom(event)}>
        <input
          placeholder="Room name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />

        <select
          aria-label="Game"
          data-testid="game-select"
          value={gameId}
          onChange={(event) => setGameId(event.target.value)}
        >
          {(games.length > 0 ? games : [{ id: "sample-tag", name: "Tag Arena" }]).map(
            (g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ),
          )}
        </select>

        <label>
          <input
            type="checkbox"
            checked={priv}
            onChange={(event) => setPriv(event.target.checked)}
          />
          Private room
        </label>

        <button type="submit">Create room</button>
      </form>

      <h2>Join by code</h2>

      <form
        data-testid="join-by-code-form"
        onSubmit={(event) => void joinRoom(event)}
      >
        <input
          placeholder="Enter room code"
          value={code}
          maxLength={6}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
        />

        <button type="submit">Join</button>
      </form>

      {err && <p role="alert">{err}</p>}

      <h2>Public rooms</h2>

      <button type="button" onClick={() => void loadRooms()}>
        Refresh
      </button>

      {rooms.length === 0 && <p>No public rooms are available.</p>}

      {rooms.map((room) => (
        <div key={room.code}>
          <strong>{room.name}</strong> ({room.code}) [{gameName(room.gameId)}]{" "}
          <button
            type="button"
            onClick={() => {
              void fetchApi("/rooms/join", {
                method: "POST",
                body: JSON.stringify({
                  code: room.code,
                }),
              })
                .then((response) => enter(response.room as Room))
                .catch((error: unknown) => {
                  setErr(
                    error instanceof Error
                      ? error.message
                      : "Could not join room",
                  );
                });
            }}
          >
            Join
          </button>
        </div>
      ))}

      <h2>Leaderboard</h2>
      <Leaderboard games={games} />

      <MyMatches userId={user.id} />
      <MyAchievements userId={user.id} />
    </section>
  );
}

function Game({
  user,
  room,
  back,
}: {
  user: User;
  room: Room;
  back: () => void;
}) {
  const [snap, setSnap] = useState<Snap>({
    game: room.gameId,
    phase: "waiting",
    remainingMs: 60000,
    players: [],
    }),
    [chat, setChat] = useState<{ from: string; text: string; at: number }[]>(
      [],
    ),
    [text, setText] = useState(""),
    [connErr, setConnErr] = useState(""),
    sock = useRef<Socket | null>(null);

  // Spectator status is server-authorized: read it from the authoritative
  // snapshot roster so the UI converges with (re)joined membership roles.
  const spectator =
    snap.players.find((p) => p.id === user.id)?.spectator ?? false;

  // sendInput stays referentially stable so arena components can hold it
  // in effect dependency lists.
  const sendInput = useCallback((input: Record<string, unknown>) => {
    sock.current?.emit("client_event", input);
  }, []);

  useEffect(() => {
    let disposed = false;
    let s: Socket | null = null;

    void (async () => {
      let token: string;
      try {
        token = (
          await fetchApi("/auth/socket-token", {
            method: "POST",
            body: JSON.stringify({}),
          })
        ).token;
      } catch (error) {
        setConnErr(
          error instanceof Error ? error.message : "Could not authorize game",
        );
        return;
      }
      if (disposed) return;

      // Identity is verified server-side from this one-time token; the
      // client never asserts its own user id on the socket. The room's
      // game definition is resolved server-side from the persisted room.
      s = io(GAME, {
        transports: ["websocket"],
        auth: {
          roomCode: room.code,
          token,
          protocolVersion: PROTOCOL_VERSION,
        },
      });
      sock.current = s;

      s.on("server_event", (x: Snap) => {
        setSnap(x);
      });

      s.on("chat_event", (x) => {
        setChat((currentChat) => [...currentChat, x]);
      });

      s.on("auth_error", () => {
        setConnErr("Game connection was rejected. Please rejoin the room.");
      });

      s.on("connect", () => {
        setConnErr("");
        s!.emit("request_snapshot");
      });

      s.on("connect_error", (error) => {
        console.error("Game socket connection failed:", error.message);
      });

      s.on("disconnect", (reason) => {
        console.warn("Game socket disconnected:", reason);
      });
    })();

    return () => {
      disposed = true;
      s?.close();
      sock.current = null;
    };
  }, [room.code]);

  useEffect(() => {
    void fetchApi(`/rooms/${room.code}/chat`)
      .then((response) => {
        setChat(
          response.messages as { from: string; text: string; at: number }[],
        );
      })
      .catch(() => {
        // ignore chat history errors in UI; live chat still works
      });
  }, [room.code]);

  const toggleSpectator = async (next: boolean): Promise<void> => {
    // The role change is membership-based and server-authorized; the
    // authoritative roster (and this checkbox) update on the next snapshot.
    try {
      await fetchApi("/rooms/join", {
        method: "POST",
        body: JSON.stringify({ code: room.code, spectator: next }),
      });
    } catch (error) {
      setConnErr(error instanceof Error ? error.message : "Could not switch role");
    }
  };

  const mine = room.hostUserId === user.id;
  const secs = Math.ceil(snap.remainingMs / 1000);
  const participants = snap.players.filter((p) => !p.spectator);
  const readyCount = participants.filter((p) => p.ready).length;
  const mineReady = participants.find((p) => p.id === user.id)?.ready ?? false;
  const canStart = participants.length >= 2 && readyCount === participants.length;
  const Arena = gameViews[room.gameId] ?? TagArena;
  return (
    <section>
      <button onClick={back}>Back to lobby</button>
      <h1>
        Room: {room.name} ({room.code})
      </h1>
      <p>
        Invite code: <code data-testid="invite-code">{room.code}</code>
      </p>
      <label>
        <input
          type="checkbox"
          checked={spectator}
          onChange={(e) => void toggleSpectator(e.target.checked)}
        />
        Spectate only
      </label>
      {connErr && <p role="alert">{connErr}</p>}
      {!spectator && snap.phase !== "running" && (
        <button
          type="button"
          data-testid="ready-toggle"
          onClick={() =>
            sock.current?.emit("client_event", {
              type: "ready",
              ready: !mineReady,
            })
          }
        >
          {mineReady ? "Unready" : "Ready up"}
        </button>
      )}
      {snap.phase !== "running" && (
        <p data-testid="readiness">
          {readyCount}/{participants.length} players ready
        </p>
      )}
      {mine && snap.phase === "waiting" && (
        <button
          type="button"
          data-testid="start-match"
          disabled={!canStart}
          title={
            canStart ? undefined : "Waiting for at least two ready players"
          }
          onClick={() => sock.current?.emit("start_match")}
        >
          Start match
        </button>
      )}
      {snap.phase === "completed" && mine && (
        <button
          type="button"
          data-testid="restart-match"
          disabled={!canStart}
          onClick={() => sock.current?.emit("restart_match")}
        >
          Play again
        </button>
      )}
      <p data-testid="match-status">
        {snap.phase === "waiting" && "Waiting for host to start"}
        {snap.phase === "running" && `Time remaining: ${secs}s`}
        {snap.phase === "completed" && "Match completed"}
      </p>
      <p data-testid="timer">
        {snap.phase === "completed" ? "Match completed" : `Time: ${secs}s`}
      </p>
      <div aria-label="arena">
        <Arena snap={snap} spectator={spectator} sendInput={sendInput} />
      </div>
      <h2>Scoreboard</h2>
      <div data-testid="scoreboard">
        {[...snap.players]
          .sort((a, b) => b.score - a.score)
          .map((p) => (
            <div key={p.id}>
              {p.name}: {p.score} pts
              {p.spectator
                ? " (spectator)"
                : snap.phase !== "running" && p.ready
                  ? " (ready)"
                  : ""}
            </div>
          ))}
      </div>
      {snap.results && (
        <>
          <h2>Results</h2>
          {snap.results.map((p, i) => (
            <div key={p.id}>
              #{i + 1} {p.name}: {p.score}
            </div>
          ))}
        </>
      )}
      <h2>Chat</h2>
      <div aria-label="chat">
        {chat.map((m, i) => (
          <div key={i}>
            <b>{m.from}:</b> {m.text}
          </div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = text.trim();
          if (!trimmed) return;
          sock.current?.emit("client_event", { type: "chat", text: trimmed });
          void fetchApi(`/rooms/${room.code}/chat`, {
            method: "POST",
            body: JSON.stringify({ text: trimmed }),
          }).catch(() => {
            // ignore persistence errors; live chat already emitted
          });
          setText("");
        }}
      >
        <input
          placeholder="Type a message"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button>Send</button>
      </form>
    </section>
  );
}
function Admin({ user, back }: { user: User; back: () => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [reports, setReports] = useState<AdminReport[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [err, setErr] = useState("");
  const [kickUser, setKickUser] = useState("");

  const reload = async (): Promise<void> => {
    try {
      setErr("");
      setUsers((await fetchApi("/admin/users")).users);
      setRooms((await fetchApi("/admin/rooms")).rooms);
      setReports((await fetchApi("/admin/reports?status=all")).reports);
      setAudit((await fetchApi("/admin/audit")).entries);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Admin data unavailable");
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const act = async (path: string, body: unknown): Promise<void> => {
    try {
      await fetchApi(path, { method: "POST", body: JSON.stringify(body) });
      await reload();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Action failed");
    }
  };

  const isAdmin = user.role === "admin";

  return (
    <section>
      <button onClick={back}>Back to lobby</button>
      <h1>Admin</h1>
      {err && <p role="alert">{err}</p>}

      <h2>Users</h2>
      <table aria-label="admin-users">
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.displayName}</td>
              <td>{u.role}</td>
              <td>
                {u.bannedUntil && new Date(u.bannedUntil) > new Date()
                  ? "banned"
                  : u.mutedUntil && new Date(u.mutedUntil) > new Date()
                    ? "muted"
                    : "active"}
              </td>
              <td>
                <button
                  onClick={() => void act(`/admin/users/${u.id}/mute`, { minutes: 10 })}
                >
                  Mute 10m
                </button>{" "}
                <button
                  onClick={() => void act(`/admin/users/${u.id}/mute`, { minutes: 0 })}
                >
                  Unmute
                </button>{" "}
                <button
                  onClick={() => void act(`/admin/users/${u.id}/ban`, { hours: 24 })}
                >
                  Ban 24h
                </button>{" "}
                <button
                  onClick={() => void act(`/admin/users/${u.id}/ban`, { hours: 0 })}
                >
                  Unban
                </button>
                {isAdmin && u.role !== "admin" && (
                  <>
                    {" "}
                    <button
                      onClick={() =>
                        void act(`/admin/users/${u.id}/role`, { role: "moderator" })
                      }
                    >
                      Make moderator
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Rooms</h2>
      <table aria-label="admin-rooms">
        <thead>
          <tr>
            <th>Name</th>
            <th>Code</th>
            <th>Status</th>
            <th>Host</th>
            <th>Members</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rooms.map((r) => (
            <tr key={r.code}>
              <td>{r.name}</td>
              <td>{r.code}</td>
              <td>{r.status}</td>
              <td>{r.hostName}</td>
              <td>{r.members}</td>
              <td>
                <button
                  onClick={() => void act(`/admin/rooms/${r.code}/close`, {})}
                >
                  Close room
                </button>{" "}
                <form
                  style={{ display: "inline" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!kickUser.trim()) return;
                    void act(`/admin/rooms/${r.code}/kick`, {
                      userId: kickUser.trim(),
                    });
                  }}
                >
                  <input
                    aria-label={`Kick user id from ${r.code}`}
                    placeholder="User id"
                    size={36}
                    value={kickUser}
                    onChange={(e) => setKickUser(e.target.value)}
                  />{" "}
                  <button type="submit">Kick</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Reports</h2>
      {reports.length === 0 && <p>No reports.</p>}
      {reports.length > 0 && (
        <table aria-label="admin-reports">
          <thead>
            <tr>
              <th>Reporter</th>
              <th>Target</th>
              <th>Room</th>
              <th>Reason</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((rp) => (
              <tr key={rp.id}>
                <td>{rp.reporterName}</td>
                <td>{rp.targetName ?? "—"}</td>
                <td>{rp.roomCode ?? "—"}</td>
                <td>{rp.reason}</td>
                <td>{rp.status}</td>
                <td>
                  {rp.status === "open" && (
                    <>
                      <button
                        onClick={() =>
                          void act(`/admin/reports/${rp.id}/resolve`, {
                            status: "resolved",
                          })
                        }
                      >
                        Resolve
                      </button>{" "}
                      <button
                        onClick={() =>
                          void act(`/admin/reports/${rp.id}/resolve`, {
                            status: "dismissed",
                          })
                        }
                      >
                        Dismiss
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Audit log</h2>
      <ul aria-label="admin-audit">
        {audit.map((a) => (
          <li key={a.id}>
            {new Date(a.createdAt).toISOString()} — {a.actorName} {a.action}{" "}
            {a.targetType} {a.targetId}
          </li>
        ))}
      </ul>
    </section>
  );
}
function App() {
  const [u, setU] = useState<User | null>(null),
    [r, setR] = useState<Room | null>(null),
    [admin, setAdmin] = useState(false);
  useEffect(() => {
    fetchApi("/auth/me")
      .then((x) => setU(x.user))
      .catch(() => {});
  }, []);
  if (!u) return <Login onLogin={setU} />;
  if (admin)
    return <Admin user={u} back={() => setAdmin(false)} />;
  if (!r)
    return (
      <>
        <Lobby user={u} enter={setR} />
        {(u.role === "admin" || u.role === "moderator") && (
          <button onClick={() => setAdmin(true)}>Open admin</button>
        )}
      </>
    );
  return <Game user={u} room={r} back={() => setR(null)} />;
}
createRoot(document.getElementById("root")!).render(<App />);
