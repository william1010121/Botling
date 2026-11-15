// Botling 3 M4-19 (D71): a page stays on the origin it was paired on and reaches a second server at its
// `wss://<tailnet name>/v3/ws` (or relay room). Each server adds the tailnet origins of all valid servers to its
// page's `connect-src`, and `/v3/ws` accepts only exact-match origins of valid servers or the relay.
import { mkdirSync, rmSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";
import { clusterOrigins, tailnetOrigin } from "../../src/server/botlingd";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { CSP, cspWith, LISTEN_HOST, LoopbackListener } from "../../src/server/net";
import { addressesValue } from "../../src/server/peer";
import { RosterStore } from "../../src/server/roster";
import { openServerStore } from "../../src/server/store";
import { testRoot } from "../botlingd-harness";
import { until } from "../helpers";
import { LocalRelay } from "../support/local-relay";
import { makeCluster, profile, readServerKeys, revokeServer, sign, strangerKeys, writeStatements } from "../support/peer-cluster";
import { startServers, type TestCluster } from "../support/two-servers";

const root = testRoot("cross-origin");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

let folders = 0;

function tryUpgrade(port: number, origin?: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WsClient(`ws://${LISTEN_HOST}:${port}/v3/ws`, origin !== undefined ? { origin } : {});
    ws.on("open", () => { ws.close(); resolve("open"); });
    ws.on("unexpected-response", (...args: unknown[]) => {
      resolve(String((args[1] as { statusCode: number }).statusCode));
      ws.terminate();
    });
    ws.on("error", () => undefined);
  });
}

describe("M4-19: exact-match Origin checks and CSP connect-src in http.ts", () => {
  it("cspWith allows valid ws/wss origins, deduplicates, and rejects non-exact or non-ws origins", () => {
    expect(cspWith([])).toBe(CSP);
    expect(cspWith(["wss://peer-b.example.invalid", "wss://peer-b.example.invalid", "wss://peer-c.example.invalid:8443"]))
      .toContain("connect-src 'self' wss://peer-b.example.invalid wss://peer-c.example.invalid:8443;");
    for (const bad of [
      "https://peer-b.example.invalid",
      "wss://peer-b.example.invalid/v3/ws",
      "wss://peer-b.example.invalid?x=1",
      "wss://peer-b.example.invalid:99999",
      "wss://peer-b.example.invalid; script-src 'unsafe-inline'",
      "javascript:alert(1)",
      "*",
    ]) {
      expect(cspWith([bad]), bad).toBe(CSP);
    }
  });

  it("LoopbackListener enforces exact-match Origin checks on /v3/ws and dynamically tracks origins/connectOrigins", async () => {
    let allowedOrigins = ["https://peer-a.example.invalid", "https://peer-a.example.invalid:8443", "http://127.0.0.1:9000", "*", "https://bad.example.invalid/", "https://*.example.invalid", "wss://ws.example.invalid", "null", ""];
    let connect = ["wss://peer-b.example.invalid"];
    const listener = await LoopbackListener.start({
      port: 0,
      remote: { accept: () => ({ link: { established: Promise.resolve() }, receive: () => undefined, transportClosed: () => undefined }) },
      pageDir: null,
      origins: () => allowedOrigins,
      connectOrigins: () => connect,
      log: () => undefined,
    });
    cleanups.push(() => listener.close());

    // Exact matches succeed; no Origin succeeds (non-browser peer/CLI).
    expect(await tryUpgrade(listener.port)).toBe("open");
    expect(await tryUpgrade(listener.port, "https://peer-a.example.invalid")).toBe("open");
    expect(await tryUpgrade(listener.port, "https://peer-a.example.invalid:8443")).toBe("open");
    expect(await tryUpgrade(listener.port, "http://127.0.0.1:9000")).toBe("open");

    // Near-misses and non-exact/malformed origins in options.origins() are refused with 403.
    for (const bad of [
      "https://peer-a.example.invalid.evil",
      "https://evil-peer-a.example.invalid",
      "https://sub.peer-a.example.invalid",
      "https://peer-a.example.invalid/",
      "http://peer-a.example.invalid",
      "wss://peer-a.example.invalid",
      "https://peer-a.example.invalid:9443",
      "https://PEER-A.example.invalid",
      "https://bad.example.invalid",
      "https://bad.example.invalid/",
      "https://*.example.invalid",
      "wss://ws.example.invalid",
      "null",
      "*",
    ]) {
      expect(await tryUpgrade(listener.port, bad), bad).toBe("403");
    }

    // An explicit empty Origin header ("Origin: ") is also refused with 403.
    const emptyOriginReply = await new Promise<string>((resolve) => {
      const socket = tcpConnect({ host: LISTEN_HOST, port: listener.port }, () => {
        socket.end("GET /v3/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: \r\n\r\n");
      });
      let text = "";
      socket.on("data", (chunk) => { text += chunk; });
      socket.on("close", () => resolve(text));
    });
    expect(emptyOriginReply).toMatch(/^HTTP\/1\.1 403 /);

    // Dynamic updates take effect immediately without restarting the listener.
    const pageBefore = await fetch(`http://${LISTEN_HOST}:${listener.port}/v3/`);
    expect(pageBefore.headers.get("content-security-policy")).toContain("connect-src 'self' wss://peer-b.example.invalid;");
    allowedOrigins = [];
    connect = [];
    expect(await tryUpgrade(listener.port, "https://peer-a.example.invalid")).toBe("403");
    const pageAfter = await fetch(`http://${LISTEN_HOST}:${listener.port}/v3/`);
    expect(pageAfter.headers.get("content-security-policy")).toBe(CSP);
  });
});

