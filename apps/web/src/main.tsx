import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io, Socket } from "socket.io-client";
type User = { id: string; displayName: string };
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
};
type Snap = {
  phase: string;
  remainingMs: number;
  itPlayerId: string | null;
  players: P[];
  results?: P[];
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
function Lobby({ user, enter }: { user: User; enter: (room: Room) => void }) {
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

      <form onSubmit={(event) => void joinRoom(event)}>
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
    sock = useRef<Socket | null>(null),
    latestSnap = useRef<Snap | null>(null);

  useEffect(() => {
    latestSnap.current = snap;
  }, [snap]);

  useEffect(() => {
    const s = io(GAME, {
      transports: ["websocket"],
      auth: {
        roomCode: room.code,
        userId: user.id,
        displayName: user.displayName,
        spectator: String(spectator),
        host: String(room.hostUserId === user.id),
      },
    });
    sock.current = s;
    s.on("server_event", (x: Snap) => setSnap(x));
    s.on("chat_event", (x) => setChat((c) => [...c, x]));
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
      s.emit("client_event", {
        type: "input",
        seq: Date.now(),
        direction,
      });
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      s.close();
    };
  }, [room.code, user.id, user.displayName, spectator]);

  useEffect(() => {
    void fetchApi(`/rooms/${room.code}/chat`)
      .then((response) => {
        setChat(response.messages as { from: string; text: string; at: number }[]);
      })
      .catch(() => {
        // ignore chat history errors in UI; live chat still works
      });
  }, [room.code]);

  const mine = room.hostUserId === user.id;
  const secs = Math.ceil(snap.remainingMs / 1000);
  return (
    <section>
      <button onClick={back}>Back to lobby</button>
      <h1>
        Room: {room.name} ({room.code})
      </h1>
      <p>
        Invite code: <code>{room.code}</code>
      </p>
      <label>
        <input
          type="checkbox"
          checked={spectator}
          onChange={(e) => setSpectator(e.target.checked)}
        />
        Spectate only
      </label>
      {mine && snap.phase === "waiting" && (
        <button type="button" onClick={() => sock.current?.emit("start_match")}>
          Start match
        </button>
      )}
      {snap.phase === "completed" && mine && (
        <button
          type="button"
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
function App() {
  const [u, setU] = useState<User | null>(null),
    [r, setR] = useState<Room | null>(null);
  useEffect(() => {
    fetchApi("/auth/me")
      .then((x) => setU(x.user))
      .catch(() => {});
  }, []);
  if (!u) return <Login onLogin={setU} />;
  if (!r) return <Lobby user={u} enter={setR} />;
  return <Game user={u} room={r} back={() => setR(null)} />;
}
createRoot(document.getElementById("root")!).render(<App />);
