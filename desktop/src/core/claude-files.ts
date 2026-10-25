// Where Claude Code keeps its files (1.x's ClaudeCodeFiles.swift): only whether a session's transcript
// is there is looked at, never what it holds.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** `$CLAUDE_CONFIG_DIR` (with ~ expanded), else ~/.claude (`configFolder`). */
export function claudeConfigFolder(env: NodeJS.ProcessEnv = process.env): string {
  const given = env.CLAUDE_CONFIG_DIR;
  if (given) return given.startsWith("~/") ? join(homedir(), given.slice(2)) : resolve(given);
  return join(homedir(), ".claude");
}

/** The folder name claude gives a working folder: every character but ASCII letters and digits as `-` (`projectFolderName`). */
export function projectFolderName(folder: string): string {
  return resolve(folder).replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Whether claude kept the transcript of `session`, started in `folder` (`claudeSessionExists`): under
 * `<config>/projects/<folder name>/<session>.jsonl`, or, for a folder claude names differently (a long
 * path, a symlink), in any project folder there.
 */
export function claudeSessionExists(session: string, folder: string, config = claudeConfigFolder()): boolean {
  const projects = join(config, "projects");
  const file = `${session.toLowerCase()}.jsonl`;
  if (existsSync(join(projects, projectFolderName(folder), file))) return true;
  let folders: string[] = [];
  try { folders = readdirSync(projects); } catch { return false; }
  return folders.some((name) => existsSync(join(projects, name, file)));
}