describe("M4-19: clusterOrigins from RosterStore", () => {
  it("normalizes tailnetOrigin and derives exact connect-src and WebSocket origins, dropping revoked servers", async () => {
    expect(tailnetOrigin({ BOTLING_SERVER_TAILNET_ORIGIN: "https://Peer-A.example.invalid/" })).toBe("https://peer-a.example.invalid");
    expect(tailnetOrigin({ BOTLING_SERVER_TAILNET_ORIGIN: "https://peer-a.example.invalid:8443" })).toBe("https://peer-a.example.invalid:8443");
    expect(tailnetOrigin({ BOTLING_SERVER_TAILNET_ORIGIN: "https://peer-a.example.invalid:443" })).toBe("https://peer-a.example.invalid");

    const dir = join(root, `roster-${++folders}`);
    mkdirSync(dir, { recursive: true });
    const store = await openServerStore(dir);
    cleanups.push(() => store.close());
    const identity = await loadOrCreateServerIdentity(dir, { create: true });
    await store.submit((tx) => bindServerIdentity(tx, identity));
    const roster = await RosterStore.open(store, identity);
    const setup = new ClusterSetup(roster);
    expect((await setup.confirm((await setup.begin()).code)).ok).toBe(true);

    // Lone server: no peer profiles yet; only own tailnet origin + relay origin when configured.
    expect(clusterOrigins(roster, "https://peer-a.example.invalid", "wss://relay.example.invalid/ws")).toEqual({
      origins: ["https://peer-a.example.invalid", "https://relay.example.invalid"],
      connectOrigins: ["wss://relay.example.invalid"],
    });

    // Add servers B (with custom port) and C (joined via B so cascade covers C).
    const kb = await strangerKeys();
    const kc = await strangerKeys();
    const selfKeys = await readServerKeys(dir);
    const clusterId = roster.clusterId!;
    const addB = await sign(
      { type: "add", cluster: clusterId, member: kb.memberId, kind: "server", keys: { sign: kb.sign, dh: kb.dh }, name: "B", by: selfKeys.memberId, at: 1_700_000_000_000, joined: true },
      selfKeys,
    );
    const addC = await sign(
      { type: "add", cluster: clusterId, member: kc.memberId, kind: "server", keys: { sign: kc.sign, dh: kc.dh }, name: "C", by: kb.memberId, at: 1_700_000_000_001, joined: true },
      kb,
    );
    const profA = await sign(
      { type: "profile", cluster: clusterId, member: selfKeys.memberId, field: "addresses", value: addressesValue(8744, { tailnet: "https://peer-a.example.invalid" }), hlc: { ms: 100, c: 0 } },
      selfKeys,
    );
    const profB = await sign(
      { type: "profile", cluster: clusterId, member: kb.memberId, field: "addresses", value: addressesValue(8745, { tailnet: "https://peer-b.example.invalid:8443" }), hlc: { ms: 100, c: 0 } },
      kb,
    );
    const profC = await sign(
      { type: "profile", cluster: clusterId, member: kc.memberId, field: "addresses", value: addressesValue(8746, { tailnet: "https://peer-c.example.invalid" }), hlc: { ms: 100, c: 0 } },
      kc,
    );
    const merged = await roster.mergeGossip([addB, addC, profA, profB, profC].map((item) => item.statement));
    expect(merged.refused).toEqual([]);

    expect(clusterOrigins(roster, "https://peer-a.example.invalid", "ws://127.0.0.1:9100/ws")).toEqual({
      origins: [
        "http://127.0.0.1:9100",
        "https://peer-a.example.invalid",
        "https://peer-b.example.invalid:8443",
        "https://peer-c.example.invalid",
      ],
      connectOrigins: [
        "ws://127.0.0.1:9100",
        "wss://peer-a.example.invalid",
        "wss://peer-b.example.invalid:8443",
        "wss://peer-c.example.invalid",
      ],
    });

    // Revoke C: C's origin is dropped immediately.
    await roster.revokeServer(kc.memberId, false, "stolen");
    expect(clusterOrigins(roster, "https://peer-a.example.invalid", null)).toEqual({
      origins: ["https://peer-a.example.invalid", "https://peer-b.example.invalid:8443"],
      connectOrigins: ["wss://peer-a.example.invalid", "wss://peer-b.example.invalid:8443"],
    });
  });
});

