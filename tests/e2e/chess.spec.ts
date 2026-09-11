import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, displayName: string): Promise<void> {
  await page.goto("/");
  await page.getByPlaceholder("Display name").fill(displayName);
  await page.getByRole("button", { name: "Sign in" }).click();
}

// The third game proves the plugin seam carries a turn-based game with
// input-driven completion: same lobby, ready gate, and scoreboard chrome,
// with a click-to-move chess board rendered from the snapshot view.
test("hosts and plays a Chess room end to end", async ({ browser }) => {
  const host = await browser.newPage();
  const guest = await browser.newPage();

  await signIn(host, "Chess Host");
  await host.getByPlaceholder("Room name").fill("Chess Club");
  await host.getByTestId("game-select").selectOption({ label: "Chess" });
  await host.getByRole("button", { name: "Create room" }).click();

  await expect(host.getByText("Room: Chess Club")).toBeVisible();
  const code = (await host.getByTestId("invite-code").innerText()).trim();
  expect(code).toMatch(/^[A-Z0-9]{6}$/);

  await signIn(guest, "Chess Guest");
  await guest.getByPlaceholder("Enter room code").fill(code);
  await guest
    .getByTestId("join-by-code-form")
    .getByRole("button", { name: "Join" })
    .click();
  await expect(guest.getByText(`Room: Chess Club (${code})`)).toBeVisible();

  // Same deterministic ready-gated startup as the realtime games.
  await expect(host.getByTestId("start-match")).toBeDisabled();
  await host.getByTestId("ready-toggle").click();
  await guest.getByTestId("ready-toggle").click();
  await expect(host.getByTestId("readiness")).toContainText("2/2");

  const startButton = host.getByTestId("start-match");
  await expect(startButton).toBeEnabled();
  await startButton.click();

  await expect(host.getByTestId("chess-arena")).toBeVisible();
  await expect(guest.getByTestId("chess-arena")).toBeVisible();
  await expect(host.getByTestId("scoreboard")).toContainText("Chess Host");
  await expect(host.getByTestId("scoreboard")).toContainText("Chess Guest");

  // The host joined first and holds White; the board starts as White to move.
  await expect(host.getByTestId("chess-turn")).toContainText("White to move");

  // White plays e4, Black replies e5 — moves come from snapshot-driven
  // legal-move highlighting, so a click pair per move is enough.
  const playMove = async (
    page: Page,
    from: string,
    to: string,
    expectedTurn: string,
  ): Promise<void> => {
    await expect(page.getByTestId("chess-turn")).toContainText(expectedTurn, {
      timeout: 10_000,
    });
    await page.locator(`[data-square="${from}"]`).click();
    await page.locator(`[data-square="${to}"]`).click();
  };

  await playMove(host, "e2", "e4", "White to move");
  await playMove(guest, "e7", "e5", "Black to move");

  // The moves propagated to both boards.
  await expect(
    host.locator('[data-square="e4"] .pc-w').first(),
  ).toBeVisible();
  await expect(
    guest.locator('[data-square="e5"] .pc-b').first(),
  ).toBeVisible();

  // Host resigns as White: the match completes through the input path and
  // the generic results card renders the 2/0 rows.
  await host.getByRole("button", { name: "Resign" }).click();
  await expect(host.getByTestId("match-status")).toHaveText(
    "Match completed",
    { timeout: 10_000 },
  );
  await expect(guest.getByTestId("match-status")).toHaveText(
    "Match completed",
  );
  await expect(host.getByTestId("chess-turn")).toContainText("resignation");
  await expect(host.locator('h2:has-text("Results") + div')).toContainText(
    "Chess Guest",
  );
});
