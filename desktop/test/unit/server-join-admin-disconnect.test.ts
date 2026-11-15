// M4-46 (J8): closing the local admin session burns its join offer or cancels its add-machine attempt,
// while letting any already in-flight welcome complete cleanly.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { AdminEvent } from "../../src/protocol";
import { effectCheckpointSink } from "../../src/server/effects";
import { ensureBot } from "../../src/server/effects/log-ops";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity, readVapidKeys } from "../../src/server/identity";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { AdminClient, ServerJoin, type JoinOfferResult, type MachineAddResult, type MachineCodeResult } from "../../src/server/pairing";
import type { PeerConnection, PeerConnector } from "../../src/server/peer/connector";
import { RosterStore } from "../../src/server/roster";
import { SessionServer, slotAuthorize, writeToken, type AdminHost, type SessionHost } from "../../src/server/session";
import { ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore } from "../../src/server/store";
import type { SessionTransport } from "../../src/session";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { testRoot } from "../botlingd-harness";
import { until } from "../helpers";

const root = testRoot("join-admin-disconnect");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanups.splice(0).reverse()) await step();
});

let seq = 0;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function memoryConnector(target: () => ServerJoin, hooks?: { holdFromTarget?: () => boolean }): PeerConnector {
  return {
    async connect(): Promise<PeerConnection> {
      let toS: { frame(frame: Uint8Array): void; closed(): void } | null = null;
      const early: Uint8Array[] = [];
      const held: Uint8Array[] = [];
      let closed = false;
      let acceptor: ReturnType<ServerJoin["accept"]> | null = null;
      const shut = () => {
        if (closed) return;
        closed = true;
        setImmediate(() => { acceptor?.transportClosed(); toS?.closed(); });
      };
      const nSide: SessionTransport = {
        send: (frame) => {
          if (closed) return;
          if (hooks?.holdFromTarget?.()) { held.push(frame); return; }
          setImmediate(() => {
            while (held.length) {
              const queued = held.shift()!;
              if (toS) toS.frame(queued); else early.push(queued);
            }
            if (toS) toS.frame(frame); else early.push(frame);
          });
        },
        close: shut,
      };
      return {
        send: (frame) => {
          if (closed) return;
          setImmediate(() => { acceptor ??= target().accept(nSide); acceptor.receive(frame); });
        },
        close: shut,
        bind: (events) => {
          toS = events;
          for (const frame of early.splice(0)) events.frame(frame);
        },
      };
    },
  };
}

