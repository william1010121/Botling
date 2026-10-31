// Components whose data comes from a CLI command (the Swift app's ComponentCommands):
// `<show name="x" command="git diff --stat"></show>`, or a component whose about.md has a
// `Command: …` line. The command runs in the core, in the bot's folder, and only once the user
// pressed "Allow and run" on its card for that command in that folder (remembered in
// approved-commands.json, 1.x's file); with a time limit, an output cap, and its whole process
// group ended when it is stopped. Its stdout becomes the data: the JSON when it is JSON, else a
// JSON string of the text. Each card keeps its own last run and can run it again.
//
// A component's `Detail command: git show {hash}` (`ccb.runDetail`) runs only once the user allowed
// that very template with the card's Command; each `{name}` gets one single-quoted value of
// letters, digits and . _ / - only. Nothing a card sends ever becomes a command of its own.
import { spawn } from "node:child_process";
import { commandShell } from "../shell";
import { killTree } from "../process/kill-tree";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { writeFileAtomic } from "../durable/atomic";

export type CommandStatus = "approve" | "idle" | "running" | "done" | "failed";

export interface CommandState {
  status: CommandStatus;
  data: string | null;
  error: string | null;
  /** Epoch ms. */
  ranAt: number | null;
}

export interface CommandOutcome {
  data?: string;
  error?: string;
  ranAt: number;
  timedOut?: boolean;
}

export const COMMAND_TIMEOUT_MS = 60_000;
export const OUTPUT_LIMIT = 1_000_000;
export const VALUE_LENGTH = 200;

export type Runner = (command: string, folder: string) => Promise<CommandOutcome>;

/** stdout as component data: the JSON itself when it is JSON, else a JSON string of the text (`data(fromOutput:)`). */
export function dataFromOutput(output: string): string {
  const trimmed = output.trim();
  if (trimmed) {
    try { JSON.parse(trimmed); return trimmed; } catch { /* text */ }
  }
  return JSON.stringify(output.endsWith("\n") ? output.slice(0, -1) : output);
}

/** The placeholders a Detail command names, `{hash}`, each once, in order. */
export function placeholders(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) if (!names.includes(match[1]!)) names.push(match[1]!);
  return names;
}

/** Why a value cannot go into a Detail command, or null when it can. */
export function valueProblem(value: string, name: string): string | null {
  if (!value) return `The value for {${name}} is empty.`;
  if ([...value].length > VALUE_LENGTH) return `The value for {${name}} is longer than ${VALUE_LENGTH} characters.`;
  if (value.startsWith("-")) return `The value for {${name}} starts with "-".`;
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return "The value for {" + name + "} may only have letters, digits and . _ / -.";
  return null;
}

/** The command line a Detail template makes with `values` (each one single-quoted), or why not. */
export function detailCommandLine(template: string, values: Record<string, string>): { line: string } | { problem: string } {
  const names = placeholders(template);
  const unknown = Object.keys(values).sort().find((key) => !names.includes(key));
  if (unknown) return { problem: `The Detail command has no {${unknown}}.` };
  const missing = names.find((name) => values[name] === undefined);
  if (missing) return { problem: `No value for {${missing}}.` };
  for (const name of names) {
    const problem = valueProblem(values[name]!, name);
    if (problem) return { problem };
  }
  return { line: template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => `'${values[name]}'`) };
}

/** A runDetail call's values as text: strings and whole numbers; null for anything else (refused, not guessed). */
export function detailValues(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") out[key] = item;
    else if (typeof item === "number" && Number.isInteger(item) && Math.abs(item) < 1e15) out[key] = String(item);
    else return null;
  }
  return out;
}

/** The shell a command runs in: the user's login shell setup as 1.x (zsh -lc on macOS). */
function shell(command: string): [string, string[]] {
  // Tests: a plain shell, so the user's own login files are never read.
  if (process.env.BOTLING_PLAIN_SHELL === "1" && process.platform !== "win32") return ["/bin/sh", ["-c", command]];
  return commandShell(command);
}

