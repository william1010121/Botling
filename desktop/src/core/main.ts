import { startConfiguredMobile } from '../mobile-bridge/start';
import { startRelay } from '../mobile-relay/start';
// The core process entry. Under Electron it runs as a utility process and talks over
// `process.parentPort`; under plain Node (tests, a headless core) it talks JSON lines on stdio,
// like the existing plugin host. The Core's options come from core-process.ts, shared with Botling 3's server.
import { join, resolve } from "node:path";
import { writeSync } from "node:fs";
import { CORE_EXIT_DATA_DIR_IN_USE, DataDirLock, LOCK_CHECK_MS } from "./store/data-dir-lock";
import { createInterface } from "node:readline";
import { Core, type AppAnswer, type AppOp } from "./server";
import type { Outbound } from "../contract";
import { PortSealer, testSealer, type Sealer } from "./plugins/secrets";
import type { HostCommand } from "./plugins/host-client";
import { UtilityHostLauncher, type PortLike } from "./plugins/utility-host";
import { StartupMarks } from "../startup-marks";
import { coreProcessOptions, envNumber as number, plainHostNode } from "./core-process";

const dataDir = resolve(process.env.BOTLING_DATA_DIR ?? join(process.cwd(), ".data"));
type ParentPort = { postMessage(message: unknown): void; on(event: "message", fn: (event: { data: unknown; ports?: PortLike[] }) => void): void };
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

const emit: (message: Outbound) => void = parentPort
  ? (message) => parentPort.postMessage(message)
  : (message) => process.stdout.write(JSON.stringify(message) + "\n");
const log = (line: string) => process.stderr.write(`[core] ${line}\n`);

// One core per data folder (store/data-dir-lock.ts), taken before any store is read. Another core
// that owns it: this one exits untouched, and main does not restart it. A core that finds its folder
// owned by another one later (the folder was swapped out under it) stops at once, writing nothing more.
const dataLock = new DataDirLock(dataDir, { version: process.env.BOTLING_APP_VERSION, app: process.env.BOTLING_APP_PATH });
{
  // A core that is still on its way out (the app restarting, an install, a core swapped out under it)
  // lets go within moments: wait that long before saying the folder is taken.
  const checkMs = number(process.env.BOTLING_DATA_LOCK_CHECK_MS, LOCK_CHECK_MS);
  const waitUntil = Date.now() + number(process.env.BOTLING_DATA_LOCK_WAIT_MS, Math.max(10_000, 2 * checkMs + 1_000));
  let claim = dataLock.claim();
  while (!claim.ok && Date.now() < waitUntil) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    claim = dataLock.claim();
  }
  if (!claim.ok) {
    const { pid, version, app } = claim.holder;
    writeSync(2, `[core] another Botling core (pid ${pid}${version ? `, version ${version}` : ""}${app ? `, from ${app}` : ""}) already uses this data folder (${dataDir}); not starting a second one\n`);
    process.exit(CORE_EXIT_DATA_DIR_IN_USE);
  }
  // However this core ends (a clean quit, a failed shutdown, an uncaught error), the folder is given
  // back; a crash or kill leaves a stale lock the next core breaks.
  process.on("exit", () => dataLock.release());
  setInterval(() => {
    if (dataLock.owns()) return;
    writeSync(2, `[core] another Botling core now owns this data folder (${dataDir}); stopping without writing\n`);
    process.exit(CORE_EXIT_DATA_DIR_IN_USE);
  }, checkMs).unref();
}

/**
 * Node for the plugin host: BOTLING_NODE_PATH, else the Node this core runs on — under Electron that is
 * Electron itself run as Node (development; packaged builds turn that fuse off, see the README's gaps).
 */
const utilityHost = parentPort && process.versions.electron && !process.env.BOTLING_NODE_PATH && process.env.BOTLING_PLUGIN_HOST !== "node"
  ? new UtilityHostLauncher(parentPort) : null;

function hostNode(): HostCommand | null {
  if (process.env.BOTLING_NODE_PATH) return { command: process.env.BOTLING_NODE_PATH };
  // Under Electron (development and packaged): main runs the host as a utility process.
  if (utilityHost) return { command: "", launch: utilityHost.launch };
  return plainHostNode(process.env);
}

/** Plugins' secrets are sealed by main (Electron safeStorage); a headless core has none unless a test gives a key. */
const portSealer = parentPort ? new PortSealer((message) => parentPort.postMessage(message)) : null;

/**
 * Developer mode's and updates' requests of main (self-update.ts): a picture of the window, quitting for
 * a build's install, or installing the newer release (main restarts on it).
 * `{botling: "app"}` out, `{botling: "appDone"}` back. Only under Electron, where main is there to answer.
 */
const appAnswers = new Map<number, (answer: { ok: boolean; file?: string; error?: string }) => void>();
let appAsks = 0;
const appBridge = parentPort ? {
  pid: Number(process.env.BOTLING_MAIN_PID) || null,
  dataDir: process.env.BOTLING_APP_DATA_DIR || null,
  bundle: process.env.BOTLING_APP_BUNDLE || null,
  request: (op: AppOp, args?: Record<string, string>) => new Promise<AppAnswer>((resolve) => {
    const id = ++appAsks;
    // Installing a release downloads and verifies it first (main/updates.ts), which can take minutes.
    const timer = setTimeout(() => { appAnswers.delete(id); resolve({ ok: false, error: "Main did not answer." }); }, op === "installRelease" ? 20 * 60_000 : 30_000);
    timer.unref?.();
    appAnswers.set(id, (answer) => { clearTimeout(timer); appAnswers.delete(id); resolve(answer); });
    parentPort.postMessage({ botling: "app", id, op, ...(args ? { args } : {}) });
  }),
} : null;
const sealer: Sealer | null = portSealer ?? (process.env.BOTLING_TEST_SEAL_KEY ? testSealer(process.env.BOTLING_TEST_SEAL_KEY) : null);
const core = new Core(coreProcessOptions({
  env: process.env, dataDir, outDir: join(__dirname, ".."), emit, log, node: hostNode(), sealer, app: appBridge,
}));
// Disabled by default. Configuration and bind failures never terminate the desktop core.
try {
  startConfiguredMobile(core, dataDir, () => log('mobile bridge unavailable: check local TLS/bind configuration'), desk => core.attachMobile(desk));
} catch { log('mobile bridge disabled: invalid local configuration'); }
// The phone relay (Settings › Phone): connects out only once the user gave it an address.
try { const relay = startRelay(core, dataDir); if (relay) core.attachRelay(relay); }
catch { log('phone relay disabled: unreadable relay settings'); }

