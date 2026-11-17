// The command a bot runs for a component shot (BOTLING_SHOT_COMMAND): the path of one small sh script the app writes
// at start, `exec env -u ELECTRON_RUN_AS_NODE '<Botling binary>' [<app folder>] --component-shot "$@"`.
// Why a script and not the command line itself: the variable's value is one word to zsh (it does not split a
// variable), and the single quotes inside a value are plain characters, so
// `$BOTLING_SHOT_COMMAND <folder> --out <dir>` looked for a program called "env -u ... 'path'" and failed. A path
// with no spaces or quote characters works unquoted in zsh, bash and sh alike. The binary's own path may have
// spaces ("Botling 3.app", "Application Support"); the script quotes it, and the script's path itself never does.
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export const SHOT_WRAPPER = "botling-component-shot";

/** `text` as one sh word. */
export const shellQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** A path that is one word in zsh, bash and sh without quoting: no spaces, quotes, globs, `~` or `$`. */
export const UNQUOTED_SAFE = /^\/[A-Za-z0-9_@%+=:,./-]+$/;

/** The script: `command` is the Botling binary and, in a development build, the app folder after it. */
export function shotWrapperScript(command: readonly string[]): string {
  return [
    "#!/bin/sh",
    "# Botling's component shot (written by the app when it starts; edits are lost). Usage: <this> <component folder> [--out <dir>] [--theme dark|light] [--sizes 1x1,2x1,2x2,4x2]; --help lists the rest.",
    `exec env -u ELECTRON_RUN_AS_NODE ${command.map(shellQuote).join(" ")} --component-shot "$@"`,
    "",
  ].join("\n");
}

/**
 * Where the script may go, best first: the app's data folder, then ~/.botling, then the temp folder (kept last: the
 * system cleans it). Each a folder whose script path is `UNQUOTED_SAFE`; "Application Support" has a space, so a packaged
 * Mac build usually lands in ~/.botling/bin.
 */
export function shotWrapperDirs(places: { dataDir?: string | null; home?: string | null; tmp?: string | null; uid?: number | null }): string[] {
  const candidates = [
    places.dataDir ? join(places.dataDir, "bin") : null,
    places.home ? join(places.home, ".botling", "bin") : null,
    places.tmp ? join(places.tmp, `botling-bin-${places.uid ?? "u"}`) : null,
  ];
  return candidates.filter((dir): dir is string => dir !== null && UNQUOTED_SAFE.test(join(dir, SHOT_WRAPPER)));
}

/**
 * Writes the script into the first of `dirs` that takes it (executable, rewritten only when its text changed: staged
 * beside it and renamed over it) and returns its path; null when none does (the caller then keeps the long command).
 */
export function installShotWrapper(command: readonly string[], dirs: readonly string[]): string | null {
  const text = shotWrapperScript(command);
  for (const dir of dirs) {
    const file = join(dir, SHOT_WRAPPER);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // A folder someone else owns, or others may write to, could swap the script for theirs: not a place for it.
      const folder = statSync(dir);
      if (!folder.isDirectory() || (folder.mode & 0o022) !== 0 || (typeof process.getuid === "function" && folder.uid !== process.getuid())) continue;
      let same = false;
      try {
        const stat = lstatSync(file);
        same = stat.isFile() && (stat.mode & 0o111) !== 0 && readFileSync(file, "utf8") === text;
      } catch { /* none yet */ }
      if (!same) {
        const staged = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
        writeFileSync(staged, text, { mode: 0o755, flag: "wx" });
        try {
          chmodSync(staged, 0o755);
          renameSync(staged, file);
        } catch (error) {
          rmSync(staged, { force: true });
          throw error;
        }
      }
      return file;
    } catch { /* this place does not take it: the next */ }
  }
  return null;
}

/** What a bot's shell runs for a shot: the script's path when one could be written, else the long command (bash only). */
export function shotCommand(command: readonly string[], dirs: readonly string[]): string {
  return installShotWrapper(command, dirs) ?? `env -u ELECTRON_RUN_AS_NODE ${command.map(shellQuote).join(" ")} --component-shot`;
}
