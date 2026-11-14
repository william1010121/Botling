// M2 step 8: the browser network state in wsDial (src/fe-link/ws-dial.ts). WebKit keeps an open WebSocket through an
// offline switch, so the page passes navigator.onLine and window: no socket while offline, and `offline` ends the open one.
import { describe, expect, it } from "vitest";
import { generateDhKeyPair } from "../../src/session";
import { wsDial, wsUrlFor } from "../../src/fe-link";

class FakeSocket {
  static made: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.made.push(this); }
  send(): void { /* the handshake's first frame waits in the queue */ }
  close(): void { this.closed = true; this.readyState = 3; }
}

async function dialer(online: () => boolean, events: EventTarget) {
  const self = await generateDhKeyPair();
  const server = await generateDhKeyPair();
  return wsDial({
    url: () => "ws://127.0.0.1:1/v3/ws",
    identity: { cluster: "c".repeat(32), memberId: "a".repeat(26), dh: self, server: { memberId: "b".repeat(26), dhPub: server.publicKey } },
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    network: { online, events },
  });
}

describe("wsDial and the browser's network state", () => {
  it("opens no socket while the browser says offline; the link hears a close", async () => {
    FakeSocket.made = [];
    const dial = await dialer(() => false, new EventTarget());
    const closed = await new Promise<string>((resolve) => dial({ open: () => undefined, frame: () => undefined, close: (detail) => resolve(detail ?? "") }));
    expect(closed).toBe("the browser is offline");
    expect(FakeSocket.made).toHaveLength(0);
  });

  it("ends the open socket on the offline event, once", async () => {
    FakeSocket.made = [];
    const events = new EventTarget();
    const dial = await dialer(() => true, events);
    const closes: string[] = [];
    dial({ open: () => undefined, frame: () => undefined, close: (detail) => closes.push(detail ?? "") });
    expect(FakeSocket.made).toHaveLength(1);
    events.dispatchEvent(new Event("offline"));
    events.dispatchEvent(new Event("offline"));
    expect(closes).toEqual(["the browser went offline"]);
    expect(FakeSocket.made[0]!.closed).toBe(true);
  });

  it("maps a page URL to its /v3/ws", () => {
    expect(wsUrlFor("https://tailnet-name.invalid/v3/#pair=x")).toBe("wss://tailnet-name.invalid/v3/ws");
    expect(wsUrlFor("http://127.0.0.1:8744/v3/?a=1")).toBe("ws://127.0.0.1:8744/v3/ws");
  });
});
