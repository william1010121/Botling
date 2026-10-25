// Temporary teams (1.x's Teams.swift and Workspace.startTeam): a kind of team the main bot pulls up
// with <team name="…">task</team> for a wish that belongs to no project. Each team is an agent file
// (`claude/agents/<name>.md`) in an enabled plugin's Claude part; the built-in ones are the
// `ccb-teams` plugin. A team runs one turn in a fresh folder under <data>/runs/ and its reply comes
// back to the main bot's chat as a notice; it is stopped after an hour.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./durable/atomic";
import { languageRule, resultsRule, type AppLanguage, type ResultPublishing } from "./prompts";
import { builtInManifest, claudePluginText } from "./maintainer";
import { ClaudeHead, type HeadConfig, type HeadExit } from "./agent/head";
import type { StreamItem } from "./agent/stream";
import { parseReply } from "./reply";

export type TeamModel = "haiku" | "sonnet" | "opus";

/** One kind of team (`TeamSpec`). */
export interface TeamSpec {
  name: string;
  title: string;
  model: TeamModel;
  tools: string[];
  description: string;
  role: string;
}

/** `.whitespaces`: spaces and tabs (no newlines). */
const trimSpaces = (text: string) => text.replace(/^[\t    -   　]+|[\t    -   　]+$/g, "");
/** Swift's `split(separator:)`: empty pieces are left out. */
const split = (text: string, separator: string) => text.split(separator).filter((piece) => piece.length > 0);

/** `TeamSpec.parse`: front matter between `---` lines, the rest is the role. Null without a name. */
export function parseTeam(text: string): TeamSpec | null {
  const parts = text.split("---");
  if (parts.length < 3) return null;
  const fields: Record<string, string> = {};
  for (const line of split(parts[1]!, "\n")) {
    const at = line.indexOf(":");
    // split(separator: ":", maxSplits: 1) leaving out empty pieces: "key: value" → 2 pieces.
    const pieces = at < 0 ? [line] : [line.slice(0, at), line.slice(at + 1)].filter((piece) => piece.length > 0);
    if (pieces.length === 2) fields[trimSpaces(pieces[0]!)] = trimSpaces(pieces[1]!);
  }
  const name = fields.name;
  if (!name) return null;
  const model = fields.model;
  return {
    name,
    title: fields.title ?? name,
    model: model === "haiku" || model === "sonnet" || model === "opus" ? model : "sonnet",
    tools: split(fields.tools ?? "Read, Write", ",").map(trimSpaces),
    description: fields.description ?? "",
    role: parts.slice(2).join("---").trim(),
  };
}

/** `TeamSpec.fileText`. */
export function teamFileText(spec: TeamSpec): string {
  return `---\nname: ${spec.name}\ntitle: ${spec.title}\nmodel: ${spec.model}\ntools: ${spec.tools.join(", ")}\ndescription: ${spec.description}\n---\n${spec.role}\n`;
}

/** `TeamSpec.defaults`: the research and prototype teams. */
export const DEFAULT_TEAMS: TeamSpec[] = [
  {
    name: "research",
    title: "Research team",
    model: "sonnet",
    tools: ["Read", "Write", "Edit", "WebSearch", "WebFetch"],
    description: "Looks things up, compares options, hands back a one-page report.",
    role: "You are a research team started for one job. Get the facts straight, compare the options, give a recommendation. Link your sources; if you cannot find something, say so instead of guessing.",
  },
  {
    name: "prototype",
    title: "Prototype team",
    model: "sonnet",
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    description: "Builds a small working prototype or tool in its own folder, hands back a preview page.",
    role: "You are a prototype team started for one job. Build the smallest version that runs in your working folder: working first, pretty later. When done, make sure it really runs.",
  },
];

/** The Artifact tool (`ResultPublishing.tool`). */
const ARTIFACT_TOOL = "Artifact";

