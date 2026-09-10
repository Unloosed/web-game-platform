// Mirrors PROTOCOL_VERSION in packages/protocol; the web app keeps its
// dependency-free local mirrors, so the constant is mirrored too.
export const PROTOCOL_VERSION = 2;

export const API = import.meta.env.VITE_API_URL ?? "http://localhost:4000",
  GAME = import.meta.env.VITE_GAME_URL ?? "http://localhost:4100";

export const fetchApi = async (path: string, opts: RequestInit = {}) => {
  const r = await fetch(API + path, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    ...opts,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? "request_failed");
  return d;
};
