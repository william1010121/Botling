// Phase 4b: temporary teams, bots of their own, removing a bot or project, <open-question> copies,
// subagent rows and settling them, and the links a chat hands over (Results). The strings are
// checked against what the Swift app's own code wrote (test/fixtures/teams-golden.json, from
// Tests/ClaudeCodeBotCoreTests/DesktopTeamsGoldenExport.swift).
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import { DEFAULT_TEAMS, loadTeams, parseTeam, prepareTeamsPlugin, runFolderName, teamFileText, teamSystem, teamTask, teamTools } from "../../src/core/teams";
import { botName, projectBriefingText } from "../../src/core/projects";
import { headArguments } from "../../src/core/agent/head";
import { listedRows, resultLinks, settledRows } from "../../src/contract";
import golden from "../fixtures/teams-golden.json";

const MAINTAINER = "DEC0DE00-0000-4000-8000-00000000DEC0";
const harnesses: CoreHarness[] = [];
function core(dir: string, env: Record<string, string> = {}) {
  const harness = new CoreHarness(dir, { FAKE_CLAUDE_INPUT: join(dir, "claude-input.log"), BOTLING_ROUTINE_TICK_MS: "0", BOTLING_COMPONENT_SCAN_MS: "0", BOTLING_WAITING_SCAN_MS: "0", BOTLING_QUIT_TIDY_MS: "0", ...env });
  harnesses.push(harness);
  return harness;
}
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});
const logged = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
async function reply(c: CoreHarness, botId: string, text: string) {
  const { turnId } = await c.call({ type: "chat.send", botId, text });
  return until(() => c.of("turn.finished").find((e) => (e.event as any).turnId === turnId), { what: `reply to ${text}` });
}
const project = (name: string) => {
  const folder = join(tempDir("proj"), name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "package.json"), "{}");
  return folder;
};

