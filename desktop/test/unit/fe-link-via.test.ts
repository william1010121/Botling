// M5-12a (D53 / protocol v1 §11.1, §13.2, plan change N3): `via` is stored with the outbox item when written and
// sent unchanged on every re-send; a via-less item omits the `via` key completely (hash-neutral).
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FeLink, MemoryFeStorage, Outbox, SerialWriter, type Dial, type FeLinkOptions, type FeStorage } from "../../src/fe-link";
import { SqliteFeStorage } from "../../src/fe-link/sqlite-storage";
import { canonicalJson, type Via } from "../../src/protocol";
import { cmdHash } from "../../src/server/slots/hash";
import { BOT, FakeClock, FakeServer, flush, react } from "./fe-link-harness";

const links: FeLink[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const link of links.splice(0)) await link.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "fe-link-via-"));
  dirs.push(dir);
  return join(dir, "fe.db");
};

const VIA: Via = { plugin: "notes-helper", codeHash: "sha256:" + "ab".repeat(32) };

interface WireCapture {
  dial: Dial;
  rawCmds: Array<Record<string, unknown>>;
}

function captureCmdFrames(baseDial: Dial): WireCapture {
  const rawCmds: Array<Record<string, unknown>> = [];
  const dial: Dial = (handlers) => {
    const socket = baseDial(handlers);
    return {
      send: (frame) => {
        const parsed = JSON.parse(frame) as Record<string, unknown>;
        if (parsed.t === "cmd") rawCmds.push(parsed);
        socket.send(frame);
      },
      close: () => socket.close(),
    };
  };
  return { dial, rawCmds };
}

let epochSeq = 0;
const nextEpoch = () => (++epochSeq).toString(16).padStart(32, "0");

async function openLink(dial: Dial, storage: FeStorage, clock: FakeClock, over: Partial<FeLinkOptions> = {}, subscribeBot = true): Promise<FeLink> {
  const link = await FeLink.open({
    storage,
    dial,
    deviceId: "desktop",
    feVersion: "3.0.0",
    clock,
    newEpoch: nextEpoch,
    local: true,
    ...over,
  });
  links.push(link);
  if (subscribeBot) link.subscribe(BOT);
  link.start();
  return link;
}

