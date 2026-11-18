// The app window as a picture, for the commands that carry one (a component's report, "Not right" feedback, the install
// receipt's screenshot). Kept out of main.ts, which is frozen at its size (scripts/line-baseline.json).
import { BrowserWindow, nativeImage, type NativeImage, type Rectangle, type WebContents } from "electron";
import { nativeEditorLayer } from "./editor-host";
import { captureScale, composeWindow } from "./window-capture";
import { fitScreenshot, pictureBudget } from "./screenshot-fit";

/**
 * The shell's window as the user sees it: the shell's pixels with the native chat view drawn in
 * (window-capture.ts). The shell's capturePage alone has an empty chat column, since the chat lives
 * in its own WebContentsView. `rect` (window DIPs) crops the result, as capturePage(rect) did.
 */
export async function windowPicture(contents: WebContents, rect?: Rectangle): Promise<NativeImage> {
  const owner = BrowserWindow.fromWebContents(contents);
  const width = owner && !owner.isDestroyed() && owner.webContents === contents ? owner.getContentBounds().width : 0;
  // Not a window's own page (no chat drawn over it): its capture is already the whole picture.
  if (!width) return contents.capturePage(rect);
  const shellImage = await contents.capturePage();
  const picture = await composeWindow(shellImage, width, nativeEditorLayer(contents),
    (bitmap) => nativeImage.createFromBitmap(bitmap.data, { width: bitmap.width, height: bitmap.height })) as NativeImage;
  if (!rect) return picture;
  const scale = captureScale(shellImage, width);
  return picture.crop({ x: Math.round(rect.x * scale), y: Math.round(rect.y * scale), width: Math.round(rect.width * scale), height: Math.round(rect.height * scale) });
}

/**
 * The picture for a command's `screenshot` field: the window cropped to `area` (window DIPs; the whole window when null), small
 * enough that the whole command (`rest`, without the picture) fits one frame (it goes through the durable outbox, and a copy over
 * the frame limit can never be sent). Undefined, with a note, when it cannot be taken or even the smallest does not fit.
 */
export async function shotFor(sender: WebContents, area: { x: number; y: number; width: number; height: number } | null | undefined, rest: unknown, what: string, note: (text: string) => void): Promise<string | undefined> {
  try {
    const rect = area ? { x: Math.max(0, Math.round(area.x)), y: Math.max(0, Math.round(area.y)), width: Math.max(1, Math.round(area.width)), height: Math.max(1, Math.round(area.height)) } : undefined;
    const image = await windowPicture(sender, rect);
    if (image.isEmpty()) return undefined;
    const shot = fitScreenshot(image, pictureBudget(rest));
    if (shot === null) note(`${what}: the screenshot does not fit one frame, sent without it`);
    return shot ?? undefined;
  } catch (error) {
    note(`${what}: no screenshot (${(error as Error).message})`);
    return undefined;
  }
}
