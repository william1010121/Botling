// A screenshot inside a command must leave the whole command under one frame (FRAME_LIMIT): a copy over it can never be
// sent (the "Queued for ever" of the eeg bot after two "Not right" taps, 2026-11-18).
import { describe, expect, it } from "vitest";
import { encodeFrame, FRAME_LIMIT, type Message } from "../../src/protocol";
import { COMMAND_FRAME_HEADROOM, SCREENSHOT_FRAME_LIMIT, fitScreenshot, pictureBudget, type FitPicture } from "../../src/main/screenshot-fit";

/** A picture whose PNG is `bytesAt(width)` bytes; `resize` gives the same kind of picture at the new width. */
function picture(width: number, bytesAt: (width: number) => number): FitPicture {
  return {
    getSize: () => ({ width, height: width }),
    toPNG: () => Buffer.alloc(bytesAt(width), 7),
    resize: ({ width: to }) => picture(to, bytesAt),
  };
}

const feedback = (over: Record<string, unknown> = {}) => ({ type: "chat.feedback", botId: "b1", messageId: "m1", text: "not right", images: [], rect: null, ...over }) as const;

/** The command as the link sends it (the longest legal slot / inc), to check it against the real codec. */
function frameOf(cmd: ReturnType<typeof feedback>) {
  const message = { t: "cmd", slot: { origin: "desktop", originEpoch: "a".repeat(32), target: "bot:b1", n: 88 }, floor: 86, inc: "i".repeat(64), cmd } as unknown as Message;
  return encodeFrame(message, "fe", { local: true });
}

describe("the frame limit", () => {
  it("is the codec's own (the 2.x main entry cannot import the protocol, so screenshot-fit.ts writes it down)", () => {
    expect(SCREENSHOT_FRAME_LIMIT).toBe(FRAME_LIMIT);
  });
});

describe("fitScreenshot", () => {
  it("keeps the picture as it is when the command still fits one frame", () => {
    const rest = feedback();
    const shot = fitScreenshot(picture(1000, () => 50_000), pictureBudget(rest));
    expect(shot).toHaveLength(Math.ceil(50_000 / 3) * 4);
    expect(frameOf(feedback({ screenshot: shot })).ok).toBe(true);
  });

  it("scales a ~410 KB PNG (the eeg bot's) down until the whole command fits", () => {
    const rest = feedback();
    // 410 KB at 1600 px: 0.16 byte per pixel of area; half the width is a quarter of the bytes.
    const image = picture(1600, (w) => Math.round(w * w * 0.16));
    expect(image.toPNG().length).toBe(409_600);
    const shot = fitScreenshot(image, pictureBudget(rest));
    expect(shot).not.toBeNull();
    expect(Buffer.from(shot!, "base64").length).toBeLessThan(409_600);
    const encoded = frameOf(feedback({ screenshot: shot }));
    expect(encoded.ok).toBe(true);
    // The unscaled picture is exactly what the codec refuses.
    expect(frameOf(feedback({ screenshot: image.toPNG().toString("base64") }))).toMatchObject({ ok: false, reason: "too-large" });
  });

  it("returns null (the command goes without a picture) when even the smallest does not fit", () => {
    expect(fitScreenshot(picture(1600, () => 5_000_000), pictureBudget(feedback()))).toBeNull();
  });

  it("counts what is already in the command: pictures the user pasted leave less room, CJK text counts 3 bytes a character", () => {
    const ascii = pictureBudget(feedback({ text: "a".repeat(20_000) }));
    const cjk = pictureBudget(feedback({ text: "字".repeat(20_000) }));
    expect(ascii - cjk).toBe(40_000);
    const pasted = feedback({ images: [{ name: "a.png", base64: "A".repeat(FRAME_LIMIT - COMMAND_FRAME_HEADROOM) }] });
    expect(pictureBudget(pasted)).toBeLessThan(0);
    expect(fitScreenshot(picture(100, () => 10), pictureBudget(pasted))).toBeNull();
  });

  it("never scales a small picture below its width, and tries the full size first", () => {
    const sizes: number[] = [];
    const small: FitPicture = { getSize: () => ({ width: 200, height: 200 }), toPNG: () => { sizes.push(200); return Buffer.alloc(1_000_000); }, resize: () => { throw new Error("resized a picture already under the minimum width"); } };
    expect(fitScreenshot(small, pictureBudget(feedback()))).toBeNull();
    expect(sizes).toEqual([200]);
  });
});
