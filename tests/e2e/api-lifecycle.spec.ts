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
  status: "waiting" | "running" | "completed" | "archived";
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

  test("archives a room through authenticated game-server calls", async ({
    browser,
  }) => {
    const context = await browser.newContext();

    try {
      await login(context.request, `host-${Date.now()}`);
      const room = await createRoom(context.request, "Archive persistence");

      const archiveResponse = await context.request.post(
        `${API_URL}/internal/rooms/${room.code}/lifecycle`,
        {
          headers: {
            "x-game-server-secret": GAME_SERVER_SECRET!,
          },
          data: { status: "archived" },
        },
      );
      expect(archiveResponse.ok()).toBeTruthy();

      const roomResponse = await context.request.get(
        `${API_URL}/rooms/${room.code}`,
      );
      const persisted = (await roomResponse.json()) as { room: Room };
      expect(persisted.room.status).toBe("archived");

      // Archived rooms are closed for (re)joining.
      const joinResponse = await context.request.post(`${API_URL}/rooms/join`, {
        data: { code: room.code, spectator: false },
      });
      expect(joinResponse.status()).toBe(409);
    } finally {
      await context.close();
    }
  });

  test("rejects state-changing requests from a hostile origin", async ({
    browser,
  }) => {
    const context = await browser.newContext();

    try {
      await login(context.request, `csrf-${Date.now()}`);

      const hostile = await context.request.post(`${API_URL}/rooms`, {
        data: { name: "CSRF probe", isPrivate: true },
        headers: { origin: "https://evil.example" },
      });
      expect(hostile.status()).toBe(403);

      // Non-browser clients (no Origin header) remain allowed.
      const headless = await context.request.post(`${API_URL}/rooms`, {
        data: { name: "No-origin client", isPrivate: true },
      });
      expect(headless.status()).toBe(201);
    } finally {
      await context.close();
    }
  });

  test("awards achievements once when a match completes", async ({
    browser,
  }) => {
    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();

    try {
      const host = await login(hostContext.request, `ach-host-${Date.now()}`);
      const guest = await login(guestContext.request, `ach-guest-${Date.now()}`);
      const room = await createRoom(hostContext.request, "Achievements");

      const completion = await hostContext.request.post(
        `${API_URL}/internal/rooms/${room.code}/lifecycle`,
        {
          headers: {
            "x-game-server-secret": GAME_SERVER_SECRET!,
          },
          data: {
            status: "completed",
            winnerUserId: host.id,
            results: [
              { id: host.id, tags: 6 },
              { id: guest.id, tags: 1 },
            ],
          },
        },
      );
      expect(completion.ok()).toBeTruthy();

      const hostAch = (await (
        await hostContext.request.get(`${API_URL}/users/${host.id}/achievements`)
      ).json()) as { achievements: Array<{ code: string }> };
      expect(hostAch.achievements.map((a) => a.code)).toEqual(
        expect.arrayContaining(["first_match", "first_win", "sharpshooter"]),
      );

      const guestAch = (await (
        await guestContext.request.get(
          `${API_URL}/users/${guest.id}/achievements`,
        )
      ).json()) as { achievements: Array<{ code: string }> };
      expect(guestAch.achievements.map((a) => a.code)).toEqual([
        "first_match",
      ]);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test("accepts reports from members but restricts review to moderators", async ({
    browser,
  }) => {
    const memberContext = await browser.newContext();
    const outsiderContext = await browser.newContext();

    try {
      await login(memberContext.request, `reporter-${Date.now()}`);
      const room = await createRoom(memberContext.request, "Reports");

      const created = await memberContext.request.post(`${API_URL}/reports`, {
        data: { reason: "hostile chat", roomCode: room.code },
      });
      expect(created.status()).toBe(201);

      // Reports review requires moderator role.
      const reviewDenied = await memberContext.request.get(
        `${API_URL}/admin/reports`,
      );
      expect(reviewDenied.status()).toBe(403);

      await login(outsiderContext.request, `bystander-${Date.now()}`);
      const kickDenied = await outsiderContext.request.post(
        `${API_URL}/admin/rooms/${room.code}/kick`,
        {
          data: { userId: room.hostUserId },
        },
      );
      expect(kickDenied.status()).toBe(403);
    } finally {
      await memberContext.close();
      await outsiderContext.close();
    }
  });
});
