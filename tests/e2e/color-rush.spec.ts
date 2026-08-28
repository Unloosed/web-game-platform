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

// Milestone 5: the second reference game must work through the same
// lobby, room, lifecycle, and scoreboard flows as sample-tag, proving
// the platform has no tag-specific internals.
test("hosts and plays a Color Rush room end to end", async ({ browser }) => {
  const host = await browser.newPage();
  const guest = await browser.newPage();

  await signIn(host, "Rush Host");

  // The lobby game selector drives the persisted rooms.game_id.
  await host.getByPlaceholder("Room name").fill("Rush Arena");
  await host.getByTestId("game-select").selectOption({ label: "Color Rush" });
  await host.getByRole("button", { name: "Create room" }).click();

  await expect(host.getByText("Room: Rush Arena")).toBeVisible();
  const code = (await host.getByTestId("invite-code").innerText()).trim();
  expect(code).toMatch(/^[A-Z0-9]{6}$/);

  await signIn(guest, "Rush Guest");
  await joinByCode(guest, code);

  await expect(
    guest.getByText(`Room: Rush Arena (${code})`),
  ).toBeVisible();

  // Same deterministic ready-gated startup as the reference game.
  await expect(host.getByTestId("start-match")).toBeDisabled();

  await host.getByTestId("ready-toggle").click();
  await expect(host.getByTestId("readiness")).toContainText("1/2");

  await guest.getByTestId("ready-toggle").click();
  await expect(host.getByTestId("readiness")).toContainText("2/2");

  const startButton = host.getByTestId("start-match");
  await expect(startButton).toBeEnabled();
  await startButton.click();

  // The room renders the Color Rush arena (orbs), not the tag arena.
  await expect(host.getByTestId("color-rush-arena")).toBeVisible();
  await expect(guest.getByTestId("color-rush-arena")).toBeVisible();
  await expect(host.getByTestId("tag-arena")).toHaveCount(0);

  // Both players appear on the generic scoreboard with score rows.
  await expect(host.getByTestId("scoreboard")).toContainText("Rush Host");
  await expect(host.getByTestId("scoreboard")).toContainText("Rush Guest");
  await expect(guest.getByTestId("scoreboard")).toContainText("Rush Guest");

  // A recognized game action: movement (dash key must not break anything).
  await host.keyboard.press("ArrowRight");
  await guest.keyboard.press(" ");

  await expect(host.getByTestId("match-status")).toContainText(
    "Time remaining",
  );
});
