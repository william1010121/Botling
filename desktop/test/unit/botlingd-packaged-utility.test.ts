// F2 regression tests: packaged botlingd must run plugin host and PDF text jobs via utilityProcess.fork,
// never by spawning process.execPath with ELECTRON_RUN_AS_NODE=1 (RunAsNode fuse is off), without launching Electron.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamId } from "../../src/protocol";
import { Botlingd } from "../../src/server/botlingd";
import { ContentService } from "../../src/server/content";
import { ensureStream } from "../../src/server/log";
import { MediaJobs, findTools } from "../../src/server/media";
import { ToolError } from "../../src/server/media/run";
import { isPackagedElectron } from "../../src/server/packaged-electron";
import { runUtilityScript } from "../../src/server/utility-process";
import { openServerStore } from "../../src/server/store";
import { Host } from "../../../Web/host/src/host";
import { testRoot } from "../botlingd-harness";
import { makeTextPdf } from "../support/make-pdf";
import { until } from "../helpers";

interface RecordedSpawn {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
}

const spawnState = vi.hoisted(() => ({
  calls: [] as RecordedSpawn[],
  blockExecPathRunAsNode: true,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const wrappedSpawn = ((command: string, argsOrOpts?: unknown, maybeOpts?: unknown) => {
    const args = Array.isArray(argsOrOpts) ? (argsOrOpts as string[]) : [];
    const opts = (Array.isArray(argsOrOpts) ? maybeOpts : argsOrOpts) as { env?: Record<string, string | undefined> } | undefined;
    spawnState.calls.push({ command, args, env: opts?.env });
    if (
      spawnState.blockExecPathRunAsNode
      && (opts?.env?.ELECTRON_RUN_AS_NODE === "1" || command === process.execPath || args.includes(process.execPath))
    ) {
      const child = new EventEmitter() as ReturnType<typeof actual.spawn>;
      Object.assign(child, {
        pid: 999_999,
        exitCode: null,
        signalCode: null,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: () => true,
        unref: () => child,
      });
      setTimeout(() => {
        (child.stderr as PassThrough).end("blocked ELECTRON_RUN_AS_NODE spawn in test\n");
        child.emit("exit", 1, null);
        child.emit("close", 1, null);
      }, 5);
      return child;
    }
    return actual.spawn(command, argsOrOpts as readonly string[], maybeOpts as import("node:child_process").SpawnOptions);
  }) as typeof actual.spawn;
  return { ...actual, spawn: wrappedSpawn };
});

function createPairedPorts() {
  const make = () => {
    const listeners = {
      message: [] as Array<(event: { data: unknown; ports?: unknown[] }) => void>,
      close: [] as Array<() => void>,
    };
    const port: {
      other: typeof port | null;
      closed: boolean;
      postMessage(data: unknown): void;
      on(event: "message" | "close", fn: ((event: { data: unknown; ports?: unknown[] }) => void) | (() => void)): void;
      start(): void;
      close(): void;
      listeners: typeof listeners;
    } = {
      other: null,
      closed: false,
      postMessage(data: unknown) {
        const other = port.other;
        if (!port.closed && other) {
          setTimeout(() => other.listeners.message.forEach((fn) => fn({ data })), 0);
        }
      },
      on(event, fn) {
        (listeners[event] as unknown[]).push(fn);
      },
      start() {},
      close() {
        if (port.closed) return;
        port.closed = true;
        if (port.other) {
          port.other.closed = true;
          const closeFns = port.other.listeners.close;
          setTimeout(() => closeFns.forEach((fn) => fn()), 0);
        }
      },
      listeners,
    };
    return port;
  };
  const a = make();
  const b = make();
  a.other = b;
  b.other = a;
  return [a, b] as const;
}

class FakeMessageChannelMain {
  readonly port1: ReturnType<typeof createPairedPorts>[0];
  readonly port2: ReturnType<typeof createPairedPorts>[0];
  constructor() {
    const [p1, p2] = createPairedPorts();
    this.port1 = p1;
    this.port2 = p2;
  }
}

interface ForkRecord {
  modulePath: string;
  args: string[];
  options: Record<string, unknown>;
}

function createFakeUtilityProcess() {
  const forks: ForkRecord[] = [];
  let nextPid = 41_000;
  const utilityProcess = {
    fork(modulePath: string, args: string[] = [], options: Record<string, unknown> = {}) {
      forks.push({ modulePath, args, options });
      const emitter = new EventEmitter();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let pid: number | undefined;
      let exited = false;
      let hostPort: ReturnType<typeof createPairedPorts>[0] | null = null;
      const finish = (code: number) => {
        if (exited) return;
        exited = true;
        hostPort?.close();
        stdout.end();
        stderr.end();
        emitter.emit("exit", code);
      };
      const proc = Object.assign(emitter, {
        get pid() { return pid; },
        stdout,
        stderr,
        postMessage(message: { botling?: string } | null, transfer: Array<ReturnType<typeof createPairedPorts>[0]> = []) {
          if (message?.botling === "port" && transfer[0]) {
            const port = transfer[0];
            hostPort = port;
            const instance = new Host((line) => port.postMessage(JSON.stringify(line)));
            instance.onShutdown = () => finish(0);
            port.on("message", (event: { data: unknown }) => {
              if (typeof event.data === "string" && event.data.trim()) {
                void instance.receive(JSON.parse(event.data));
              }
            });
            port.on("close", () => finish(0));
            port.start();
            instance.notify("ready", { pid });
          }
        },
        kill() {
          setTimeout(() => finish(0), 0);
          return true;
        },
      });
      setTimeout(() => {
        pid = ++nextPid;
        emitter.emit("spawn");
        if (modulePath.endsWith("pdf-text.cjs")) {
          const [, outFile] = args;
          if (!outFile) {
            stderr.write("pdf-text: missing output path\n");
            finish(1);
            return;
          }
          writeFileSync(outFile, JSON.stringify({
            v: 1,
            pages: 1,
            outline: [],
            text: ["Extracted via Electron utilityProcess\n"],
          }));
          finish(0);
        }
      }, 5);
      return proc;
    },
  };
  return { utilityProcess, forks };
}

const tempRoots: string[] = [];
const socketDirs: string[] = [];
const daemons: Botlingd[] = [];
const origElectronVersion = Object.getOwnPropertyDescriptor(process.versions, "electron");

function tempDir(prefix: string): string {
  const dir = testRoot(prefix);
  tempRoots.push(dir);
  return dir;
}

function setElectronVersion(value: string | undefined) {
  if (value === undefined) {
    if (origElectronVersion) Object.defineProperty(process.versions, "electron", origElectronVersion);
    else delete (process.versions as Record<string, string | undefined>).electron;
    return;
  }
  Object.defineProperty(process.versions, "electron", { value, configurable: true, writable: true });
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  setElectronVersion(undefined);
  spawnState.calls = [];
  spawnState.blockExecPathRunAsNode = true;
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
  while (socketDirs.length) rmSync(socketDirs.pop()!, { recursive: true, force: true });
});

