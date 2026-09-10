import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { fetchApi } from "./api";
import { Admin } from "./Admin";
import { Lobby } from "./Lobby";
import { RoomView } from "./room/RoomView";
import type { Room, User } from "./types";
import { BrandMark } from "./ui";
import "./styles.css";

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
          onSubmit={async (e: FormEvent<HTMLFormElement>) => {
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
  return <RoomView user={u} room={r} back={() => setR(null)} onLogout={() => setU(null)} />;
}
createRoot(document.getElementById("root")!).render(<App />);
