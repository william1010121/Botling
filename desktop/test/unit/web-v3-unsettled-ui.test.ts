// @vitest-environment jsdom
// M4-43 (D67): web-v3 UI ("This device" sheet in Shell.tsx and itemWords in connection.ts) for items stopped after
// 5 consecutive bye{unsettled}.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { FeLink, MemoryFeStorage, type Dial, type PendingView } from "../../src/fe-link";
import type { Message } from "../../src/protocol";
import { itemWords, UNSETTLED_LEGACY_WARNING, UNSETTLED_STOPPED_TEXT, type Connection } from "../../web-v3/shell/connection";
import type { DeviceRecord } from "../../web-v3/shell/device-store";
import { ThisDevice } from "../../web-v3/shell/Shell";
import { BOT, FakeClock, FakeServer, flush, react } from "./fe-link-harness";

const links: FeLink[] = [];
afterEach(async () => {
  for (const link of links.splice(0)) await link.stop();
});

const DEVICE: DeviceRecord = {
  v: 1,
  cluster: "c1",
  memberId: "desktop",
  name: "Phone",
  signKey: {} as CryptoKey,
  signPub: "pub",
  addId: "a1",
  scope: ["read", "reply", "approve", "manage"],
  pairedAt: 1_700_000_000_000,
  dhKey: {} as CryptoKey,
  dhPub: new Uint8Array(32),
  server: { memberId: "srv1", name: "Mac", dhPub: new Uint8Array(32) },
};

describe("M4-43 web-v3 unsettled UI", () => {
  it("itemWords reports the stopped message before give-up and not sent: skipped after give-up", () => {
    const base: PendingView = {
      key: "k1",
      slot: { origin: "desktop", originEpoch: "a".repeat(32), target: BOT, n: 1 },
      cmd: react("m1"),
      state: "waiting",
      lost: false,
      sending: false,
      createdAt: 1,
    };
    expect(itemWords({ ...base, stopped: true })).toBe("The server could not take this command.");
    expect(itemWords({ ...base, state: "not sent", reason: "skipped" })).toBe("not sent: skipped");
    expect(UNSETTLED_STOPPED_TEXT).toBe("The server could not take this command.");
    expect(UNSETTLED_LEGACY_WARNING).toBe("A legacy command may already have run.");
  });

  it("ThisDevice renders stopped items with 'The server could not take this command.', 'Give up', and 'A legacy command may already have run.', and clicking Give up resolves the item", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const server = new FakeServer();
    const clock = new FakeClock();
    const dial: Dial = (handlers) => {
      const inner = server.dial(handlers);
      return {
        send(frame: string) {
          const msg = JSON.parse(frame) as Message;
          if (msg.t === "cmd" && msg.slot.n === 1) {
            server.send({ t: "bye", reason: "unsettled", slot: msg.slot });
            setImmediate(() => server.kill());
            return;
          }
          inner.send(frame);
        },
        close() { inner.close(); },
      };
    };

    const link = await FeLink.open({
      storage: new MemoryFeStorage(),
      dial,
      deviceId: "desktop",
      feVersion: "3.0.0",
      clock,
      reconnectMinMs: 250,
      reconnectMaxMs: 5_000,
    });
    links.push(link);
    link.subscribe(BOT);
    link.start();
    await flush();

    const a1 = await link.submit(BOT, { type: "chat.send", botId: "b1", text: "stuck message" });
    await link.submit(BOT, react("m2"));
    await flush();
    for (const ms of [250, 500, 1_000, 2_000, 4_000]) {
      clock.advance(ms);
      await flush();
    }
    expect(link.pending(BOT)[0]).toMatchObject({ stopped: true });

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const conn = { link, port: link, path: "direct", close: () => link.close() } as unknown as Connection;

    try {
      await act(async () => {
        root.render(createElement(ThisDevice, {
          device: DEVICE,
          connection: conn,
          path: "direct",
          onClose: () => undefined,
          onForget: () => undefined,
        }));
      });

      expect(host.textContent).toContain("The server could not take this command.");
      expect(host.textContent).toContain("A legacy command may already have run.");
      const buttons = [...host.querySelectorAll("button")];
      const giveUpBtn = buttons.find((b) => b.textContent?.trim() === "Give up");
      expect(giveUpBtn).toBeDefined();

      await act(async () => {
        giveUpBtn!.click();
        await flush();
      });

      // Slot 1 left stopped items and became not sent / skipped; slot 2 went through with floor = 2.
      expect(link.pending(BOT)).toHaveLength(1);
      expect(link.pending(BOT)[0]).toMatchObject({ slot: a1.slot, state: "not sent", reason: "skipped" });
      expect(server.applied.map((a) => a.slot.n)).toEqual([2]);
      expect(host.textContent).not.toContain("The server could not take this command.");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });
});