log(`started epoch ${core.epoch} data ${dataDir} agent ${process.env.BOTLING_AGENT ?? "fake"}`);
// Main's startup log (src/startup-marks.ts): how long after this process began its bots and chats were loaded.
if (process.env.BOTLING_STARTUP_LOG) new StartupMarks({ file: process.env.BOTLING_STARTUP_LOG }).mark("core.loaded");

/**
 * A core hot swap : `{botling: "drain", id, timeoutMs, boundaryMs}` stops beginning turns and
 * waits for those under way, then answers `{botling: "drained", id, ok, …}`; `{botling: "undrain"}` calls it off.
 */
function swapControl(data: { botling?: unknown; id?: unknown; timeoutMs?: unknown; boundaryMs?: unknown }, reply: (message: unknown) => void): boolean {
  if(data.botling === "prepareRestart" || data.botling === "cancelRestart") {
    try{
      if(data.botling === "prepareRestart"){
        const quit=(data as {onlyIfBusy?:unknown}).onlyIfBusy===true;
        const armed=quit?core.prepareQuitContinuation():(core.prepareRestart(),true);
        reply({botling:"drained",id:data.id,ok:true,armed});
      }else{core.cancelRestart();reply({botling:"drained",id:data.id,ok:true});}
    }
    catch(error){reply({botling:"drained",id:data.id,ok:false,error:String(error)});}
    return true;
  }
  // Main's quit: the whole shutdown runs to its end (the restart checkpoint's `ready` last) and the core exits itself.
  // A SIGTERM from `utilityProcess.kill()` is cut off by Electron after about 2 s, too short for that.
  if (data.botling === "quit") { quit(); return true; }
  if (data.botling === "undrain") { core.cancelSwap(); return true; }
  if (data.botling !== "drain") return false;
  const ms = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 30 * 60_000) : fallback);
  void core.drainForSwap(ms(data.timeoutMs, 120_000), ms(data.boundaryMs, 30_000)).then(
    (result) => reply({ botling: "drained", id: data.id, ok: true, ...result }),
    (error) => reply({ botling: "drained", id: data.id, ok: false, error: String((error as Error)?.message ?? error).slice(0, 500) }),
  );
  return true;
}

if (parentPort) {
  parentPort.on("message", (event) => {
    // Main's answer to a seal/open request (safeStorage), never a contract message.
    const data = event.data as { botling?: unknown } | null;
    if (data && typeof data === "object" && swapControl(data, (message) => parentPort.postMessage(message))) return;
    if (data && typeof data === "object" && data.botling === "sealed") portSealer?.answer(data as Parameters<PortSealer["answer"]>[0]);
    else if (data && typeof data === "object" && data.botling === "appDone") {
      const answer = data as { id?: unknown; ok?: unknown; file?: unknown; error?: unknown; plan?: unknown; data?: unknown };
      if (typeof answer.id === "number") appAnswers.get(answer.id)?.({ ok: answer.ok === true, ...(typeof answer.file === "string" ? { file: answer.file } : {}), ...(typeof answer.error === "string" ? { error: answer.error } : {}), ...(answer.plan !== undefined ? { plan: answer.plan } : {}), ...(answer.data !== undefined ? { data: answer.data } : {}) });
    }
    else if (data && typeof data === "object" && data.botling === "release") {
      // Main found a newer release (main/updates.ts): an update notice in the main bot's chat (self-update.ts).
      const release = data as { version?: unknown; name?: unknown; url?: unknown; current?: unknown; unavailable?: unknown };
      const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
      if (typeof release.version === "string" && typeof release.url === "string" && release.url.startsWith("https://github.com/")) {
        try {
          core.releases.announce({
            version: text(release.version, 100), name: text(release.name, 400) || text(release.version, 100), url: text(release.url, 2_000),
            current: text(release.current, 100), unavailable: typeof release.unavailable === "string" ? release.unavailable.slice(0, 500) : null,
          });
        } catch (error) { process.stderr.write(`release notice: ${(error as Error).message}\n`); }
      }
    }
    else if (data && typeof data === "object" && typeof data.botling === "string" && data.botling.startsWith("host")) utilityHost?.receive(data, event.ports ?? []);
    else core.receive(event.data);
  });
} else {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      log("refused: a line that is not JSON");
      return;
    }
    if (value && typeof value === "object" && swapControl(value as { botling?: unknown }, (message) => process.stdout.write(JSON.stringify(message) + "\n"))) return;
    core.receive(value);
  });
  lines.on("close", () => quit());
}

let quitting = false;
const quit = () => {
  if (quitting) return;
  quitting = true;
  void core.shutdown().then(
    () => process.exit(0),
    error => {
      try { process.stderr.write(`core shutdown failed: ${String(error)}${error?.cause ? `; cause: ${String(error.cause)}` : ""}\n`); }
      finally { process.exit(1); }
    },
  );
};
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
