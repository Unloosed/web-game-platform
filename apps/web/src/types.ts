// Mirrors of the server-side types the UI consumes. The web app
// deliberately does not import from packages/ — keep these in sync with
// packages/protocol and the API responses.

export type User = { id: string; displayName: string; role?: string };

export type Room = {
  id: string;
  code: string;
  name: string;
  gameId: string;
  isPrivate: boolean;
  status: string;
  hostUserId: string;
  role?: string;
};

export type GameMeta = {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
};

// Generic roster row mirrored from packages/protocol Snapshot.
export type P = {
  id: string;
  name: string;
  score: number;
  spectator: boolean;
  ready: boolean;
};

export type Snap = {
  game: string;
  phase: string;
  remainingMs: number;
  players: P[];
  view?: unknown;
  results?: P[];
};

export type LeaderboardRow = {
  id: string;
  displayName: string;
  matchesPlayed: number;
  totalScore: number;
  wins: number;
};

export type MatchRow = {
  id: string;
  roomName: string;
  gameId: string;
  winnerName: string | null;
  endedAt: string;
  score: number;
};

export type AdminUser = {
  id: string;
  displayName: string;
  role: string;
  bannedUntil: string | null;
  mutedUntil: string | null;
};

export type AdminRoom = {
  code: string;
  name: string;
  status: string;
  hostName: string;
  members: number;
};

export type AuditEntry = {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  actorName: string;
  createdAt: string;
};

export type Achievement = { code: string; grantedAt: string };

export type AdminReport = {
  id: string;
  reason: string;
  status: string;
  roomCode: string | null;
  chatMessageId: string | null;
  reporterName: string;
  targetName: string | null;
  createdAt: string;
};
