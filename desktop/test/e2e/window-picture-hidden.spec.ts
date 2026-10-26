// The app's picture of its own window (<app-screenshot/> after an install, "Not right" feedback, a
// card's report) must show the chat. The chat is a separate native WebContentsView over the shell,
// so the shell's capturePage alone had an empty chat column: an install looked like a blank chat.
// Hidden only: nothing is shown or focused.
import { expect, test } from "@playwright/test";
import { launch, showChat } from "./launch";
import { until } from "../helpers";

test("the window picture draws the native chat view's messages, not an empty column", async () => {
  test.setTimeout(60_000);
  const { app } = await launch({ waitForState: false });
  try {
    const editor = await until(() => app.context().pages().find(page => page.url().includes("nativeHost=1")), { what: "native chat page" });
    await until(async () => (await editor.locator(".row[data-id]").count()) > 0, { what: "chat rows" });
    const shellPage = await until(() => app.context().pages().find(page => page.url() === "app://botling/index.html"), { what: "shell page" });
    await shellPage.waitForSelector('.shell[data-ready="1"]');
    await showChat(shellPage);
    await until(() => editor.evaluate(() => innerWidth > 0 && innerHeight > 0), { what: "the chat view laid out" });
    const colours = async (which: "shell" | "window") => app.evaluate(async ({ BrowserWindow, WebContentsView, nativeImage }, which) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const view = window.contentView.children.find(child => child instanceof WebContentsView && child.webContents.getURL().includes("nativeHost=1")) as Electron.WebContentsView;
      const bounds = view.getBounds();
      const image = which === "shell" ? await window.webContents.capturePage()
        : nativeImage.createFromDataURL((await (globalThis as unknown as { __botlingWindowPicture: () => Promise<string> }).__botlingWindowPicture()));
      // A capture holds the display's pixels (2x on Retina) labelled scale 1: its scale is pixels per content DIP.
      const { width, height } = image.getSize(), data = image.toBitmap(), scale = width / window.getContentBounds().width;
      const seen = new Set<number>();
      for (let y = Math.round(bounds.y * scale); y < Math.min(height, Math.round((bounds.y + bounds.height) * scale)); y += 2)
        for (let x = Math.round(bounds.x * scale); x < Math.min(width, Math.round((bounds.x + bounds.width) * scale)); x += 2) seen.add(data.readUInt32LE((y * width + x) * 4));
      return { bounds, colours: seen.size };
    }, which);
    // The precondition: the shell alone really does have nothing there (else this test proves nothing).
    const shell = await colours("shell");
    expect(shell.bounds.width).toBeGreaterThan(0);
    expect(shell.colours).toBeLessThan(8);
    // The app's picture has the chat's text, avatars and composer in that column.
    await until(async () => (await colours("window")).colours > 50, { what: "chat pixels in the window picture" });
  } finally { await app.close(); }
});
