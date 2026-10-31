// Where Claude Code keeps its files (1.x's ClaudeCodeFiles.swift): the config and project folder names.
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
