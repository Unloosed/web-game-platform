import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomManager, type RoomLifecycleApi } from "../src/room-manager.js";

const HOST_ID = "11111111-1111-1111-1111-111111111111";
const PLAYER_ID = "22222222-2222-2222-2222-222222222222";
const SPECTATOR_ID = "33333333-3333-3333-3333-333333333333";
const ROOM_CODE = "ABC123";

function createApi(): RoomLifecycleApi & {
  markRunning: ReturnType<typeof vi.fn>;
  persistCompletion: ReturnType<typeof vi.fn>;
  deleteAbandonedWaitingRoom: ReturnType<typeof vi.fn>;
  archiveAbandonedRoom: ReturnType<typeof vi.fn>;
  persistReady: ReturnType<typeof vi.fn>;
} {
  return {
    markRunning: vi.fn().mockResolvedValue(undefined),
    persistCompletion: vi.fn().mockResolvedValue(undefined),
    deleteAbandonedWaitingRoom: vi.fn().mockResolvedValue(undefined),
    archiveAbandonedRoom: vi.fn().mockResolvedValue(undefined),
    persistReady: vi.fn().mockResolvedValue(undefined),
  };
}

function createManager() {
  const api = createApi();
  const broadcasts: unknown[] = [];

  const manager = new RoomManager({
    reconnectGraceMs: 1_000,
    tickMs: 50,
    api,
    onBroadcast: (_roomCode, snapshot) => broadcasts.push(snapshot),
  });

  return { api, broadcasts, manager };
}

function connectHost(manager: RoomManager) {
  manager.connect(ROOM_CODE, {
    userId: HOST_ID,
    displayName: "Host",
    spectator: false,
    host: true,
    socketId: "host-socket",
  });
}

function connectPlayer(
  manager: RoomManager,
  options: Partial<{ spectator: boolean; socketId: string }> = {},
) {
  manager.connect(ROOM_CODE, {
    userId: PLAYER_ID,
    displayName: "Guest",
    spectator: options.spectator ?? false,
    host: false,
    socketId: options.socketId ?? "guest-socket",
  });
}

function connectSpectator(manager: RoomManager) {
  manager.connect(ROOM_CODE, {
    userId: SPECTATOR_ID,
    displayName: "Watcher",
    spectator: true,
    host: false,
    socketId: "spectator-socket",
  });
}

