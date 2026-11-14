// Botling 3 M2 step 6, the built botlingd (out/server/main.cjs, `npm run build` first) with its loopback listener,
// through the M3 two-server harness (each server gets its port as BOTLING_SERVER_PORT, a clean environment, no window):
// - A: listens on 127.0.0.1:<its port> and nowhere else (assertLoopbackOnly({ expectListener: true })); `/v3/` carries
//   the CSP; `botlingd status` prints the listener and the `tailscale serve` line with the placeholder tailnet name (also
//   in --json); a WebSocket handshake from an unknown key gets nothing back; a clean stop removes the listen file;
// - B: BOTLING_SERVER_PORT=off → no TCP listener at all, status says off;
// - C: its port already taken → botlingd still starts (the local socket works), status says why it is not listening,
//   and with BOTLING_SERVER_TAILNET_ORIGIN set the tailscale line names that origin instead of the placeholder.
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateDhKeyPair, SessionLink } from "../../src/session";
import { fromBase64Url, memberIdFromKey } from "../../src/protocol";
import { until } from "../helpers";
import { freeLoopbackPort, LISTEN_PORT_ENV, startServers, type TestCluster } from "../support/two-servers";

let cluster: TestCluster;
let taken: Server;
let takenPort = 0;

beforeAll(async () => {
  takenPort = await freeLoopbackPort();
  taken = createServer();
  await new Promise<void>((resolve) => taken.listen(takenPort, "127.0.0.1", () => resolve()));
  cluster = await startServers({
    count: 3, name: "listener-cli",
    env: {
      B: { [LISTEN_PORT_ENV]: "off" },
      C: { [LISTEN_PORT_ENV]: String(takenPort), BOTLING_SERVER_TAILNET_ORIGIN: "https://botling-test.example.invalid" },
    },
  });
}, 180_000);

afterAll(async () => {
  await cluster?.cleanup();
  await new Promise<void>((resolve) => taken.close(() => resolve()));
}, 60_000);

describe("botlingd's loopback listener (built server)", () => {
  it("listens on 127.0.0.1:<port> only, serves /v3/ with the CSP, and status prints the tailscale serve line", async () => {
    const a = cluster.a;
    const sockets = a.assertLoopbackOnly({ expectListener: true });
    expect(sockets.filter((socket) => socket.proto === "tcp").map((socket) => `${socket.address}:${socket.port}`)).toEqual([`127.0.0.1:${a.port}`]);
    expect(a.log).toContain(`listener: http://127.0.0.1:${a.port} (loopback only`);

    const page = await fetch(`http://127.0.0.1:${a.port}/v3/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    await page.text();

    const status = a.command(["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(`listener: http://127.0.0.1:${a.port} (loopback only)`);
    expect(status.stdout).toContain(`tailscale serve (run it yourself; botlingd never does): tailscale serve --bg http://127.0.0.1:${a.port}`);
    expect(status.stdout).toContain("devices then open https://tailnet-name.invalid/v3/: replace tailnet-name.invalid with this machine's tailnet name");
    const json = JSON.parse(a.command(["status", "--json"]).stdout);
    expect(json.listener).toEqual({ address: "127.0.0.1", port: a.port, listening: true });
    expect(json.tailscaleServe).toEqual({ command: `tailscale serve --bg http://127.0.0.1:${a.port}`, page: "https://tailnet-name.invalid/v3/", placeholder: true });
  });

  it("a WebSocket handshake from a key it does not know gets no frame back, and the server keeps serving", async () => {
    const a = cluster.a;
    const ws = new WebSocket(`ws://127.0.0.1:${a.port}/v3/ws`);
    ws.binaryType = "arraybuffer";
    let received = 0;
    let closed = false;
    ws.onmessage = () => { received++; };
    ws.onclose = () => { closed = true; };
    await until(() => ws.readyState === WebSocket.OPEN, { what: "socket open" });
    // The server's real public keys (so HS1 opens and the roster check is what refuses), and a key no roster has.
    const serverKeys = JSON.parse(readFileSync(join(a.dataDir, "server-keys.json"), "utf8")) as { sign: { pub: string }; dh: { pub: string } };
    const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
    const dh = await generateDhKeyPair();
    const started = Date.now();
    const link = SessionLink.initiate({ send: (frame) => ws.send(frame), close: () => ws.close() }, {
      // Before the first pairing botlingd has no cluster: its handshake uses the all-zero id, and refuses every claim.
      mode: "ik", transport: "tailnet", cluster: "0".repeat(32), self: { memberId: await memberIdFromKey(signPub), dhPub: dh.publicKey, dhKey: dh.privateKey },
      responder: { memberId: await memberIdFromKey(fromBase64Url(serverKeys.sign.pub)!), dhPub: fromBase64Url(serverKeys.dh.pub)! },
    }, { onFrame: () => { throw new Error("no frame may arrive"); } });
    ws.onmessage = (event) => { received++; link.receive(new Uint8Array(event.data as ArrayBuffer)); };
    ws.onclose = () => { closed = true; link.transportClosed(); };
    await expect(link.established).rejects.toThrow();
    await until(() => closed, { timeout: 20_000, what: "socket closed by the server" });
    expect(received).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000); // refused at HS1, not left to time out
    expect(a.log).toMatch(/remote session \?: ended \(roster: no cluster yet\)/);
    const client = await a.client();
    expect(client.welcome?.serverId).toBeTruthy();
    client.close();
  });

  it("BOTLING_SERVER_PORT=off: no TCP listener at all, status says off", () => {
    const b = cluster.b;
    expect(b.listeners().filter((socket) => socket.proto === "tcp")).toEqual([]);
    expect(b.log).toContain("listener: off");
    const status = b.command(["status"]);
    expect(status.stdout).toContain("listener: off");
    expect(status.stdout).not.toContain("tailscale serve");
  });

  it("a taken port does not stop botlingd: the local socket works, status says why, the tailscale line names the set origin", async () => {
    const c = cluster.c;
    expect(c.alive).toBe(true);
    expect(c.listeners().filter((socket) => socket.proto === "tcp")).toEqual([]);
    const client = await c.client();
    expect(client.welcome?.serverId).toBeTruthy();
    client.close();
    const status = c.command(["status"]);
    expect(status.stdout).toMatch(new RegExp(`listener: not listening on 127\\.0\\.0\\.1:${takenPort}: .*EADDRINUSE`));
    expect(status.stdout).toContain(`tailscale serve --bg http://127.0.0.1:${takenPort}`);
    expect(status.stdout).toContain("devices then open https://botling-test.example.invalid/v3/");
    expect(status.stdout).not.toContain("tailnet-name.invalid");
  });

  it("a clean stop removes the listen file; status then gives the configured port", async () => {
    const a = cluster.a;
    expect(existsSync(join(a.dataDir, "botlingd.listen.json"))).toBe(true);
    await a.stop();
    expect(existsSync(join(a.dataDir, "botlingd.listen.json"))).toBe(false);
    const status = a.command(["status"]);
    expect(status.stdout).toContain("botlingd is not running.");
    expect(status.stdout).toContain(`listener: 127.0.0.1:${a.port} once botlingd runs (loopback only)`);
    await a.start();
    a.assertLoopbackOnly({ expectListener: true });
    await until(() => existsSync(join(a.dataDir, "botlingd.listen.json")), { what: "listen file again" });
  });
});
