import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io, Socket } from "socket.io-client";
type User = { id: string; displayName: string; role?: string };
type Room = {
  id: string;
  code: string;
  name: string;
  isPrivate: boolean;
  status: string;
  hostUserId: string;
  role?: string;
};
type P = {
  id: string;
  name: string;
  x: number;
  y: number;
  color: string;
  tags: number;
  spectator: boolean;
  ready: boolean;
};
type Snap = {
  phase: string;
  remainingMs: number;
  itPlayerId: string | null;
  players: P[];
  results?: P[];
};
type LeaderboardRow = {
  id: string;
  displayName: string;
  matchesPlayed: number;
  totalTags: number;
  wins: number;
};
type MatchRow = {
  id: string;
  roomName: string;
  winnerName: string | null;
  endedAt: string;
  tags: number;
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
function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [n, setN] = useState("");
  return (
    <section>
      <h1>Web Game Platform</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          onLogin(
            (
              await fetchApi("/auth/dev-login", {
                method: "POST",
                body: JSON.stringify({ displayName: n }),
              })
            ).user,
          );
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
    </section>
  );
}
function Leaderboard() {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  useEffect(() => {
    void fetchApi("/leaderboard")
      .then((r) => setRows(r.leaderboard))
      .catch(() => setRows([]));
  }, []);
  if (!rows) return <p>Loading leaderboard…</p>;
  if (rows.length === 0) return <p>No completed matches yet.</p>;
  return (
    <table data-testid="leaderboard">
      <thead>
        <tr>
          <th>#</th>
          <th>Player</th>
          <th>Tags</th>
          <th>Wins</th>
          <th>Matches</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.id}>
            <td>{i + 1}</td>
            <td>{r.displayName}</td>
            <td>{r.totalTags}</td>
            <td>{r.wins}</td>
            <td>{r.matchesPlayed}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
            {m.roomName} — {m.tags} tags — winner: {m.winnerName ?? "none"}
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
  const [rooms, setRooms] = useState<Room[]>([]);
  const [name, setName] = useState("");
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
          <strong>{room.name}</strong> ({room.code}){" "}
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
      <Leaderboard />

      <MyMatches userId={user.id} />
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
    phase: "waiting",
    remainingMs: 60000,
    itPlayerId: null,
    players: [],
    }),
    [chat, setChat] = useState<{ from: string; text: string; at: number }[]>(
      [],
    ),
    [text, setText] = useState(""),
    [spectator, setSpectator] = useState(room.role === "spectator"),
    [connErr, setConnErr] = useState(""),
    sock = useRef<Socket | null>(null),
    latestSnap = useRef<Snap | null>(null);

  useEffect(() => {
    latestSnap.current = snap;
  }, [snap]);

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
      // client never asserts its own user id on the socket.
      s = io(GAME, {
        transports: ["websocket"],
        auth: { roomCode: room.code, token },
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
      const current = latestSnap.current ?? snap;
      if (current.phase !== "running" || spectator) return;
      sock.current?.emit("client_event", {
        type: "input",
        seq: Date.now(),
        direction,
      });
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      disposed = true;
      s?.close();
      sock.current = null;
    };
  }, [room.code, spectator]);

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
    // Spectator status is membership-based and server-authorized.
    try {
      await fetchApi("/rooms/join", {
        method: "POST",
        body: JSON.stringify({ code: room.code, spectator: next }),
      });
      setSpectator(next);
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
      <div
        aria-label="arena"
        style={{
          position: "relative",
          width: 400,
          height: 400,
          border: "2px solid #94a3b8",
          background: "#071122",
        }}
      >
        {snap.players.map((p) => (
          <div
            title={p.name}
            key={p.id}
            style={{
              position: "absolute",
              width: 24,
              height: 24,
              left: p.x,
              top: p.y,
              background: p.color,
              borderRadius: 6,
              outline: snap.itPlayerId === p.id ? "3px solid gold" : "none",
            }}
          />
        ))}
      </div>
      <h2>Scoreboard</h2>
      <div data-testid="scoreboard">
        {[...snap.players]
          .sort((a, b) => b.tags - a.tags)
          .map((p) => (
            <div key={p.id}>
              {p.name}: {p.tags} tags {snap.itPlayerId === p.id ? "(IT)" : ""}
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
              #{i + 1} {p.name}: {p.tags}
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
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [err, setErr] = useState("");

  const reload = async (): Promise<void> => {
    try {
      setErr("");
      setUsers((await fetchApi("/admin/users")).users);
      setRooms((await fetchApi("/admin/rooms")).rooms);
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
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

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
