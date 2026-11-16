// M7-11b (found by the swap-outbox property test, seed 20262478): `cmd.retry{inc}` (D49) makes the front end hold an item until the
// owner's `srv:` stream is on `inc`. When the owner is restored AGAIN before the front end has heard of the first restore, the stream
// never shows that `inc` (it goes from the old logId straight to the newest): the item waited for ever, and every later item of its
// queue, sent under the new inc, was held ahead of it at the owner and never applied. The wait ends when the front end's inc moves
// on from the one the copy was refused under.
import { afterEach, describe, expect, it } from "vitest";
import { type Message } from "../../src/protocol";
import { FeLink, MemoryFeStorage, type Dial, type FeLinkEvent } from "../../src/fe-link";
import { BOT, FakeClock, FakeServer, flush, react, SRV_STREAM } from "./fe-link-harness";

const links: FeLink[] = [];
afterEach(async () => { for (const link of links.splice(0)) await link.stop(); });

let epochCounter = 0;
const nextEpoch = () => (++epochCounter).toString(16).padStart(32, "0");

async function attach(server: FakeServer, clock: FakeClock, storage = new MemoryFeStorage()) {
  const link = await FeLink.open({ storage, dial: server.dial, deviceId: "desktop", feVersion: "3.0.0", clock, newEpoch: nextEpoch, local: true });
  links.push(link);
  const events: FeLinkEvent[] = [];
  link.on((event) => events.push(event));
  link.subscribe(BOT);
  link.start();
  await flush();
  return { link, events, storage };
}
const outcomesOf = (events: FeLinkEvent[]) => events.flatMap((event) => (event.type === "outcome" ? [event.item.outcome?.kind] : []));

describe("cmd.retry for an inc the front end never sees (D49)", () => {
  it("an owner restored twice before the first reset arrives: the item and the ones behind it still apply, once each", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const { link, events } = await attach(server, clock);
    server.holdResets = true;
    server.restore(); // inc 02: the front end has not heard of it
    await link.submit(BOT, react("m1"));
    await flush();
    expect(server.copies.map((copy) => copy.inc)).toEqual(["inc-00000001"]); // refused: cmd.retry{inc-00000002}
    server.restore(); // inc 03, still unheard of
    server.releaseResets();
    await flush();
    expect(link.cursor(SRV_STREAM)?.logId).toBe("inc-00000003"); // 02 was never shown
    await link.submit(BOT, react("m2"));
    await flush();
    clock.advance(1_000);
    await flush();
    expect(server.applied.map((entry) => entry.slot.n)).toEqual([1, 2]);
    expect(outcomesOf(events)).toEqual(["applied", "applied"]);
    expect(link.pending(BOT)).toEqual([]);
  });

  it("still waits while the front end is on the inc the copy was refused under (no re-send loop)", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const { link, events } = await attach(server, clock);
    server.holdResets = true;
    server.restore(); // the owner is on 02, the front end on 01
    await link.submit(BOT, react("m1"));
    await flush();
    await link.submit(BOT, react("m2")); // another send trigger: m1 is not sent again, m2 goes out once
    await flush();
    const copiesOf = (n: number) => server.copies.filter((copy) => copy.slot.n === n).map((copy) => copy.inc);
    expect(copiesOf(1)).toEqual(["inc-00000001"]);
    expect(copiesOf(2)).toEqual(["inc-00000001"]);
    expect(server.applied).toEqual([]);
    server.releaseResets();
    await flush();
    expect(link.cursor(SRV_STREAM)?.logId).toBe("inc-00000002");
    expect(server.applied.map((entry) => entry.slot.n)).toEqual([1, 2]);
    expect(outcomesOf(events)).toEqual(["applied", "applied"]);
  });
});

describe("cmd.retry that arrives after the front end already moved past the inc it sent under (review M7-11b)", () => {
  it("a late refusal names an inc the stream never shows: the item is still re-sent under the inc the stream is on", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const { link, events } = await attach(server, clock);
    server.holdResets = true;
    server.restore(); // inc 02: the front end has not heard of it
    server.dropReplies = 1; // the refusal of m1's copy (cmd.retry{inc-02}) is late: it comes after the front end is on inc 03
    await link.submit(BOT, react("m1"));
    await flush();
    expect(server.copies.map((copy) => copy.inc)).toEqual(["inc-00000001"]);
    const slot = server.copies[0]!.slot;
    server.restore(); // inc 03
    server.releaseResets();
    await flush();
    expect(link.cursor(SRV_STREAM)?.logId).toBe("inc-00000003");
    server.send({ t: "cmd.retry", slot, inc: "inc-00000002" }); // the late refusal (a forwarded reply on a slower path)
    await flush();
    await link.submit(BOT, react("m2"));
    await flush();
    clock.advance(1_000);
    await flush();
    expect(server.copies.filter((copy) => copy.slot.n === 1).map((copy) => copy.inc)).toEqual(["inc-00000001", "inc-00000003"]);
    expect(server.applied.map((entry) => entry.slot.n)).toEqual([1, 2]);
    expect(outcomesOf(events)).toEqual(["applied", "applied"]);
    expect(link.pending(BOT)).toEqual([]);
  });
});

describe("a copy sent under the newest inc after a refusal, then lost to a reconnect (re-check M7-11b)", () => {
  it("the next session sends it again under that inc: it was never refused there, so there is nothing to wait for", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    let dropNextCmd = false;
    const dial: Dial = (handlers) => {
      const inner = server.dial(handlers);
      return {
        send(frame: string) {
          if (dropNextCmd && (JSON.parse(frame) as Message).t === "cmd") { dropNextCmd = false; server.kill(); return; } // lost with the connection
          inner.send(frame);
        },
        close() { inner.close(); },
      };
    };
    const link = await FeLink.open({ storage: new MemoryFeStorage(), dial, deviceId: "desktop", feVersion: "3.0.0", clock, newEpoch: nextEpoch, local: true });
    links.push(link);
    const events: FeLinkEvent[] = [];
    link.on((event) => events.push(event));
    link.subscribe(BOT);
    link.start();
    await flush();
    server.holdResets = true;
    server.restore(); // inc 02: the front end has not heard of it
    await link.submit(BOT, react("m1"));
    await flush(); // refused: cmd.retry{inc-00000002}; the front end is on 01, so m1 waits
    server.restore(); // inc 03
    dropNextCmd = true; // m1's copy under 03 is lost: the connection drops before it reaches the server
    server.releaseResets();
    await flush();
    for (const ms of [1_000, 2_000, 4_000]) { clock.advance(ms); await flush(); }
    expect(link.cursor(SRV_STREAM)?.logId).toBe("inc-00000003");
    await link.submit(BOT, react("m2"));
    await flush();
    clock.advance(1_000);
    await flush();
    expect(server.copies.filter((copy) => copy.slot.n === 1).map((copy) => copy.inc)).toEqual(["inc-00000001", "inc-00000003"]);
    expect(server.applied.map((entry) => entry.slot.n)).toEqual([1, 2]);
    expect(outcomesOf(events)).toEqual(["applied", "applied"]);
    expect(link.pending(BOT)).toEqual([]);
  });
});