describe("M4-19 (D71): real botlingd servers allow valid cluster & relay origins and drop revoked servers", () => {
  let cluster: TestCluster;
  let relay: LocalRelay;

  afterAll(async () => {
    await cluster?.cleanup();
    await relay?.stop();
  }, 60_000);

  it("A's page CSP lists B's tailnet origin, B accepts A's Origin & relay Origin, refuses unknown/near-miss, and drops C on revocation", async () => {
    relay = await new LocalRelay().ready();
    const timersEnv = { BOTLING_SERVER_PEER_TIMERS: "ping=300,dead=1500,redial=150,redialMax=1000,revoked=2500" };
    cluster = await startServers({
      count: 3,
      name: "cross-origin-e2e",
      env: {
        A: { ...timersEnv, BOTLING_SERVER_TAILNET_ORIGIN: "https://peer-a.example.invalid", BOTLING_SERVER_RELAY_URL: relay.url },
        B: { ...timersEnv, BOTLING_SERVER_TAILNET_ORIGIN: "https://peer-b.example.invalid", BOTLING_SERVER_RELAY_URL: relay.url },
        C: { ...timersEnv, BOTLING_SERVER_TAILNET_ORIGIN: "https://peer-c.example.invalid" },
      },
    });
    const [a, b, c] = cluster.servers as [typeof cluster.a, typeof cluster.b, NonNullable<typeof cluster.c>];
    await Promise.all([a.stop(), b.stop(), c.stop()]);
    const [ka, kb, kc] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir), readServerKeys(c.dataDir)]);
    const made = await makeCluster([ka, kb, kc]); // A is the revocation root.
    const bootstrapProfiles = [
      await profile(made.clusterId, ka, ka, a.port, 1_700_000_000_000),
      await profile(made.clusterId, kb, kb, b.port, 1_700_000_000_000),
      await profile(made.clusterId, kc, kc, c.port, 1_700_000_000_000),
    ];
    for (const s of [a, b, c]) writeStatements(s.dataDir, made.clusterId, [...made.statements, ...bootstrapProfiles]);
    await Promise.all([a.start(), b.start(), c.start()]);

    // 1. Wait for A's page CSP to list A, B, and C's tailnet origins plus the relay origin.
    const relayConnect = `ws://127.0.0.1:${relay.port}`;
    const aCsp = await until(async () => {
      const response = await fetch(`http://127.0.0.1:${a.port}/v3/`);
      const value = response.headers.get("content-security-policy") ?? "";
      await response.arrayBuffer();
      return value.includes("wss://peer-b.example.invalid") && value.includes("wss://peer-c.example.invalid") ? value : null;
    }, { timeout: 20_000, every: 100, what: "A's CSP lists B and C tailnet origins" });
    const connectSrc = aCsp.split("; ").find((d) => d.startsWith("connect-src "))!;
    expect(connectSrc).toContain("'self'");
    expect(connectSrc).toContain("wss://peer-a.example.invalid");
    expect(connectSrc).toContain("wss://peer-b.example.invalid");
    expect(connectSrc).toContain("wss://peer-c.example.invalid");
    expect(connectSrc).toContain(relayConnect);

    // Wait for B to receive A and C's tailnet profiles via gossip as well.
    await until(async () => {
      const response = await fetch(`http://127.0.0.1:${b.port}/v3/`);
      const value = response.headers.get("content-security-policy") ?? "";
      await response.arrayBuffer();
      return value.includes("wss://peer-a.example.invalid") && value.includes("wss://peer-c.example.invalid") ? value : null;
    }, { timeout: 20_000, every: 100, what: "B's CSP lists A and C tailnet origins" });

    // 2. B accepts a WebSocket with Origin = A's tailnet origin, C's tailnet origin, and the relay's HTTP origin.
    expect(await tryUpgrade(b.port, "https://peer-a.example.invalid")).toBe("open");
    expect(await tryUpgrade(b.port, "https://peer-c.example.invalid")).toBe("open");
    expect(await tryUpgrade(b.port, `http://127.0.0.1:${relay.port}`)).toBe("open");

    // 3a. B refuses an Origin that no valid server has, and near-misses (exact match only).
    for (const bad of [
      "https://stranger.example.invalid",
      "https://peer-a.example.invalid.evil",
      "https://sub.peer-a.example.invalid",
      "https://peer-a.example.invalid/",
      "http://peer-a.example.invalid",
      "https://peer-a.example.invalid:8443",
      "null",
    ]) {
      expect(await tryUpgrade(b.port, bad), bad).toBe("403");
    }

    // 3b. Root A revokes C; once B receives the revocation via gossip, B drops C's origin from /v3/ws and CSP.
    const revokeC = await revokeServer(made.clusterId, ka, kc);
    await a.stop();
    writeStatements(a.dataDir, made.clusterId, [revokeC]);
    await a.start();

    await until(async () => {
      const response = await fetch(`http://127.0.0.1:${b.port}/v3/`);
      const value = response.headers.get("content-security-policy") ?? "";
      await response.arrayBuffer();
      return !value.includes("wss://peer-c.example.invalid") ? value : null;
    }, { timeout: 20_000, every: 100, what: "B drops revoked C from CSP" });

    expect(await tryUpgrade(b.port, "https://peer-c.example.invalid")).toBe("403");
    expect(await tryUpgrade(b.port, "https://peer-a.example.invalid")).toBe("open");
  }, 90_000);
});