/** `TeamPrompts.system`. */
export function teamSystem(spec: TeamSpec, folder: string, results: ResultPublishing = "artifactUnlessSensitive", language: AppLanguage = "en"): string {
  return [
    spec.role,
    `- ${languageRule(language)} The task below may be written in the user's language. Your working folder is ${folder}; read and write only there.`,
    `- ${resultsRule(results, join(folder, "artifacts"))}`,
    "- Do not ask questions: when unsure, make reasonable assumptions and write them down in the result page.",
    "- Your final reply is at most 3 sentences: what you did, the conclusion, then the result's link, [result name](url).",
  ].join("\n");
}

/** `TeamPrompts.tools`: its own, plus the Artifact tool when results may be published. */
export function teamTools(spec: TeamSpec, results: ResultPublishing): string[] {
  return results === "localOnly" || spec.tools.includes(ARTIFACT_TOOL) ? spec.tools : [...spec.tools, ARTIFACT_TOOL];
}

/** `TeamPrompts.task`. */
export const teamTask = (task: string) => `(App: A task from the main bot)\n${task}`;

/**
 * `Workspace.prepareTeamsPlugin`: the `ccb-teams` plugin holds the teams as Claude Code agents. Team
 * files from before plugins (`<data>/teams`) move into it once; the old folder is kept as `teams.v1-backup`.
 */
export function prepareTeamsPlugin(library: string, old: string) {
  const plugin = join(library, "ccb-teams");
  if (existsSync(plugin)) return;
  const agents = join(plugin, "claude", "agents");
  mkdirSync(agents, { recursive: true });
  mkdirSync(join(plugin, "claude", ".claude-plugin"), { recursive: true });
  let oldFiles: string[] = [];
  try { oldFiles = readdirSync(old).filter((name) => name.endsWith(".md")); } catch { /* none */ }
  if (!oldFiles.length) {
    for (const spec of DEFAULT_TEAMS) writeFileAtomic(join(agents, `${spec.name}.md`), teamFileText(spec));
  } else {
    for (const name of oldFiles) { try { copyFileSync(join(old, name), join(agents, name)); } catch { /* unreadable */ } }
  }
  if (existsSync(old)) { try { renameSync(old, join(old, "..", "teams.v1-backup")); } catch { /* kept */ } }
  writeFileAtomic(join(plugin, "claude", ".claude-plugin", "plugin.json"), claudePluginText("ccb-teams", "Botling's temporary teams: Research team, Prototype team."));
  writeFileAtomic(join(plugin, "package.json"), builtInManifest("ccb-teams", "Temporary teams", "Temporary teams the main bot can start. Each team is one agent file in claude/agents/.", ["claude"], { claude: "claude" }));
}

/** `Workspace.loadTeams`: the agents in enabled plugins' Claude parts (not ccb-core's); the first of a name wins. */
export function loadTeams(agentFiles: { plugin: string; file: string }[]): TeamSpec[] {
  const seen = new Set<string>();
  const specs: TeamSpec[] = [];
  for (const { plugin, file } of agentFiles) {
    if (plugin === "ccb-core") continue;
    let spec: TeamSpec | null = null;
    try { spec = parseTeam(readFileSync(file, "utf8")); } catch { /* unreadable */ }
    if (!spec || seen.has(spec.name)) continue;
    seen.add(spec.name);
    specs.push(spec);
  }
  return specs.length ? specs : DEFAULT_TEAMS;
}

/** A team at work (`TeamRun`). */
export interface TeamRun {
  id: string;
  spec: TeamSpec;
  task: string;
  folder: string;
  /** ms since 1970. */
  startedAt: number;
}

