import type { ReactNode } from "react";
import { fetchApi } from "./api";
import type { User } from "./types";

export const mmss = (ms: number): string =>
  `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

export const BrandMark = ({ size = 20 }: { size?: number }) => (
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

export function Topbar({
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
