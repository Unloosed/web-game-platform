import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { fetchApi, GAME, PROTOCOL_VERSION } from "../api";
import { getGameView } from "../games/registry";
import { useGames } from "../Lobby";
import { useSfx } from "./sfx";
import type { Room, Snap, User } from "../types";
import { mmss, Topbar } from "../ui";

export function Scoreboard({ snap }: { snap: Snap }) {
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

export function RoomView({
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
    [wasConnected, setWasConnected] = useState(false),
    [sfxOn, setSfxOn] = useState(true),
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

  useSfx(snap, sfxOn);

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
      // E2E seam: lets tests drop/re-establish the connection deterministically.
      (window as unknown as { __roomSocket?: Socket }).__roomSocket = s;

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
        setWasConnected(true);
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
  const { component: Arena, controls } = getGameView(room.gameId);
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
          <button
            type="button"
            className="btn btn-small"
            data-testid="sfx-toggle"
            aria-pressed={sfxOn}
            title="Game sound effects"
            onClick={() => setSfxOn((v) => !v)}
          >
            SFX {sfxOn ? "on" : "off"}
          </button>
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
              <Arena
                snap={snap}
                spectator={spectator}
                userId={user.id}
                sendInput={sendInput}
              />
              {!connected && wasConnected && !connErr && (
                <div className="reconnect-overlay" data-testid="reconnect-banner" role="status">
                  Connection lost — reconnecting…
                </div>
              )}
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
