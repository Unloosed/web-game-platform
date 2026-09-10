import { useEffect, useState } from "react";
import { fetchApi } from "./api";
import type { AdminReport, AdminRoom, AdminUser, AuditEntry, User } from "./types";
import { Topbar } from "./ui";

export function Admin({
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
