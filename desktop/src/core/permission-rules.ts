// "Always allow" entries as 1.x keeps them (settings.json `alwaysAllowed`, Bot.swift ~1727-1748):
// a bare tool name ("WebSearch", "mcp__github__get_issue") or a Claude Code permission rule that
// lets one narrow kind of call through ("Bash(npm test)", "Edit(//Users/me/p/notes.md)",
// "WebFetch(domain:example.com)").
//
// 1.x gives the rules to claude (`--settings` / `apply_flag_settings`, the same approach as the
// auto-mode port's `allow(rules)`), so Claude Code itself matches them. This module is the app's own
// copy of that matching, for a permission request that still reaches the app: an imported 1.x rule
// then answers it without a card, instead of only a bare tool name doing so. It is deliberately
// narrow — when in doubt it does not match, and the user is asked as before:
// - `Bash(cmd)` is that exact command; `Bash(prefix:*)` and `*` wildcards never match a command that
//   chains or substitutes others (`;`, `&&`, `|`, backticks, `$(`, newlines, redirection);
// - file rules (`Edit(…)` covers Write/Edit/MultiEdit/NotebookEdit, `Read(…)` covers Read/Glob/Grep)
//   match only an absolute path, gitignore-style: `//abs`, `~/home`, `/from-the-bot's-folder`, or
//   relative (`src/**`, `*.md`: a pattern without a slash matches the name at any depth);
// - `WebFetch(domain:host)` is that host, `domain:*.host` its subdomains;
// - `mcp__server` (or `mcp__server__*`) covers every tool of that MCP server.

import { homedir } from "node:os";
import { isAbsolute, normalize, relative, resolve } from "node:path";

/** A tool call as a permission request gives it. */
export interface RuleCall {
  tool: string;
  input: Record<string, unknown>;
}

/** An entry that is a permission rule ("Bash(npm test)"), not a tool name (`Bot.isRule`). */
export function isPermissionRule(entry: string): boolean {
  return entry.includes("(") && entry.endsWith(")");
}

const FILE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const FILE_READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
/** What makes a command more than one command, or writes somewhere it does not name. */
const COMPOUND = /[;&|`\n\r<>]|\$\(/;

/** Whether one always-allowed entry lets this call through. `folder`: the bot's folder (where relative patterns start). */
export function ruleMatches(entry: string, call: RuleCall, folder: string): boolean {
  const rule = entry.trim();
  if (!rule) return false;
  if (!isPermissionRule(rule)) {
    if (rule === call.tool) return true;
    // A whole MCP server: "mcp__github" or "mcp__github__*".
    const server = rule.endsWith("__*") ? rule.slice(0, -3) : rule;
    return /^mcp__[^_].*$/.test(server) && !server.slice(5).includes("__") && call.tool.startsWith(`${server}__`);
  }
  const open = rule.indexOf("(");
  const tool = rule.slice(0, open);
  const body = rule.slice(open + 1, -1);
  switch (tool) {
    case "Bash": {
      const command = text(call.input.command);
      return call.tool === "Bash" && command !== null && bashMatches(body, command);
    }
    case "Edit":
      return FILE_EDIT_TOOLS.has(call.tool) && fileMatches(body, filePath(call), folder);
    case "Read":
      return FILE_READ_TOOLS.has(call.tool) && fileMatches(body, filePath(call), folder);
    case "WebFetch": {
      if (call.tool !== "WebFetch" || !body.startsWith("domain:")) return false;
      const url = text(call.input.url);
      if (!url) return false;
      let host: string;
      try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
      const wanted = body.slice("domain:".length).trim().toLowerCase();
      if (!wanted || !host) return false;
      return wanted.startsWith("*.") ? host.endsWith(wanted.slice(1)) && host.length > wanted.length - 1 : host === wanted;
    }
    default:
      // Another tool's rule with an argument the app cannot read: leave it to claude.
      return false;
  }
}

/** Whether any of these always-allowed entries lets this call through. */
export function alwaysAllows(entries: readonly string[], call: RuleCall, folder: string): boolean {
  return entries.some((entry) => ruleMatches(entry, call, folder));
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function filePath(call: RuleCall): string | null {
  return text(call.input.file_path) ?? text(call.input.notebook_path) ?? text(call.input.path);
}

function bashMatches(pattern: string, raw: string): boolean {
  const command = raw.trim();
  const body = pattern.trim();
  if (!body) return false;
  if (body === command) return true;
  if (!body.includes("*")) return false;
  if (COMPOUND.test(command)) return false;
  if (body.endsWith(":*") && !body.slice(0, -2).includes("*")) {
    const prefix = body.slice(0, -2).trimEnd();
    return !!prefix && (command === prefix || command.startsWith(`${prefix} `));
  }
  return new RegExp(`^${body.split("*").map(escape).join(".*")}$`, "s").test(command);
}

function fileMatches(pattern: string, path: string | null, folder: string): boolean {
  const body = pattern.trim();
  if (!body || !path || !isAbsolute(path)) return false;
  const target = normalize(path);
  let base: string;
  let glob: string;
  if (body.startsWith("//")) { base = "/"; glob = body.slice(2); }
  else if (body === "~" || body.startsWith("~/")) { base = homedir(); glob = body.slice(2); }
  else if (body.startsWith("/")) { base = folder; glob = body.slice(1); }
  else { base = folder; glob = body.startsWith("./") ? body.slice(2) : body; }
  if (!base || !isAbsolute(base)) return false;
  const inside = relative(resolve(base), target);
  if (inside.startsWith("..") || isAbsolute(inside)) return false;
  if (!glob) return true; // The whole folder: "Edit(//tmp/out)" with nothing after it reads as that folder.
  const trimmed = glob.endsWith("/") ? `${glob}**` : glob;
  // A pattern with no slash matches the name at any depth (gitignore).
  const anchored = trimmed.includes("/") ? trimmed : `**/${trimmed}`;
  if (globRegex(anchored).test(inside)) return true;
  // "dir/**" covers that folder itself too (a Grep or Glob over it).
  if (anchored.endsWith("/**") && globRegex(anchored.slice(0, -3)).test(inside)) return true;
  // "dir" names a folder: everything in it.
  return globRegex(`${anchored}/**`).test(inside);
}

function globRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += escape(c);
  }
  return new RegExp(`^${out}$`, "s");
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
