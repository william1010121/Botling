// Botling 3 M2 step 13: the relay connection's pacer (src/server/net/pacing.ts) on a fake clock. The relay closes a
// connection above 50 messages/s (burst 200); botlingd keeps to 45/s (burst 150), control and live first, content at
// most 30/s, each channel (one device session) in order, at most CHANNEL_FRAMES frames per channel held here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_FRAMES, PaceBucket, RELAY_PACE, RelayPacer } from "../../src/server/net";

/** A token bucket like the relay's (relay/src/limits.ts): is any message refused? */
function relayCheck(times: number[], rate: number, burst: number): number {
  let tokens = burst, at = times[0] ?? 0, refused = 0;
  for (const t of times) {
    tokens = Math.min(burst, tokens + ((t - at) / 1000) * rate);
    at = t;
    if (tokens < 1) { refused++; continue; }
    tokens -= 1;
  }
  return refused;
}

describe("relay pacer", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it("keeps to 45/s with a burst of 150, and the relay's own 50/200 bucket never refuses", async () => {
    const sent: Array<{ at: number; text: string }> = [];
    const pacer = new RelayPacer({ write: (text) => sent.push({ at: Date.now(), text }) });
    for (let i = 0; i < 600; i++) pacer.push(`p${i % 3}`, i % 2 ? "bulk" : "control", `m${i}`);
    for (let s = 0; s < 20 && sent.length < 600; s++) await vi.advanceTimersByTimeAsync(1_000);
    expect(sent.length).toBe(600);
    const times = sent.map((m) => m.at);
    expect(relayCheck(times, RELAY_PACE.rate, RELAY_PACE.burst)).toBe(0);
    expect(relayCheck(times, 50, 200)).toBe(0);
    // Any window of w seconds holds at most 45·w + 150 (the bucket's bound; tokens saved while only content waited
    // come back as a burst, never more than 150).
    for (const w of [1, 2, 5]) {
      let max = 0;
      for (let i = 0; i < times.length; i++) { let n = 0; for (let j = i; j < times.length && times[j]! - times[i]! < w * 1000; j++) n++; max = Math.max(max, n); }
      expect(max).toBeLessThanOrEqual(45 * w + 150);
    }
    expect(pacer.stats.minTokens).toBeGreaterThanOrEqual(0);
  });

  it("content goes at most 30/s, and control overtakes waiting bulk heads of other channels", async () => {
    const sent: Array<{ at: number; text: string }> = [];
    const pacer = new RelayPacer({ write: (text) => sent.push({ at: Date.now(), text }), burst: 1, contentBurst: 1 });
    for (let i = 0; i < 90; i++) pacer.push("bulk-peer", "bulk", `b${i}`);
    await vi.advanceTimersByTimeAsync(500);
    pacer.push("other", "control", "approve");
    await vi.advanceTimersByTimeAsync(40);
    // The control frame left within one main-bucket interval (≈ 22 ms), not after the 75 waiting bulk frames.
    expect(sent.some((m) => m.text === "approve")).toBe(true);
    await vi.advanceTimersByTimeAsync(4_000);
    const bulk = sent.filter((m) => m.text.startsWith("b")).map((m) => m.at);
    expect(bulk.length).toBe(90);
    expect(relayCheck(bulk, 30, 1)).toBe(0);
    expect(pacer.stats.maxBulkPerSecond).toBeLessThanOrEqual(31);
  });

  it("each channel is FIFO (sealed frames keep their order), and writable/onWritable bound what a channel holds here", async () => {
    const sent: string[] = [];
    const pacer = new RelayPacer({ write: (text) => sent.push(text), burst: 1, rate: 10 });
    pacer.push(null, "control", "hello");
    pacer.push("a", "bulk", "a1");
    pacer.push("a", "control", "a2");
    expect(pacer.writable("a")).toBe(false);
    expect(CHANNEL_FRAMES).toBe(2);
    let woke = 0;
    pacer.onWritable("a", () => { woke++; });
    pacer.push("b", "control", "b1");
    await vi.advanceTimersByTimeAsync(1_000);
    // a1 (bulk) went first because it was the first frame overall; a2 after it, never before.
    expect(sent.indexOf("a1")).toBeLessThan(sent.indexOf("a2"));
    expect(sent).toHaveLength(4);
    expect(woke).toBe(1);
    expect(pacer.writable("a")).toBe(true);
  });

  it("waits while the socket's buffer is full, drops a gone channel's frames, and stops", async () => {
    const sent: string[] = [];
    let buffered = 2 * 1024 * 1024;
    const pacer = new RelayPacer({ write: (text) => sent.push(text), buffered: () => buffered });
    pacer.push("a", "control", "x");
    pacer.push("b", "control", "y");
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual([]);
    pacer.drop("b");
    buffered = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual(["x"]);
    pacer.stop();
    pacer.push("a", "control", "z");
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual(["x"]);
  });

  it("a bucket says how long until its next token", () => {
    let now = 0;
    const bucket = new PaceBucket(45, 2, () => now);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    expect(bucket.wait()).toBe(Math.ceil(1000 / 45));
    now += 23;
    expect(bucket.take()).toBe(true);
  });
});