function setupOutDir(outDir: string): void {
  mkdirSync(join(outDir, "host"), { recursive: true });
  mkdirSync(join(outDir, "server"), { recursive: true });
  writeFileSync(join(outDir, "host", "host-utility.mjs"), "// built utility host marker\n");
  writeFileSync(join(outDir, "host", "host.mjs"), "// built node host marker\n");
  writeFileSync(join(outDir, "server", "pdf-text.cjs"), "// built pdf-text marker\n");
  const echoDir = join(outDir, "builtin-plugins", "echo");
  mkdirSync(echoDir, { recursive: true });
  writeFileSync(join(echoDir, "package.json"), JSON.stringify({
    name: "echo",
    version: "1.0.0",
    engines: { ccb: "^2.0.0" },
    ccb: {
      host: "host.mjs",
      contributes: { commands: [{ id: "echo.ping", title: "Ping" }] },
    },
  }));
  writeFileSync(join(echoDir, "host.mjs"), `export function activate(ccb) { ccb.commands.register("echo.ping", () => "pong-from-utility"); }\n`);
}

function readDbRows(dataDir: string, sql: string, ...params: Array<string | number>) {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(join(dataDir, "server.db"), { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe("F2: packaged botlingd never spawns process.execPath with ELECTRON_RUN_AS_NODE", () => {
  it("runs both plugin host and PDF text jobs through utilityProcess.fork when packaged", async () => {
    setElectronVersion("35.0.0");
    const root = tempDir("botlingd-pkg-f2");
    const sockDir = mkdtempSync("/tmp/b3u-");
    socketDirs.push(sockDir);
    const dataDir = join(root, "data");
    const outDir = join(root, "out");
    setupOutDir(outDir);
    const pdfFile = join(root, "sample.pdf");
    makeTextPdf(pdfFile, 1, { figure: 0 });

    const fakeUtility = createFakeUtilityProcess();
    const daemon = await Botlingd.start({
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: root,
        BOTLING_SERVER_DATA_DIR: dataDir,
        BOTLING_SERVER_SOCKET: join(sockDir, "d.sock"),
        BOTLING_SERVER_PORT: "off",
        BOTLING_NODE_PATH: "/tmp/must-be-ignored-when-packaged",
      },
      outDir,
      packaged: true,
      electronUtility: {
        utilityProcess: fakeUtility.utilityProcess as any,
        MessageChannelMain: FakeMessageChannelMain as any,
      },
    } as any);
    daemons.push(daemon);

    // 1) Plugin host started via utilityProcess.fork(host-utility.mjs), never plainHostNode.
    await until(() => daemon.core.plugins.host.running && daemon.core.plugins.host.commands.includes("echo.ping"), {
      what: "packaged utility plugin host ready",
    });
    expect(await daemon.core.plugins.host.command("echo.ping")).toBe("pong-from-utility");
    expect(fakeUtility.forks.some((f) => f.modulePath === join(outDir, "host", "host-utility.mjs"))).toBe(true);

    // 2) PDF text job started via utilityProcess.fork(pdf-text.cjs), never runTool(process.execPath, { ELECTRON_RUN_AS_NODE: "1" }).
    const stream = "bot:main" as StreamId;
    await daemon.store.submit((db) => ensureStream(db, stream));
    const text = `![sample](${pathToFileURL(pdfFile).href})`;
    const message = { id: "m1", role: "bot", text, time: "2026-11-15T00:00:00.000Z", state: "done" };
    const { ready } = await daemon.content.appendLine(stream, "main", { id: "m1", text }, [{ kind: "message.added", body: { botId: "main", message } }]);
    await ready;
    await daemon.media!.idle();

    const textVariant = readDbRows(dataDir, "SELECT id, path, state FROM variants WHERE variant = 'text'")[0];
    expect(textVariant?.state).toBe("ready");
    expect(JSON.parse(readFileSync(String(textVariant!.path), "utf8"))).toMatchObject({
      v: 1,
      pages: 1,
      text: ["Extracted via Electron utilityProcess\n"],
    });
    const pdfFork = fakeUtility.forks.find((f) => f.modulePath.endsWith("pdf-text.cjs"));
    expect(pdfFork).toBeDefined();
    expect(pdfFork!.args[0]).toContain(join(dataDir, "content", "pins"));
    expect(pdfFork!.args[1]).toContain(join(dataDir, "variants", ".tmp"));
    expect((pdfFork!.options.env as Record<string, string | undefined>)?.ELECTRON_RUN_AS_NODE).toBeUndefined();

    // 3) Neither plugin host nor PDF text spawned process.execPath or ELECTRON_RUN_AS_NODE=1.
    const badSpawns = spawnState.calls.filter((call) =>
      call.env?.ELECTRON_RUN_AS_NODE === "1"
      || call.command === process.execPath
      || call.args.includes(process.execPath),
    );
    expect(badSpawns).toEqual([]);
  }, 30_000);

  it("unpackaged dev Botlingd keeps plainHostNode rather than utilityProcess.fork", async () => {
    setElectronVersion("35.0.0");
    const root = tempDir("botlingd-dev-f2");
    const sockDir = mkdtempSync("/tmp/b3d-");
    socketDirs.push(sockDir);
    const dataDir = join(root, "data");
    const outDir = join(root, "out");
    setupOutDir(outDir);

    const fakeUtility = createFakeUtilityProcess();
    const daemon = await Botlingd.start({
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: root,
        BOTLING_SERVER_DATA_DIR: dataDir,
        BOTLING_SERVER_SOCKET: join(sockDir, "d.sock"),
        BOTLING_SERVER_PORT: "off",
        BOTLING_NODE_PATH: process.execPath,
      },
      outDir,
      packaged: false,
      electronUtility: {
        utilityProcess: fakeUtility.utilityProcess as any,
        MessageChannelMain: FakeMessageChannelMain as any,
      },
    } as any);
    daemons.push(daemon);

    await until(() => spawnState.calls.some((call) => call.args.some((arg) => arg.endsWith("host.mjs"))), {
      what: "dev plugin host spawn via plainHostNode",
    });
    expect(fakeUtility.forks).toEqual([]);
  }, 30_000);

  it("MediaJobs with packaged: true never falls back to process.execPath + ELECTRON_RUN_AS_NODE even without pdfTextRunner", async () => {
    const root = tempDir("media-pkg-f2");
    const dataDir = join(root, "data");
    const pdfFile = join(root, "sample.pdf");
    makeTextPdf(pdfFile, 1, { figure: 0 });
    const fakeScript = join(root, "pdf-text.cjs");
    writeFileSync(fakeScript, "// marker\n");

    const store = await openServerStore(dataDir);
    const stream = "bot:pdf" as StreamId;
    await store.submit((db) => ensureStream(db, stream));
    const content = new ContentService({ store, dataDir, serverId: store.meta("serverId")! });
    const media = new MediaJobs({
      store,
      dataDir,
      tools: findTools({ path: "/usr/bin:/bin:/usr/sbin:/sbin", platform: "linux" }),
      pdfTextScript: fakeScript,
      packaged: true,
    } as any);
    content.attachMedia(media);
    try {
      await content.recover();
      await media.start();
      const text = `![doc](${pathToFileURL(pdfFile).href})`;
      const message = { id: "m1", role: "bot", text, time: "2026-11-15T00:00:00.000Z", state: "done" };
      const { ready } = await content.appendLine(stream, "pdf", { id: "m1", text }, [{ kind: "message.added", body: { botId: "pdf", message } }]);
      await ready;
      await media.idle();

      const badSpawns = spawnState.calls.filter((call) =>
        call.env?.ELECTRON_RUN_AS_NODE === "1"
        || call.command === process.execPath
        || call.args.includes(process.execPath),
      );
      expect(badSpawns).toEqual([]);
    } finally {
      await media.close();
      await content.close();
      await store.close();
    }
  });
});

describe("F1 utility-process runner & F3 shared packaged helper", () => {
  it("runUtilityScript rejects with ToolError on non-zero exit and timeout without passing ELECTRON_RUN_AS_NODE", async () => {
    const seenEnvs: Array<Record<string, string>> = [];
    const failingUtility = {
      fork(_script: string, _args: string[] = [], options: Record<string, unknown> = {}) {
        seenEnvs.push((options.env ?? {}) as Record<string, string>);
        const emitter = new EventEmitter();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const proc = Object.assign(emitter, {
          pid: 1234,
          stdout,
          stderr,
          postMessage() {},
          kill: () => true,
        });
        setTimeout(() => {
          stderr.write("pdf-text: corrupt header\n");
          stdout.end();
          stderr.end();
          emitter.emit("exit", 1);
        }, 5);
        return proc;
      },
    };
    await expect(runUtilityScript(failingUtility as any, "/app.asar/out/server/pdf-text.cjs", ["a.pdf", "out.json"], { timeoutMs: 5_000 }))
      .rejects.toBeInstanceOf(ToolError);
    expect(seenEnvs[0]?.ELECTRON_RUN_AS_NODE).toBeUndefined();

    const hangingUtility = {
      fork() {
        const emitter = new EventEmitter();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const proc = Object.assign(emitter, {
          pid: 1235,
          stdout,
          stderr,
          postMessage() {},
          kill() {
            setTimeout(() => { stdout.end(); stderr.end(); emitter.emit("exit", 1); }, 5);
            return true;
          },
        });
        return proc;
      },
    };
    await expect(runUtilityScript(hangingUtility as any, "/app.asar/out/server/pdf-text.cjs", ["a.pdf", "out.json"], { timeoutMs: 25 }))
      .rejects.toMatchObject({ name: "ToolError", run: { signal: "SIGKILL" } });
  });

  it("isPackagedElectron detects packaged Electron apps and rejects non-Electron / unpackaged contexts", () => {
    expect(isPackagedElectron(undefined)).toBe(false);
    expect(isPackagedElectron({ app: { isPackaged: false } })).toBe(false);
    expect(isPackagedElectron({ app: { isPackaged: true } })).toBe(true);
  });
});
