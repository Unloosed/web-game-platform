import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, displayName: string): Promise<void> {
  await page.goto("/");
  await page.getByPlaceholder("Display name").fill(displayName);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function joinByCode(page: Page, code: string): Promise<void> {
  await page.getByPlaceholder("Enter room code").fill(code);
  await page
    .getByTestId("join-by-code-form")
    .getByRole("button", { name: "Join" })
    .click();
}

async function readyUpAndStart(
  host: Page,
  guest: Page,
): Promise<void> {
  await host.getByTestId("ready-toggle").click();
  await expect(host.getByTestId("readiness")).toContainText("1/2");

  await guest.getByTestId("ready-toggle").click();
  await expect(host.getByTestId("readiness")).toContainText("2/2");

  const startButton = host.getByTestId("start-match");
  await expect(startButton).toBeEnabled();
  await startButton.click();
}

test.describe("Milestone 3.1 room lifecycle", () => {
  test("completes a match once, shows results, and rematches", async ({
    browser,
  }) => {
    // The default GAME_MATCH_MS is 60s; set a lower value in the running
    // game-server environment to finish this test faster.
    test.setTimeout(150_000);

    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();

    try {
      const host = await hostContext.newPage();
      const guest = await guestContext.newPage();

      await signIn(host, "Match Host");
      await host.getByPlaceholder("Room name").fill("Lifecycle Arena");
      await host.getByRole("button", { name: "Create room" }).click();

      const code = (await host.getByTestId("invite-code").innerText()).trim();

      await signIn(guest, "Match Guest");
      await joinByCode(guest, code);

      await readyUpAndStart(host, guest);

      await expect(host.getByTestId("match-status")).toContainText(
        "Time remaining",
      );

      // Timer expiry is decided by the authoritative simulation; every
      // client observes the same completed phase.
      await expect(host.getByTestId("match-status")).toHaveText(
        "Match completed",
        { timeout: 140_000 },
      );
      await expect(guest.getByTestId("match-status")).toHaveText(
        "Match completed",
      );

      await expect(
        host.getByRole("heading", { name: "Results" }),
      ).toBeVisible();
      await expect(host.locator('h2:has-text("Results") + div')).toContainText(
        "#1",
      );

      // Rematch resets to a fresh running match in the same room.
      await host.getByTestId("restart-match").click();
      await expect(host.getByTestId("match-status")).toContainText(
        "Time remaining",
      );
      await expect(guest.getByTestId("match-status")).toContainText(
        "Time remaining",
      );
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test("preserves a player who reconnects within the grace window", async ({
    browser,
  }) => {
    test.setTimeout(60_000);

    const hostContext = await browser.newContext();
    // The same context is reused after closing so the reconnect carries
    // the identical session cookie (and therefore user id).
    const guestContext = await browser.newContext();

    try {
      const host = await hostContext.newPage();
      const guest = await guestContext.newPage();

      await signIn(host, "Grace Host");
      await host.getByPlaceholder("Room name").fill("Reconnect Arena");
      await host.getByRole("button", { name: "Create room" }).click();

      const code = (await host.getByTestId("invite-code").innerText()).trim();

      await signIn(guest, "Grace Guest");
      await joinByCode(guest, code);

      await readyUpAndStart(host, guest);
      await expect(guest.getByTestId("match-status")).toContainText(
        "Time remaining",
      );

      // Abrupt drop: simulation state must survive through reconnect grace.
      await guest.close();
      await host.waitForTimeout(1_000);
      await expect(host.getByTestId("scoreboard")).toContainText("Grace Guest");

      const reconnected = await guestContext.newPage();
      await reconnected.goto("/");
      await joinByCode(reconnected, code);

      await expect(reconnected.getByTestId("scoreboard")).toContainText(
        "Grace Guest",
      );
      // Rebinding replaces the ephemeral connection instead of duplicating
      // the logical player entity.
      expect(
        await reconnected
          .getByTestId("scoreboard")
          .getByText("Grace Guest")
          .count(),
      ).toBe(1);
      // The readiness panel only renders outside a running match; wait for
      // the authoritative completion rather than a timing window.
      await expect(reconnected.getByTestId("match-status")).toHaveText(
        "Match completed",
        { timeout: 30_000 },
      );
      await expect(reconnected.getByTestId("readiness")).toContainText("/2");
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test("renders a server-authorized spectator view", async ({ browser }) => {
    test.setTimeout(60_000);

    const hostContext = await browser.newContext();
    const spectatorContext = await browser.newContext();

    try {
      const host = await hostContext.newPage();
      const watcher = await spectatorContext.newPage();

      await signIn(host, "Spectate Host");
      await host.getByPlaceholder("Room name").fill("Viewing Gallery");
      await host.getByRole("button", { name: "Create room" }).click();

      const code = (await host.getByTestId("invite-code").innerText()).trim();

      await signIn(watcher, "Watcher");
      await joinByCode(watcher, code);

      // The toggle updates durable membership; the API then propagates the
      // role change to the live socket session. Click (not check): the
      // controlled checkbox re-renders with each 20 Hz snapshot, so assert
      // the authoritative server state below instead of the input state.
      await watcher.getByRole("checkbox").click();

      await expect(watcher.getByTestId("scoreboard")).toContainText(
        "(spectator)",
      );
      await expect(watcher.getByLabel("arena")).toBeVisible();
      // Spectators receive no gameplay controls and never block readiness.
      await expect(watcher.getByTestId("ready-toggle")).toHaveCount(0);
    } finally {
      await hostContext.close();
      await spectatorContext.close();
    }
  });
});
