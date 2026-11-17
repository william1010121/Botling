// M4-43 (D67): bounding the FE's resend loop on repeated `bye{unsettled}`.
import { afterEach, describe, expect, it } from "vitest";
import { type Message, type Slot, type StreamId } from "../../src/protocol";
import { FeLink, MemoryFeStorage, type Dial, type FeLinkEvent, type FeLinkOptions, type FeStorage } from "../../src/fe-link";
import { SlotRefusal } from "../../src/server/slots";
import { BOT, FakeClock, FakeServer, flush, react } from "./fe-link-harness";

const BOT2 = "bot:b2" as StreamId;

const links: FeLink[] = [];
afterEach(async () => {
  for (const link of links.splice(0)) await link.stop();
});

let epochCounter = 0;
const nextEpoch = () => (++epochCounter).toString(16).padStart(32, "0");

/**
 * Wraps FakeServer's dial so a test can inject `bye{unsettled}` (with or without `slot`), or silently drop a `cmd`
 * on the wire while keeping the session open, while delegating normal traffic, `cmd.skipped`, and other queues to the
 * real SlotEngine.
 */
function wrapServer(
  server: FakeServer,
  clock: FakeClock,
  onCmd?: (body: { slot: Slot; floor: number }) => "unsettled" | "unsettled-slotless" | "drop" | void,
  onCancel?: (slot: Slot) => "unsettled" | "unsettled-slotless" | void,
) {
  const dialTimes: number[] = [];
  const dial: Dial = (handlers) => {
    dialTimes.push(clock.now());
    const inner = server.dial(handlers);
    return {
      send(frame: string) {
        const msg = JSON.parse(frame) as Message;
        if (msg.t === "cmd" && onCmd) {
          const action = onCmd(msg);
          if (action === "drop") return;
          if (action) {
            server.send({
              t: "bye",
              reason: "unsettled",
              detail: "injected cmd unsettled",
              ...(action === "unsettled" ? { slot: msg.slot } : {}),
            });
            setImmediate(() => server.kill());
            return;
          }
        }
        if (msg.t === "cancel" && onCancel) {
          const action = onCancel(msg.slot);
          if (action) {
            server.send({
              t: "bye",
              reason: "unsettled",
              detail: "injected cancel unsettled",
              ...(action === "unsettled" ? { slot: msg.slot } : {}),
            });
            setImmediate(() => server.kill());
            return;
          }
        }
        inner.send(frame);
      },
      close() { inner.close(); },
    };
  };
  return { dial, dialTimes };
}

async function openLink(dial: Dial, storage: FeStorage, clock: FakeClock, over: Partial<FeLinkOptions> = {}) {
  const link = await FeLink.open({
    storage,
    dial,
    deviceId: "desktop",
    feVersion: "3.0.0",
    clock,
    newEpoch: nextEpoch,
    reconnectMinMs: 250,
    reconnectMaxMs: 5_000,
    ...over,
  });
  links.push(link);
  const events: FeLinkEvent[] = [];
  link.on((e) => events.push(e));
  link.subscribe(BOT);
  link.subscribe(BOT2);
  link.start();
  return { link, events };
}

