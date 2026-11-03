// What enabled plugins give the AI engines (plugin-platform.md §4.4, step M9; provider-layer.md §8): one neutral list.
// The registry finds the pieces and computes the stamp and knows no engine; each engine's wiring turns the list into
// what that engine takes. Only the Claude wiring exists so far (`claudeWiring`, what the Claude CLI is started with);
// Codex and Antigravity do not read the list yet (provider-layer.md steps 12–14 are what is left).
import { join, resolve } from "node:path";
import { ofKind } from "./contributions";
import type { PluginRegistry } from "./registry";

export interface AgentContributions {
  /** Every skill (a folder with SKILL.md): the old `ccb.claude/skills/` ones and `contributes.skills`. */
  skills: { plugin: string; name: string; dir: string }[];
  /** Agent definition files (`ccb.claude/agents/*.md` and `contributes.agents`). */
  agents: { plugin: string; name: string; file: string }[];
  /** Claude Code plugin folders (`ccb.claude`): what `--plugin-dir` takes, with their MCP servers' tools. */
  claude: { plugin: string; dir: string; mcpTools: string[] }[];
  /** Secrets that name an environment variable (MCP servers read them), by plugin. */
  secrets: { plugin: string; env: Record<string, string> }[];
  /** One entry per Claude folder, with a hash of its files: a bot started with a different stamp has older skills, agents or MCP servers. */
  stamp: string[];
}

/** Just the stamp (it is asked for on every message; the list reads each manifest again). */
export function agentStamp(registry: PluginRegistry): string[] {
  return registry.claudeParts().map((part) => `${resolve(part.dir)}#${part.hash}`);
}

export function agentContributions(registry: PluginRegistry): AgentContributions {
  const claude = registry.claudeParts();
  const folders = new Map(registry.plugins.map((plugin) => [plugin.manifest.name, plugin.folder]));
  const skills: AgentContributions["skills"] = [];
  const agents: AgentContributions["agents"] = [];
  for (const part of ofKind(registry.contributions(), "agent")) {
    const folder = folders.get(part.plugin);
    if (!folder) continue;
    for (const skill of part.skills) skills.push({ plugin: part.plugin, name: skill.name, dir: join(folder, skill.dir) });
    for (const agent of part.agents) agents.push({ plugin: part.plugin, name: agent.name, file: join(folder, agent.file) });
  }
  return {
    skills, agents,
    claude: claude.map(({ plugin, dir, mcpTools }) => ({ plugin, dir, mcpTools })),
    secrets: registry.secretEnvironments(),
    stamp: agentStamp(registry),
  };
}

/**
 * The Claude side: the `--plugin-dir` folders, the environment of the bot's process and the tools it uses without asking
 * (what `claudeDirectories`, `secretEnvironment` and `claudeTools` gave). Only `ccb.claude` folders are handed over, so a
 * plugin's skill that lives elsewhere (`contributes.skills`) is not one Claude loads, and does not turn the Skill tool on.
 */
export function claudeWiring(contributions: AgentContributions): { dirs: string[]; env: Record<string, string>; tools: string[] } {
  return {
    dirs: contributions.claude.map((part) => part.dir),
    env: Object.assign({}, ...contributions.secrets.map((entry) => entry.env)),
    tools: contributions.claude.flatMap((part) => part.mcpTools),
  };
}
