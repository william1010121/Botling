// The spec/ folder (TLA+ models, reference machines, conformance tests) is changed only by the strong model and
// people (approved 2026-11-02). App-managed workers that run on another model may read it but never write it:
// - Claude workers: a PreToolUse hook on their own `claude -p` denies Edit/Write/MultiEdit/NotebookEdit into spec/
//   and Bash commands that clearly write there (head.ts `SPEC_GUARD_HOOK`);
// - Antigravity workers: their file and command tools are the app's bridge (agy-mcp.ts), which refuses the same calls
//   and, outside Full permission, runs commands in a Seatbelt profile that denies writes under spec/;
// - Codex workers: an approval request that writes into spec/ is declined without a card (codex.ts).
// Bot heads (the project's own bot) are not restricted. Which models may write is settings.json `specWriters`
// (model families, default ["opus"]); a worker whose model is not known is treated as not allowed.
//
// The shell check is best effort: it reads the command as words and catches the plain ways to write a file
// (redirection, rm/mv/cp/touch/mkdir/tee/…, sed -i, git checkout/restore/rm/mv, find -delete, xargs, one-line
// interpreters, `sh -c`), following `cd` within the command. A command that builds the path at run time (variables,
// globs outside spec, scripts on disk that write there) is not caught; CI's spec gate and CODEOWNERS back it up.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RawSettings } from "./settings";

export const DEFAULT_SPEC_WRITERS: readonly string[] = ["opus"];
export const SPEC_DIR = "spec";
export const SPEC_DENIED = "spec/ is changed only by the strong model and people (settings.json `specWriters`); this worker may read it but not write it. Leave spec/ as it is and say in your report what should change there and why.";

const FILE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** settings.json `specWriters`: model families (or exact model ids) whose workers may write spec/. */
export function specWriters(raw: RawSettings): string[] {
  const value = (raw as Record<string, unknown>).specWriters;
  if (!Array.isArray(value)) return [...DEFAULT_SPEC_WRITERS];
  return value.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()).map((entry) => entry.trim().toLowerCase());
}

/** Whether a worker on `model` may write spec/: its id names an allowed family ("claude-opus-5-5", "opus[1m]" → opus). */
export function maySpecWrite(model: string | null | undefined, writers: readonly string[] = DEFAULT_SPEC_WRITERS): boolean {
  const id = model?.trim().toLowerCase();
  if (!id) return false;
  const words = id.split(/[^a-z0-9]+/).filter(Boolean);
  return writers.some((writer) => { const w = writer.trim().toLowerCase(); return !!w && (id === w || words.includes(w)); });
}

/** The spec/ folders a worker in `cwd` must not write: `cwd/spec` and, up to the repository's root, each parent's. */
export function specRoots(cwd: string): string[] {
  const roots: string[] = [];
  let dir = resolve(cwd);
  for (let depth = 0; depth < 64; depth++) {
    roots.push(join(dir, SPEC_DIR));
    if (existsSync(join(dir, ".git"))) break;
    const up = dirname(dir);
    if (up === dir) { roots.splice(1); break; } // No repository above: only the folder's own spec/.
    dir = up;
  }
  return [...new Set(roots.flatMap((root) => [root, real(root)]))];
}

/** Whether `path` (absolute, or relative to `cwd`) is spec/ or inside it. Symlinked parents are followed. */
export function inSpec(path: string, cwd: string, roots = specRoots(cwd)): boolean {
  if (!path.trim()) return false;
  const target = resolve(cwd, expandHome(path.trim()));
  return [target, real(target)].some((candidate) => roots.some((root) => under(candidate, root)));
}

/** A file tool call that writes into spec/ (Edit/Write/MultiEdit/NotebookEdit). */
export function specFileWrite(tool: string, input: Record<string, unknown>, cwd: string): boolean {
  if (!FILE_EDIT_TOOLS.has(tool)) return false;
  const path = [input.file_path, input.notebook_path, input.path].find((value): value is string => typeof value === "string" && !!value.trim());
  return !!path && inSpec(path, cwd);
}

/** A tool call (Claude's names) that writes into spec/: a file edit there, or a Bash command that clearly does. */
export function specWriteCall(tool: string, input: Record<string, unknown>, cwd: string): boolean {
  if (FILE_EDIT_TOOLS.has(tool)) return specFileWrite(tool, input, cwd);
  if (tool === "Bash") return typeof input.command === "string" && shellWritesSpec(input.command, cwd);
  return false;
}

