// Reload Chat Page (phase 2 of "most changes without an app restart"): the native chat page is
// reloaded on its own, its chat comes back from the core through the shell, and an unsent draft
// survives. Hidden only: CDP input inside the renderer, never a shown/focused native window.
import { expect, test } from "@playwright/test";
import { launch } from "./launch";
import { until } from "../helpers";

test("the native chat page reloads in place: same shell and view, chat rehydrated, unsent draft kept", async () => {
  test.setTimeout(60_000);
  const { app } = await launch({ waitForState: false, env: { BOTLING_HIDDEN: "1" } });
  try {
    const shell = await until(() => app.context().pages().find(page => page.url() === "app://botling/index.html"), { what: "shell page" });
    const editor = await until(() => app.context().pages().find(page => page.url().includes("nativeHost=1")), { what: "native chat page" });
    await editor.locator("html[data-chat]").waitFor({ state: "attached" });
    const chat = await editor.locator("html").getAttribute("data-chat");
    await until(async () => (await editor.locator(".row[data-id]").count()) > 0, { what: "first chat rows" });
    const rows = await editor.locator(".row[data-id]").count();
    const viewId = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(c => c.getURL().includes("nativeHost=1"))!.id);
    await shell.evaluate(() => { (window as unknown as { shellMarker: number }).shellMarker = 1; });
    await editor.evaluate(() => { (window as unknown as { oldDocument: number }).oldDocument = 1; });
    // Type without OS input; the composer's own 500 ms save delay must not lose the last words.
    const cdp = await editor.context().newCDPSession(editor);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await editor.evaluate(() => (document.querySelector(".composer .cm-content") as HTMLElement).focus());
    await cdp.send("Input.insertText", { text: "unsent words" });
    await expect(editor.locator(".composer .cm-content")).toHaveText("unsent words");
    // The shell's IPC (what the menu item and an install card use).
    const answer = await shell.evaluate(() => new Promise(resolve => {
      const bridge = (window as unknown as { botling: { post(e: unknown): void; subscribe(l: (m: any) => void): () => void } }).botling;
      const stop = bridge.subscribe(message => { if (message?.id === "reload-chat") { stop(); resolve(message); } });
      bridge.post({ v: 10, id: "reload-chat", cmd: { type: "chat.reloadPage" } });
    }));
    expect(answer).toMatchObject({ ok: true, result: { reloaded: true } });
    await until(() => editor.evaluate(() => (window as unknown as { oldDocument?: number }).oldDocument === undefined), { what: "a new chat document" });
    await expect(editor.locator("html")).toHaveAttribute("data-chat", chat!);
    await until(async () => (await editor.locator(".row[data-id]").count()) === rows, { what: "rehydrated chat rows" });
    await expect(editor.locator(".composer .cm-content")).toHaveText("unsent words");
    expect(await shell.evaluate(() => (window as unknown as { shellMarker?: number }).shellMarker)).toBe(1);
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(c => c.getURL().includes("nativeHost=1"))!.id)).toBe(viewId);
    // The new document's preload ran (its bridge exists) and the window was never shown.
    expect(await editor.evaluate(() => typeof (window as unknown as { botlingEditor?: unknown }).botlingEditor)).toBe("object");
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.isVisible()))).toBe(false);
  } finally { await app.close(); }
});