/** The run's folder name: `yyyyMMdd-HHmmss-<team>`, local time (1.x's stamp). */
export function runFolderName(spec: TeamSpec, at = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}-${spec.name}`;
}

export const newRunId = () => randomUUID().toUpperCase();

// ---------------------------------------------------------------------------------------------
// Running teams (`Workspace.startTeam`)

export interface TeamDeskDeps {
  root: string;
  /** The team's head: the same way bots' heads run (the real CLI, or the fake one in tests). */
  config: (folder: string, spec: TeamSpec, tools: string[], session: { sessionId: string; systemPrompt: string; model: string }) => HeadConfig;
  language: () => AppLanguage;
  results: () => ResultPublishing;
  /** The teams there are now (from plugins' agent files). */
  teams: () => TeamSpec[];
  /** A line in the main bot's chat. */
  tell: (text: string) => void;
  /** The running list changed. */
  changed: () => void;
  ledger?: { record(pid: number): void; forget(pid: number): void };
  log: (line: string) => void;
  /** A team that runs away is stopped after this long (1.x: an hour). */
  limitMs?: number;
}

/** The teams at work, each one turn of its own head (`runningTeams`). */
export class TeamDesk {
  private runs = new Map<string, { run: TeamRun; head: ClaudeHead; timer: NodeJS.Timeout }>();

  constructor(private deps: TeamDeskDeps) {}

  get running(): TeamRun[] {
    return [...this.runs.values()].map((entry) => entry.run);
  }

  /** Pulls up a team in a fresh folder, gives it the task, and brings its reply back to the main bot's chat. */
  start(name: string, task: string, now = new Date()): TeamRun | null {
    const teams = this.deps.teams();
    const spec = teams.find((candidate) => candidate.name === name) ?? teams[0] ?? DEFAULT_TEAMS[0]!;
    const folder = join(this.deps.root, "runs", runFolderName(spec, now));
    mkdirSync(join(folder, "artifacts"), { recursive: true });
    const run: TeamRun = { id: newRunId(), spec, task, folder, startedAt: now.getTime() };
    const results = this.deps.results();
    let reported = false;
    let head: ClaudeHead | null = null;
    const end = () => {
      const entry = this.runs.get(run.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.runs.delete(run.id);
      this.deps.changed();
    };
    const onItem = (item: StreamItem) => {
      if (!head) return;
      if (item.kind === "permission") {
        // Teams are started without asking: a tool not on their list is not theirs to use.
        head.answer(item.requestId, false, item.input, "Not available to this team.");
        return;
      }
      if (item.kind !== "result" || reported) return;
      reported = true;
      this.deps.tell(`${spec.title}: ${parseReply(item.text).body}`);
      head.finish();
    };
    const onExit = (exit: HeadExit) => {
      if (head && head.pid > 0) this.deps.ledger?.forget(head.pid);
      if (!reported) this.deps.tell(`${spec.title} did not finish: ${exit.stderr ? exit.stderr : `exit code ${exit.code ?? exit.signal ?? "?"}`}`);
      end();
    };
    try {
      const config = this.deps.config(folder, spec, teamTools(spec, results), { sessionId: run.id.toLowerCase(), systemPrompt: teamSystem(spec, folder, results, this.deps.language()), model: spec.model });
      head = new ClaudeHead({ ...config, askPermission: false }, { onItem, onExit });
    } catch (error) {
      this.deps.tell(`${spec.title} could not start: ${(error as Error).message}`);
      return null;
    }
    try {
      head.start();
    } catch (error) {
      this.deps.tell(`${spec.title} could not start: ${(error as Error).message}`);
      return null;
    }
    const started = head;
    if (started.pid > 0) this.deps.ledger?.record(started.pid);
    // A team that runs away is stopped after an hour.
    const timer = setTimeout(() => { void started.terminate(); }, this.deps.limitMs ?? 3_600_000);
    timer.unref?.();
    this.runs.set(run.id, { run, head: started, timer });
    started.send(teamTask(task), randomUUID());
    this.deps.log(`team ${spec.name} started in ${folder}`);
    this.deps.changed();
    return run;
  }

  /** Quitting: every team ends with its tree. */
  async shutdown() {
    const entries = [...this.runs.values()];
    for (const entry of entries) clearTimeout(entry.timer);
    await Promise.all(entries.map((entry) => entry.head.terminate(500)));
  }
}
