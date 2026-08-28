import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { io, Socket } from "socket.io-client";
import "./styles.css";

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

const mmss = (ms: number): string =>
  `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

const BrandMark = ({ size = 20 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M5 7l3 10 4-7 4 7 3-10"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

function Topbar({
  user,
  onLogout,
  children,
}: {
  user: User;
  onLogout: () => void;
  children?: ReactNode;
}) {
  const initial = user.displayName.trim().charAt(0).toUpperCase() || "?";
  return (
    <header className="topbar">
      <span className="brand">
        <span className="brand-mark">
          <BrandMark />
        </span>
        Web Game Platform
      </span>
      <div className="topbar-spacer" />
      {children}
      <div className="user-chip">
        <span className="avatar" aria-hidden="true">
          {initial}
        </span>
        {user.displayName}
        {user.role && user.role !== "player" && (
          <span className="role-tag">{user.role}</span>
        )}
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-small"
        onClick={() => {
          void fetchApi("/auth/logout", { method: "POST" })
            .catch(() => {})
            .finally(onLogout);
        }}
      >
        Sign out
      </button>
    </header>
  );
}

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

type GameViewEntry = {
  component: React.ComponentType<ArenaProps>;
  controls: Array<{ keys: string; action: string }>;
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
  onDirection: (direction: string) => void,
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
      onDirection(direction);
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
        background:
          "radial-gradient(ellipse at 50% 0%, #16234a 0%, #071122 62%)",
      }}
    >
      {view.players.map((p) => (
        <div
          title={snap.players.find((r) => r.id === p.id)?.name ?? p.id}
          key={p.id}
          className={"player-dot" + (view.itPlayerId === p.id ? " is-it" : "")}
          style={{
            width: 24,
            height: 24,
            left: p.x,
            top: p.y,
            background: p.color,
            color: p.color,
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
        background:
          "radial-gradient(ellipse at 50% 0%, #241636 0%, #0b1020 62%)",
      }}
    >
      {view.orbs.map((o) => (
        <div
          key={o.id}
          className="orb"
          style={{
            width: 20,
            height: 20,
            left: o.x - 10,
            top: o.y - 10,
            background: o.color,
            color: o.color,
          }}
        />
      ))}
      {view.players.map((p) => (
        <div
          title={snap.players.find((r) => r.id === p.id)?.name ?? p.id}
          key={p.id}
          className={
            "player-dot is-round" + (p.dashing ? " is-dashing" : "")
          }
          style={{
            width: 22,
            height: 22,
            left: p.x - 11,
            top: p.y - 11,
            background: p.color,
            color: p.color,
          }}
        />
      ))}
    </div>
  );
}

const gameViews: Record<string, GameViewEntry> = {
  "sample-tag": {
    component: TagArena,
    controls: [
      { keys: "WASD / ← ↑ → ↓", action: "move" },
      { keys: "Tag", action: "steal the crown" },
    ],
  },
  "color-rush": {
    component: ColorRushArena,
    controls: [
      { keys: "WASD / ← ↑ → ↓", action: "move" },
      { keys: "Space", action: "dash" },
    ],
  },
};

function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [n, setN] = useState("");
  const [err, setErr] = useState("");
  return (
    <div className="login-wrap">
      <div className="login-card card">
        <div className="brand-mark">
          <BrandMark size={30} />
        </div>
        <h1>Web Game Platform</h1>
        <p className="login-sub">
          Self-hosted multiplayer browser games. Pick a name and drop into a
          room.
        </p>
        <form
          className="login-form"
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
            className="input"
            aria-label="Display name"
            placeholder="Display name"
            value={n}
            onChange={(e) => setN(e.target.value)}
          />
          <button className="btn btn-primary">Sign in</button>
        </form>
        {err && (
          <p className="alert" role="alert">
            {err === "rate_limited"
              ? "Too many sign-in attempts. Please retry shortly."
              : err}
          </p>
        )}
      </div>
    </div>
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
  return (
    <section className="card">
      <h2>Leaderboard</h2>
      <div className="filter-row" data-testid="leaderboard-game">
        <button
          type="button"
          className="filter-pill"
          aria-pressed={game === ""}
          onClick={() => setGame("")}
        >
          All games
        </button>
        {games.map((g) => (
          <button
            key={g.id}
            type="button"
            className="filter-pill"
            aria-pressed={game === g.id}
            onClick={() => setGame(g.id)}
          >
            {g.name}
          </button>
        ))}
      </div>
      {rows === null && <p className="hint">Loading leaderboard…</p>}
      {rows !== null && rows.length === 0 && (
        <div className="empty-state">No completed matches yet.</div>
      )}
      {rows !== null && rows.length > 0 && (
        <table className="table" data-testid="leaderboard">
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th className="num">Score</th>
              <th className="num">Wins</th>
              <th className="num">Matches</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id}>
                <td>
                  <span className={"rank" + (i < 3 ? ` rank-${i + 1}` : "")}>
                    {i + 1}
                  </span>
                </td>
                <td>{r.displayName}</td>
                <td className="num">{r.totalScore}</td>
                <td className="num">{r.wins}</td>
                <td className="num">{r.matchesPlayed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function MyMatches({ userId }: { userId: string }) {
  const [rows, setRows] = useState<MatchRow[] | null>(null);
  useEffect(() => {
    void fetchApi(`/users/${userId}/matches`)
      .then((r) => setRows(r.matches))
      .catch(() => setRows([]));
  }, [userId]);
  if (rows !== null && rows.length === 0) return null;
  return (
    <section className="card">
      <h2>My recent matches</h2>
      {rows === null && <p className="hint">Loading…</p>}
      {rows !== null && (
        <ul className="stat-list">
          {rows.slice(0, 5).map((m) => (
            <li key={m.id}>
              <span className="badge" data-game={m.gameId}>
                {m.gameId}
              </span>
              <span>{m.roomName}</span>
              <span className="spacer" />
              <span>{m.score} pts</span>
              <span className="stat-date">{shortDate(m.endedAt)}</span>
            </li>
          ))}
        </ul>
      )}
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
  if (rows !== null && rows.length === 0) return null;
  return (
    <section className="card">
      <h2>Achievements</h2>
      {rows === null && <p className="hint">Loading…</p>}
      {rows !== null && (
        <ul className="stat-list" data-testid="achievements">
          {rows.map((a) => (
            <li key={a.code}>
              <span className="achv-code">{a.code}</span>
              <span className="spacer" />
              <span className="stat-date">{shortDate(a.grantedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Lobby({
  user,
  enter,
  onLogout,
  openAdmin,
}: {
  user: User;
  enter: (room: Room) => void;
  onLogout: () => void;
  openAdmin: () => void;
}) {
  const games = useGames();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [name, setName] = useState("");
  const [gameId, setGameId] = useState("sample-tag");
  const [priv, setPriv] = useState(false);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const canAdmin = user.role === "admin" || user.role === "moderator";

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
    <>
      <Topbar user={user} onLogout={onLogout}>
        {canAdmin && (
          <button
            type="button"
            className="btn btn-small"
            onClick={openAdmin}
          >
            Open admin
          </button>
        )}
      </Topbar>
      <main className="shell">
        <div className="lobby-grid">
          <div className="stack">
            <section className="card">
              <h2>Create room</h2>
              <form className="form-row" onSubmit={(event) => void createRoom(event)}>
                <input
                  className="input"
                  placeholder="Room name"
                  aria-label="Room name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <select
                  aria-label="Game"
                  data-testid="game-select"
                  value={gameId}
                  onChange={(event) => setGameId(event.target.value)}
                >
                  {(
                    games.length > 0
                      ? games
                      : [{ id: "sample-tag", name: "Tag Arena" }]
                  ).map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
                <label className="switch" title="Only joinable with the invite code">
                  <input
                    type="checkbox"
                    checked={priv}
                    onChange={(event) => setPriv(event.target.checked)}
                  />
                  Private
                </label>
                <button type="submit" className="btn btn-primary">
                  Create room
                </button>
              </form>
              {games.find((g) => g.id === gameId) && (
                <p className="hint">
                  {games.find((g) => g.id === gameId)!.description}
                </p>
              )}
            </section>

            <section className="card">
              <h2>Join by code</h2>
              <form
                className="form-row"
                data-testid="join-by-code-form"
                onSubmit={(event) => void joinRoom(event)}
              >
                <input
                  className="input code-input"
                  placeholder="Enter room code"
                  aria-label="Enter room code"
                  value={code}
                  maxLength={6}
                  onChange={(event) =>
                    setCode(event.target.value.toUpperCase())
                  }
                />
                <button type="submit" className="btn btn-primary">
                  Join
                </button>
              </form>
            </section>

            {err && (
              <p className="alert" role="alert">
                {err}
              </p>
            )}

            <div>
              <div className="section-title">
                Public rooms
                <small>
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => void loadRooms()}>
                    Refresh
                  </button>
                </small>
              </div>
              {rooms.length === 0 && (
                <div className="empty-state">
                  No public rooms are available. Create one and share the code!
                </div>
              )}
              <div className="room-list">
                {rooms.map((room) => (
                  <div key={room.code} className="room-card">
                    <span className="badge" data-game={room.gameId}>
                      {gameName(room.gameId)}
                    </span>
                    <span className="status-pill" data-status={room.status}>
                      {room.status}
                    </span>
                    <span className="room-card-name">{room.name}</span>
                    <span className="room-card-code">{room.code}</span>
                    <button
                      type="button"
                      className="btn btn-small"
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
              </div>
            </div>
          </div>

          <div className="stack">
            <Leaderboard games={games} />
            <MyMatches userId={user.id} />
            <MyAchievements userId={user.id} />
          </div>
        </div>
      </main>
    </>
  );
}

function Scoreboard({ snap }: { snap: Snap }) {
  // Player colors live in the game-specific view payload; the generic
  // scoreboard only borrows them for the color dots.
  const colorById = new Map<string, string>();
  const view = snap.view as { players?: Array<{ id: string; color: string }> };
  if (view && Array.isArray(view.players)) {
    for (const p of view.players) {
      if (p && typeof p.id === "string" && typeof p.color === "string") {
        colorById.set(p.id, p.color);
      }
    }
  }
  const ranked = [...snap.players].sort((a, b) => b.score - a.score);
  return (
    <section className="card">
      <h2>Scoreboard</h2>
      <div className="score-list" data-testid="scoreboard">
        {ranked.map((p, i) => (
          <div key={p.id} className="score-row">
            <span className={"rank" + (i < 3 && p.score > 0 ? ` rank-${i + 1}` : "")}>
              {i + 1}
            </span>
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: colorById.get(p.id) ?? "var(--surface-2)",
                boxShadow: colorById.has(p.id)
                  ? `0 0 8px ${colorById.get(p.id)}`
                  : undefined,
                flexShrink: 0,
              }}
            />
            <span className="name">{p.name}</span>
            {p.spectator ? (
              <span className="tag-note is-spectator">(spectator)</span>
            ) : snap.phase !== "running" && p.ready ? (
              <span className="tag-note is-ready">(ready)</span>
            ) : null}
            <span className="score">{p.score}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Game({
  user,
  room,
  back,
  onLogout,
}: {
  user: User;
  room: Room;
  back: () => void;
  onLogout: () => void;
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
    [copied, setCopied] = useState(false),
    [connected, setConnected] = useState(false),
    sock = useRef<Socket | null>(null),
    chatLogRef = useRef<HTMLDivElement | null>(null),
    matchTotalMs = useRef(0);

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
        setConnected(true);
        setConnErr("");
        s!.emit("request_snapshot");
      });

      s.on("connect_error", (error) => {
        console.error("Game socket connection failed:", error.message);
      });

      s.on("disconnect", (reason) => {
        setConnected(false);
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

  // QoL: keep the newest chat message in view.
  useEffect(() => {
    const el = chatLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  // The progress bar needs the match's total length; running snapshots
  // carry the remaining time, which starts at the full match length.
  useEffect(() => {
    if (snap.phase === "running") {
      matchTotalMs.current = Math.max(matchTotalMs.current, snap.remainingMs);
    }
  }, [snap.phase, snap.remainingMs]);

  const toggleSpectator = async (next: boolean): Promise<void> => {
    // The role change is membership-based and server-authorized; the
    // authoritative roster (and this switch) update on the next snapshot.
    try {
      await fetchApi("/rooms/join", {
        method: "POST",
        body: JSON.stringify({ code: room.code, spectator: next }),
      });
    } catch (error) {
      setConnErr(error instanceof Error ? error.message : "Could not switch role");
    }
  };

  const copyInvite = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(room.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard unavailable (permissions/insecure context): no-op.
    }
  };

  const mine = room.hostUserId === user.id;
  const secs = Math.ceil(snap.remainingMs / 1000);
  const participants = snap.players.filter((p) => !p.spectator);
  const readyCount = participants.filter((p) => p.ready).length;
  const mineReady = participants.find((p) => p.id === user.id)?.ready ?? false;
  const canStart = participants.length >= 2 && readyCount === participants.length;
  const Arena = (gameViews[room.gameId] ?? gameViews["sample-tag"]).component;
  const controls = (gameViews[room.gameId] ?? gameViews["sample-tag"]).controls;
  const games = useGames();
  const gameName =
    games.find((g) => g.id === room.gameId)?.name ?? room.gameId;
  const timerPct =
    matchTotalMs.current > 0
      ? Math.max(0, Math.min(100, (snap.remainingMs / matchTotalMs.current) * 100))
      : 0;
  return (
    <>
      <Topbar user={user} onLogout={onLogout}>
        <button type="button" className="btn btn-small" onClick={back}>
          Back to lobby
        </button>
      </Topbar>
      <main className="shell">
        <div className="room-head">
          <h1>
            Room: {room.name}{" "}
            <span style={{ color: "var(--text-dim)" }}>({room.code})</span>
          </h1>
          <span className="badge" data-game={room.gameId}>
            {gameName}
          </span>
          <span className="status-pill" data-status={snap.phase}>
            {snap.phase}
          </span>
          <span className="invite-chip">
            Invite
            <code data-testid="invite-code">{room.code}</code>
            <button
              type="button"
              className={"copy-btn" + (copied ? " copied" : "")}
              onClick={() => void copyInvite()}
              title="Copy invite code"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </span>
          <label className="switch" title="Watch the match without playing">
            <input
              type="checkbox"
              checked={spectator}
              onChange={(e) => void toggleSpectator(e.target.checked)}
            />
            Spectate only
          </label>
        </div>
        {connErr && (
          <p className="alert" role="alert">
            {connErr}
          </p>
        )}
        <div className="status-strip">
          <p className="match-status" data-testid="match-status">
            {snap.phase === "waiting" && "Waiting for host to start"}
            {snap.phase === "running" && `Time remaining: ${secs}s`}
            {snap.phase === "completed" && "Match completed"}
          </p>
          {snap.phase === "running" && (
            <>
              <span className="timer-chip" data-testid="timer">
                {mmss(snap.remainingMs)}
              </span>
              <div className="timer-bar" aria-hidden="true">
                <div
                  className="timer-fill"
                  style={{ width: `${timerPct}%` }}
                />
              </div>
            </>
          )}
          {snap.phase !== "running" && (
            <p className="timer-chip" data-testid="timer">
              {snap.phase === "completed" ? "—" : mmss(snap.remainingMs)}
            </p>
          )}
          {snap.phase !== "running" && (
            <p className="readiness-line" data-testid="readiness">
              {readyCount}/{participants.length} players ready
            </p>
          )}
          {!spectator && snap.phase !== "running" && (
            <button
              type="button"
              className="btn"
              data-testid="ready-toggle"
              disabled={!connected}
              title={connected ? undefined : "Connecting…"}
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
          {mine && snap.phase === "waiting" && (
            <button
              type="button"
              className="btn btn-primary"
              data-testid="start-match"
              disabled={!canStart || !connected}
              title={
                !connected
                  ? "Connecting…"
                  : canStart
                    ? undefined
                    : "Waiting for at least two ready players"
              }
              onClick={() => sock.current?.emit("start_match")}
            >
              Start match
            </button>
          )}
          {snap.phase === "completed" && mine && (
            <button
              type="button"
              className="btn btn-primary"
              data-testid="restart-match"
              disabled={!canStart || !connected}
              title={!connected ? "Connecting…" : undefined}
              onClick={() => sock.current?.emit("restart_match")}
            >
              Play again
            </button>
          )}
        </div>
        <div className="room-grid">
          <div className="arena-stage" aria-label="arena" data-game={room.gameId}>
            <div className="arena-frame">
              <Arena snap={snap} spectator={spectator} sendInput={sendInput} />
            </div>
            {!spectator && (
              <div className="controls-hint">
                {controls.map((c) => (
                  <span key={c.keys}>
                    <span className="keycap">{c.keys}</span> {c.action}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="stack">
            <Scoreboard snap={snap} />
            {snap.results && (
              <section className="card">
                <h2>Results</h2>
                <div className="results-list">
                  {snap.results.map((p, i) => (
                    <div key={p.id} className="result-row">
                      <span
                        className={"rank" + (i < 3 ? ` rank-${i + 1}` : "")}
                      >
                        #{i + 1}
                      </span>
                      <span className="name">{p.name}</span>
                      <span className="score">{p.score}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
            <section className="card chat-panel">
              <h2>Chat</h2>
              <div className="chat-log" aria-label="chat" ref={chatLogRef}>
                {chat.length === 0 && (
                  <div className="chat-empty">No messages yet. Say hi!</div>
                )}
                {chat.map((m, i) => (
                  <div key={i} className="chat-msg">
                    <span className="from">{m.from}:</span>
                    {m.text}
                  </div>
                ))}
              </div>
              <form
                className="chat-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const trimmed = text.trim();
                  if (!trimmed) return;
                  sock.current?.emit("client_event", {
                    type: "chat",
                    text: trimmed,
                  });
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
                  className="input"
                  placeholder="Type a message"
                  aria-label="Chat message"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <button className="btn">Send</button>
              </form>
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
function Admin({
  user,
  back,
  onLogout,
}: {
  user: User;
  back: () => void;
  onLogout: () => void;
}) {
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
    <>
      <Topbar user={user} onLogout={onLogout}>
        <button type="button" className="btn btn-small" onClick={back}>
          Back to lobby
        </button>
      </Topbar>
      <main className="shell">
        <div className="admin-grid">
          {err && (
            <p className="alert" role="alert">
              {err}
            </p>
          )}

          <section className="card">
            <h2>Users</h2>
            <table className="table" aria-label="admin-users">
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
                        className="btn btn-small"
                        onClick={() =>
                          void act(`/admin/users/${u.id}/mute`, { minutes: 10 })
                        }
                      >
                        Mute 10m
                      </button>{" "}
                      <button
                        className="btn btn-small"
                        onClick={() =>
                          void act(`/admin/users/${u.id}/mute`, { minutes: 0 })
                        }
                      >
                        Unmute
                      </button>{" "}
                      <button
                        className="btn btn-small btn-danger"
                        onClick={() =>
                          void act(`/admin/users/${u.id}/ban`, { hours: 24 })
                        }
                      >
                        Ban 24h
                      </button>{" "}
                      <button
                        className="btn btn-small"
                        onClick={() =>
                          void act(`/admin/users/${u.id}/ban`, { hours: 0 })
                        }
                      >
                        Unban
                      </button>
                      {isAdmin && u.role !== "admin" && (
                        <>
                          {" "}
                          <button
                            className="btn btn-small"
                            onClick={() =>
                              void act(`/admin/users/${u.id}/role`, {
                                role: "moderator",
                              })
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
          </section>

          <section className="card">
            <h2>Rooms</h2>
            <table className="table" aria-label="admin-rooms">
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
                    <td>
                      <code>{r.code}</code>
                    </td>
                    <td>
                      <span className="status-pill" data-status={r.status}>
                        {r.status}
                      </span>
                    </td>
                    <td>{r.hostName}</td>
                    <td className="num">{r.members}</td>
                    <td>
                      <button
                        className="btn btn-small btn-danger"
                        onClick={() =>
                          void act(`/admin/rooms/${r.code}/close`, {})
                        }
                      >
                        Close room
                      </button>{" "}
                      <form
                        className="inline-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!kickUser.trim()) return;
                          void act(`/admin/rooms/${r.code}/kick`, {
                            userId: kickUser.trim(),
                          });
                        }}
                      >
                        <input
                          className="input"
                          aria-label={`Kick user id from ${r.code}`}
                          placeholder="User id"
                          size={36}
                          value={kickUser}
                          onChange={(e) => setKickUser(e.target.value)}
                        />{" "}
                        <button className="btn btn-small" type="submit">
                          Kick
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card">
            <h2>Reports</h2>
            {reports.length === 0 && (
              <div className="empty-state">No reports.</div>
            )}
            {reports.length > 0 && (
              <table className="table" aria-label="admin-reports">
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
                      <td>
                        <code>{rp.roomCode ?? "—"}</code>
                      </td>
                      <td>{rp.reason}</td>
                      <td>
                        <span className="status-pill" data-status={rp.status}>
                          {rp.status}
                        </span>
                      </td>
                      <td>
                        {rp.status === "open" && (
                          <>
                            <button
                              className="btn btn-small"
                              onClick={() =>
                                void act(`/admin/reports/${rp.id}/resolve`, {
                                  status: "resolved",
                                })
                              }
                            >
                              Resolve
                            </button>{" "}
                            <button
                              className="btn btn-small"
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
          </section>

          <section className="card">
            <h2>Audit log</h2>
            <ul className="stat-list" aria-label="admin-audit">
              {audit.map((a) => (
                <li key={a.id}>
                  <span className="stat-date">
                    {new Date(a.createdAt).toISOString()}
                  </span>
                  <span>
                    <b>{a.actorName}</b> {a.action} {a.targetType}{" "}
                    {a.targetId}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
    </>
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
    return <Admin user={u} back={() => setAdmin(false)} onLogout={() => setU(null)} />;
  if (!r)
    return (
      <Lobby
        user={u}
        enter={setR}
        onLogout={() => setU(null)}
        openAdmin={() => setAdmin(true)}
      />
    );
  return <Game user={u} room={r} back={() => setR(null)} onLogout={() => setU(null)} />;
}
createRoot(document.getElementById("root")!).render(<App />);
