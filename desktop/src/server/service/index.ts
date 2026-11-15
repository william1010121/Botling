// Login-item service management for botlingd (M6-08, D74): LaunchAgent on macOS, systemd user unit on Linux.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { botlingdPaths } from "../session";
import { DEFAULT_SERVICE_LABEL, launchAgentPath, launchAgentPlist, serviceLabel } from "./launchd";
import { SYSTEMD_UNIT_NAME, systemdUnit, systemdUnitPath } from "./systemd";

export { DEFAULT_APP_ID, DEFAULT_SERVICE_LABEL, launchAgentPath, launchAgentPlist, serviceLabel } from "./launchd";
export { SYSTEMD_UNIT_NAME, systemdUnit, systemdUnitPath } from "./systemd";

export interface ServiceSpec {
  program: string;
  args: string[];
  env: Record<string, string>;
  dataDir: string;
  label: string;
}

export type ServiceRunner = (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;
export interface ServiceOptions { platform?: NodeJS.Platform; home?: string; uid?: number; label?: string }
export type ServiceStatus = "running" | "installed, not running" | "not installed";

export class ServiceError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = "ServiceError";
  }
}

export function execServiceRunner(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(cmd, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ?? ""}`;
      if (!error) return resolvePromise({ code: 0, out });
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return rejectPromise(error);
      const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
      resolvePromise({ code, out });
    });
  });
}

/** Developer form only: `process.execPath` and the real path of the running botlingd script with `start`. */
export function botlingdProgram(script = process.argv[1]): { program: string; args: string[] } {
  if (!script) throw new ServiceError("Cannot determine the running botlingd script path.");
  let resolved: string;
  try { resolved = realpathSync(script); } catch { resolved = resolve(script); }
  return { program: process.execPath, args: [resolved, "start"] };
}

/** Only the data-folder, socket (when set), optional ELECTRON_RUN_AS_NODE=1, and BOTLING_SERVICE=1. */
export function serviceEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  if (env.BOTLING_SERVER_DATA_DIR) out.BOTLING_SERVER_DATA_DIR = resolve(env.BOTLING_SERVER_DATA_DIR);
  else if (env.BOTLING_DATA_DIR) out.BOTLING_DATA_DIR = resolve(env.BOTLING_DATA_DIR);
  if (env.BOTLING_SERVER_SOCKET) out.BOTLING_SERVER_SOCKET = resolve(env.BOTLING_SERVER_SOCKET);
  if (env.ELECTRON_RUN_AS_NODE && env.ELECTRON_RUN_AS_NODE !== "0") out.ELECTRON_RUN_AS_NODE = "1";
  out.BOTLING_SERVICE = "1";
  return out;
}

export function buildServiceSpec(
  env: Record<string, string | undefined>,
  options: { appId?: string; label?: string; program?: { program: string; args: string[] } } = {},
): ServiceSpec {
  const paths = botlingdPaths(env);
  const { program, args } = options.program ?? botlingdProgram();
  const label = options.label ?? (options.appId ? serviceLabel(options.appId) : DEFAULT_SERVICE_LABEL);
  return { program, args, env: serviceEnv(env), dataDir: resolve(paths.dataDir), label };
}

function resolvePlatform(options: ServiceOptions): "darwin" | "linux" {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin" || platform === "linux") return platform;
  throw new ServiceError("botlingd service is for macOS and Linux.", 2);
}

function resolveUid(options: ServiceOptions): number {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new ServiceError("Cannot determine the current user id.");
  return uid;
}

export async function install(spec: ServiceSpec, run: ServiceRunner = execServiceRunner, options: ServiceOptions = {}): Promise<string> {
  const platform = resolvePlatform(options);
  const home = options.home ?? homedir();
  if (platform === "darwin") {
    const uid = resolveUid(options);
    const path = launchAgentPath(home, spec.label);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, launchAgentPlist(spec), { mode: 0o644 });
    chmodSync(path, 0o644);
    await run("launchctl", ["bootout", `gui/${uid}/${spec.label}`]);
    const boot = await run("launchctl", ["bootstrap", `gui/${uid}`, path]);
    if (boot.code !== 0) throw new ServiceError(`launchctl bootstrap failed (${boot.code}): ${boot.out.trim() || "unknown error"}`);
    return path;
  }
  const path = systemdUnitPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, systemdUnit(spec), { mode: 0o644 });
  chmodSync(path, 0o644);
  const reload = await run("systemctl", ["--user", "daemon-reload"]);
  if (reload.code !== 0) throw new ServiceError(`systemctl --user daemon-reload failed (${reload.code}): ${reload.out.trim() || "unknown error"}`);
  const enable = await run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT_NAME]);
  if (enable.code !== 0) throw new ServiceError(`systemctl --user enable --now failed (${enable.code}): ${enable.out.trim() || "unknown error"}`);
  return path;
}

export async function uninstall(run: ServiceRunner = execServiceRunner, options: ServiceOptions = {}): Promise<void> {
  const platform = resolvePlatform(options);
  const home = options.home ?? homedir();
  if (platform === "darwin") {
    const uid = resolveUid(options);
    const label = options.label ?? DEFAULT_SERVICE_LABEL;
    await run("launchctl", ["bootout", `gui/${uid}/${label}`]);
    rmSync(launchAgentPath(home, label), { force: true });
    return;
  }
  await run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT_NAME]);
  rmSync(systemdUnitPath(home), { force: true });
  const reload = await run("systemctl", ["--user", "daemon-reload"]);
  if (reload.code !== 0) throw new ServiceError(`systemctl --user daemon-reload failed (${reload.code}): ${reload.out.trim() || "unknown error"}`);
}

export async function status(run: ServiceRunner = execServiceRunner, options: ServiceOptions = {}): Promise<ServiceStatus> {
  const platform = resolvePlatform(options);
  const home = options.home ?? homedir();
  if (platform === "darwin") {
    const uid = resolveUid(options);
    const label = options.label ?? DEFAULT_SERVICE_LABEL;
    const path = launchAgentPath(home, label);
    const print = await run("launchctl", ["print", `gui/${uid}/${label}`]);
    if (print.code === 0) return /\bstate\s*=\s*running\b/i.test(print.out) ? "running" : "installed, not running";
    return existsSync(path) ? "installed, not running" : "not installed";
  }
  const active = await run("systemctl", ["--user", "is-active", SYSTEMD_UNIT_NAME]);
  if (active.code === 0) return "running";
  return existsSync(systemdUnitPath(home)) ? "installed, not running" : "not installed";
}

export async function serviceCommand(
  args: string[],
  env: Record<string, string | undefined>,
  out: (line: string) => void,
  deps: { run?: ServiceRunner; options?: ServiceOptions; program?: { program: string; args: string[] } } = {},
): Promise<void> {
  const [sub, ...extra] = args;
  if (sub !== "install" && sub !== "uninstall" && sub !== "status") {
    throw new ServiceError(`unknown service command "${sub ?? ""}" (use: botlingd service install | uninstall | status)`, 2);
  }
  if (extra.length) throw new ServiceError("service takes one subcommand: install | uninstall | status", 2);
  const run = deps.run ?? execServiceRunner;
  const options = deps.options ?? {};
  if (sub === "install") {
    const path = await install(buildServiceSpec(env, { label: options.label, program: deps.program }), run, options);
    out(`installed: botlingd starts at login (${path})`);
  } else if (sub === "uninstall") {
    await uninstall(run, options);
    out("removed: botlingd no longer starts at login");
  } else {
    out(await status(run, options));
  }
}
