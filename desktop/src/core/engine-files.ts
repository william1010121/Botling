// What the engines' own config files say, shown read-only on Settings → Models & workers: Claude Code's auto-compact
// window (~/.claude/settings.json `autoCompactWindow`) and the top-level model, effort and service tier of
// ~/.codex/config.toml (what Codex workers use while they follow it). Botling never writes these files.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const read = (file: string): string | null => {
  try { return readFileSync(file, "utf8"); } catch { return null; }
};

/** ~/.claude/settings.json `autoCompactWindow` in tokens; null when the file, the key or a usable number is missing. */
export function claudeAutoCompactWindow(home: string = homedir(), configDir: string = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude")): number | null {
  const text = read(join(configDir, "settings.json"));
  if (text === null) return null;
  try {
    const value = (JSON.parse(text) as Record<string, unknown> | null)?.autoCompactWindow;
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch { return null; }
}

/** One TOML basic or literal string, or a bare word; anything else is not read. */
function tomlValue(raw: string): string | null {
  const value = raw.replace(/\s+#.*$/, "").trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(value) ?? /^'([^']*)'$/.exec(value);
  if (quoted) return quoted[1]!.replace(/\\(["\\])/g, "$1").trim() || null;
  return /^[A-Za-z0-9_.-]+$/.test(value) ? value : null;
}

export interface CodexConfigFile { model: string | null; effort: string | null; fast: boolean | null }

/**
 * The top-level `model`, `model_reasoning_effort` and `service_tier` of a config.toml (keys before the first table).
 * `fast` is true for the priority / fast tier, false for another tier, null when none is set.
 */
export function parseCodexConfig(text: string): CodexConfigFile {
  const found: Record<string, string | null> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) break;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (match && !(match[1]! in found)) found[match[1]!] = tomlValue(match[2]!);
  }
  const tier = found.service_tier?.toLowerCase() ?? null;
  return {
    model: found.model?.slice(0, 200) ?? null,
    effort: found.model_reasoning_effort?.slice(0, 40) ?? null,
    fast: tier === null ? null : tier === "priority" || tier === "fast",
  };
}

/** ~/.codex/config.toml's top-level choices; null when there is no such file. */
export function codexConfigFile(home: string = homedir(), codexHome: string = process.env.CODEX_HOME || join(home, ".codex")): CodexConfigFile | null {
  const text = read(join(codexHome, "config.toml"));
  return text === null ? null : parseCodexConfig(text);
}
