// An outbox item whose copy the frame codec refuses (over FRAME_LIMIT) can never be sent. It must not hold its queue: it is set
// aside as "not sent" (persisted, like `giveUp`), and the later items go out with a `floor` past it, which the owner answers with
// `cmd.skipped` (§11.3). The eeg bot's chat sat at "Queued" for ever behind two oversize "Not right" feedbacks (2026-11-18).
import { afterEach, describe, expect, it } from "vitest";
import { FRAME_LIMIT, type Slot } from "../../src/protocol";
import { FeLink, MemoryFeStorage, type Dial, type FeLinkEvent, type FeStorage } from "../../src/fe-link";
import { wireError } from "../../src/main-v3/adapter-types";
import { BOT, FakeClock, FakeServer, flush, react } from "./fe-link-harness";

const links: FeLink[] = [];
afterEach(async () => { for (const link of links.splice(0)) await link.stop(); });

let epochCounter = 0;
const nextEpoch = () => (++epochCounter).toString(16).padStart(32, "0");

const big = () => ({ type: "chat.feedback", botId: "b1", messageId: "m1", text: "not right", images: [], rect: null, screenshot: "A".repeat(FRAME_LIMIT + 1_000) }) as const;

async function open(dial: Dial, storage: FeStorage, clock: FakeClock) {
  const link = await FeLink.open({ storage, dial, deviceId: "desktop", feVersion: "3.0.0", clock, newEpoch: nextEpoch, reconnectMinMs: 250, reconnectMaxMs: 5_000 });
  links.push(link);
  const events: FeLinkEvent[] = [];
  link.on((event) => events.push(event));
  link.subscribe(BOT);
  link.start();
  return { link, events };
}

describe("an outbox item that can never be encoded", () => {
  it("is set aside as not sent; the items behind it go out with a floor past it and the owner skips its slot", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const { link, events } = await open(server.dial, new MemoryFeStorage(), clock);
    await flush();
    expect(link.state).toBe("live");

    const first = await link.submit(BOT, big());
    await link.submit(BOT, react("m2"));
    await link.submit(BOT, react("m3"));
    await flush();

    expect(server.copies.some((c) => c.slot.n === 1)).toBe(false); // the oversize copy never went out
    expect(server.copies.filter((c) => c.slot.n === 2).map((c) => c.floor)).toEqual([2]);
    expect(server.applied.map((a) => a.slot.n)).toEqual([2, 3]);
    expect(server.entries(BOT).filter((e) => e.kind === "cmd.skipped").map((e) => [(e.body as { from: number }).from, (e.body as { to: number }).to])).toEqual([[1, 1]]);
    // Nothing is left waiting; the oversize item shows as not sent, with its own words, until dismissed.
    expect(link.pending(BOT)).toMatchObject([{ slot: first.slot, state: "not sent", reason: "skipped", reasonText: "too large to send" }]);
    expect(events.some((e) => e.type === "outcome" && e.item.slot.n === 1 && e.item.state === "not sent")).toBe(true);
    await link.dismiss(first.slot);
    expect(link.pending(BOT)).toEqual([]);
  });

  it("after a restart, oversize items already stored (the eeg outbox: 86, 87 oversize, then 88–90 waiting) no longer block the queue", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    // The old app's state: the items were stored while no server was reachable, so every one of them is waiting.
    server.refuse = true;
    const old = await open(server.dial, storage, clock);
    const stored: Slot[] = [];
    for (const cmd of [big(), big(), react("m3"), react("m4"), react("m5")]) stored.push((await old.link.submit(BOT, cmd)).slot);
    await flush();
    expect(old.link.pending(BOT).map((p) => p.state)).toEqual(["waiting", "waiting", "waiting", "waiting", "waiting"]);
    await old.link.stop();

    server.refuse = false;
    const { link } = await open(server.dial, storage, clock);
    await flush();
    expect(link.state).toBe("live");

    expect(server.applied.map((a) => a.slot.n)).toEqual([3, 4, 5]);
    // The first copy that reached the owner already carries the floor past both oversize slots, so it skips 1…2 and applies 3.
    expect(server.copies.map((c) => [c.slot.n, c.floor])).toEqual([[3, 3], [4, 3], [5, 3]]);
    expect(server.entries(BOT).filter((e) => e.kind === "cmd.skipped").map((e) => [(e.body as { from: number }).from, (e.body as { to: number }).to])).toEqual([[1, 2]]);
    expect(link.pending(BOT).map((p) => [p.slot.n, p.state, p.reasonText])).toEqual([[1, "not sent", "too large to send"], [2, "not sent", "too large to send"]]);

    // Persisted: a second restart finds them not sent and does not try them again.
    await link.stop();
    const again = await open(server.dial, storage, clock);
    await flush();
    expect(again.link.pending(BOT).map((p) => [p.slot.n, p.state])).toEqual([[1, "not sent"], [2, "not sent"]]);
    expect(server.copies).toHaveLength(3);
    // The next command takes the next slot and is applied (the owner's next is past the skipped ones).
    const next = await again.link.submit(BOT, react("m6"));
    await flush();
    expect(next.slot.n).toBe(6);
    expect(server.applied.map((a) => a.slot.n)).toEqual([3, 4, 5, 6]);
  });

  it("names the reason for the caller that waited on the command", () => {
    expect(wireError({ kind: "skipped" }, "too large to send").message).toBe("Not sent: too large to send.");
    expect(wireError({ kind: "skipped" }).message).toBe("Not sent: skipped after a restore.");
  });
});