describe("D67 loop bound (bye{unsettled} and giveUp)", () => {
  it("5 consecutive bye{unsettled} on slot n escalate backoff, stop sending n, keep same-queue FIFO waiting, and leave other queues unaffected", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    let failSlot1 = true;
    const copiesSlot1: number[] = [];
    const { dial, dialTimes } = wrapServer(server, clock, (msg) => {
      if (msg.slot.target === BOT && msg.slot.n === 1) {
        copiesSlot1.push(clock.now());
        if (failSlot1) return "unsettled";
      }
    });

    const { link } = await openLink(dial, storage, clock);
    await flush();
    expect(link.state).toBe("live");

    const a1 = await link.submit(BOT, react("m1"));
    await link.submit(BOT, react("m2")); // same queue behind slot 1: must wait FIFO until giveUp
    await link.submit(BOT2, { type: "chat.react", botId: "b2", messageId: "o1", emoji: "👍", present: true });
    await flush();

    // 1st bye{unsettled} happened on session 1; advance through 4 more reconnect attempts (250, 500, 1000, 2000)
    // and then the 5th reconnect (4000) where slot 1 is now stopped.
    for (const ms of [250, 500, 1_000, 2_000, 4_000]) {
      clock.advance(ms);
      await flush();
    }

    // Backoff was NOT reset by any welcome after bye{unsettled}: exact dial intervals match 250, 500, 1000, 2000, 4000.
    const intervals = dialTimes.slice(1).map((t, i) => t - dialTimes[i]!);
    expect(intervals).toEqual([250, 500, 1_000, 2_000, 4_000]);

    // Slot 1 was tried 5 times (and stopped after the 5th bye{unsettled}); session 6 stays live without sending it!
    expect(copiesSlot1).toHaveLength(5);
    expect(link.state).toBe("live");

    // No further reconnects occur while idle.
    clock.advance(10_000);
    await flush();
    expect(dialTimes).toHaveLength(6);

    // Slot 1 is stopped in pending() (`sending: false`); slot 2 (same queue) is waiting behind it and was NOT sent ahead;
    // BOT2 (other queue) succeeded and left the outbox.
    const pendingBot1 = link.pending(BOT);
    expect(pendingBot1.map((p) => [p.slot.n, p.state, p.stopped ?? false, p.sending])).toEqual([
      [1, "waiting", true, false],
      [2, "waiting", false, true],
    ]);
    expect(server.copies.filter((c) => c.slot.target === BOT && c.slot.n === 2)).toEqual([]);
    expect(server.applied.filter((a) => a.slot.target === BOT2)).toHaveLength(1);

    // Submitting a new command on BOT2 while BOT is stopped goes through immediately.
    await link.submit(BOT2, { type: "chat.react", botId: "b2", messageId: "o2", emoji: "🔥", present: true });
    await flush();
    expect(server.applied.filter((a) => a.slot.target === BOT2)).toHaveLength(2);

    // Submitting another command on BOT waits FIFO behind stopped slot 1.
    await link.submit(BOT, react("m3"));
    await flush();
    expect(server.copies.filter((c) => c.slot.target === BOT && c.slot.n >= 2)).toEqual([]);

    // Give up on slot 1: transitions slot 1 out of unresolved() to persisted not sent / skipped,
    // and immediately sends waiting items 2 and 3 with floor > 1 (triggering cmd.skipped at the owner).
    failSlot1 = false;
    await link.giveUp(a1.slot);
    await flush();

    expect(server.copies.filter((c) => c.slot.target === BOT && c.slot.n === 2).map((c) => c.floor)).toEqual([2]);
    expect(server.applied.filter((a) => a.slot.target === BOT).map((a) => a.slot.n)).toEqual([2, 3]);
    expect(server.entries(BOT).some((e) => e.kind === "cmd.skipped")).toBe(true);
    expect(link.pending(BOT).map((p) => [p.slot.n, p.state, p.reason, p.stopped ?? false])).toEqual([
      [1, "not sent", "skipped", false],
    ]);

    // Dismiss removes it.
    await link.dismiss(a1.slot);
    expect(link.pending(BOT)).toEqual([]);
  });

  it("reconnectFastMs does not shorten the bye{unsettled} escalation: dial intervals stay 250, 500, 1000, 2000", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const { dial, dialTimes } = wrapServer(server, clock, (msg) => {
      if (msg.slot.target === BOT && msg.slot.n === 1) return "unsettled";
    });
    const { link } = await openLink(dial, new MemoryFeStorage(), clock, { reconnectFastMs: 500 });
    await flush();
    await link.submit(BOT, react("m1"));
    await flush();
    for (const ms of [250, 500, 1_000, 2_000]) { clock.advance(ms); await flush(); }
    expect(dialTimes.slice(1).map((t, i) => t - dialTimes[i]!)).toEqual([250, 500, 1_000, 2_000]);
  });

  it("giving up with an empty tail sends nothing immediately; the next command carries floor > n", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    const { dial } = wrapServer(server, clock, (msg) => {
      if (msg.slot.target === BOT && msg.slot.n === 1) return "unsettled";
    });

    const { link } = await openLink(dial, storage, clock);
    await flush();
    const a1 = await link.submit(BOT, react("m1"));
    await flush();
    for (const ms of [250, 500, 1_000, 2_000, 4_000]) { clock.advance(ms); await flush(); }
    expect(link.pending(BOT)[0]).toMatchObject({ state: "waiting", stopped: true });

    const sentBefore = server.received.length;
    await link.giveUp(a1.slot);
    await flush();
    // Nothing was sent on the wire when giving up with no later item waiting.
    expect(server.received.length).toBe(sentBefore);
    expect(link.pending(BOT)[0]).toMatchObject({ state: "not sent", reason: "skipped" });

    // Persisted across reload: reopening storage keeps slot 1 as not sent / skipped and does not resend it.
    await link.stop();
    const reopened = await openLink(dial, storage, clock);
    await flush();
    expect(reopened.link.pending(BOT)).toHaveLength(1);
    expect(reopened.link.pending(BOT)[0]).toMatchObject({ state: "not sent", reason: "skipped" });

    // Next command carries floor = 2 past slot 1, causing cmd.skipped on slot 1 and applying slot 2.
    const a2 = await reopened.link.submit(BOT, react("m2"));
    await flush();
    expect(a2.slot.n).toBe(2);
    expect(server.copies.filter((c) => c.slot.target === BOT && c.slot.n === 2).map((c) => c.floor)).toEqual([2]);
    expect(server.entries(BOT).some((e) => e.kind === "cmd.skipped")).toBe(true);
    expect(server.applied.map((a) => a.slot.n)).toEqual([2]);
  });

  it("slotless bye{unsettled} does not count toward any slot, yet still skips backoff reset on the next welcome", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    let slotlessRemaining = 6;
    const { dial, dialTimes } = wrapServer(server, clock, (msg) => {
      if (msg.slot.target === BOT && slotlessRemaining > 0) {
        slotlessRemaining -= 1;
        return "unsettled-slotless";
      }
    });

    const { link } = await openLink(dial, storage, clock);
    await flush();
    await link.submit(BOT, react("m1"));
    await flush();

    // 6 consecutive slotless bye{unsettled}: backoff keeps growing (never reset by welcome),
    // and slot 1 is NOT stopped — on the 7th attempt it succeeds!
    for (const ms of [250, 500, 1_000, 2_000, 4_000, 5_000]) {
      clock.advance(ms);
      await flush();
    }
    const intervals = dialTimes.slice(1).map((t, i) => t - dialTimes[i]!);
    expect(intervals).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000]);
    expect(server.applied.map((a) => a.slot.n)).toEqual([1]);
    expect(link.pending(BOT)).toEqual([]);
  });

  it("resets slot n's count when a bye{unsettled} names a different slot", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    let b1Unsettled = 0;
    let dropB1Once = false;
    let failB2Once = false;
    const { dial } = wrapServer(server, clock, (msg) => {
      if (msg.slot.target === BOT) {
        if (dropB1Once) { dropB1Once = false; return "drop"; }
        if (b1Unsettled < 7) { b1Unsettled += 1; return "unsettled"; }
      }
      if (msg.slot.target === BOT2 && failB2Once) {
        failB2Once = false;
        return "unsettled";
      }
    });

    const { link } = await openLink(dial, storage, clock);
    await flush();
    await link.submit(BOT, react("m1"));
    await flush(); // b1 #1
    clock.advance(250); await flush(); // b1 #2
    clock.advance(500); await flush(); // b1 #3
    expect(b1Unsettled).toBe(3);

    // Session 4: BOT#1 is silently held on the wire (stays unresolved), then BOT2#1 gets bye{unsettled, slot: BOT2#1}.
    dropB1Once = true;
    failB2Once = true;
    clock.advance(1_000); await flush();
    expect(link.state).toBe("live");
    await link.submit(BOT2, { type: "chat.react", botId: "b2", messageId: "o1", emoji: "👍", present: true });
    await flush(); // BOT2#1 -> bye{unsettled, slot: BOT2#1} resets BOT#1's count from 3 to 0

    // Next 4 sessions fail BOT#1 (counts 1..4 after reset, total 7 failures) -> STILL NOT stopped!
    // On the 5th session after reset (8th overall attempt), BOT#1 succeeds!
    for (const ms of [2_000, 4_000, 5_000, 5_000, 5_000]) {
      clock.advance(ms);
      await flush();
    }
    expect(b1Unsettled).toBe(7);
    expect(server.applied.some((a) => a.slot.target === BOT && a.slot.n === 1)).toBe(true);
    expect(link.pending(BOT)).toEqual([]);
  });

  it("resets slot n's count on cancel.noted and on cmd.result (refused)", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    let dropB1Once = false;
    let cmdFails = 0;
    const { dial } = wrapServer(server, clock, (msg) => {
      if (msg.slot.target === BOT && msg.slot.n === 1) {
        if (dropB1Once) { dropB1Once = false; return "drop"; }
        if (cmdFails < 7) { cmdFails += 1; return "unsettled"; }
      }
      if (msg.slot.target === BOT && msg.slot.n === 2) {
        if (cmdFails < 10) { cmdFails += 1; return "unsettled"; }
      }
    });

    const { link } = await openLink(dial, storage, clock);
    await flush();
    const a1 = await link.submit(BOT, react("m1"));
    await flush(); // 1
    clock.advance(250); await flush(); // 2
    clock.advance(500); await flush(); // 3
    expect(cmdFails).toBe(3);

    // Session 4: BOT#1 is dropped on wire (unresolved), then user cancels and gets cancel.noted -> count resets to 0.
    dropB1Once = true;
    clock.advance(1_000); await flush();
    expect(link.state).toBe("live");
    await link.cancel(a1.slot);
    await flush();
    expect(link.pending(BOT)[0]).toMatchObject({ state: "waiting", cancelNoted: true });

    // Kill session 4 and suffer 4 more bye{unsettled} on BOT#1 (counts 1..4 after reset; total 7).
    // On the 5th reconnect, cmd reaches FakeServer where cancel was committed -> resolves as cancelled (NOT stopped!).
    server.kill();
    await flush();
    for (const ms of [2_000, 4_000, 5_000, 5_000, 5_000]) {
      clock.advance(ms);
      await flush();
    }
    expect(cmdFails).toBe(7);
    expect(link.pending(BOT)[0]).toMatchObject({ state: "not sent", reason: "cancelled" });
    expect(link.pending(BOT)[0]?.stopped).toBeUndefined();
    await link.dismiss(a1.slot);

    // Also verify cmd.result (refused) clears count and resolves cleanly without stopped state:
    const a2 = await link.submit(BOT, react("m2"));
    await flush(); // fail #1 (cmdFails = 8)
    clock.advance(5_000); await flush(); // fail #2 (cmdFails = 9)
    clock.advance(5_000); await flush(); // fail #3 (cmdFails = 10)
    expect(cmdFails).toBe(10);
    // Reconnect and refuse a2 on the wire:
    server.applyHook = () => { throw new SlotRefusal("changed"); };
    clock.advance(5_000); await flush();
    expect(link.pending(BOT).find((p) => p.slot.n === a2.slot.n)).toMatchObject({ state: "not sent", reason: "changed" });
    expect(link.pending(BOT).find((p) => p.slot.n === a2.slot.n)?.stopped).toBeUndefined();
  });
});
