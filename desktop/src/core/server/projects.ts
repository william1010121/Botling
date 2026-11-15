// M7-S62: `CoreProjects` cut out of `Core` (core/server.ts). The project list: add a project, the bot requests about projects and the 1.x import. Same bridge convention as `CoreWatch` (core/server/watch.ts, in its header): a
// block of one-line forwarders to `host` first, then the members as they were in `Core`, byte for byte.
import type { Core } from "../server";
import { ProjectFiles } from "../project-files";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
import { childFolders, defaultName, folderPath, folderURLText, nextAvatar, prepareNotesFolder, projectFolders, saveProjectRow } from "../projects";
import { ContractError, type ImportView } from "../../contract";
import { Bot } from "../bot";
import { importFrom1x, importRecord, looksLike1x, needsImport } from "../store/importer";
import { projectProfile } from "../store/workspace";
import { type BotRequest } from "../reply";

export class CoreProjects {
  constructor(private readonly host: Core) {}

  // The bridge: everything this class borrows from `Core`.
  private agentTag(...a: Parameters<Core["agentTag"]>) { return this.host.agentTag(...a); }
  private attach(...a: Parameters<Core["attach"]>) { return this.host.attach(...a); }
  private botRequested(...a: Parameters<Core["botRequested"]>) { return this.host.botRequested(...a); }
  private botRequestedOn(...a: Parameters<Core["botRequestedOn"]>) { return this.host.botRequestedOn(...a); }
  private get bots() { return this.host.bots; }
  private log(...a: Parameters<Core["log"]>) { return this.host.log(...a); }
  private machineNamed(...a: Parameters<Core["machineNamed"]>) { return this.host.machineNamed(...a); }
  private mainBot(...a: Parameters<Core["mainBot"]>) { return this.host.mainBot(...a); }
  private get maintainerId() { return this.host.maintainerId; }
  private get options() { return this.host.options; }
  private get profiles() { return this.host.profiles; }
  private removeBotRequested(...a: Parameters<Core["removeBotRequested"]>) { return this.host.removeBotRequested(...a); }
  private removeSubBotRequested(...a: Parameters<Core["removeSubBotRequested"]>) { return this.host.removeSubBotRequested(...a); }
  private seedEngineDefaults(...a: Parameters<Core["seedEngineDefaults"]>) { return this.host.seedEngineDefaults(...a); }
  private showOpenQuestion(...a: Parameters<Core["showOpenQuestion"]>) { return this.host.showOpenQuestion(...a); }
  private subBotRequested(...a: Parameters<Core["subBotRequested"]>) { return this.host.subBotRequested(...a); }
  private tellMain(...a: Parameters<Core["tellMain"]>) { return this.host.tellMain(...a); }

  imported: ImportView | null = null;

  readonly projectFiles = new ProjectFiles();

  /** "Add as project?" cards waiting for your pick, by their line in the main chat. */
  private projectQuestions = new Map<string, { folder: string; task: string }[]>();