/** Brings every connected non-spectator player to the ready state. */
function readyUp(
  manager: RoomManager,
  userIds: string[] = [HOST_ID, PLAYER_ID],
) {
  for (const userId of userIds) {
    manager.setReady(ROOM_CODE, userId, true);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RoomManager", () => {
  it("allows only the host to start a waiting match", async () => {
    const { manager, api } = createManager();
    connectHost(manager);
    connectPlayer(manager);
    readyUp(manager);

    expect(manager.startMatch(ROOM_CODE, PLAYER_ID)).toBe(false);
    expect(manager.getSnapshot(ROOM_CODE)?.phase).toBe("waiting");
    expect(api.markRunning).not.toHaveBeenCalled();

    expect(manager.startMatch(ROOM_CODE, HOST_ID)).toBe(true);
    expect(manager.getSnapshot(ROOM_CODE)?.phase).toBe("running");
    expect(api.markRunning).toHaveBeenCalledWith(ROOM_CODE);

    manager.dispose();
  });

  it("blocks start until every non-spectator player is ready", () => {
    const { manager, api } = createManager();
    connectHost(manager);
    connectPlayer(manager);

    expect(manager.setReady(ROOM_CODE, HOST_ID, true)).not.toBeNull();

    expect(manager.getSnapshot(ROOM_CODE)?.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: HOST_ID, ready: true }),
        expect.objectContaining({ id: PLAYER_ID, ready: false }),
      ]),
    );

    expect(manager.startMatch(ROOM_CODE, HOST_ID)).toBe(false);
    expect(api.markRunning).not.toHaveBeenCalled();

    manager.setReady(ROOM_CODE, PLAYER_ID, true);

    expect(manager.startMatch(ROOM_CODE, HOST_ID)).toBe(true);
    expect(api.markRunning).toHaveBeenCalledWith(ROOM_CODE);

    manager.dispose();
  });

  it("blocks start below the minimum participant count even when everyone is ready", () => {
    const { manager, api } = createManager();
    connectHost(manager);
    connectSpectator(manager);
    readyUp(manager, [HOST_ID]);

    // Only one non-spectator is present; spectators never count toward
    // minimum-player or readiness requirements.
    expect(manager.setReady(ROOM_CODE, SPECTATOR_ID, true)).not.toBeNull();
    expect(
      manager
        .getSnapshot(ROOM_CODE)
        ?.players.find((p) => p.id === SPECTATOR_ID)?.ready,
    ).toBe(false);

    expect(manager.startMatch(ROOM_CODE, HOST_ID)).toBe(false);
    expect(api.markRunning).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("persists ready state through the lifecycle API", () => {
    const { manager, api } = createManager();
    connectHost(manager);
    connectPlayer(manager);

    manager.setReady(ROOM_CODE, PLAYER_ID, true);

    expect(api.persistReady).toHaveBeenCalledWith(ROOM_CODE, PLAYER_ID, true);

    manager.setReady(ROOM_CODE, PLAYER_ID, false);

    expect(api.persistReady).toHaveBeenCalledWith(ROOM_CODE, PLAYER_ID, false);

    manager.dispose();
  });

  it("ignores ready toggles during a running match", () => {
    const { manager, api } = createManager();
    connectHost(manager);
    connectPlayer(manager);
    readyUp(manager);
    manager.startMatch(ROOM_CODE, HOST_ID);

    api.persistReady.mockClear();
    manager.setReady(ROOM_CODE, PLAYER_ID, false);

    expect(
      manager.getSnapshot(ROOM_CODE)?.players.find((p) => p.id === PLAYER_ID)
        ?.ready,
    ).toBe(true);
    expect(api.persistReady).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("applies live spectator role changes and broadcasts them", () => {
    const { manager } = createManager();
    connectHost(manager);
    connectPlayer(manager);

    expect(manager.setSpectator(ROOM_CODE, PLAYER_ID, true)).toBe(true);
    expect(
      manager
        .getSnapshot(ROOM_CODE)
        ?.players.find((p) => p.id === PLAYER_ID)?.spectator,
    ).toBe(true);

    expect(manager.setSpectator("UNKNOWN", PLAYER_ID, false)).toBe(false);
    expect(manager.setSpectator(ROOM_CODE, "missing-user", false)).toBe(false);

    manager.dispose();
  });

  it("allows only the host to rematch after completion", () => {
    vi.useFakeTimers();

    const { manager, api } = createManager();
    connectHost(manager);
    connectPlayer(manager);
    readyUp(manager);
    manager.startMatch(ROOM_CODE, HOST_ID);

    vi.advanceTimersByTime(61_000);

    expect(manager.getSnapshot(ROOM_CODE)?.phase).toBe("completed");
    expect(manager.restartMatch(ROOM_CODE, PLAYER_ID)).toBe(false);
    expect(manager.restartMatch(ROOM_CODE, HOST_ID)).toBe(true);
    expect(manager.getSnapshot(ROOM_CODE)?.phase).toBe("running");
    expect(api.markRunning).toHaveBeenCalledTimes(2);

    manager.dispose();
  });

  it("gates rematch until a rejoined player readies again", () => {
    vi.useFakeTimers();

    const { manager, api } = createManager();
    connectHost(manager);
    connectPlayer(manager);
    readyUp(manager);
    manager.startMatch(ROOM_CODE, HOST_ID);
    vi.advanceTimersByTime(61_000);

    expect(manager.getSnapshot(ROOM_CODE)?.phase).toBe("completed");

    // The player leaves past the grace window, so their simulation state
    // (including readiness) is discarded, then they join again.
    manager.disconnect(ROOM_CODE, PLAYER_ID);
    vi.advanceTimersByTime(1_000);
    connectPlayer(manager, { socketId: "guest-rejoined" });

    expect(manager.restartMatch(ROOM_CODE, HOST_ID)).toBe(false);
    expect(api.markRunning).toHaveBeenCalledTimes(1);

    manager.setReady(ROOM_CODE, PLAYER_ID, true);

    expect(manager.restartMatch(ROOM_CODE, HOST_ID)).toBe(true);
    expect(api.markRunning).toHaveBeenCalledTimes(2);

    manager.dispose();
  });

  it("resets timer, score, IT state, and preserves player roles on rematch", () => {
    vi.useFakeTimers();

    const { manager } = createManager();
    connectHost(manager);
    connectPlayer(manager);
    connectSpectator(manager);
    readyUp(manager);
    manager.startMatch(ROOM_CODE, HOST_ID);

    vi.advanceTimersByTime(61_000);

    const completed = manager.getSnapshot(ROOM_CODE);
    expect(completed?.phase).toBe("completed");

    manager.restartMatch(ROOM_CODE, HOST_ID);

    const restarted = manager.getSnapshot(ROOM_CODE);
    expect(restarted?.phase).toBe("running");
    expect(restarted?.remainingMs).toBe(60_000);
    expect(restarted?.itPlayerId).toBeNull();
    expect(restarted?.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: HOST_ID,
          tags: 0,
          spectator: false,
        }),
        expect.objectContaining({
          id: PLAYER_ID,
          tags: 0,
          spectator: false,
        }),
        expect.objectContaining({
          id: SPECTATOR_ID,
          tags: 0,
          spectator: true,
        }),
      ]),
    );

    manager.dispose();
  });

  it("restores persisted readiness when a player reconnects inside the grace window", () => {
    vi.useFakeTimers();

    const { manager } = createManager();
    connectHost(manager);
    connectPlayer(manager);
    readyUp(manager);

    manager.disconnect(ROOM_CODE, PLAYER_ID);
    vi.advanceTimersByTime(999);

    manager.connect(ROOM_CODE, {
      userId: PLAYER_ID,
      displayName: "Guest",
      spectator: false,
      host: false,
      socketId: "guest-reconnected",
      ready: true,
    });

    vi.advanceTimersByTime(10);

    expect(manager.getSnapshot(ROOM_CODE)?.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: PLAYER_ID, ready: true }),
      ]),
    );

    manager.dispose();
  });

  it("keeps a player when they reconnect inside the grace window", () => {
    vi.useFakeTimers();

    const { manager } = createManager();
    connectHost(manager);
    connectPlayer(manager);

    manager.disconnect(ROOM_CODE, PLAYER_ID);
    vi.advanceTimersByTime(999);

    manager.connect(ROOM_CODE, {
      userId: PLAYER_ID,
      displayName: "Guest",
      spectator: false,
      host: false,
      socketId: "guest-reconnected",
    });

    vi.advanceTimersByTime(10);

    expect(manager.getSnapshot(ROOM_CODE)?.players).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: PLAYER_ID })]),
    );

    manager.dispose();
  });

  it("removes a player after reconnect grace expires", () => {
    vi.useFakeTimers();

    const { manager } = createManager();
    connectHost(manager);
    connectPlayer(manager);

    manager.disconnect(ROOM_CODE, PLAYER_ID);
    vi.advanceTimersByTime(1_000);

    const snapshot = manager.getSnapshot(ROOM_CODE);
    expect(snapshot?.players).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: PLAYER_ID })]),
    );

    manager.dispose();
  });

  it("keeps a player while another of their sockets is still connected", () => {
    vi.useFakeTimers();

    const { manager } = createManager();
    connectHost(manager);
    connectPlayer(manager, { socketId: "guest-tab-1" });
    connectPlayer(manager, { socketId: "guest-tab-2" });

    // One tab drops; the player must be retained because the other is live.
    manager.disconnect(ROOM_CODE, PLAYER_ID, "guest-tab-1");
    vi.advanceTimersByTime(10_000);

    expect(
      manager
        .getSnapshot(ROOM_CODE)
        ?.players.some((p) => p.id === PLAYER_ID),
    ).toBe(true);

    // The last socket leaving triggers the normal grace removal.
    manager.disconnect(ROOM_CODE, PLAYER_ID, "guest-tab-2");
    vi.advanceTimersByTime(1_000);

    expect(
      manager
        .getSnapshot(ROOM_CODE)
        ?.players.some((p) => p.id === PLAYER_ID),
    ).toBe(false);

    manager.dispose();
  });

  it("keeps a player when they reconnect after a sibling tab disconnected", () => {
    vi.useFakeTimers();

    const { manager } = createManager();
    connectHost(manager);
    connectPlayer(manager, { socketId: "guest-tab-1" });
    connectPlayer(manager, { socketId: "guest-tab-2" });

    manager.disconnect(ROOM_CODE, PLAYER_ID, "guest-tab-1");
    // Reconnect replaces the closed socket without duplicating the player.
    connectPlayer(manager, { socketId: "guest-tab-3" });
    vi.advanceTimersByTime(10_000);

    expect(
      manager
        .getSnapshot(ROOM_CODE)
        ?.players.filter((p) => p.id === PLAYER_ID).length,
    ).toBe(1);

    manager.dispose();
  });

  it("deletes an empty waiting room from persistence", async () => {
    vi.useFakeTimers();

    const { manager, api } = createManager();
    connectHost(manager);

    manager.disconnect(ROOM_CODE, HOST_ID);
    vi.advanceTimersByTime(1_000);
    await vi.runAllTimersAsync();

    expect(manager.hasRoom(ROOM_CODE)).toBe(false);
    expect(api.deleteAbandonedWaitingRoom).toHaveBeenCalledWith(ROOM_CODE);

    manager.dispose();
  });

  it("retains completed room persistence when the last player leaves", async () => {
    vi.useFakeTimers();

    const { manager, api } = createManager();
    connectHost(manager);
    connectPlayer(manager);
    readyUp(manager);
    manager.startMatch(ROOM_CODE, HOST_ID);
    vi.advanceTimersByTime(61_000);

    expect(manager.getSnapshot(ROOM_CODE)?.phase).toBe("completed");

    manager.disconnect(ROOM_CODE, PLAYER_ID);
    vi.advanceTimersByTime(1_000);
    manager.disconnect(ROOM_CODE, HOST_ID);
    await vi.runAllTimersAsync();

    expect(manager.hasRoom(ROOM_CODE)).toBe(false);
    expect(api.deleteAbandonedWaitingRoom).not.toHaveBeenCalled();
    expect(api.archiveAbandonedRoom).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("archives a running room when the last player leaves past grace", async () => {
    vi.useFakeTimers();

    const { manager, api } = createManager();
    connectHost(manager);
    connectPlayer(manager);
    readyUp(manager);
    manager.startMatch(ROOM_CODE, HOST_ID);

    manager.disconnect(ROOM_CODE, PLAYER_ID);
    vi.advanceTimersByTime(1_000);
    manager.disconnect(ROOM_CODE, HOST_ID);
    await vi.runAllTimersAsync();

    // An abandoned running match can never complete, so the room must not
    // linger as "running": it is archived instead.
    expect(manager.hasRoom(ROOM_CODE)).toBe(false);
    expect(api.archiveAbandonedRoom).toHaveBeenCalledWith(ROOM_CODE);
    expect(api.deleteAbandonedWaitingRoom).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("archives a running room when a kick removes the last player", () => {
    vi.useFakeTimers();

    const { manager, api } = createManager();
    connectHost(manager);
    connectPlayer(manager);
    readyUp(manager);
    manager.startMatch(ROOM_CODE, HOST_ID);

    manager.kick(ROOM_CODE, HOST_ID);
    expect(manager.hasRoom(ROOM_CODE)).toBe(true);
    expect(api.archiveAbandonedRoom).not.toHaveBeenCalled();

    manager.kick(ROOM_CODE, PLAYER_ID);
    expect(manager.hasRoom(ROOM_CODE)).toBe(false);
    expect(api.archiveAbandonedRoom).toHaveBeenCalledWith(ROOM_CODE);

    manager.dispose();
  });
});
