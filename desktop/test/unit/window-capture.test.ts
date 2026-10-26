import { expect, it } from "vitest";
import { composeWindow, pasteBitmap, type Bitmap, type Picture } from "../../src/main/window-capture";

const solid = (width: number, height: number, value: number): Bitmap => {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.writeUInt32LE(value, i * 4);
  return { width, height, data };
};
const at = (bitmap: Bitmap, x: number, y: number) => bitmap.data.readUInt32LE((y * bitmap.width + x) * 4);
// A capture as Electron returns it: the display's pixels, labelled scale factor 1.
const picture = (bitmap: Bitmap): Picture & { bitmap: Bitmap } => ({ bitmap, isEmpty: () => bitmap.width === 0, getSize: () => ({ width: bitmap.width, height: bitmap.height }), toBitmap: () => bitmap.data });
const make = (bitmap: Bitmap) => picture(bitmap);

it("pastes one bitmap into another, clipped to the destination", () => {
  const dst = solid(4, 3, 1), src = solid(3, 3, 2);
  pasteBitmap(dst, src, 2, 1);
  expect([at(dst, 1, 1), at(dst, 2, 1), at(dst, 3, 2), at(dst, 2, 0)]).toEqual([1, 2, 2, 1]);
  pasteBitmap(dst, src, -2, -2);
  expect(at(dst, 0, 0)).toBe(2);
  expect(at(dst, 1, 1)).toBe(1);
});

it("draws the native chat view into the shell's picture at the window's pixel scale (Retina 2x)", async () => {
  // A 100x50 DIP window captured at 2x; the chat view at DIP (40,10) 30x20 is drawn by its own web contents.
  const shell = picture(solid(200, 100, 0xff111111)), chat = picture(solid(60, 40, 0xffeeeeee));
  const result = await composeWindow(shell, 100, { bounds: { x: 40, y: 10, width: 30, height: 20 }, capture: async () => chat }, make) as ReturnType<typeof picture>;
  expect(at(result.bitmap, 80, 20)).toBe(0xffeeeeee);
  expect(at(result.bitmap, 139, 59)).toBe(0xffeeeeee);
  expect(at(result.bitmap, 79, 20)).toBe(0xff111111);
  expect(at(result.bitmap, 140, 60)).toBe(0xff111111);
  // The shell's own capture is left as it was.
  expect(at(shell.bitmap, 80, 20)).toBe(0xff111111);
});

it("keeps the shell's picture when no chat is showing or it cannot be captured", async () => {
  const shell = picture(solid(200, 100, 7));
  expect(await composeWindow(shell, 100, null, make)).toBe(shell);
  expect(await composeWindow(shell, 100, { bounds: { x: 0, y: 0, width: 30, height: 20 }, capture: async () => { throw new Error("gone"); } }, make)).toBe(shell);
  expect(await composeWindow(shell, 100, { bounds: { x: 0, y: 0, width: 30, height: 20 }, capture: async () => picture(solid(0, 0, 0)) }, make)).toBe(shell);
  // A chat captured at another scale (window between displays) is not resampled.
  expect(await composeWindow(shell, 100, { bounds: { x: 0, y: 0, width: 30, height: 20 }, capture: async () => picture(solid(30, 20, 9)) }, make)).toBe(shell);
});
