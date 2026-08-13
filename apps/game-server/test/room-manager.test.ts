import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomManager, type RoomLifecycleApi } from "../src/room-manager.js";

const HOST_ID = "11111111-1111-1111-1111-111111111111";
const PLAYER_ID = "22222222-2222-2222-2222-222222222222";
const ROOM_CODE = "ABC123";

function createApi(): RoomLifecycleApi & {
  markRunning: ReturnType<typeof vi.fn>;
  persistCompletion: ReturnType<typeof vi.fn>;
  deleteAbandonedWaitingRoom: ReturnType<typeof vi.fn>;
} {
  return {
    markRunning: vi.fn().mockResolvedValue(undefined),
    persistCompletion: vi.fn().mockResolvedValue(undefined),
    deleteAbandonedWaitingRoom: vi.fn().mockResolvedValue(undefined),
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

afterEach(() => {
  vi.useRealTimers();
});

describe("RoomManager", () => {
  it("allows only the host to start a waiting match", async () => {
    const { manager, api } = createManager();
    connectHost(manager);
    connectPlayer(manager);

    expect(manager.startMatch(ROOM_CODE, PLAYER_ID)).toBe(false);
    expect(manager.getSnapshot(ROOM_CODE)?.phase).toBe("waiting");
    expect(api.markRunning).not.toHaveBeenCalled();

    expect(manager.startMatch(ROOM_CODE, HOST_ID)).toBe(true);
    expect(manager.getSnapshot(ROOM_CODE)?.phase).toBe("running");
    expect(api.markRunning).toHaveBeenCalledWith(ROOM_CODE);

    manager.dispose();
  });

  it("allows only the host to rematch after completion", () => {
    vi.useFakeTimers();

    const { manager, api } = createManager();
    connectHost(manager);
    connectPlayer(manager);
    manager.startMatch(ROOM_CODE, HOST_ID);

    vi.advanceTimersByTime(61_000);

    expect(manager.getSnapshot(ROOM_CODE)?.phase).toBe("completed");
    expect(manager.restartMatch(ROOM_CODE, PLAYER_ID)).toBe(false);
    expect(manager.restartMatch(ROOM_CODE, HOST_ID)).toBe(true);
    expect(manager.getSnapshot(ROOM_CODE)?.phase).toBe("running");
    expect(api.markRunning).toHaveBeenCalledTimes(2);

    manager.dispose();
  });

  it("resets timer, score, IT state, and preserves player roles on rematch", () => {
    vi.useFakeTimers();

    const { manager } = createManager();
    connectHost(manager);
    connectPlayer(manager, { spectator: true });
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
          spectator: true,
        }),
      ]),
    );

    manager.dispose();
  });

  it("persists match completion once when the running match transitions to completed", async () => {
    vi.useFakeTimers();

    const { manager, api } = createManager();

    try {
      connectHost(manager);
      connectPlayer(manager);

      expect(manager.startMatch(ROOM_CODE, HOST_ID)).toBe(true);

      await vi.advanceTimersByTimeAsync(60_050);

      expect(manager.getSnapshot(ROOM_CODE)?.phase).toBe("completed");

      expect(api.persistCompletion).toHaveBeenCalledTimes(1);
      expect(api.persistCompletion).toHaveBeenCalledWith(
        ROOM_CODE,
        expect.objectContaining({
          winnerUserId: expect.any(String),
          results: expect.arrayContaining([
            expect.objectContaining({
              id: HOST_ID,
              tags: expect.any(Number),
            }),
            expect.objectContaining({
              id: PLAYER_ID,
              tags: expect.any(Number),
            }),
          ]),
        }),
      );

      // Advance farther: the completed tick loop may keep broadcasting,
      // but completion persistence must not happen a second time.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(api.persistCompletion).toHaveBeenCalledTimes(1);
    } finally {
      manager.dispose();
    }
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

  it("retains completed room persistence when the last player leaves", () => {
    vi.useFakeTimers();

    const { manager, api } = createManager();
    connectHost(manager);
    manager.startMatch(ROOM_CODE, HOST_ID);
    vi.advanceTimersByTime(61_000);

    manager.disconnect(ROOM_CODE, HOST_ID);
    vi.advanceTimersByTime(1_000);

    expect(manager.hasRoom(ROOM_CODE)).toBe(false);
    expect(api.deleteAbandonedWaitingRoom).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("retains running room persistence when the last player leaves", () => {
    vi.useFakeTimers();

    const { manager, api } = createManager();
    connectHost(manager);
    manager.startMatch(ROOM_CODE, HOST_ID);

    manager.disconnect(ROOM_CODE, HOST_ID);
    vi.advanceTimersByTime(1_000);

    expect(manager.hasRoom(ROOM_CODE)).toBe(false);
    expect(api.deleteAbandonedWaitingRoom).not.toHaveBeenCalled();

    manager.dispose();
  });
});