describe("teams, bot names and the project list, string for string as the Swift app", () => {
  it("the default teams' agent files, their system prompts, tools and task", () => {
    expect(DEFAULT_TEAMS.map((spec) => ({ name: spec.name, fileText: teamFileText(spec) }))).toEqual(golden.defaults);
    expect(teamTask("Compare three note apps")).toBe(golden.task);
    for (const row of golden.system) {
      const spec = DEFAULT_TEAMS.find((candidate) => candidate.name === row.team)!;
      expect(teamSystem(spec, "/r/runs/20260101-120000-research", row.results as any, row.language as any)).toBe(row.system);
      expect(teamTools(spec, row.results as any)).toEqual(row.tools);
    }
    expect(golden.system).toHaveLength(12);
  });

  it("reads team files as TeamSpec.parse does", () => {
    for (const row of golden.parsed as { text: string; spec: unknown }[]) expect(parseTeam(row.text)).toEqual(row.spec);
  });

  it("keeps bot names as Workspace.botName does", () => {
    expect(["  Morning news  ", "a\"b@c<d>e`f", "first line\nsecond", "x".repeat(50) + " ", ""].map(botName)).toEqual(golden.botNames);
  });

  it("the main bot's project list with the team lines, and the <open-question> note when one asks", () => {
    const b = golden.briefing;
    const maintainer = { name: "Maintainer", about: "plugin-library extensions and in-chat components only", memory: `${b.root}/plugins/.bot/memory.md`, inbox: `${b.root}/plugins/.bot/inbox.md`, question: null };
    const teams = [DEFAULT_TEAMS[1]!, DEFAULT_TEAMS[0]!];
    const shop = { name: "Shop", about: `folder ${b.shop}`, memory: `${b.shop}/.bot/memory.md`, inbox: `${b.shop}/.bot/inbox.md`, question: null as string | null };
    const news = { name: b.newsName, about: "Every day at 08:00, the top 5 tech stories.", memory: `${b.news}/.bot/memory.md`, inbox: `${b.news}/.bot/inbox.md`, question: null };
    expect(projectBriefingText({ projects: [], bots: [], maintainer, teams })).toBe(b.empty);
    expect(projectBriefingText({ projects: [shop], bots: [news], maintainer, teams })).toBe(b.plain);
    expect(projectBriefingText({ projects: [{ ...shop, question: "Which theme?\nMore words" }], bots: [news], maintainer, teams })).toBe(b.asking);
  });

  it("the ccb-teams plugin is made once (old team files move in); teams come from enabled plugins' agents, ccb-core's left out", () => {
    const root = tempDir("teams-plugin");
    const old = join(root, "teams");
    mkdirSync(old);
    writeFileSync(join(old, "writers.md"), "---\nname: writers\nmodel: haiku\n---\nYou write.");
    prepareTeamsPlugin(join(root, "plugins"), old);
    const agents = join(root, "plugins", "ccb-teams", "claude", "agents");
    expect(readFileSync(join(agents, "writers.md"), "utf8")).toContain("name: writers");
    expect(existsSync(join(root, "teams.v1-backup", "writers.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "plugins", "ccb-teams", "package.json"), "utf8"))).toMatchObject({ name: "ccb-teams", displayName: "Temporary teams", ccb: { permissions: ["claude"], claude: "claude" } });
    const fresh = tempDir("teams-fresh");
    prepareTeamsPlugin(join(fresh, "plugins"), join(fresh, "teams"));
    expect(readFileSync(join(fresh, "plugins", "ccb-teams", "claude", "agents", "research.md"), "utf8")).toBe(teamFileText(DEFAULT_TEAMS[0]!));
    const specs = loadTeams([{ plugin: "ccb-core", file: join(agents, "writers.md") }, { plugin: "ccb-teams", file: join(agents, "writers.md") }, { plugin: "other", file: join(agents, "writers.md") }]);
    expect(specs.map((spec) => [spec.name, spec.model])).toEqual([["writers", "haiku"]]);
    expect(loadTeams([])).toEqual(DEFAULT_TEAMS);
    expect(runFolderName(DEFAULT_TEAMS[0]!, new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102-030405-research");
  });

  it("a team's head asks nothing (no permission prompt tool), as 1.x's teams", () => {
    const args = headArguments({ command: "claude", cwd: "/r", sessionId: "s", resume: false, allowedTools: ["Read", "Artifact"], askPermission: false });
    expect(args).not.toContain("--permission-prompt-tool");
    expect(args).not.toContain("AskUserQuestion");
    expect(args.join(" ")).toContain("--allowedTools Read,Artifact");
    expect(headArguments({ command: "claude", cwd: "/r", sessionId: "s", resume: false, allowedTools: [] })).toContain("--permission-prompt-tool");
  });

  it("subagent rows: running and recently ended ones are listed (at most 4), settled ones are not", () => {
    const now = 1_000_000_000;
    const row = (id: string, status: string, startedAt: number, endedAt: number | null, settled = false, unsettledAt: number | null = null) =>
      ({ id, title: id, status, head: null, startedAt, endedAt, unsettledAt, settled, prompt: "" }) as any;
    const rows = [row("old", "completed", now - 3_600_000, now - 11 * 60_000), row("a", "completed", now - 60_000, now - 30_000), row("b", "running", now - 120_000, null),
      row("c", "failed", now - 50_000, now - 10_000), row("d", "running", now - 10_000, null, true), row("e", "stopped", now - 40_000, now - 20_000), row("f", "completed", now - 30_000, now - 5_000),
      row("back", "completed", now - 7_200_000, now - 7_000_000, false, now - 60_000)];
    expect(listedRows(rows, now, null).map((r: any) => r.id)).toEqual(["b", "f", "e", "c", "a", "back"]);
    expect(listedRows(rows, now).map((r: any) => r.id)).toEqual(["b", "f", "e", "c"]);
    expect(settledRows(rows).map((r: any) => r.id)).toEqual(["d"]);
  });

  it("the links a chat hands over, newest first, each once (Bot.results)", () => {
    const lines = [
      { role: "bot", text: "See [Plan](file:///a/plan.html) and [Doc](https://claude.ai/artifact/x)" },
      { role: "user", text: "[Mine](https://example.com)" },
      { role: "notice", text: "Research team: done, [Report](file:///r/report.html). Also [Plan](file:///a/plan.html)" },
      { role: "bot", text: "[bad link](has space) [x](y)" },
    ];
    expect(resultLinks(lines)).toEqual([
      { label: "x", url: "y" },
      { label: "Report", url: "file:///r/report.html" },
      { label: "Plan", url: "file:///a/plan.html" },
      { label: "Doc", url: "https://claude.ai/artifact/x" },
    ]);
  });
});

describe("teams, bots and settling through the core", () => {
  it("<team>: a run in its own folder, asking nothing; its reply comes back to the main bot's chat; teams.updated before and after", async () => {
    const dir = tempDir("team-run");
    const c = core(dir, { FAKE_CLAUDE_ARGS: join(dir, "args.log") });
    await reply(c, MAIN, "/say Handed to the Research team.\n<team name=\"research\">/say Done: compared them. [Report](file:///tmp/report.html)</team>");
    const notice = await until(async () => (await c.chat()).messages.find((m: any) => m.role === "notice" && m.text.startsWith("Research team:")), { what: "the team's reply" });
    expect(notice.text).toBe("Research team: Done: compared them. [Report](file:///tmp/report.html)");
    const updates = c.of("teams.updated").map((e) => (e.event as any).teams);
    expect(updates[0]).toEqual([expect.objectContaining({ name: "research", title: "Research team", task: "/say Done: compared them. [Report](file:///tmp/report.html)" })]);
    await until(() => c.of("teams.updated").some((e) => (e.event as any).teams.length === 0), { what: "the team done" });
    expect((await c.call({ type: "chat.snapshot" })).teams).toEqual([]);
    // Its own folder under runs/, with artifacts/; claude ran there with the team's tools and no permission prompt tool.
    const team = logged(join(dir, "args.log")).find((line) => line.args.some((arg: string) => arg.startsWith("You are a research team")));
    expect(team).toBeTruthy();
    expect(team.args).not.toContain("--permission-prompt-tool");
    expect(team.args[team.args.indexOf("--allowedTools") + 1]).toBe("Read,Write,Edit,WebSearch,WebFetch,Artifact");
    expect(team.args[team.args.indexOf("--model") + 1]).toBe("sonnet");
    expect(team.args[team.args.indexOf("--append-system-prompt") + 1]).toMatch(/^You are a research team started for one job\./);
    const input = logged(join(dir, "claude-input.log")).find((line) => line.text.startsWith("(App: A task from the main bot)\n"));
    expect(input.text).toBe("(App: A task from the main bot)\n/say Done: compared them. [Report](file:///tmp/report.html)");
    // The result is one of the main bot's results now.
    expect((await c.call({ type: "results.list", botId: MAIN })).results[0]).toEqual({ label: "Report", url: "file:///tmp/report.html" });
    // A manager's <team> is not acted on (only the main bot pulls up teams), and no "cannot do" notice.
    const { botId } = await c.call({ type: "projects.add", folder: project("Shop") });
    const before = c.of("teams.updated").length;
    await reply(c, botId, "/team");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(c.of("teams.updated").length).toBe(before);
    expect((await c.chat(botId)).messages.some((m: any) => m.text.includes("cannot do this yet"))).toBe(false);
  });

  it("New bot: a row in projects.json with its job, its own folder, set up at once; the same name again is that bot; the app's names are taken", async () => {
    const dir = tempDir("new-bot");
    const c = core(dir);
    const made = await c.call({ type: "bots.create", name: "Morning \"news\"", job: "Every day at 08:00, the top 5 tech stories.\nIn English." });
    expect(made.created).toBe(true);
    const rows = JSON.parse(readFileSync(join(dir, "projects.json"), "utf8"));
    expect(rows).toEqual([{ id: made.botId, name: "Morning news", folder: `file://${join(dir, "bots", made.botId)}/`, avatar: "square", job: "Every day at 08:00, the top 5 tech stories.\nIn English." }]);
    expect(readFileSync(join(dir, "bots", made.botId, ".bot", ".gitignore"), "utf8")).toBe("*\n");
    const bot = (await c.call({ type: "chat.snapshot" })).bots.find((b: any) => b.id === made.botId);
    expect(bot).toMatchObject({ name: "Morning news", role: "bot", job: "Every day at 08:00, the top 5 tech stories.\nIn English.", subagentRows: [] });
    // It is handed its job (1.x's set-up note) and answers.
    const relay = await until(async () => (await c.chat(made.botId)).messages.find((m: any) => m.role === "relay"), { what: "the set-up note" });
    expect(relay.text).toBe("(App) You were just created. Your job: Every day at 08:00, the top 5 tech stories.\nIn English.\nIf it should happen at fixed times, add those jobs to your routines file now; if it is a report, also do the first one now. Then introduce yourself to the user in one sentence.");
    await until(async () => (await c.chat()).messages.some((m: any) => m.role === "notice" && m.text === "New bot \"Morning news\": Every day at 08:00, the top 5 tech stories."), { what: "the notice" });
    expect(await c.call({ type: "bots.create", name: "morning NEWS", job: "x" })).toEqual({ botId: made.botId, created: false });
    await expect(c.call({ type: "bots.create", name: "Main bot", job: "x" })).rejects.toThrow("conflict");
    await expect(c.call({ type: "bots.create", name: "@\"", job: "x" })).rejects.toThrow("bad_request");
    // The main bot's wake note lists it among the bots of their own.
    await reply(c, MAIN, "hi");
    const wake = logged(join(dir, "claude-input.log")).find((line) => line.text.includes("(App: Project list."))!.text as string;
    expect(wake).toContain(`(App: Bots of their own, which you reach the same way.)\n- Morning news (Every day at 08:00, the top 5 tech stories.): memory file ${join(dir, "bots", made.botId, ".bot", "memory.md")}; inbox file ${join(dir, "bots", made.botId, ".bot", "inbox.md")}`);
  });

  it("<new-bot> from the main bot makes one; from a manager it is left out; an existing name is said", async () => {
    const dir = tempDir("new-bot-tag");
    const c = core(dir);
    await reply(c, MAIN, "/say Created Reading coach.\n<new-bot name=\"Reading coach\">Helps me read one chapter a day.</new-bot>");
    const bots = await until(async () => { const all = (await c.call({ type: "chat.snapshot" })).bots; return all.find((b: any) => b.name === "Reading coach") ? all : null; }, { what: "the bot" });
    expect(bots.map((b: any) => b.name)).toEqual(["Main bot", "Reading coach", "Maintainer"]);
    await reply(c, MAIN, "/say <new-bot name=\"reading coach\">again</new-bot>");
    await until(async () => (await c.chat()).messages.some((m: any) => m.text === "There is already a bot called \"Reading coach\"; nothing new was made. To change its job, tell it, or remove it from its menu first."), { what: "the notice" });
    const { botId } = await c.call({ type: "projects.add", folder: project("Shop") });
    await reply(c, botId, "/say <new-bot name=\"Sneaky\">x</new-bot>");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await c.call({ type: "chat.snapshot" })).bots.some((b: any) => b.name === "Sneaky")).toBe(false);
  });

  it("removing a bot or a project: out of the list and projects.json, stopped, nothing deleted; the main bot and Maintainer stay", async () => {
    const dir = tempDir("remove");
    const folder = project("Keep");
    writeFileSync(join(folder, "important.txt"), "mine");
    const c = core(dir);
    const shop = await c.call({ type: "projects.add", folder });
    const bot = await c.call({ type: "bots.create", name: "Helper", job: "Helps." });
    await until(async () => (await c.chat(bot.botId)).messages.some((m: any) => m.role === "bot"), { what: "the new bot's hello" });
    await expect(c.call({ type: "bots.remove", botId: MAIN })).rejects.toThrow("forbidden");
    await expect(c.call({ type: "bots.remove", botId: MAINTAINER })).rejects.toThrow("forbidden");
    expect(await c.call({ type: "bots.remove", botId: bot.botId })).toEqual({ removed: true });
    expect(c.of("bot.removed").map((e) => (e.event as any).botId)).toEqual([bot.botId]);
    expect(existsSync(join(dir, "bots", bot.botId, ".bot"))).toBe(true);
    expect(existsSync(join(dir, "projects", bot.botId, "chat.json"))).toBe(true);
    await until(async () => (await c.chat()).messages.some((m: any) => m.text === `Removed the bot "Helper". Its folder stays at ${join(dir, "bots", bot.botId)}.`), { what: "the notice" });
    await c.call({ type: "bots.remove", botId: shop.botId });
    expect(readFileSync(join(folder, "important.txt"), "utf8")).toBe("mine");
    expect(existsSync(join(folder, ".bot", ".gitignore"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "projects.json"), "utf8"))).toEqual([]);
    expect((await c.call({ type: "chat.snapshot" })).bots.map((b: any) => b.name)).toEqual(["Main bot", "Maintainer"]);
    await expect(c.call({ type: "chat.send", botId: shop.botId, text: "hi" })).rejects.toThrow("not_found");
    // After a restart it is still gone; adding the folder again makes it a project again.
    await c.kill();
    const again = core(dir);
    expect((await again.call({ type: "chat.snapshot" })).bots.map((b: any) => b.name)).toEqual(["Main bot", "Maintainer"]);
    expect((await again.call({ type: "projects.add", folder })).added).toBe(true);
  });

  it("subagent rows in the bot's view; settling moves one to Settled (kept as 1.x's dismissedAt) and back", async () => {
    const dir = tempDir("settle");
    const c = core(dir);
    await reply(c, MAIN, "/agent");
    const row = await until(() => c.of("bot.updated").map((e) => (e.event as any).bot).find((b: any) => b.id === MAIN && b.subagentRows.some((r: any) => r.status === "completed"))?.subagentRows[0], { what: "the row" });
    expect(row).toMatchObject({ title: "Research the API", status: "completed", head: null, settled: false, prompt: "Look up the API and report", unsettledAt: null });
    expect(listedRows([row], Date.now())).toHaveLength(1);
    expect(await c.call({ type: "subagent.settle", botId: MAIN, subagentId: row.id, settled: true })).toEqual({ changed: true });
    expect(await c.call({ type: "subagent.settle", botId: MAIN, subagentId: row.id, settled: true })).toEqual({ changed: false });
    const settled = (await c.call({ type: "chat.snapshot" })).bots.find((b: any) => b.id === MAIN).subagentRows[0];
    expect(settled.settled).toBe(true);
    expect(typeof JSON.parse(readFileSync(join(dir, "main", "subagents.json"), "utf8"))[0].dismissedAt).toBe("number");
    await c.call({ type: "subagent.settle", botId: MAIN, subagentId: row.id, settled: false });
    const back = (await c.call({ type: "chat.snapshot" })).bots.find((b: any) => b.id === MAIN).subagentRows[0];
    expect(back.settled).toBe(false);
    expect(back.unsettledAt).toBeGreaterThan(0);
    await expect(c.call({ type: "subagent.settle", botId: MAIN, subagentId: "nope", settled: true })).rejects.toThrow("not_found");
  });

  it("<open-question>: the project's card shows in the main bot's chat; a pick there answers it in the project's chat; one settled there closes the copy", async () => {
    const dir = tempDir("open-question");
    const c = core(dir);
    const { botId } = await c.call({ type: "projects.add", folder: project("Garden") });
    await reply(c, botId, "/choices");
    const question = (await c.chat(botId)).messages.find((m: any) => m.choices?.length);
    // The project list says it asks, with the note on <open-question>.
    await reply(c, MAIN, "hi");
    const wake = logged(join(dir, "claude-input.log")).find((line) => line.text.includes("(App: Project list."))!.text as string;
    expect(wake).toContain("; open question in its chat: Which way?\n");
    expect(wake).toContain("(App: A decision marked \"open question in its chat\" already has its card there. To bring it up, write <open-question from=\"its name\"/> in your reply: the app shows that same card here. Never write a new choices block for it.)");
    await reply(c, MAIN, "/say Garden asks this: <open-question from=\"garden\"/>");
    const copy = await until(async () => (await c.chat()).messages.find((m: any) => m.role === "notice" && m.text === "Garden: Which way?"), { what: "the copy" });
    expect(copy.choices.map((choice: any) => choice.label)).toEqual(["Fast", "Slow"]);
    // The copy is the project's question, not the main bot's own (what waits on you lists it once).
    expect((await c.call({ type: "waiting.list" })).items).toEqual([{ botId, text: "Which way?", messageId: question.id }]);
    await c.call({ type: "chat.choose", botId: MAIN, messageId: copy.id, index: 1 });
    await until(async () => (await c.chat(botId)).messages.find((m: any) => m.id === question.id)?.chosen === 1, { what: "the pick in the project's chat" });
    await until(async () => (await c.chat(botId)).messages.some((m: any) => m.role === "user" && m.text === "Slow"), { what: "the pick as the project's message" });
    // A second question, settled in its own chat: the copy follows.
    await reply(c, botId, "/choices");
    const second = (await c.chat(botId)).messages.filter((m: any) => m.choices?.length).at(-1);
    await reply(c, MAIN, "/say <open-question from=\"Garden\"/>");
    const copy2 = await until(async () => (await c.chat()).messages.filter((m: any) => m.text === "Garden: Which way?").at(1), { what: "the second copy" });
    await c.call({ type: "chat.choose", botId, messageId: second.id, index: 0 });
    await until(async () => (await c.chat()).messages.find((m: any) => m.id === copy2.id)?.chosen === 0, { what: "the copy closed" });
    // No such project: nothing is shown.
    await reply(c, MAIN, "/say <open-question from=\"Nobody\"/>");
    expect((await c.chat()).messages.filter((m: any) => m.text.startsWith("Garden:"))).toHaveLength(2);
  });
});