/** The hook answer for a worker on `model`: deny a spec/ write unless that model may write it; {} lets the call go on. */
export function specGuardDecision(input: any, guard: { model: string | null | undefined; writers?: readonly string[]; cwd: string }): Record<string, unknown> {
  if (input?.hook_event_name !== "PreToolUse" || maySpecWrite(guard.model, guard.writers)) return {};
  const tool = String(input.tool_name ?? "");
  const args = input.tool_input && typeof input.tool_input === "object" ? input.tool_input as Record<string, unknown> : {};
  if (!specWriteCall(tool, args, guard.cwd)) return {};
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: SPEC_DENIED } };
}

// Shell commands

const SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n"]);
/** Commands that change every path they are given. */
const WRITES_ANY = new Set(["rm", "rmdir", "unlink", "touch", "mkdir", "truncate", "shred", "chmod", "chown", "chgrp", "tee", "mv", "mkfifo", "srm"]);
/** Commands that change only their destination (the last path, or `-t dir`). */
const WRITES_LAST = new Set(["cp", "ln", "install", "rsync", "scp", "ditto"]);
const IN_PLACE = new Set(["sed", "gsed", "perl", "ruby"]);
const GIT_WRITES = new Set(["checkout", "restore", "rm", "mv", "apply", "clean", "reset", "stash", "switch", "am", "cherry-pick", "revert", "merge", "pull", "rebase"]);
const INTERPRETERS = /^(python[0-9.]*|node|deno|bun|ruby|perl|php|osascript)$/;
const WRAPPERS = new Set(["sudo", "env", "command", "builtin", "exec", "nohup", "time", "nice", "doas", "caffeinate"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const WRITE_WORDS = /write|unlink|rmSync|rmdir|\brm\b|rename|mkdir|appendFile|copyFile|truncate|open\([^)]*,\s*['"][wax+]|>\s*['"]?\.?\/?spec\//;
const SPEC_MENTION = /(^|[^\w.-])(\.\/|\.\.\/)*spec(\/|['"\s]|$)/;

interface Word { text: string; redirect?: boolean }

/** Whether a shell command clearly writes into spec/ (best effort; see the top of this file). */
export function shellWritesSpec(command: string, cwd: string, depth = 0): boolean {
  if (depth > 3) return false;
  let here = resolve(cwd);
  const roots = specRoots(cwd);
  const spec = (path: string) => inSpec(path, here, roots) || (here !== cwd && inSpec(path, here));
  const pipelines = segments(tokens(command));
  for (const pipeline of pipelines) {
    const mentions = pipeline.some((words) => words.some((w) => !w.redirect && spec(w.text)));
    for (const words of pipeline) {
      if (words.some((w) => w.redirect && spec(w.text))) return true;
      const args = words.filter((w) => !w.redirect).map((w) => w.text);
      while (args.length && (WRAPPERS.has(basename(args[0]!)) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0]!))) args.shift();
      const name = args.length ? basename(args[0]!) : "";
      const rest = args.slice(1);
      const paths = rest.filter((a) => !a.startsWith("-"));
      if (name === "cd") { const to = paths[0]; here = to ? resolve(here, expandHome(to)) : here; continue; }
      if (WRITES_ANY.has(name) && paths.some(spec)) return true;
      if (WRITES_LAST.has(name)) {
        const target = optionValue(rest, ["-t", "--target-directory"]) ?? paths.at(-1);
        if (target && spec(target)) return true;
      }
      if (IN_PLACE.has(name) && rest.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place")) && paths.some(spec)) return true;
      if (name === "dd" && rest.some((a) => a.startsWith("of=") && spec(a.slice(3)))) return true;
      if (name === "git" && rest.some((a) => GIT_WRITES.has(a)) && paths.some(spec)) return true;
      if (name === "find" && paths.some(spec) && (rest.includes("-delete")
        || (rest.some((a) => a === "-exec" || a === "-execdir") && rest.some((a) => WRITES_ANY.has(basename(a)) || IN_PLACE.has(basename(a)))))) return true;
      if ((name === "tar" || name === "bsdtar") && rest.some((a) => /^-?[a-zA-Z]*x/.test(a))) {
        const into = optionValue(rest, ["-C", "--directory"]);
        if (into ? spec(into) : spec(here)) return true;
      }
      if (name === "unzip" && (() => { const d = optionValue(rest, ["-d"]); return !!d && spec(d); })()) return true;
      if (name === "xargs" && mentions && rest.some((a) => WRITES_ANY.has(basename(a)) || WRITES_LAST.has(basename(a)) || IN_PLACE.has(basename(a)))) return true;
      if (SHELLS.has(name) || name === "eval") {
        const script = name === "eval" ? rest.join(" ") : optionValue(rest, ["-c"]);
        if (script && shellWritesSpec(script, here, depth + 1)) return true;
      }
      if (INTERPRETERS.test(name)) {
        const code = optionValue(rest, ["-c", "-e", "-p", "--eval", "--print"]);
        if (code && SPEC_MENTION.test(code) && WRITE_WORDS.test(code)) return true;
      }
    }
  }
  return false;
}

/** The value after one of `flags` ("-C dir", "-Cdir", "--directory=dir"). */
function optionValue(args: readonly string[], flags: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    for (const flag of flags) {
      if (arg === flag) return args[i + 1];
      if (flag.startsWith("--") && arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
      if (!flag.startsWith("--") && arg.startsWith(flag) && arg.length > flag.length && flag !== "-c" && flag !== "-e" && flag !== "-p") return arg.slice(flag.length);
    }
  }
  return undefined;
}

/** Words of a command, with quotes removed; a redirection's target is marked; separators are words of their own. */
function tokens(command: string): (Word | string)[] {
  const out: (Word | string)[] = [];
  let word = "", quoted = false, redirect = false;
  const end = () => {
    if (word || quoted) { out.push({ text: word, ...(redirect ? { redirect: true } : {}) }); redirect = false; }
    word = ""; quoted = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "\\" && i + 1 < command.length) { word += command[++i]; continue; }
    if (c === "'") { const close = command.indexOf("'", i + 1); const stop = close < 0 ? command.length : close; word += command.slice(i + 1, stop); quoted = true; i = stop; continue; }
    if (c === "\"") {
      let j = i + 1;
      for (; j < command.length && command[j] !== "\""; j++) { if (command[j] === "\\" && j + 1 < command.length) j++; }
      word += command.slice(i + 1, j).replace(/\\(.)/g, "$1"); quoted = true; i = j; continue;
    }
    if (c === " " || c === "\t") { end(); continue; }
    if (c === "\n" || c === ";") { end(); out.push("\n"); continue; }
    if (c === "&" || c === "|") {
      if (c === "&" && command[i + 1] === ">") { end(); redirect = true; i += command[i + 2] === ">" ? 2 : 1; continue; }
      end();
      if (command[i + 1] === c) { out.push(c + c); i++; } else out.push(c);
      continue;
    }
    if (c === ">") {
      if (/^\d+$/.test(word)) word = ""; // "2>file"
      end();
      if (command[i + 1] === ">" || command[i + 1] === "|") i++;
      if (command[i + 1] === "&") { i++; continue; } // "2>&1": a descriptor, not a file
      redirect = true;
      continue;
    }
    if (c === "<") { end(); continue; }
    word += c;
  }
  end();
  return out;
}

/** Pipelines (split at ; && || & and newlines), each a list of commands (split at |), each a list of words. */
function segments(all: (Word | string)[]): Word[][][] {
  const pipelines: Word[][][] = [[[]]];
  for (const token of all) {
    if (typeof token === "string") {
      if (token === "|") pipelines.at(-1)!.push([]);
      else if (SEPARATORS.has(token)) pipelines.push([[]]);
      continue;
    }
    pipelines.at(-1)!.at(-1)!.push(token);
  }
  return pipelines;
}

function expandHome(path: string): string {
  if (path === "~" || path.startsWith("~/")) return join(process.env.HOME ?? "~", path.slice(1));
  return path;
}

function under(path: string, root: string): boolean {
  const fold = process.platform === "darwin" || process.platform === "win32";
  const inside = relative(fold ? root.toLowerCase() : root, fold ? path.toLowerCase() : path);
  return inside === "" || (!!inside && !inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside));
}

/** `path` with its deepest existing parent resolved through symlinks. */
function real(path: string): string {
  let head = path;
  const tail: string[] = [];
  for (let depth = 0; depth < 256; depth++) {
    try { return join(realpathSync(head), ...tail); } catch { /* not there yet */ }
    const up = dirname(head);
    if (up === head) return path;
    tail.unshift(basename(head));
    head = up;
  }
  return path;
}
