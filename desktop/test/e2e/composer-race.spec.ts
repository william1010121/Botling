// What you type in the first second after the window opens stays in the input box and is sent, even
// when the page gets its first state (and switches the box to that chat's draft) after you started.
// No refill workaround here: the words are typed once, as a person would.
import { expect, test } from "@playwright/test";
import { chatFrame, launch, MAIN } from "./launch";

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

// Legacy key/ack messages are deliberately held. Native input must not depend on their delivery.
test("launch recovery preserves native edit order without forwarding keys", async () => {
  const { app, page, chat } = await launch();
  try {
    await app.context().addInitScript(() => {
      if (location.origin !== "botling-chat://chat") return;
      (window as any).__forwarded = 0;
      window.addEventListener("message", event => {
        if (event.source === parent && event.data?.botling === "key") {
          (window as any).__forwarded++;
          event.stopImmediatePropagation();
        }
      });
    });
    await page.reload();
    await chat.locator("html[data-chat]").waitFor({ state: "attached" });
    const box = chat.getByRole("textbox", { name: "Message" });
    await box.click();
    await page.keyboard.type("Prefix ");
    await box.evaluate(element => (element as HTMLElement).blur());
    await page.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
      window.dispatchEvent(new Event("focus"));
    });
    await page.keyboard.type("ab");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("X");
    await expect(box).toHaveText("Prefix aXb");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.type("x");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await expect(chat.locator(".row.user .user-bubble").last()).toHaveText("Prefix aXb");
    const frame = await chatFrame(page);
    expect(await frame.evaluate(() => (window as any).__forwarded)).toBe(0);
  } finally { await app.close(); }
});

test("Return after shell launch recovery sends the existing draft once", async () => {
  const { app, page, chat } = await launch();
  try {
    const box = chat.getByRole("textbox", { name: "Message" });
    await box.click();
    await box.fill("ready to send");
    await box.evaluate(element => (element as HTMLElement).blur());
    await page.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
      window.dispatchEvent(new Event("focus"));
    });
    await page.keyboard.press("Enter");
    await expect(chat.locator(".row.user .user-bubble")).toHaveText(["ready to send"]);
  } finally { await app.close(); }
});

// An app switch must not turn CodeMirror into a partial synthetic keyboard.
for (const delay of [350, 3_100]) test(`app-switch blur preserves native caret order and editing (${delay}ms)`, async () => {
  const { app, page, chat } = await launch({ env: { BOTLING_HIDDEN: "0" } });
  try {
    const box = chat.getByRole("textbox", { name: "Message" });
    await box.click();
    await page.waitForTimeout(delay);
    // Returning to the app resumes the intended native editor, rather than the shell body.
    await box.click();
    await box.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
    // Resume the same editor without pointerdown (which would clear the old broken handoff flag).
    await box.focus();
    await expect(box).toBeFocused();
    await page.keyboard.type("ab");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("X");
    await expect(box).toHaveText("aXb");
    // Separate history groups: Undo must restore this deletion, rather than grouped typing.
    await page.waitForTimeout(600);
    await page.keyboard.press("Delete");
    await expect(box).toHaveText("aX");
    await page.keyboard.press("Meta+z");
    await expect(box).toHaveText("aXb");
    await page.keyboard.press("Meta+Shift+z");
    await expect(box).toHaveText("aX");
  } finally { await app.close(); }
});

// Composition events model the macOS unflagged candidate key. CDP supplies trusted keys with
// isComposing=false (unlike a synthetic KeyboardEvent, which the old handoff skipped entirely).
for (const mode of ["state", "229", "ended"] as const) test(`IME candidate Space/Enter stays native (${mode})`, async () => {
  const { app, page, chat } = await launch();
  try {
    const box = chat.getByRole("textbox", { name: "Message" });
    await box.click();
    await box.fill("中文");
    await page.waitForTimeout(350);
    await box.evaluate((element, mode) => {
      window.dispatchEvent(new Event("blur"));
      element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "中文" }));
      if (mode !== "state") element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
      (window as any).__candidateKeys = [];
      window.addEventListener("keydown", event => (window as any).__candidateKeys.push({ trusted: event.isTrusted, composing: event.isComposing, code: event.keyCode }), true);
    }, mode);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: mode === "229" ? 229 : 32 });
    await page.waitForTimeout(100);
    // Exact text: Playwright's toHaveText(string) hides the erroneous trailing space.
    expect(await box.textContent()).toBe("中文");
    expect(await box.evaluate(() => (window as any).__candidateKeys[0])).toMatchObject({ trusted: true, composing: false, code: mode === "229" ? 229 : 32 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 229 });
    await page.waitForTimeout(100);
    await expect(chat.locator(".row.user")).toHaveCount(0);
    expect(await box.textContent()).toBe("中文");
    await box.evaluate(element => element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" })));
    await cdp.detach();
  } finally { await app.close(); }
});

