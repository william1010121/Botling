// Electron utilityProcess.fork launchers for packaged `--botlingd` (M6-07c F1).
// With the RunAsNode fuse disabled, packaged builds cannot use `ELECTRON_RUN_AS_NODE=1` on `process.execPath`,
// so both the plugin host (`host-utility.mjs`) and one-shot Node scripts (`pdf-text.cjs`) run as utility processes.
import { basename, dirname, join } from "node:path";
import type { HostLauncher, HostProcess } from "../core/plugins/host-client";
import { PluginChildren } from "../main/plugin-children";
import type { ToolRun, RunOptions } from "./media/run";
import { ToolError } from "./media/run";
import type { ElectronPortLike, ElectronUtilityContext, ElectronUtilityProcessLike } from "./packaged-electron";

export type ScriptRunner = (script: string, args: string[], options: RunOptions) => Promise<ToolRun>;

export interface UtilityHostLauncherOptions {
  utilityProcess: ElectronUtilityContext["utilityProcess"];
  MessageChannelMain: ElectronUtilityContext["MessageChannelMain"];
  /** Explicit utility host bundle (`out/host/host-utility.mjs`); derived beside `script` when omitted. */
  utilityScript?: string;
  ledgerFile?: string;
  log?: (text: string) => void;
}

function stripElectronEnv(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !key.startsWith("ELECTRON_")) out[key] = value;
  }
  return out;
}

export function createUtilityHostLauncher(options: UtilityHostLauncherOptions): {
  launch: HostLauncher;
  shutdown: () => Promise<void>;
} {
  let nextId = 0;
  const hosts = new Map<number, ElectronUtilityProcessLike>();
  const hostPids = () => [...hosts.values()].map((host) => host.pid ?? -1).filter((pid) => pid > 0);
  const pluginChildren = new PluginChildren({
    ...(options.ledgerFile ? { ledgerFile: options.ledgerFile } : {}),
    protectedPids: () => [process.pid, ...hostPids()],
    log: options.log,
  });

  const launch: HostLauncher = (script, cwd, env, handlers) => {
    const id = ++nextId;
    const targetScript = options.utilityScript ?? join(dirname(script), "host-utility.mjs");
    const cleanEnv = stripElectronEnv(env);
    let port: ElectronPortLike | null = null;
    const queued: string[] = [];
    let pid = 0;
    let exited = false;
    let killed = false;
    let resolveGone!: () => void;
    const gone = new Promise<void>((resolve) => { resolveGone = resolve; });

    let child: ElectronUtilityProcessLike;
    try {
      child = options.utilityProcess.fork(targetScript, [], {
        serviceName: "Botling Plugin Host",
        stdio: "pipe",
        env: cleanEnv,
        cwd,
      });
    } catch (error) {
      handlers.error(error instanceof Error ? error : new Error(String(error)));
      return { pid: -1, write() {}, terminate: async () => {} };
    }

    hosts.set(id, child);
    child.on("message", (message) => {
      const value = message as { botling?: unknown; pid?: unknown } | null;
      if (value && typeof value === "object" && value.botling === "child") {
        pluginChildren.add(id, value.pid);
      }
    });
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", (chunk) => handlers.stderr(String(chunk)));
    child.once("spawn", () => {
      pid = child.pid ?? 0;
      if (killed || exited) {
        child.kill();
        return;
      }
      const { port1, port2 } = new options.MessageChannelMain();
      port = port2;
      port2.on("message", (event) => {
        const data = event.data;
        if (typeof data === "string") handlers.data(`${data}\n`);
        else if (data && typeof data === "object" && typeof (data as { stderr?: unknown }).stderr === "string") {
          handlers.stderr((data as { stderr: string }).stderr);
        }
      });
      port2.start();
      child.postMessage({ botling: "port" }, [port1]);
      for (const line of queued.splice(0)) port2.postMessage(line);
    });
    child.once("exit", (code) => {
      if (exited) return;
      exited = true;
      if (hosts.get(id) === child) hosts.delete(id);
      try { port?.close(); } catch { /* already closed */ }
      void pluginChildren.end(id);
      handlers.exit(typeof code === "number" ? code : null, null);
      resolveGone();
    });

    const host: HostProcess = {
      get pid() { return pid; },
      write(line) {
        if (exited) return;
        const text = line.endsWith("\n") ? line.slice(0, -1) : line;
        if (port) port.postMessage(text);
        else queued.push(text);
      },
      async terminate(graceMs) {
        if (exited) return;
        killed = true;
        child.kill();
        const grace = Math.min(Math.max(graceMs, 0), 10_000);
        const timer = setTimeout(() => {
          if (!exited && child.pid) {
            try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ }
          }
        }, grace);
        timer.unref?.();
        await gone;
        clearTimeout(timer);
        await pluginChildren.end(id, 0);
      },
    };
    return host;
  };

  const shutdown = async () => {
    for (const host of hosts.values()) host.kill();
    hosts.clear();
    await pluginChildren.endAll();
  };

  return { launch, shutdown };
}

const STDOUT_LIMIT = 1024 * 1024;
const STDERR_TAIL = 4096;

export function createUtilityScriptRunner(utilityProcess: ElectronUtilityContext["utilityProcess"]): ScriptRunner {
  return (script, args, options) => runUtilityScript(utilityProcess, script, args, options);
}

export function runUtilityScript(
  utilityProcess: ElectronUtilityContext["utilityProcess"],
  script: string,
  args: string[],
  options: RunOptions,
): Promise<ToolRun> {
  const toolName = basename(script);
  if (options.signal?.aborted) {
    return Promise.reject(new ToolError(toolName, { code: null, signal: "SIGKILL", stdout: "", stderr: "aborted" }));
  }
  const env = stripElectronEnv({ ...process.env, ...(options.env ?? {}) });
  return new Promise((resolve, reject) => {
    let child: ElectronUtilityProcessLike;
    try {
      child = utilityProcess.fork(script, args, {
        serviceName: "Botling PDF Text",
        stdio: "pipe",
        env,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < STDOUT_LIMIT) stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-STDERR_TAIL);
    });
    child.once("error", (type, location, report) => {
      const detail = `${type} at ${location}: ${report}`.slice(-STDERR_TAIL);
      if (detail) stderr = (stderr + (stderr ? "\n" : "") + detail).slice(-STDERR_TAIL);
    });

    const killChild = () => {
      child.kill();
      if (child.pid) {
        const force = setTimeout(() => {
          if (!settled && child.pid) {
            try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ }
          }
        }, 1_000);
        force.unref?.();
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, options.timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      aborted = true;
      killChild();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const signal = timedOut || aborted ? "SIGKILL" : null;
      const run: ToolRun = { code: typeof code === "number" ? code : null, signal, stdout, stderr };
      if (code === 0 && !timedOut && !aborted) resolve(run);
      else reject(new ToolError(toolName, run));
    });
  });
}
