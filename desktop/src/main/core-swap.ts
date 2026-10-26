// Core hot swap, main's side (docs/core-hot-swap.md). Electron-free so it can be tested with fakes;
// main/core-client.ts supplies the real ports (utility processes).
//
// 1. Self-check: the new build starts on a scratch data folder and answers. Failing: it is discarded and
//    the running core is not touched.
// 2. Drain: the running core begins no new turn (main holds the renderers' requests that would change
//    something; the core keeps what arises inside it), lets turns under way finish, stops late ones at a
//    tool-call boundary and writes the handover (core/hot-swap.ts).
// 3. Switch: the old core stops (its heads end without the tidy); the new one starts on the real data,
//    resumes the handed-over sessions and gets the held requests. If it does not come up, the old build
//    starts again with the same handover (rollback).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** What a core build directory must have (the layout of desktop/out). */
export const CORE_FILES = ["core/main.cjs", "host/host.mjs", "host/check-plugin.cjs"];
/** Optional parts copied along when present. */
const CORE_PARTS = ["core", "host", "web-extractors"];

export interface CoreBuild { directory: string; script: string; development: boolean }

/**
 * Where swaps take the core from: the bundled out/ (the default), or `--botling-core-dir=<absolute out dir>`,
 * honoured like `--botling-renderer-dir` only by source runs and builds marked botlingDevTrial.
 */
export function coreBuild(root: string, packaged: boolean, devTrial: boolean, argv: string[]): CoreBuild {
  const bundled = { directory: join(root, "out"), script: join(root, "out", "core", "main.cjs"), development: false };
  if (packaged && !devTrial) return bundled;
  const flag = "--botling-core-dir=";
  const argument = argv.find((arg) => arg.startsWith(flag));
  if (argument === undefined) return { ...bundled, development: !packaged };
  const directory = argument.slice(flag.length);
  if (!isAbsolute(directory)) throw new Error("--botling-core-dir must be an absolute core build directory (desktop/out)");
  return { directory: resolve(directory), script: join(resolve(directory), "core", "main.cjs"), development: true };
}

/** Throws with what to do when `directory` is not a complete core build. */
export function checkCoreDirectory(directory: string) {
  for (const name of CORE_FILES) {
    try { if (statSync(join(directory, name)).isFile()) continue; } catch { /* reported below */ }
    throw new Error(`Missing core file ${name} in ${directory}; run npm run core:build in desktop/ first`);
  }
}

/**
 * Copies a development core build to `<stagingRoot>/<stamp>` so later rebuilds never change files under a
 * running core; keeps only the newest copies and the one in `keep`. Returns the copy's core script.
 */
export function stageCoreBuild(source: string, stagingRoot: string, keep: string | null, stamp = `${Date.now()}`): string {
  checkCoreDirectory(source);
  mkdirSync(stagingRoot, { recursive: true });
  const target = join(stagingRoot, stamp);
  const partial = `${target}.partial`;
  rmSync(partial, { recursive: true, force: true });
  for (const part of CORE_PARTS) if (existsSync(join(source, part))) cpSync(join(source, part), join(partial, part), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  cpSync(partial, target, { recursive: true });
  rmSync(partial, { recursive: true, force: true });
  const kept = new Set([basename(target), ...(keep ? [basename(dirname(dirname(keep)))] : [])]);
  for (const name of readdirSync(stagingRoot)) if (!kept.has(name)) rmSync(join(stagingRoot, name), { recursive: true, force: true });
  return join(target, "core", "main.cjs");
}

/** Renderer commands that still go to a draining core: they read, or stop work (which helps it drain). */
export const PASS_WHILE_DRAINING = new Set<string>([
  "chat.snapshot", "settings.get", "plugins.list", "plugins.web", "plugins.file", "results.list", "waiting.list", "bot.settings",
  "usage.view", "doctor.view", "attachment.file", "card.image", "card.html", "web.state", "link.authorize", "task.output",
  "subagent.view", "whiteboard.view", "routines.list", "codex.models", "turn.stop", "turn.await", "handoff.stop", "rounds.stop",
]);

/** How requests are held: none; those that change something (draining); all (switching). */
export type HoldMode = "none" | "drain" | "all";

export interface SwapPorts {
  /** The running core's script. */
  readonly script: string;
  /** Starts `script` on a scratch folder and checks it answers; null when it passed, else why not. Never touches the running core. */
  probe(script: string): Promise<string | null>;
  hold(mode: HoldMode): void;
  drain(timeoutMs: number, boundaryMs: number): Promise<{ ok: true; entries: number; interrupted: string[] } | { ok: false; error: string }>;
  undrain(): void;
  /** Ends the running core for good (no automatic restart). */
  stop(): Promise<void>;
  /** Starts `script` on the real data and waits for it to answer; null when it did, else why not. */
  start(script: string): Promise<string | null>;
  /** The handover file's text (null: none), and writing it back for a rollback. */
  readHandover(): string | null;
  writeHandover(text: string): void;
  log(line: string): void;
}

export interface SwapOptions { timeoutMs?: number; boundaryMs?: number }

export type SwapOutcome =
  | { ok: true; script: string; entries: number; interrupted: string[]; ms: number }
  | { ok: false; stage: "busy" | "self-check" | "drain" | "start"; error: string; rolledBack?: boolean };

export const SWAP_TIMEOUT_MS = 120_000;
export const SWAP_BOUNDARY_MS = 30_000;

export class CoreSwapper {
  private running = false;
  constructor(private ports: SwapPorts) {}

  get busy() { return this.running; }

  async swap(script: string, options: SwapOptions = {}): Promise<SwapOutcome> {
    if (this.running) return { ok: false, stage: "busy", error: "A core swap is already under way." };
    this.running = true;
    const started = Date.now();
    const ports = this.ports;
    try {
      const problem = await ports.probe(script).catch((error) => String((error as Error)?.message ?? error));
      if (problem) {
        ports.log(`core swap: the new build failed its self-check and was discarded: ${problem}`);
        return { ok: false, stage: "self-check", error: problem };
      }
      ports.hold("drain");
      const drained = await ports.drain(options.timeoutMs ?? SWAP_TIMEOUT_MS, options.boundaryMs ?? SWAP_BOUNDARY_MS)
        .catch((error) => ({ ok: false as const, error: String((error as Error)?.message ?? error) }));
      if (!drained.ok) {
        ports.undrain();
        ports.hold("none");
        ports.log(`core swap: draining failed, the running core goes on: ${drained.error}`);
        return { ok: false, stage: "drain", error: drained.error };
      }
      ports.hold("all");
      const old = ports.script;
      const handover = ports.readHandover();
      await ports.stop();
      const failure = await ports.start(script);
      if (failure) {
        ports.log(`core swap: the new core did not come up (${failure}); starting the previous build again`);
        await ports.stop();
        if (handover !== null) ports.writeHandover(handover);
        const back = await ports.start(old);
        ports.hold("none");
        if (back) ports.log(`core swap: the previous build did not come up either: ${back}`);
        return { ok: false, stage: "start", error: failure, rolledBack: back === null };
      }
      ports.hold("none");
      const ms = Date.now() - started;
      ports.log(`core swap: now running ${script} (${drained.entries} head(s) resumed, ${drained.interrupted.length} told to carry on, ${ms} ms)`);
      return { ok: true, script, entries: drained.entries, interrupted: drained.interrupted, ms };
    } finally {
      this.running = false;
    }
  }
}
