import { useEffect, useState, type FormEvent } from "react";
import { fetchApi } from "./api";
import type { Achievement, GameMeta, LeaderboardRow, MatchRow, Room, User } from "./types";
import { shortDate, Topbar } from "./ui";

export function useGames() {
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

export function Lobby({
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
    event: FormEvent<HTMLFormElement>,
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

  const joinByCode = async (rawCode: string): Promise<void> => {
    const response = await fetchApi("/rooms/join", {
      method: "POST",
      body: JSON.stringify({ code: rawCode }),
    });
    enter(response.room as Room);
  };

  const joinRoom = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    try {
      setErr("");
      await joinByCode(code.trim().toUpperCase());
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Could not join room");
    }
  };

  const quickJoin = async (): Promise<void> => {
    try {
      setErr("");
      const open = rooms.find(
        (r) =>
          r.status === "waiting" &&
          (r.maxPlayers ?? 8) > (r.playerCount ?? 0),
      );
      if (!open) {
        setErr("No open public room right now — create one!");
        return;
      }
      await joinByCode(open.code);
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
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    data-testid="quick-join"
                    onClick={() => void quickJoin()}
                  >
                    Quick join
                  </button>
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
                    {(room.maxPlayers ?? 0) > 0 && (
                      <span
                        className="occupancy"
                        data-full={
                          (room.playerCount ?? 0) >= (room.maxPlayers ?? 8)
                        }
                      >
                        {room.playerCount ?? 0}/{room.maxPlayers}
                      </span>
                    )}
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
