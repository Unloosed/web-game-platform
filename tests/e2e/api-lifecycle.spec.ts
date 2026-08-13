import { expect, test, type APIRequestContext } from "@playwright/test";

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const GAME_SERVER_SECRET = process.env.GAME_SERVER_SECRET;

if (!GAME_SERVER_SECRET) {
  throw new Error(
    "GAME_SERVER_SECRET must be set before running lifecycle E2E tests.",
  );
}

type Login = {
  user: {
    id: string;
    displayName: string;
  };
};

type Room = {
  id: string;
  code: string;
  name: string;
  status: "waiting" | "running" | "completed";
  hostUserId: string;
};

async function login(
  request: APIRequestContext,
  displayName: string,
): Promise<Login["user"]> {
  const response = await request.post(`${API_URL}/auth/dev-login`, {
    data: { displayName },
  });

  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as Login).user;
}

async function createRoom(
  request: APIRequestContext,
  name: string,
): Promise<Room> {
  const response = await request.post(`${API_URL}/rooms`, {
    data: {
      name,
      isPrivate: true,
    },
  });

  expect(response.status()).toBe(201);
  return ((await response.json()) as { room: Room }).room;
}

async function joinRoom(
  request: APIRequestContext,
  code: string,
): Promise<void> {
  const response = await request.post(`${API_URL}/rooms/join`, {
    data: {
      code,
      spectator: false,
    },
  });

  expect(response.ok()).toBeTruthy();
}

test.describe("Milestone 3/3.1 API behavior", () => {
  test("rejects internal lifecycle requests without the game-server secret", async ({
    request,
  }) => {
    const response = await request.post(
      `${API_URL}/internal/rooms/ABC123/lifecycle`,
      {
        data: { status: "running" },
      },
    );

    expect(response.status()).toBe(401);
  });

  test("rejects a non-host attempting to start or complete a room", async ({
    browser,
  }) => {
    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();

    try {
      await login(hostContext.request, `host-${Date.now()}`);
      const room = await createRoom(hostContext.request, "Authorization test");

      await login(guestContext.request, `guest-${Date.now()}`);
      await joinRoom(guestContext.request, room.code);

      const startResponse = await guestContext.request.post(
        `${API_URL}/rooms/${room.code}/start`,
      );
      expect(startResponse.status()).toBe(403);

      const completeResponse = await guestContext.request.post(
        `${API_URL}/rooms/${room.code}/complete`,
        {
          data: {
            winnerUserId: null,
            results: [],
          },
        },
      );
      expect(completeResponse.status()).toBe(403);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test("persists chat for members and rejects a non-member", async ({
    browser,
  }) => {
    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const outsiderContext = await browser.newContext();

    try {
      await login(hostContext.request, `host-${Date.now()}`);
      const room = await createRoom(hostContext.request, "Chat persistence");

      await login(guestContext.request, `guest-${Date.now()}`);
      await joinRoom(guestContext.request, room.code);

      const message = `persisted-${Date.now()}`;
      const postResponse = await guestContext.request.post(
        `${API_URL}/rooms/${room.code}/chat`,
        {
          data: { text: message },
        },
      );
      expect(postResponse.ok()).toBeTruthy();

      const historyResponse = await hostContext.request.get(
        `${API_URL}/rooms/${room.code}/chat`,
      );
      expect(historyResponse.ok()).toBeTruthy();

      const history = (await historyResponse.json()) as {
        messages: Array<{ from: string; text: string; at: number }>;
      };

      expect(history.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: message,
            at: expect.any(Number),
          }),
        ]),
      );

      await login(outsiderContext.request, `outsider-${Date.now()}`);

      const writeDenied = await outsiderContext.request.post(
        `${API_URL}/rooms/${room.code}/chat`,
        {
          data: { text: "not permitted" },
        },
      );
      expect(writeDenied.status()).toBe(403);

      const readDenied = await outsiderContext.request.get(
        `${API_URL}/rooms/${room.code}/chat`,
      );
      expect(readDenied.status()).toBe(403);
    } finally {
      await hostContext.close();
      await guestContext.close();
      await outsiderContext.close();
    }
  });

  test("validates chat message bounds", async ({ browser }) => {
    const context = await browser.newContext();

    try {
      await login(context.request, `host-${Date.now()}`);
      const room = await createRoom(context.request, "Chat validation");

      const empty = await context.request.post(
        `${API_URL}/rooms/${room.code}/chat`,
        {
          data: { text: "   " },
        },
      );
      expect(empty.status()).toBe(400);

      const oversized = await context.request.post(
        `${API_URL}/rooms/${room.code}/chat`,
        {
          data: { text: "x".repeat(501) },
        },
      );
      expect(oversized.status()).toBe(400);
    } finally {
      await context.close();
    }
  });

  test("updates persistent lifecycle state through authenticated game-server calls", async ({
    browser,
  }) => {
    const context = await browser.newContext();

    try {
      await login(context.request, `host-${Date.now()}`);
      const room = await createRoom(context.request, "Lifecycle persistence");

      const runningResponse = await context.request.post(
        `${API_URL}/internal/rooms/${room.code}/lifecycle`,
        {
          headers: {
            "x-game-server-secret": GAME_SERVER_SECRET!,
          },
          data: { status: "running" },
        },
      );
      expect(runningResponse.ok()).toBeTruthy();

      const roomResponse = await context.request.get(
        `${API_URL}/rooms/${room.code}`,
      );
      const persisted = (await roomResponse.json()) as { room: Room };
      expect(persisted.room.status).toBe("running");
    } finally {
      await context.close();
    }
  });
});