function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "ELECTRON_RUN_AS_NODE"]) delete env[key];
  if (process.platform !== "win32") {
    const extra = [`${homedir()}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin"];
    const existing = (env.PATH ?? "").split(":").filter(Boolean);
    env.PATH = [...extra, ...existing.filter((part) => !extra.includes(part))].join(":");
  }
  env.NO_COLOR = "1";
  return env;
}

/** Runs `command` in `folder` with no input, stopping its whole group after `timeoutMs` or once it prints more than `limit` bytes (`execute`). */
export function execute(command: string, folder: string, timeoutMs = COMMAND_TIMEOUT_MS, limit = OUTPUT_LIMIT): Promise<CommandOutcome> {
  return new Promise((done) => {
    let isFolder = false;
    try { isFolder = statSync(folder).isDirectory(); } catch { /* not there */ }
    if (!isFolder) return done({ error: `The project folder ${folder} is not there.`, ranAt: Date.now() });
    const [file, args] = shell(command);
    const child = spawn(file, args, { cwd: folder, env: environment(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let stdout: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    let finished = false;
    const signal = (name: NodeJS.Signals) => {
      if (child.pid && killTree(child.pid, name)) return;
      try { child.kill(name); } catch { /* gone */ }
    };
    const stop = () => {
      signal("SIGTERM");
      setTimeout(() => signal("SIGKILL"), 2_000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (overflow) return;
      size += chunk.length;
      if (size > limit) { overflow = true; stdout = []; stop(); return; }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8_000); });
    const tail = (text: string) => { const t = text.slice(-2_000).trim(); return t ? `\n${t}` : ""; };
    child.once("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done({ error: `Couldn't start the command: ${error.message}`, ranAt: Date.now() });
    });
    child.once("close", (code, sig) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Whatever it left behind in its group goes too.
      signal("SIGKILL");
      const ranAt = Date.now();
      if (overflow) return done({ error: `The command printed more than ${Math.floor(limit / 1000)} KB, so it was stopped.`, ranAt });
      if (timedOut) return done({ error: `The command took longer than ${Math.round(timeoutMs / 1000)} seconds, so it was stopped.${tail(stderr)}`, ranAt, timedOut: true });
      const text = Buffer.concat(stdout).toString("utf8");
      if (sig || code !== 0) return done({ error: `The command failed (exit code ${code ?? (sig ? 1 : 0)}).${tail(stderr || text)}`, ranAt });
      done({ data: dataFromOutput(text), ranAt });
    });
  });
}

/** What allowing a Detail command stores beside the commands. */
export const detailKey = (template: string) => `Detail command: ${template}`;

export class ComponentCommands {
  private runs = new Map<string, CommandState>();
  /** What each card's last run was of (folder and command): another command or folder runs anew. */
  private ranWith = new Map<string, string>();
  private approved: Record<string, string[]>;
  private saving = new Map<string, { command: string; run: Promise<CommandOutcome> }>();
  /** A card's run changed (started, finished): its view is drawn again. */
  onChange: (card: string) => void = () => {};

