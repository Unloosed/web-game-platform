import { expect, test } from "@playwright/test";

test("two users create and join a room", async ({ browser }) => {
  const host = await browser.newPage();
  const guest = await browser.newPage();

  await host.goto("/");
  await host.getByPlaceholder("Display name").fill("Host");
  await host.getByRole("button", { name: "Sign in" }).click();

  await host.getByPlaceholder("Room name").fill("Test Arena");
  await host.getByRole("button", { name: "Create room" }).click();

  await expect(host.getByText("Room: Test Arena")).toBeVisible();

  const heading = await host.locator("h1").innerText();
  const code = heading.match(/\(([A-Z0-9]{6})\)/)?.[1];
  expect(code).toBeTruthy();

  await guest.goto("/");
  await guest.getByPlaceholder("Display name").fill("Guest");
  await guest.getByRole("button", { name: "Sign in" }).click();

  await guest.getByPlaceholder("Enter room code").fill(code!);

  await guest
    .getByTestId("join-by-code-form")
    .getByRole("button", { name: "Join" })
    .click();

  await expect(guest.getByText(`Room: Test Arena (${code})`)).toBeVisible();

  await host.getByRole("button", { name: "Start match" }).click();
  await host.keyboard.press("ArrowRight");

  await expect(host.getByTestId("scoreboard")).toContainText("Host");
  await expect(guest.getByTestId("scoreboard")).toContainText("Guest");
});