describe("M5-12a: via on outbox items", () => {
  it("an item submitted with via sends it; one without sends no via key at all", async () => {
    const server = new FakeServer();
    const wire = captureCmdFrames(server.dial);
    const clock = new FakeClock();
    const link = await openLink(wire.dial, new MemoryFeStorage(), clock);
    await flush();

    await link.submit(BOT, react("m1"));
    await link.submit(BOT, react("m2"), undefined, VIA);
    await flush();

    expect(wire.rawCmds).toHaveLength(2);
    expect(Object.prototype.hasOwnProperty.call(wire.rawCmds[0], "via")).toBe(false);
    expect(wire.rawCmds[1].via).toEqual(VIA);
    expect(server.copies).toHaveLength(2);
    expect("via" in server.copies[0]).toBe(false);
    expect(server.copies[1].via).toEqual(VIA);
  });

  it("reopening the outbox from SQLite and MemoryFeStorage (IDB structured-clone fake) keeps via and sends it unchanged", async () => {
    const file = tempFile();
    const cases: Array<{ name: string; openStorage: () => FeStorage }> = [
      { name: "SQLite", openStorage: () => new SqliteFeStorage(file) },
      { name: "MemoryFeStorage", openStorage: (() => { const mem = new MemoryFeStorage(); return () => mem; })() },
    ];

    for (const testCase of cases) {
      const server = new FakeServer();
      server.refuse = true;
      const clock = new FakeClock();

      const first = await FeLink.open({
        storage: testCase.openStorage(),
        dial: server.dial,
        deviceId: "desktop",
        feVersion: "3.0.0",
        clock,
        newEpoch: nextEpoch,
        local: true,
      });
      first.start();
      const created = await first.submit(BOT, react("m1"), undefined, VIA);
      expect(created.via, testCase.name).toEqual(VIA);
      await first.close();

      server.refuse = false;
      const wire = captureCmdFrames(server.dial);
      const second = await openLink(wire.dial, testCase.openStorage(), clock);
      await flush();

      expect(wire.rawCmds, testCase.name).toHaveLength(1);
      expect(wire.rawCmds[0].via, testCase.name).toEqual(VIA);
      expect(server.copies[0].via, testCase.name).toEqual(VIA);
      await second.close();
      links.pop();
    }
  });

  it("the command hash of a via-less item equals the M2 golden value", async () => {
    // Pinned M2/pre-N1 golden from protocol-via.test.ts.
    const pinned = createHash("sha256").update('{"cmd":{"botId":"B1","type":"chat.read"},"scope":"reply"}').digest("hex");
    expect(cmdHash({ cmd: { type: "chat.read", botId: "B1" } as never, scope: "reply" })).toBe(pinned);
    expect(cmdHash({ cmd: { type: "chat.read", botId: "B1" } as never, scope: "reply", via: undefined })).toBe(pinned);

    const server = new FakeServer();
    const wire = captureCmdFrames(server.dial);
    const clock = new FakeClock();
    const link = await openLink(wire.dial, new MemoryFeStorage(), clock);
    await flush();

    await link.submit(BOT, react("m1"));
    await flush();

    expect(wire.rawCmds).toHaveLength(1);
    const sent = wire.rawCmds[0];
    expect("via" in sent).toBe(false);
    const expectedHash = createHash("sha256")
      .update(canonicalJson({ cmd: sent.cmd, scope: "local" }))
      .digest("hex");
    expect(cmdHash({ cmd: sent.cmd as ReturnType<typeof react>, scope: "local" })).toBe(expectedHash);
    const stored = String(server.db.prepare("SELECT cmdHash FROM receipts WHERE n = 1").get()!.cmdHash);
    expect(stored).toBe(expectedHash);
  });

  it("re-sending after a reconnect never changes via", async () => {
    const server = new FakeServer();
    server.dropReplies = 1;
    const wire = captureCmdFrames(server.dial);
    const clock = new FakeClock();
    const link = await openLink(wire.dial, new MemoryFeStorage(), clock, {}, false);
    await flush();

    await link.submit(BOT, react("m1"), undefined, VIA);
    await flush();
    expect(wire.rawCmds).toHaveLength(1);
    expect(wire.rawCmds[0].via).toEqual(VIA);

    server.kill();
    await flush();
    clock.advance(500);
    await flush();

    expect(wire.rawCmds).toHaveLength(2);
    expect(wire.rawCmds[1].via).toEqual(wire.rawCmds[0].via);
    expect(wire.rawCmds[1].slot).toEqual(wire.rawCmds[0].slot);
    expect(wire.rawCmds[1].cmd).toEqual(wire.rawCmds[0].cmd);
    expect(server.copies.map((c) => c.via)).toEqual([VIA, VIA]);
  });

  it("moving a conflicted slot to a new epoch keeps via", async () => {
    const storage = new MemoryFeStorage();
    const writer = new SerialWriter(storage);
    const outbox = await Outbox.open({
      origin: "desktop",
      state: await storage.load(),
      writer,
      newEpoch: nextEpoch,
      now: () => 1,
    });
    const item = await outbox.submit(BOT, react("m1"), undefined, VIA);
    const res = await outbox.resolve(item.slot, { kind: "refused", reason: "slot conflict" }, { logId: "log-0000001", seq: 1 });
    expect(res?.kind).toBe("moved");
    if (res?.kind === "moved") {
      expect(res.item.via).toEqual(VIA);
      expect(outbox.envelope(res.item, "inc-0000001").via).toEqual(VIA);
    }
  });
});