  constructor(readonly approvalsFile: string, private runner: Runner = (command, folder) => execute(command, folder)) {
    let value: unknown = {};
    try { value = JSON.parse(readFileSync(approvalsFile, "utf8")); } catch { /* none yet */ }
    this.approved = value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((e): e is [string, string[]] => Array.isArray(e[1])).map(([k, v]) => [k, v.filter((c) => typeof c === "string")]))
      : {};
  }

  private static key(folder: string) { return resolve(folder); }
  private static what(command: string, folder: string) { return `${ComponentCommands.key(folder)}\n${command}`; }

  isApproved(command: string, folder: string): boolean {
    return this.approved[ComponentCommands.key(folder)]?.includes(command) === true;
  }

  isDetailApproved(template: string | null, folder: string): boolean {
    return template === null || this.isApproved(detailKey(template), folder);
  }

  approve(command: string, folder: string) {
    if (this.isApproved(command, folder)) return;
    const key = ComponentCommands.key(folder);
    (this.approved[key] ??= []).push(command);
    const sorted = Object.fromEntries(Object.keys(this.approved).sort().map((k) => [k, this.approved[k]]));
    writeFileAtomic(this.approvalsFile, JSON.stringify(sorted, null, 2));
  }

  /** The card's state: it asks until its command (and its Detail command) are allowed in that folder. */
  state(card: string, command: string, detail: string | null, folder: string): CommandState {
    if (!this.isApproved(command, folder) || !this.isDetailApproved(detail, folder)) return { status: "approve", data: null, error: null, ranAt: null };
    return this.runOf(card, command, folder) ?? { status: "idle", data: null, error: null, ranAt: null };
  }

  /** The card's last run, if it was of this command in this folder. */
  runOf(card: string, command: string, folder: string): CommandState | null {
    return this.ranWith.get(card) === ComponentCommands.what(command, folder) ? this.runs.get(card) ?? null : null;
  }

  lastRan(card: string): number | null {
    return this.runs.get(card)?.ranAt ?? null;
  }

  /** Runs it for the card if allowed and not running; `force` runs a done or failed card again (↻). */
  async run(card: string, command: string, folder: string, force = false): Promise<void> {
    if (!this.isApproved(command, folder)) return;
    if (this.runs.get(card)?.status === "running") return;
    const previous = this.runOf(card, command, folder);
    if (previous && !force) return;
    this.ranWith.set(card, ComponentCommands.what(command, folder));
    this.runs.set(card, { status: "running", data: previous?.data ?? null, error: null, ranAt: previous?.ranAt ?? null });
    this.onChange(card);
    const outcome = await this.runner(command, folder);
    this.runs.set(card, outcome.data !== undefined
      ? { status: "done", data: outcome.data, error: null, ranAt: outcome.ranAt }
      : { status: "failed", data: null, error: outcome.error ?? "The command failed.", ranAt: outcome.ranAt });
    this.onChange(card);
  }

  /**
   * A component's `ccb.runDetail(values)`: its Detail command `template`, as about.md has it now,
   * filled and run in `folder` — only if that template is allowed there. With `saving` (`{save:
   * true}`) the output is that card's data, as a run of its command would be.
   */
  async runDetail(template: string, values: Record<string, string>, folder: string, saving?: { card: string; command: string }): Promise<CommandOutcome> {
    if (!this.isDetailApproved(template, folder)) return { error: "This component's Detail command is not allowed yet: press \"Allow and run\" on its card first.", ranAt: Date.now() };
    const made = detailCommandLine(template, values);
    if ("problem" in made) return { error: made.problem, ranAt: Date.now() };
    if (!saving || !this.isApproved(saving.command, folder)) return this.runner(made.line, folder);
    const running = this.saving.get(saving.card);
    if (running) {
      if (running.command === made.line) return running.run;
      return { error: "This card is already running a command: try again once it is done.", ranAt: Date.now() };
    }
    if (this.runs.get(saving.card)?.status === "running") return { error: "This card's command is running: try again once it is done.", ranAt: Date.now() };
    const previous = this.runOf(saving.card, saving.command, folder);
    this.ranWith.set(saving.card, ComponentCommands.what(saving.command, folder));
    this.runs.set(saving.card, { status: "running", data: previous?.data ?? null, error: null, ranAt: previous?.ranAt ?? null });
    this.onChange(saving.card);
    const run = this.runner(made.line, folder);
    this.saving.set(saving.card, { command: made.line, run });
    const outcome = await run;
    this.saving.delete(saving.card);
    this.runs.set(saving.card, outcome.data !== undefined
      ? { status: "done", data: outcome.data, error: null, ranAt: outcome.ranAt }
      : { status: "failed", data: previous?.data ?? null, error: outcome.error ?? "The command failed.", ranAt: outcome.ranAt });
    this.onChange(saving.card);
    return outcome;
  }
}
