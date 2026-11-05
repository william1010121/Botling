// What enabled plugins give the AI engines (plugin-platform.md §4.4, step M9; provider-layer.md §8): one neutral list.
// The registry finds the pieces and computes the stamp and knows no engine; each engine's wiring turns the list into
// what that engine takes: `claudeWiring` (what the Claude CLI is started with) and `skillRootsWiring` (the skill folders
// Codex's app-server and Antigravity's profile are pointed at, engine-skills.ts). Only skills reach Codex and Antigravity;
// their agents and MCP servers do not yet (provider-layer.md steps 12–14).
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
  /** The folders that hold those skills (`claude`: inside a Claude part, which Claude loads with --plugin-dir already). */
  skillRoots: { plugin: string; root: string; claude: boolean }[];
  /** Secrets that name an environment variable (MCP servers read them), by plugin. */
  secrets: { plugin: string; env: Record<string, string> }[];
  /**
   * One entry per Claude folder, with a hash of its files, and one per skill folder: a bot started with a different stamp has
   * older skills, agents or MCP servers (a plugin with skills turned on or off restarts every engine's heads once they are free).
   */
  stamp: string[];
}

/** Just the stamp (it is asked for on every message; the list reads each manifest again). */
export function agentStamp(registry: PluginRegistry): string[] {
  return [
    ...registry.claudeParts().map((part) => `${resolve(part.dir)}#${part.hash}`),
    ...registry.skillRoots().filter((entry) => !entry.claude).map((entry) => `skills:${entry.plugin}:${resolve(entry.root)}`),
  ];
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
    skillRoots: registry.skillRoots(),
    claude: claude.map(({ plugin, dir, mcpTools }) => ({ plugin, dir, mcpTools })),
    secrets: registry.secretEnvironments(),
    stamp: agentStamp(registry),
  };
}

/**
 * The Claude side: the `--plugin-dir` folders, the environment of the bot's process and the tools it uses without asking
 * (what `claudeDirectories`, `secretEnvironment` and `claudeTools` gave): the `ccb.claude` folders, then `skillDirs`, the
 * Claude plugin folders made for skills that live elsewhere (`contributes.skills`, engine-skills.ts `claudeSkillFolders`).
 * Either turns the Skill tool on (main.ts `allowedTools`).
 */
export function claudeWiring(contributions: AgentContributions, skillDirs: readonly string[] = []): { dirs: string[]; env: Record<string, string>; tools: string[] } {
  return {
    dirs: [...contributions.claude.map((part) => part.dir), ...skillDirs],
    env: Object.assign({}, ...contributions.secrets.map((entry) => entry.env)),
    tools: contributions.claude.flatMap((part) => part.mcpTools),
  };
}

/**
 * The skill folders for engines that are pointed at folders of skills (Codex's `skills/extraRoots/set`, Antigravity's
 * `skills.json`): every plugin's, its Claude part's too, each through `place` (the path that stays the same while a shipped
 * plugin's override comes or goes, server.ts), without repeats.
 */
export function skillRootsWiring(contributions: AgentContributions, place: (plugin: string, root: string) => string = (_plugin, root) => root): string[] {
  return [...new Set(contributions.skillRoots.map((entry) => place(entry.plugin, entry.root)))];
}