  /**
   * Adds a folder as a project with a manager (`Workspace.addProject`); a folder that is one already
   * gives that project. Its row goes into projects.json, its `.bot/` is made, its bot joins the list.
   */
  addProject(path: string): { botId: string; added: boolean } {
    const folder = folderPath(path);
    if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) throw new ContractError("not_found", `There is no folder at ${path}.`);
    const existing = this.profiles.find((profile) => profile.role !== "main" && !profile.parent && profile.folder === folder);
    if (existing) return { botId: existing.id, added: false };
    const id = randomUUID().toUpperCase();
    const row = { id, name: defaultName(folder), folder, avatar: nextAvatar(this.profiles.filter((profile) => profile.role !== "main" && profile.id !== this.maintainerId).map((profile) => profile.avatar)) };
    prepareNotesFolder(folder);
    this.seedEngineDefaults(id);
    saveProjectRow(this.options.dataDir, row);
    this.attach(projectProfile(this.options.dataDir, { id, name: row.name, folder: folderURLText(folder), avatar: row.avatar }));
    this.log(`added project ${row.name} (${folder})`);
    return { botId: id, added: true };
  }

  /**
   * The main bot's <new-project folder="…">task</new-project> (`proposeProjects`): folders found (`/*`,
   * `/**`), ones that are projects already get the task, the rest are asked about on one card.
   */
  projectRequests(bot: Bot, requests: BotRequest[]): BotRequest[] {
    // New bots and <open-question> (`Workspace.handle`): only the main bot
    // shows other bots' cards; it makes bots when you ask it, and Maintainer may too. From anyone else
    // they are left out, as in 1.x. They act once the reply is in.
    const main = bot.profile.role === "main";
    const later: (() => void)[] = [];
    const rest: BotRequest[] = [];
    // M5-04d: one bots.create per machine and name in a reply, however often the tag was written.
    const elsewhere = new Set<string>();
    for (const request of requests) {
      if (request.kind === "newBot" && request.machine) {
        // Only the main bot acts on another machine (D26); from anyone else the tag is left out, as a tag from a bot that may not make bots.
        if (main) later.push(() => this.botRequestedOn(request.machine!, request.name, request.job, elsewhere));
        else if (bot.id === this.maintainerId && this.machineNamed(request.machine).kind === "here") later.push(() => this.botRequested(request.name, request.job, bot.profile.name));
      }
      else if (request.kind === "newBot") { if (main || bot.id === this.maintainerId) later.push(() => this.botRequested(request.name, request.job, main ? null : bot.profile.name)); }
      else if (request.kind === "openQuestion") { if (main) later.push(() => this.showOpenQuestion(request.from)); }
      else if (request.kind === "subBot") later.push(() => { void this.subBotRequested(bot, request); });
      else if (request.kind === "removeSubBot") later.push(() => { void this.removeSubBotRequested(bot, request); });
      else if (request.kind === "removeBot") later.push(() => this.removeBotRequested(bot, request));
      else if (request.kind === "agentMessage" || request.kind === "agentStop") later.push(() => { void this.agentTag(bot, request); });
      else rest.push(request);
    }
    if (later.length) setImmediate(() => { for (const act of later) { try { act(); } catch (error) { this.log(`request: ${(error as Error).message}`); } } });
    return this.newProjectRequests(bot, rest);
  }

  /** The main bot's <new-project> requests: found, asked about on one card (the rest are passed on). */
  private newProjectRequests(bot: Bot, requests: BotRequest[]): BotRequest[] {
    const asked = requests.filter((request): request is Extract<BotRequest, { kind: "newProject" }> => request.kind === "newProject");
    if (!asked.length) return requests;
    // Only the main bot adds projects; anyone else's <new-project> is left out silently, as in 1.x (`Workspace.handle`).
    if (bot.profile.role !== "main") return requests.filter((request) => request.kind !== "newProject");
    const main = bot;
    const home = homedir();
    const own = resolvePath(this.options.dataDir);
    // M5-04d: `projects.add` is never sent. A project on another machine is that machine's own window's to add.
    const told = new Set<string>();
    const here = asked.filter((request) => {
      if (!request.machine) return true;
      const machine = this.machineNamed(request.machine);
      if (machine.kind === "here") return true;
      if (machine.kind === "unknown") {
        this.tellMain((p) => `There is no machine named "${p(machine.name)}"; the project was not added.`);
      } else if (!told.has(machine.name.toLowerCase())) {
        told.add(machine.name.toLowerCase());
        this.tellMain((p) => `Adding a project on ${p(machine.name)} needs ${p(machine.name)}'s own window.`);
      }
      return false;
    });
    const adding: { folder: string; task: string }[] = [];
    const missing: string[] = [];
    const tooBroad: string[] = [];
    const handed: string[] = [];
    const expanded: { path: string; task: string }[] = [];
    for (const { folder: path, task } of here) {
      const trimmed = path.trim();
      if (trimmed.endsWith("/**")) {
        const parent = folderPath(trimmed.slice(0, -3));
        if (!parent || !existsSync(parent)) { missing.push(trimmed.slice(0, -3)); continue; }
        const found = projectFolders(parent);
        if (!found.length) missing.push(trimmed);
        expanded.push(...found.map((folder) => ({ path: folder, task })));
        continue;
      }
      if (!trimmed.endsWith("/*")) { expanded.push({ path, task }); continue; }
      const parent = folderPath(trimmed.slice(0, -2));
      const inside = parent ? childFolders(parent) : null;
      if (!inside) { missing.push(trimmed.slice(0, -2)); continue; }
      if (!inside.length) missing.push(trimmed);
      expanded.push(...inside.map((folder) => ({ path: folder, task })));
    }
    for (const { path, task: raw } of expanded) {
      const task = raw.trim();
      const folder = folderPath(path);
      if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) { missing.push(path); continue; }
      if (folder === "/" || folder === home || folder === own || folder.startsWith(own + "/")) { tooBroad.push(folder); continue; }
      const existing = this.profiles.find((profile) => profile.role !== "main" && !profile.parent && profile.folder === folder);
      if (existing) {
        if (task) { try { this.bots.get(existing.id)?.relay(task); } catch { /* read-only */ } }
        handed.push(existing.name);
        continue;
      }
      if (!adding.some((entry) => entry.folder === folder)) adding.push({ folder, task });
    }
    const notes: string[] = [];
    if (missing.length) {
      main.appNotice(`Couldn't add a project: there is no folder at ${missing.join(", ")}.`);
      notes.push(`There is no folder at ${missing.join(", ")}; nothing was added for it. Ask the user for the full path.`);
    }
    if (tooBroad.length) {
      main.appNotice(`Couldn't add ${tooBroad.join(", ")} as a project: a manager there could change far more than one project.`);
      notes.push(`${tooBroad.join(", ")} was not added: a whole disk, the home folder or Botling's own folder cannot be a project. Ask for the project's own folder.`);
    }
    if (handed.length) main.appNotice(handed.length === 1 ? `${handed[0]} is already a project; any task went to its manager.` : `${handed.join(", ")} are already projects; any task went to their managers.`);
    if (adding.length) {
      let text: string;
      let add: string;
      if (adding.length === 1) {
        const only = adding[0]!;
        text = `Add **${basename(only.folder)}** as a project?\n\n\`${only.folder}\`\n\nIts manager can read and change the files in this folder.${only.task ? `\n\nThen its manager starts on: ${only.task}` : ""}`;
        add = "Add as project";
      } else {
        const tasks = new Set(adding.map((entry) => entry.task));
        const shared = tasks.size === 1 ? [...tasks][0]! : null;
        const list = adding.map((entry) => `- **${basename(entry.folder)}** \`${entry.folder}\`${shared !== null || !entry.task ? "" : ` — then: ${entry.task}`}`);
        const then = shared ? `\n\nThen each manager starts on: ${shared}` : "";
        text = `Add these ${adding.length} folders as projects?\n\n${list.join("\n")}${then}\n\nEach gets a manager that can read and change the files in its folder. To leave some out, tell the main bot instead.`;
        add = `Add all ${adding.length}`;
      }
      const question = main.appNotice(text, [{ label: add, recommended: true }, { label: "Don't add" }], (index) => this.answerProjects(question, index === 0));
      this.projectQuestions.set(question, adding);
      notes.push(`The user now sees a card asking to add ${adding.length === 1 ? "this folder" : `these ${adding.length} folders`} as projects: ${adding.map((entry) => entry.folder).join(", ")}. Nothing is added until they pick.`);
    }
    if (notes.length) main.queueNote(`(App: ${notes.join(" ")})`);
    return requests.filter((request) => request.kind !== "newProject");
  }

  /** Your pick on an "Add as project?" card (`answerProjects`). */
  private answerProjects(question: string, add: boolean) {
    const folders = this.projectQuestions.get(question);
    this.projectQuestions.delete(question);
    const main = this.mainBot();
    if (!folders || !main) return;
    const paths = folders.map((entry) => entry.folder).join(", ");
    if (!add) { main.queueNote(`(App: The user chose not to add ${paths} as projects.)`); return; }
    const names: string[] = [];
    for (const { folder, task } of folders) {
      try {
        const { botId } = this.addProject(folder);
        names.push(this.bots.get(botId)!.profile.name);
        if (task) this.bots.get(botId)?.relay(task);
      } catch (error) {
        this.log(`adding ${folder}: ${(error as Error).message}`);
      }
    }
    if (!names.length) { main.appNotice(`Couldn't add ${paths} as ${folders.length === 1 ? "a project" : "projects"}.`); return; }
    const list = names.join(", ");
    const anyTask = folders.some((entry) => entry.task);
    main.appNotice(names.length === 1
      ? (anyTask ? `Added ${list} as a project; the managers with a task are on it.` : `Added ${list} as a project.`)
      : (anyTask ? `Added ${list} as projects; the managers with a task are on it.` : `Added ${list} as projects.`));
    main.queueNote(`(App: The user added ${list} as projects (${paths}); they are in the project list now.)`);
  }

  importOnce() {
    const source = this.options.importFrom;
    const root = this.options.dataDir;
    if (source && needsImport(root)) {
      if (looksLike1x(source)) {
        try {
          const report = importFrom1x(source, root);
          this.log(`imported ${report.bots.length} bot(s) and ${report.messages} message(s) from ${source} (read-only); skipped ${report.skipped.length}`);
        } catch (error) {
          this.log(`import from ${source} failed: ${(error as Error).message}`);
        }
      } else {
        this.log(`nothing to import: ${source} is not a Botling 1.x data folder`);
      }
    }
    const report = importRecord(root);
    if (report) {
      this.imported = {
        source: report.source.slice(0, 4_000), at: report.at, bots: report.bots.length, messages: report.messages,
        skipped: report.skipped.slice(0, 200).map((entry) => entry.slice(0, 2_000)),
      };
    }
  }
}
