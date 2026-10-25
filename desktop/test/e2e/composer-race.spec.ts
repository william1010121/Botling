// What you type in the first second after the window opens stays in the input box and is sent, even
// when the page gets its first state (and switches the box to that chat's draft) after you started.
// No refill workaround here: the words are typed once, as a person would.
import { expect, test } from "@playwright/test";
import { launch, MAIN } from "./launch";

// Focus was also seen leaving the box as the window finished opening (a card's frame loading), about
// one start in fifteen: "right away" runs a few times.
for (const [name, env] of [
  ["right away", {}],
  ["right away, again", {}],
  ["right away, a third time", {}],
  // The first state held back 1.5 s, so the words are surely typed before it lands.
  ["before the first state", { BOTLING_TEST_FIRST_SNAPSHOT_MS: "1500" }],
] as const) {
  test(`words typed in the first second are kept (${name})`, async () => {
    const { app, page, chat } = await launch({ waitForState: false, env });
    try {
      const box = chat.getByRole("textbox", { name: "Message" });
      await box.waitFor();
      const typedBeforeState = await chat.locator("html[data-chat]").count() === 0;
      await box.click();
      await box.pressSequentially("early words stay", { delay: 15 });
      // The first state lands (the box switches to the main bot's chat).
      await chat.locator(`html[data-chat="${MAIN}"]`).waitFor({ state: "attached" });
      await page.waitForTimeout(300);
      await expect(box).toHaveText("early words stay");
      await box.press("Enter");
      await expect(chat.locator(".row.user").last()).toContainText("early words stay");
      if (name === "before the first state") expect(typedBeforeState).toBe(true);
    } finally {
      await app.close();
    }
  });
}

// Focus taken from the box by nothing you did (as when the window finishes opening): Return still sends.
test("Return sends even right after focus left the box by itself", async () => {
  const { app, page, chat } = await launch();
  try {
    const box = chat.getByRole("textbox", { name: "Message" });
    await box.click();
    await box.fill("still sent");
    await box.evaluate((element) => (element as HTMLElement).blur());
    await page.keyboard.press("Enter");
    await expect(chat.locator(".row.user").last()).toContainText("still sent");
  } finally {
    await app.close();
  }
});