test("Chromium marked Traditional Chinese survives candidate Return without sending", async () => {
  const { app, page, chat } = await launch();
  try {
    const box = chat.getByRole("textbox", { name: "Message" });
    await box.click();
    await page.waitForTimeout(350);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "繁體中文", selectionStart: 4, selectionEnd: 4 });
    await expect(box).toHaveText("繁體中文");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 229 });
    await page.waitForTimeout(150);
    expect(await box.textContent()).toBe("繁體中文");
    await expect(chat.locator(".row.user")).toHaveCount(0);
    await cdp.detach();
  } finally { await app.close(); }
});

test("CmdV uses the editor paste path alongside navigation and undo", async () => {
  const { app, page, chat } = await launch();
  try {
    const box = chat.getByRole("textbox", { name: "Message" });
    await box.click();
    await page.waitForTimeout(350);
    await box.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      // Preserve the system clipboard. Substitute fixture data only at this page's paste boundary.
      (window as any).__trustedPastes = 0;
      window.addEventListener("paste", event => {
        if (!event.isTrusted) return;
        (window as any).__trustedPastes++;
        event.preventDefault();
        event.stopImmediatePropagation();
        const data = new DataTransfer();
        data.setData("text/plain", "貼上");
        event.target?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      }, true);
    });
    await page.keyboard.type("ab");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Meta+v");
    await expect(box).toHaveText("a貼上b");
    expect(await box.evaluate(() => (window as any).__trustedPastes)).toBe(1);
    await page.keyboard.press("Meta+z");
    await expect(box).toHaveText("ab");
  } finally { await app.close(); }
});

test("handoff never hijacks the feedback textarea", async () => {
  const { app, page, chat } = await launch({ chat: [{
    id: "00000000-0000-4000-8000-0000000000D2", role: "bot", text: "Feedback fixture",
    date: (Date.now() - Date.UTC(2001, 0, 1)) / 1000,
  }] });
  try {
    // Enable the existing feedback UI only in incoming test state, without changing app settings.
    await app.context().addInitScript(() => {
      if (location.origin !== "botling-chat://chat") return;
      window.addEventListener("message", event => {
        if (event.source === parent && event.data?.botling === "state") event.data.state.feedback = true;
      });
    });
    await page.reload();
    await chat.locator("html[data-chat]").waitFor({ state: "attached" });
    const box = chat.getByRole("textbox", { name: "Message" });
    await box.click();
    await page.waitForTimeout(350);
    await box.fill("composer draft");
    const frame = await chatFrame(page);
    await frame.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      document.querySelector<HTMLButtonElement>(".feedback-button")!.click();
    });
    const feedback = chat.locator(".report textarea");
    await page.keyboard.type("feedback");
    await expect(feedback).toHaveValue("feedback");
    await expect(box).toHaveText("composer draft");
  } finally { await app.close(); }
});

// Once Tab leaves the composer, a former handoff's idle acknowledgement must not steal it back.
test("Tab focus survives the former 500ms handoff recovery timer", async () => {
  const { app, page, chat } = await launch();
  try {
    const box = chat.getByRole("textbox", { name: "Message" });
    await box.click();
    await page.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
      window.dispatchEvent(new Event("focus"));
    });
    await page.keyboard.type("n");
    await expect(box).toHaveText("n");
    await box.evaluate(element => (element as HTMLElement).focus());
    await page.keyboard.press("Tab");
    const frame = await chatFrame(page);
    const active = await frame.evaluate(() => {
      (window as any).__tabTarget = document.activeElement;
      return document.activeElement?.className;
    });
    expect(active).not.toContain("cm-content");
    await page.waitForTimeout(750);
    expect(await frame.evaluate(() => document.activeElement === (window as any).__tabTarget)).toBe(true);
  } finally { await app.close(); }
});

