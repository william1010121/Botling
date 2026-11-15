// M5-07c: fetch git repositories as git bundles (`what: { kind: "git", path }`).
// Temp directories only; skips with a clear message if `git` is not on PATH.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeWireFrame, encodeChunkFrame, encodeWireFrame, type WireMessage } from "../../src/protocol";
import { FetchRequester, incomingDirName, type FetchPeer } from "../../src/server/fetch/requester";
import { FetchSource, type FetchAskHook, type FetchSink } from "../../src/server/fetch/source";
import { bindServerIdentity, loadOrCreateServerIdentity } from "../../src/server/identity";
import { RosterStore } from "../../src/server/roster";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { makeCluster, readServerKeys, writeStatements } from "../support/peer-cluster";

const realpath = realpathSync.native ?? realpathSync;
const PEER = { local: false } as const;
const MiB = 1024 * 1024;
const SOURCE_NAME = "build-box";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
if (!hasGit) {
  console.info("M5-07c fetch-git tests skipped: `git` executable not found on PATH");
}

function gitSync(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function initTwoCommitRepo(repoDir: string, options: { largeFileBytes?: number } = {}): { commit1: string; commit2: string } {
  mkdirSync(repoDir, { recursive: true });
  gitSync(repoDir, ["init"]);
  gitSync(repoDir, ["config", "user.email", "bot@example.test"]);
  gitSync(repoDir, ["config", "user.name", "Bot Test"]);

  writeFileSync(join(repoDir, "README.md"), "first commit\n");
  gitSync(repoDir, ["add", "README.md"]);
  gitSync(repoDir, ["commit", "-m", "first commit"]);
  const commit1 = gitSync(repoDir, ["rev-parse", "HEAD"]).trim();

  let secondBody: string | Buffer = "second commit\n";
  if (options.largeFileBytes) {
    const buf = Buffer.alloc(options.largeFileBytes);
    let block = createHash("sha256").update("fetch-git-large-seed").digest();
    for (let at = 0; at < buf.length; at += 32) {
      block.copy(buf, at);
      block = createHash("sha256").update(block).digest();
    }
    secondBody = buf;
  }
  writeFileSync(join(repoDir, "notes.txt"), secondBody);
  gitSync(repoDir, ["add", "notes.txt"]);
  gitSync(repoDir, ["commit", "-m", "second commit"]);
  const commit2 = gitSync(repoDir, ["rev-parse", "HEAD"]).trim();

  return { commit1, commit2 };
}

async function setup(options: {
  ask?: FetchAskHook;
  onChunk?: (fetchId: string, index: number) => void | Promise<void>;
  holdFirstDeliver?: boolean;
} = {}) {
  const root = realpath(mkdtempSync(join(tmpdir(), "botling-fetch-git-")));
  const dataA = join(root, "data-a");
  const dataB = join(root, "data-b");
  const folderA = join(root, "bots", "bot-a");
  const folderB = join(root, "bots", "bot-b");
  const artifactsA = join(folderA, ".bot", "artifacts");
  const bundleTmpDir = join(root, "source-tmp");
  for (const dir of [dataA, dataB, artifactsA, folderB, bundleTmpDir]) mkdirSync(dir, { recursive: true });

  const storeA0 = await openServerStore(dataA);
  const storeB0 = await openServerStore(dataB);
  const idA = await loadOrCreateServerIdentity(dataA, { create: true });
  const idB = await loadOrCreateServerIdentity(dataB, { create: true });
  await storeA0.submit((tx) => bindServerIdentity(tx, idA));
  await storeB0.submit((tx) => bindServerIdentity(tx, idB));
  const ka = await readServerKeys(dataA);
  const kb = await readServerKeys(dataB);
  const cluster = await makeCluster([ka, kb]);
  await storeA0.close();
  await storeB0.close();
  writeStatements(dataA, cluster.clusterId, cluster.statements);
  writeStatements(dataB, cluster.clusterId, cluster.statements);

  const storeA = await openServerStore(dataA);
  const storeB: ServerStore = await openServerStore(dataB);
  const rosterA = await RosterStore.open(storeA, idA);
  const readerA = storeA.openReader();
  const readerB = storeB.openReader();
  await storeA.submit((tx) => {
    tx.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, 1, ?, 0)")
      .run(`srv:${kb.memberId}`, "bot:bot-b", JSON.stringify({ name: "B Bot" }));
  });

  const source = new FetchSource({
    self: ka.memberId,
    dataDir: dataA,
    store: storeA,
    reader: () => readerA,
    roster: rosterA,
    botFolders: () => new Map([["bot-a", folderA]]),
    bundleTmpDir,
    ...(options.ask ? { ask: options.ask } : {}),
    ...(options.onChunk ? { onChunk: options.onChunk } : {}),
  });

  const delivered: WireMessage[] = [];
  let current: (FetchPeer & { open: boolean }) | null = null;
  let sinkA: (FetchSink & { open: boolean }) | null = null;

  const requester = new FetchRequester({
    store: storeB,
    session: (member) => (current && current.open && member === ka.memberId ? current : null),
    botFolder: (botId) => (botId === "bot-b" ? folderB : null),
    serverName: (member) => (member === ka.memberId ? SOURCE_NAME : null),
  });

  const roundTrip = (message: WireMessage): WireMessage => {
    if (message.t === "fetch.chunk") {
      const encoded = encodeChunkFrame(message, "peer", PEER);
      if (!encoded.ok) throw new Error(`chunk refused by codec: ${encoded.detail}`);
      const decoded = decodeWireFrame(encoded.bytes, "peer", PEER);
      if (!decoded.ok) throw new Error(decoded.detail);
      return decoded.message;
    }
    const encoded = encodeWireFrame(message, "peer", PEER);
    if (!encoded.ok) throw new Error(`frame refused by codec: ${encoded.detail}`);
    const decoded = decodeWireFrame(encoded.text, "peer", PEER);
    if (!decoded.ok) throw new Error(decoded.detail);
    return decoded.message;
  };

  const connect = () => {
    const req: FetchPeer & { open: boolean } = {
      peer: ka.memberId,
      open: true,
      get state() { return this.open ? "open" : "closed"; },
      sendWire: (message) => {
        if (!req.open) return false;
        const wire = roundTrip(message);
        const target = sinkA!;
        setImmediate(() => { if (target.open) source.onMessage(target, wire); });
        return true;
      },
    };
    const deliver = (message: WireMessage): boolean => {
      if (!sink.open) return false;
      const wire = roundTrip(message);
      setImmediate(() => {
        if (!sink.open || !req.open) return;
        delivered.push(wire);
        requester.onMessage(req, wire);
      });
      return true;
    };
    const sink: FetchSink & { open: boolean } = {
      peer: kb.memberId,
      open: true,
      queuedBytes: 0,
      transport: "tailnet",
      get state() { return this.open ? "open" : "closed"; },
      sendWire: deliver,
      sendChunk: deliver,
    };
    current = req;
    sinkA = sink;
    return { req, sink };
  };

  const drop = () => {
    const req = current;
    const sink = sinkA;
    if (!req || !sink) return;
    req.open = false;
    sink.open = false;
    source.sessionClosed(sink);
    requester.sessionClosed(req);
    current = null;
  };

  const reconnect = () => {
    const { req } = connect();
    requester.sessionOpened(req);
  };

  connect();

  return {
    root,
    dataA,
    folderA,
    folderB,
    artifactsA,
    bundleTmpDir,
    ka,
    kb,
    storeA,
    storeB,
    readerA,
    readerB,
    source,
    requester,
    delivered,
    drop,
    reconnect,
    sink: () => sinkA,
    cleanup: async () => {
      requester.close();
      await requester.flushed();
      source.close();
      await source.flushed();
      readerA.close();
      readerB.close();
      await storeA.close();
      await storeB.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(!hasGit)("M5-07c: fetch git repositories as git bundles", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it("1. bundle arrives as <repo>.bundle and `git clone` gives both commits + audit rows on both servers", async () => {
    const env = await setup({ ask: async () => "once" });
    cleanups.push(env.cleanup);

    const repoDir = join(env.root, "project-alpha");
    // > 64 KiB so the bundle exercises multi-chunk framing and manifest reassembly.
    const { commit1, commit2 } = initTwoCommitRepo(repoDir, { largeFileBytes: 150 * 1024 });

    const res = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "git", path: repoDir }, "clone repo", 10 * MiB);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.files).toBe(1);
    expect(res.dest).toBe(`.bot/incoming/${incomingDirName(SOURCE_NAME, env.ka.memberId)}/${res.fetchId}`);
    const bundlePath = join(res.absDest, "project-alpha.bundle");
    expect(existsSync(bundlePath)).toBe(true);

    const clonedDir = join(env.root, "cloned-alpha");
    execFileSync("git", ["clone", bundlePath, clonedDir], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const log = gitSync(clonedDir, ["log", "--format=%H"]).trim().split("\n");
    expect(log).toEqual([commit2, commit1]);
    expect(readFileSync(join(clonedDir, "README.md"), "utf8")).toBe("first commit\n");

    const serveAudit = env.readerA.prepare("SELECT body FROM rows WHERE stream = ? AND key = ?")
      .get(`srv:${env.ka.memberId}`, `audit:${res.fetchId}`) as { body: string } | undefined;
    expect(serveAudit).toBeDefined();
    expect(JSON.parse(serveAudit!.body)).toMatchObject({ act: "fetch.serve", member: "bot-b", size: res.bytes, hash: res.manifest });

    const recvAudit = env.readerB.prepare("SELECT body FROM rows WHERE stream = ? AND key = ?")
      .get(`srv:${env.kb.memberId}`, `audit:${res.fetchId}`) as { body: string } | undefined;
    expect(recvAudit).toBeDefined();
    expect(JSON.parse(recvAudit!.body)).toMatchObject({ act: "fetch.receive", member: "bot-b", size: res.bytes, hash: res.manifest });

    const grantRow = env.readerA.prepare("SELECT revokedAt FROM grants WHERE fetchId = ?").get(res.fetchId) as { revokedAt: number | null };
    expect(grantRow.revokedAt).not.toBeNull();
  });

  it("2. non-repository directory, regular file, and repo subdirectory -> fetch.denied{gone} with detail 'not a git repository'", async () => {
    const env = await setup({ ask: async () => "once" });
    cleanups.push(env.cleanup);

    const notRepo = join(env.root, "plain-dir");
    mkdirSync(notRepo, { recursive: true });
    writeFileSync(join(notRepo, "file.txt"), "not git\n");

    const resDir = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "git", path: notRepo }, "check dir", 10 * MiB);
    expect(resDir).toMatchObject({ ok: false, reason: "gone", detail: "not a git repository" });

    const plainFile = join(env.root, "plain-file.txt");
    writeFileSync(plainFile, "just a file\n");
    const resFile = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "git", path: plainFile }, "check file", 10 * MiB);
    expect(resFile).toMatchObject({ ok: false, reason: "gone", detail: "not a git repository" });

    // A subdirectory inside a git repo must not walk up to bundle the parent repo.
    const parentRepo = join(env.root, "parent-repo");
    initTwoCommitRepo(parentRepo);
    const subDir = join(parentRepo, "sub");
    mkdirSync(subDir, { recursive: true });
    const resSub = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "git", path: subDir }, "check subdir", 10 * MiB);
    expect(resSub).toMatchObject({ ok: false, reason: "gone", detail: "not a git repository" });

    // Failed bundle creation must leave no grant or audit rows behind.
    const grantsCount = (env.readerA.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n;
    const auditCount = (env.readerA.prepare("SELECT COUNT(*) AS n FROM rows WHERE key LIKE 'audit:%'").get() as { n: number }).n;
    expect(grantsCount).toBe(0);
    expect(auditCount).toBe(0);
    expect(readdirSync(env.bundleTmpDir)).toEqual([]);
  });

  it("3. temp bundle file is created during transfer and deleted after fetch.done and after failures", async () => {
    let seenDuringTransfer = false;
    let revokeOnFirstChunk = false;
    let envRef!: Awaited<ReturnType<typeof setup>>;

    const env = await setup({
      ask: async () => "once",
      onChunk: async (fetchId, index) => {
        if (index === 0) {
          const entries = readdirSync(envRef.bundleTmpDir);
          if (entries.length === 1 && existsSync(join(envRef.bundleTmpDir, entries[0]!, "repo.bundle"))) {
            seenDuringTransfer = true;
          }
        }
        if (revokeOnFirstChunk && index === 0) {
          await envRef.storeA.submit((tx) => {
            tx.prepare("UPDATE grants SET revokedAt = ? WHERE fetchId = ?").run(Date.now(), fetchId);
          });
        }
      },
    });
    envRef = env;
    cleanups.push(env.cleanup);

    const repoDir = join(env.root, "bundle-life");
    initTwoCommitRepo(repoDir, { largeFileBytes: 200 * 1024 });

    // 3a: normal completion cleans temp bundle
    const okRes = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "git", path: repoDir }, "success", 10 * MiB);
    expect(okRes.ok).toBe(true);
    if (okRes.ok) expect(okRes.bytes).toBeGreaterThan(128 * 1024);
    expect(seenDuringTransfer).toBe(true);
    await env.source.flushed();
    expect(readdirSync(env.bundleTmpDir)).toEqual([]);

    // 3b: failure via maxBytes limit cleans temp bundle
    const limitRes = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "git", path: repoDir }, "too small", 1024);
    expect(limitRes).toMatchObject({ ok: false, reason: "limit" });
    await env.source.flushed();
    expect(readdirSync(env.bundleTmpDir)).toEqual([]);

    // 3c: failure via mid-stream grant revocation cleans temp bundle
    revokeOnFirstChunk = true;
    const revokedRes = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "git", path: repoDir }, "revoked mid-stream", 10 * MiB);
    expect(revokedRes).toMatchObject({ ok: false, reason: "revoked" });
    await env.source.flushed();
    expect(readdirSync(env.bundleTmpDir)).toEqual([]);
  });

  it("4. enforces the same grant, deny-list, and symlink/.git containment checks as files", async () => {
    const askCalls: string[] = [];
    let allow = false;
    const env = await setup({
      ask: async (req) => {
        askCalls.push(req.realPath);
        return allow ? "always" : "deny";
      },
    });
    cleanups.push(env.cleanup);

    const repoOutside = join(env.root, "asked-repo");
    initTwoCommitRepo(repoOutside);

    // 4a: ask hook denies -> fetch.denied{denied}
    const denied = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "git", path: repoOutside }, "need ask", 10 * MiB);
    expect(denied).toMatchObject({ ok: false, reason: "denied" });
    expect(askCalls).toEqual([repoOutside]);

    // 4b: ask hook grants "always" -> second fetch does not re-ask
    allow = true;
    const first = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "git", path: repoOutside }, "grant always", 10 * MiB);
    expect(first.ok).toBe(true);
    expect(askCalls).toHaveLength(2);
    const second = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "git", path: repoOutside }, "reuse always", 10 * MiB);
    expect(second.ok).toBe(true);
    expect(askCalls).toHaveLength(2);

    // 4c: repo inside bot's .bot/artifacts is free (does not call askHook)
    const artifactRepo = join(env.artifactsA, "free-repo");
    initTwoCommitRepo(artifactRepo);
    const freeRes = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "git", path: artifactRepo }, "free artifact repo", 10 * MiB);
    expect(freeRes.ok).toBe(true);
    expect(askCalls).toHaveLength(2);

    // 4d: deny-list (.ssh or dataDir) -> fetch.denied{deny-list} without calling askHook
    const sshRepo = join(env.root, ".ssh", "keys-repo");
    initTwoCommitRepo(sshRepo);
    const denySsh = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "git", path: sshRepo }, "ssh repo", 10 * MiB);
    expect(denySsh).toMatchObject({ ok: false, reason: "deny-list" });
    const dataRepo = join(env.dataA, "internal-repo");
    initTwoCommitRepo(dataRepo);
    const denyData = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "git", path: dataRepo }, "dataDir repo", 10 * MiB);
    expect(denyData).toMatchObject({ ok: false, reason: "deny-list" });
    expect(askCalls).toHaveLength(2);

    // 4e: .git symlink pointing outside grantPrefix inside free artifacts -> fetch.denied{outside}
    const evilLinkRepo = join(env.artifactsA, "symlink-git-repo");
    mkdirSync(evilLinkRepo, { recursive: true });
    symlinkSync(join(repoOutside, ".git"), join(evilLinkRepo, ".git"));
    const escapeLink = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "git", path: evilLinkRepo }, "symlink escape", 10 * MiB);
    expect(escapeLink).toMatchObject({ ok: false, reason: "outside" });

    // 4f: .git gitdir file pointing outside grantPrefix -> fetch.denied{outside}
    const evilGitdirRepo = join(env.artifactsA, "gitdir-escape-repo");
    mkdirSync(evilGitdirRepo, { recursive: true });
    writeFileSync(join(evilGitdirRepo, ".git"), `gitdir: ${join(repoOutside, ".git")}\n`);
    const escapeGitdir = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "git", path: evilGitdirRepo }, "gitdir escape", 10 * MiB);
    expect(escapeGitdir).toMatchObject({ ok: false, reason: "outside" });
    expect(readdirSync(env.bundleTmpDir)).toEqual([]);
  });

  it("5. resumes after session drop mid-bundle and cloned repo has both commits", async () => {
    let droppedOnce = false;
    let envRef!: Awaited<ReturnType<typeof setup>>;
    const env = await setup({
      ask: async () => "once",
      onChunk: async (_fetchId, index) => {
        if (!droppedOnce && index === 1) {
          droppedOnce = true;
          setImmediate(() => {
            envRef.drop();
            setImmediate(() => envRef.reconnect());
          });
        }
      },
    });
    envRef = env;
    cleanups.push(env.cleanup);

    const repoDir = join(env.root, "resume-repo");
    const { commit1, commit2 } = initTwoCommitRepo(repoDir, { largeFileBytes: 220 * 1024 });

    const res = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "git", path: repoDir }, "resume git", 10 * MiB);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(droppedOnce).toBe(true);

    const bundlePath = join(res.absDest, "resume-repo.bundle");
    const clonedDir = join(env.root, "cloned-resume");
    execFileSync("git", ["clone", bundlePath, clonedDir], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    expect(gitSync(clonedDir, ["rev-list", "HEAD"]).trim().split("\n")).toEqual([commit2, commit1]);
    await env.source.flushed();
    expect(readdirSync(env.bundleTmpDir)).toEqual([]);
  });

  it("6. no shell is invoked for repo names with shell metacharacters and NFD names normalize to NFC", async () => {
    const env = await setup({ ask: async () => "once" });
    cleanups.push(env.cleanup);

    const markerName = "pwned-no-shell.txt";
    const nfdName = `cafe\u0301 $(touch ${markerName}); repo`;
    const repoDir = join(env.root, nfdName);
    const { commit1, commit2 } = initTwoCommitRepo(repoDir);

    const res = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "git", path: repoDir }, "metachars", 10 * MiB);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(existsSync(join(env.root, markerName))).toBe(false);
    expect(existsSync(join(repoDir, markerName))).toBe(false);
    const chunkFiles = env.delivered.filter((m): m is Extract<WireMessage, { t: "fetch.chunk" }> => m.t === "fetch.chunk").map((m) => m.file);
    expect(chunkFiles[0]).toBe(`${nfdName.normalize("NFC")}.bundle`);
    const bundlePath = join(res.absDest, `${nfdName.normalize("NFC")}.bundle`);
    expect(existsSync(bundlePath)).toBe(true);
    const clonedDir = join(env.root, "cloned-meta");
    execFileSync("git", ["clone", bundlePath, clonedDir], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    expect(gitSync(clonedDir, ["rev-list", "HEAD"]).trim().split("\n")).toEqual([commit2, commit1]);
  });
});