async function makeNode(options: { withCluster: boolean; connector?: PeerConnector }) {
  const dir = join(root, `n${++seq}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = await openServerStore(dir);
  const identity = await loadOrCreateServerIdentity(dir);
  await store.submit((tx) => bindServerIdentity(tx, identity));
  const roster = await RosterStore.open(store, identity);
  if (options.withCluster) {
    const setup = new ClusterSetup(roster);
    const started = await setup.begin();
    expect((await setup.confirm(started.code)).ok).toBe(true);
  }
  const serverJoin = new ServerJoin({
    roster,
    identity,
    serverName: options.withCluster ? "S" : "N",
    version: "3.0.0",
    dataDir: dir,
    ownAddresses: () => null,
    joinAddresses: () => (options.withCluster ? [] : ["ws://127.0.0.1:9/v3/ws"]),
    ...(options.connector ? { connector: options.connector } : {}),
    replyTimeoutMs: 5_000,
  });
  const events: AdminEvent[] = [];
  serverJoin.onEvent((event) => events.push(event));

  const engine = new FakeTurnEngine({ bots: ["6A0B0000-0000-4000-8000-000000000002"], chunks: ["ok"], chunkMs: 1 });
  const hub = new LogHub(store, { serverStreams: true });
  const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 5 });
  const runtime = new IntentRuntime({ store, engine, hub, live, log: () => undefined, authorize: slotAuthorize(roster), serverEvents: "all", mirrorBotUpdates: true });
  await runtime.start();
  const shell = new ShellBridge();
  const sock = join(dir, "botlingd.sock");
  const token = writeToken(join(dir, "botlingd.token"));
  const admin: AdminHost = {
    handle: (op, session) => serverJoin.admin(op, session),
    onEvent: (listener) => serverJoin.onEvent(listener),
    sessionClosed: (session) => serverJoin.adminClosed(session),
  };
  const host: SessionHost = {
    serverId: identity.memberId,
    serverName: options.withCluster ? "S" : "N",
    startedAt: Date.now(),
    minFeVersion: "3.0.0",
    token: () => token,
    hub,
    live,
    runtime,
    engine,
    content: null,
    shell,
    nextFor: () => ({}),
    ensureBotStream: async (botId) => {
      if (!engine.hasBot(botId)) return false;
      await store.submit((tx) => { ensureBot(tx, botId); });
      return true;
    },
    log: () => undefined,
    admin,
  };
  const local = new SessionServer(sock, host);
  await local.listen();

  cleanups.push(async () => {
    await local.close();
    serverJoin.close();
    await runtime.scope.submit(() => undefined);
    engine.close();
    runtime.close();
    shell.close();
    live.close();
    hub.close();
    await store.close();
  });

  return { dir, identity, roster, join: serverJoin, events, sock, token };
}

async function connectAdmin(node: { sock: string; token: string }): Promise<AdminClient> {
  const client = await AdminClient.connect(node.sock, node.token);
  cleanups.push(() => client.close());
  return client;
}

describe("M4-46 (J8): admin client disconnect invalidates pairing invite, lets in-flight welcome finish", () => {
  it("closing the botlingd join admin client while open burns the offer and refuses a later dial", async () => {
    const n = await makeNode({ withCluster: false });
    const s = await makeNode({ withCluster: true, connector: memoryConnector(() => n.join) });
    const nClient = await connectAdmin(n);

    const offer = await nClient.request({ op: "join.offer" }) as JoinOfferResult;
    expect(n.join.isOffer(offer.offer)).toBe(true);

    nClient.close();
    await until(() => !n.join.isOffer(offer.offer), { timeout: 3_000, what: "open offer burned on admin disconnect" });
    expect(n.events.find((e) => e.kind === "join.declined" && e.offer === offer.offer)).toMatchObject({ reason: "cancelled" });
    await expect(s.join.addMachine(offer.link)).rejects.toThrow();
  });

  it("closing the botlingd join admin client while busy (before welcome) burns the offer and refuses the right digits", async () => {
    const n = await makeNode({ withCluster: false });
    const s = await makeNode({ withCluster: true, connector: memoryConnector(() => n.join) });
    const nClient = await connectAdmin(n);

    const offer = await nClient.request({ op: "join.offer" }) as JoinOfferResult;
    const added = await s.join.addMachine(offer.link);
    expect(added.server).toBe(n.identity.memberId);

    nClient.close();
    await until(() => !n.join.isOffer(offer.offer), { timeout: 3_000, what: "busy offer burned on admin disconnect" });
    expect(n.events.find((e) => e.kind === "join.declined" && e.offer === offer.offer)).toMatchObject({ reason: "cancelled" });

    const codeResult = await s.join.code(added.attempt, offer.code);
    expect(codeResult.ok).toBe(false);
    expect(n.roster.clusterId).toBeNull();
    await expect(s.join.addMachine(offer.link)).rejects.toThrow();
  });

  it("closing the botlingd join admin client while N is taking join.welcome lets the welcome finish and joins N", async () => {
    const n = await makeNode({ withCluster: false });
    const s = await makeNode({ withCluster: true, connector: memoryConnector(() => n.join) });
    const nClient = await connectAdmin(n);

    const entered = deferred();
    const release = deferred();
    const origJoinCluster = n.roster.joinCluster.bind(n.roster);
    n.roster.joinCluster = async (...args) => {
      entered.resolve();
      await release.promise;
      return origJoinCluster(...args);
    };

    const offer = await nClient.request({ op: "join.offer" }) as JoinOfferResult;
    const added = await s.join.addMachine(offer.link);
    const codePromise = s.join.code(added.attempt, offer.code);

    await entered.promise;
    nClient.close();
    // Give socket close handler time to run; the in-flight welcome must not be burned.
    await new Promise((r) => setTimeout(r, 40));
    expect(n.join.isOffer(offer.offer)).toBe(true);
    expect(n.events.some((e) => e.kind === "join.declined" && e.offer === offer.offer)).toBe(false);

    release.resolve();
    const codeResult = await codePromise;
    expect(codeResult).toMatchObject({ ok: true, server: n.identity.memberId, cluster: s.roster.clusterId });
    expect(n.roster.clusterId).toBe(s.roster.clusterId);
    expect(n.join.isOffer(offer.offer)).toBe(false);
  });

  it("closing the botlingd join admin client while N is taking join.welcome, if joinCluster fails, writes nothing and retires the offer", async () => {
    const n = await makeNode({ withCluster: false });
    const s = await makeNode({ withCluster: true, connector: memoryConnector(() => n.join) });
    const nClient = await connectAdmin(n);

    const entered = deferred();
    const release = deferred<never>();
    n.roster.joinCluster = async () => {
      entered.resolve();
      return release.promise;
    };

    const offer = await nClient.request({ op: "join.offer" }) as JoinOfferResult;
    const added = await s.join.addMachine(offer.link);
    const codePromise = s.join.code(added.attempt, offer.code);

    await entered.promise;
    nClient.close();
    await new Promise((r) => setTimeout(r, 40));
    expect(n.join.isOffer(offer.offer)).toBe(true);

    release.reject(new Error("simulated joinCluster failure"));
    const codeResult = await codePromise;
    expect(codeResult.ok).toBe(false);
    expect(n.roster.clusterId).toBeNull();
    expect(readVapidKeys(n.dir)).toBeNull();
    await until(() => !n.join.isOffer(offer.offer), { timeout: 3_000, what: "offer retired after failed welcome" });
  });

  it("closing the add-machine admin client cancels the attempt with no Add signed", async () => {
    const n = await makeNode({ withCluster: false });
    const s = await makeNode({ withCluster: true, connector: memoryConnector(() => n.join) });
    const nClient = await connectAdmin(n);
    const sClient = await connectAdmin(s);

    const offer = await nClient.request({ op: "join.offer" }) as JoinOfferResult;
    const added = await sClient.request({ op: "machine.add", link: offer.link }) as MachineAddResult;
    expect(added.server).toBe(n.identity.memberId);

    sClient.close();
    await until(() => !n.join.isOffer(offer.offer), { timeout: 3_000, what: "offer cancelled when add-machine closed" });
    expect(s.roster.statements().some((st) => st.statement.body.type === "add" && st.statement.body.member === n.identity.memberId)).toBe(false);
    expect(await s.join.code(added.attempt, offer.code)).toMatchObject({ ok: false, reason: "expired" });
  });

  it("closing the add-machine admin client while machine.code awaits join.checked (before welcome) signs no Add", async () => {
    let holdChecked = false;
    const n = await makeNode({ withCluster: false });
    const s = await makeNode({ withCluster: true, connector: memoryConnector(() => n.join, { holdFromTarget: () => holdChecked }) });
    const nClient = await connectAdmin(n);
    const sClient = await connectAdmin(s);

    const offer = await nClient.request({ op: "join.offer" }) as JoinOfferResult;
    const added = await sClient.request({ op: "machine.add", link: offer.link }) as MachineAddResult;

    holdChecked = true;
    const codeReq = sClient.request({ op: "machine.code", attempt: added.attempt, code: offer.code }) as Promise<MachineCodeResult>;
    // Wait until N processed join.code and tried to send join.checked (held), then close sClient before welcome starts.
    await new Promise((r) => setTimeout(r, 40));
    sClient.close();
    await expect(codeReq).rejects.toThrow();
    holdChecked = false;

    await until(() => !n.join.isOffer(offer.offer), { timeout: 3_000, what: "offer cancelled before welcome" });
    expect(s.roster.statements().some((st) => st.statement.body.type === "add" && st.statement.body.member === n.identity.memberId)).toBe(false);
    expect(n.roster.clusterId).toBeNull();
  });

  it("closing the add-machine admin client while S is already in welcome lets the welcome finish", async () => {
    const n = await makeNode({ withCluster: false });
    const s = await makeNode({ withCluster: true, connector: memoryConnector(() => n.join) });
    const nClient = await connectAdmin(n);
    const sClient = await connectAdmin(s);

    const entered = deferred();
    const release = deferred();
    const origAddServer = s.roster.addServer.bind(s.roster);
    s.roster.addServer = async (...args) => {
      entered.resolve();
      await release.promise;
      return origAddServer(...args);
    };

    const offer = await nClient.request({ op: "join.offer" }) as JoinOfferResult;
    const added = await sClient.request({ op: "machine.add", link: offer.link }) as MachineAddResult;
    const codeReq = sClient.request({ op: "machine.code", attempt: added.attempt, code: offer.code });

    await entered.promise;
    sClient.close();
    await expect(codeReq).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 40));
    release.resolve();

    await until(() => n.roster.clusterId === s.roster.clusterId, { timeout: 3_000, what: "N joined after in-flight welcome" });
    await until(() => s.roster.statements().some((st) => st.statement.body.type === "add" && st.statement.body.member === s.identity.memberId && st.statement.body.by === n.identity.memberId), {
      timeout: 3_000,
      what: "S merged N's Add from join.done",
    });
  });

  it("closing one admin client does not cancel another admin client's attempt", async () => {
    const n1 = await makeNode({ withCluster: false });
    const n2 = await makeNode({ withCluster: false });
    let activeTarget: ServerJoin = n1.join;
    const s = await makeNode({ withCluster: true, connector: memoryConnector(() => activeTarget) });
    const nClient1 = await connectAdmin(n1);
    const nClient2 = await connectAdmin(n2);
    const sClient1 = await connectAdmin(s);
    const sClient2 = await connectAdmin(s);

    const offer1 = await nClient1.request({ op: "join.offer" }) as JoinOfferResult;
    const offer2 = await nClient2.request({ op: "join.offer" }) as JoinOfferResult;

    activeTarget = n1.join;
    await sClient1.request({ op: "machine.add", link: offer1.link });
    activeTarget = n2.join;
    const added2 = await sClient2.request({ op: "machine.add", link: offer2.link }) as MachineAddResult;

    sClient1.close();
    await until(() => !n1.join.isOffer(offer1.offer), { timeout: 3_000, what: "client1 offer cancelled" });
    expect(n2.join.isOffer(offer2.offer)).toBe(true);

    const res2 = await sClient2.request({ op: "machine.code", attempt: added2.attempt, code: offer2.code }) as MachineCodeResult;
    expect(res2).toMatchObject({ ok: true, server: n2.identity.memberId, cluster: s.roster.clusterId });
  });
});