test("sidebar search retains focus and Escape returns native typing to the composer", async () => {
  const { app, page, chat } = await launch();
  try {
    const box = chat.getByRole("textbox", { name: "Message" });
    await box.click();
    const search = page.getByRole("searchbox", { name: "Search bots" });
    await search.click();
    await page.keyboard.type("Main");
    await page.waitForTimeout(750);
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("Main");
    await page.keyboard.press("Escape");
    await expect(box).toBeFocused();
    await page.keyboard.type("after search");
    await expect(box).toHaveText("after search");
  } finally { await app.close(); }
});

test("iframe reload has no stale key or ack that can replay text or steal Tab focus", async () => {
  const { app, page, chat } = await launch();
  try {
    const box = chat.getByRole("textbox", { name: "Message" });
    await box.click();
    await page.keyboard.type("before reload");
    await box.evaluate(() => parent.postMessage({ botling: "keyHandled", id: 1 }, "app://botling"));
    await page.locator("#chat-frame").evaluate(element => {
      const iframe = element as HTMLIFrameElement;
      iframe.src = iframe.src;
    });
    await chat.locator("html[data-chat]").waitFor({ state: "attached" });
    await box.click();
    await box.fill("after reload");
    await page.keyboard.press("Enter");
    await expect(chat.locator(".row.user .user-bubble")).toHaveText(["after reload"]);
    // Let the fake reply settle before choosing a Tab target: Stop disappears on completion.
    await expect(chat.locator(".row.bot[data-id]").last()).toHaveAttribute("data-state", "done");
    await expect(chat.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
    await box.focus();
    await page.keyboard.press("Tab");
    const frame = await chatFrame(page);
    await frame.evaluate(() => { (window as any).__tabTarget = document.activeElement; });
    await expect(box).not.toBeFocused();
    await page.waitForTimeout(750);
    expect(await frame.evaluate(() => document.activeElement === (window as any).__tabTarget)).toBe(true);
  } finally { await app.close(); }
});

test("launch recovery expires instead of reclaiming deliberately empty focus", async () => {
  const { app, page, chat } = await launch();
  try {
    const box = chat.getByRole("textbox", { name: "Message" });
    await box.click();
    await box.fill("draft");
    await page.waitForTimeout(3_100);
    await box.evaluate(element => (element as HTMLElement).blur());
    await page.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
      window.dispatchEvent(new Event("focus"));
    });
    await page.keyboard.type("x");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(650);
    await expect(box).toHaveText("draft");
    await expect(box).not.toBeFocused();
    await expect(chat.locator(".row.user")).toHaveCount(0);
  } finally { await app.close(); }
});

// A visible disposable window is necessary for real macOS app-switch blur events.
for (const delay of [350, 3_100]) test(`native Electron window blur leaves reselected composer editing native (${delay}ms)`, async () => {
  const { app, page, chat } = await launch({ env: { BOTLING_HIDDEN: "0" } });
  try {
    const box = chat.getByRole("textbox", { name: "Message" });
    await box.click();
    await page.waitForTimeout(delay);
    // macOS may consume the first click only to activate a new window.
    await box.click();
    await expect(box).toBeFocused();
    await box.evaluate(() => {
      (window as any).__nativeBlurs = 0;
      window.addEventListener("blur", event => { if (event.isTrusted) (window as any).__nativeBlurs++; });
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].blur());
    await expect.poll(() => box.evaluate(() => (window as any).__nativeBlurs)).toBeGreaterThan(0);
    await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
    // Selecting the editor is explicit user intent; app activation alone may focus a sidebar button.
    await box.click();
    await expect(box).toBeFocused();
    await page.keyboard.type("ab");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("X");
    await expect(box).toHaveText("aXb");
    await page.keyboard.press("Enter");
    await expect(chat.locator(".row.user .user-bubble")).toHaveText(["aXb"]);
  } finally { await app.close(); }
});
