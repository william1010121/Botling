// A picture of the app's window as the user sees it. The chat (messages, composer, cards) is drawn by
// the native chat WebContentsView (editor-host.ts), a separate web contents laid over the shell's
// placeholder, so the shell's own capturePage shows an empty chat column. This pastes the chat view's
// pixels over that placeholder, at the window's pixel scale, so the install receipt's
// <app-screenshot/>, "Not right" feedback and a card's report show the chat that is really there.
import type { NativeImage, Rectangle } from "electron";

export interface Bitmap { width: number; height: number; data: Buffer }
/** The parts of a NativeImage used here (tests pass plain objects). */
export type Picture = Pick<NativeImage, "isEmpty" | "getSize" | "toBitmap">;
export interface ChatLayer { bounds: Rectangle; capture: () => Promise<Picture> }

/** Copies `src` into `dst` with its top-left at (x, y) pixels, clipped to `dst`. 4 bytes per pixel, same order in both. */
export function pasteBitmap(dst: Bitmap, src: Bitmap, x: number, y: number): void {
  const left = Math.max(0, x), top = Math.max(0, y);
  const right = Math.min(dst.width, x + src.width), bottom = Math.min(dst.height, y + src.height);
  if (right <= left || bottom <= top) return;
  for (let row = top; row < bottom; row++) {
    const from = ((row - y) * src.width + (left - x)) * 4;
    src.data.copy(dst.data, (row * dst.width + left) * 4, from, from + (right - left) * 4);
  }
}

/** The image's pixels. A capture comes back at the display's pixels (2x on Retina), labelled scale factor 1. */
export function bitmapOf(image: Picture): Bitmap {
  const size = image.getSize(), data = image.toBitmap();
  return { width: size.width, height: size.height, data };
}

/** Pixels per window DIP of a capture `image` of something `width` DIPs wide. */
export const captureScale = (image: Picture, width: number): number => width > 0 ? image.getSize().width / width : 1;

/**
 * The shell's picture with the native chat drawn in. `width` is the window's content width in DIPs (the
 * shell capture's width), `chat` null when no chat view is showing (another tab, a covered chat, no
 * native editor): the shell's picture is then the whole truth. `make` builds the result at the shell
 * capture's pixels (nativeImage.createFromBitmap in main). Never fails over the chat layer: a chat that
 * cannot be captured leaves the shell's picture as it was.
 */
export async function composeWindow(shell: Picture, width: number, chat: ChatLayer | null,
  make: (bitmap: Bitmap) => Picture): Promise<Picture> {
  if (!chat || shell.isEmpty() || chat.bounds.width <= 0 || chat.bounds.height <= 0) return shell;
  let layer: Picture;
  try { layer = await chat.capture(); } catch { return shell; }
  if (layer.isEmpty()) return shell;
  const scale = captureScale(shell, width);
  // Different displays mid-move: no resampling, keep what is certain.
  if (Math.abs(captureScale(layer, chat.bounds.width) - scale) > 0.01) return shell;
  const base = bitmapOf(shell), canvas = { ...base, data: Buffer.from(base.data) };
  pasteBitmap(canvas, bitmapOf(layer), Math.round(chat.bounds.x * scale), Math.round(chat.bounds.y * scale));
  return make(canvas);
}
