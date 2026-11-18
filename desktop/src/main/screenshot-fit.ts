// A screenshot that travels inside a command must leave the whole command under one frame (protocol §5.2, FRAME_LIMIT):
// the command goes through the front end's durable outbox, and a copy the frame codec refuses can never be sent (L-005).
// `fitScreenshot` takes the picture at full size when it fits, then smaller and smaller, and gives up (null) when even the
// smallest does not: the caller then sends the command without a picture. PNG all the way (the core keeps it as `.png`).

// The 2.x main entry bundles this file and must not pull in the v3 protocol (main-v3-server-client.test.ts), so the limit is
// written here; screenshot-fit.test.ts checks it against the codec's own FRAME_LIMIT.
export const SCREENSHOT_FRAME_LIMIT = 256 * 1024;

/** What the `cmd` frame adds around the command: `t`, the slot, floor, inc, basis, via (a long target and plugin names included). */
export const COMMAND_FRAME_HEADROOM = 16 * 1024;
/** `,"screenshot":""` around the picture. */
const FIELD_BYTES = `,"screenshot":""`.length;
/** The widths tried, as a share of the picture's own width; none goes below `MIN_WIDTH` pixels. */
const SCALES = [1, 0.75, 0.5, 0.35, 0.25] as const;
const MIN_WIDTH = 240;

/** The parts of a NativeImage used here (tests pass plain objects). */
export interface FitPicture {
  getSize(): { width: number; height: number };
  toPNG(): Buffer;
  resize(options: { width: number; height?: number; quality?: "good" | "better" | "best" }): FitPicture;
}

/** The UTF-8 bytes of the command's JSON without a picture (what is left of the frame for it, with the headroom). */
export function pictureBudget(rest: unknown): number {
  return SCREENSHOT_FRAME_LIMIT - COMMAND_FRAME_HEADROOM - FIELD_BYTES - Buffer.byteLength(JSON.stringify(rest), "utf8");
}

/** The picture as base64 PNG that fits `budget` characters (base64 is ASCII, so characters are bytes), or null. */
export function fitScreenshot(image: FitPicture, budget: number): string | null {
  if (budget <= 0) return null;
  const { width } = image.getSize();
  let tried = 0;
  for (const scale of SCALES) {
    const target = Math.round(width * scale);
    if (scale !== 1 && (target < MIN_WIDTH || target === tried)) continue;
    tried = target;
    const base64 = (scale === 1 ? image : image.resize({ width: target, quality: "best" })).toPNG().toString("base64");
    if (base64.length <= budget) return base64;
  }
  return null;
}
