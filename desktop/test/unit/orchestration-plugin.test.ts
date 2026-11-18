// M7-O04: the built-in orchestration plugin carries the rules; a failure falls back to core's own. The built-in's answer is core's default
// byte for byte; a plugin that throws, is slow or is not the shipped file never changes a prompt and never delays a turn; one setting
// goes back to the shipped rules; no project, library copy or Plugins-page switch can replace or turn off the built-in.
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Core } from "../../src/core/server";
import type { Bot } from "../../src/core/bot";
import type { BotProfile } from "../../src/core/store/workspace";
import { CoreSend } from "../../src/core/server/send";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { orchestrationPlugin, orchestrationPluginSha256, writeSettings } from "../../src/core/settings";
import { DEFAULT_ORCHESTRATION_RULES as DEFAULT, renderFragments, SECTION_IDS, type Fragment, type OrchestrationRules } from "../../src/core/orchestration/default-rules";
import { BUILTIN_RULES_SHA256 } from "../../src/core/orchestration/pinned-hash";
import { builtinSource, chosenSource, OrchestrationRulesBook, parseSlots, RULES_NOTICE, RULES_TIME_LIMIT_MS, withSlots, type Slots } from "../../src/core/orchestration/plugin-rules";
import { DELEGATION_CAPS, delegationPolicy, type DelegationCaps } from "../../src/core/prompts/delegation";
import { claudeWorkerPolicy } from "../../src/core/agent/claude-workers";
import { AgyWorkers, type AgyWorkerHead } from "../../src/core/agent/agy-workers";
import type { AgyConfig } from "../../src/core/agent/agy";
import { agyWorkerPolicy } from "../../src/core/prompts-agy";
import { Core as RealCore } from "../../src/core/server";
import { MAIN_BOT_ID } from "../../src/core/store/records";
import { claudeHarness } from "../claude-workers-fake";
import { desktop, tempDir } from "../helpers";

const BUILT = join(desktop, "builtin-plugins");
const RULES_FILE = join(BUILT, "botling.orchestration", "rules.json");
const golden: Record<string, string> = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "orchestration-default-rules-golden.json"), "utf8"));
const ENGINES = ["claude", "codex", "agy"] as const;
const CAPS: DelegationCaps[] = [...Object.values(DELEGATION_CAPS), { ...DELEGATION_CAPS.agy, appTools: new Set(["app_handoff"]) }, { ...DELEGATION_CAPS.codex, steerWorkerRun: false }];
const slots = (entries: Record<string, string>): Slots => new Map(Object.entries(entries));
const answer = (entries: Record<string, string>) => Buffer.from(JSON.stringify({ format: 1, slots: entries }));
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

afterEach(() => { vi.useRealTimers(); });

/** Every output of a rule set that a prompt is built from, as fragments (what a set gives for each engine, form and worktree). */
function everything(rules: OrchestrationRules): Record<string, readonly Fragment[]> {
  const out: Record<string, readonly Fragment[]> = {};
  CAPS.forEach((caps, at) => {
    for (const id of SECTION_IDS) for (const engine of ENGINES) for (const worktree of [null, "/w/tree"]) out[`section/${at}/${id}/${engine}/${worktree}`] = rules.section(id, caps, { engine, worktree });
    out[`claudeLine/${at}`] = rules.claudeLine(caps);
    out[`onRequestLine/${at}`] = rules.onRequestLine(caps);
    out[`workerNote/${at}`] = rules.workerNote(caps);
  });
  out.claudeMainLine = rules.claudeMainLine();
  out.workerRules = [rules.workerRules().lookup, rules.workerRules().reportBlock];
  return out;
}
const ids = (rules: OrchestrationRules, kind: "C" | "P") => [...new Set(Object.values(everything(rules)).flat().filter((fragment) => fragment.kind === kind).map((fragment) => fragment.id))].sort();

describe("the built-in plugin's answer is core's default", () => {
  it("rules.json is the pinned file: its sha256 is the one in pinned-hash.ts", () => {
    const actual = createHash("sha256").update(readFileSync(RULES_FILE)).digest("hex");
    expect(actual, `rules.json changed: put ${actual} in src/core/orchestration/pinned-hash.ts`).toBe(BUILTIN_RULES_SHA256);
  });

  it("carries every policy fragment but the engine one, and no contract fragment", () => {
    const given = [...parseSlots(readFileSync(RULES_FILE)).keys()].sort();
    expect(given).toEqual(ids(DEFAULT, "P").filter((id) => id !== "runDispatch.2a"));
    expect(given.filter((id) => ids(DEFAULT, "C").includes(id))).toEqual([]);
  });

  it("gives every section, line and note the same fragments, and the golden text through delegationPolicy", async () => {
    const book = new OrchestrationRulesBook(builtinSource(BUILT));
    await book.refresh();
    const rules = book.current();
    expect(rules).not.toBe(DEFAULT); // it came from the plugin's file, not from core's copy
    expect(everything(rules)).toEqual(everything(DEFAULT));
    for (const engine of ENGINES) {
      expect(delegationPolicy(DELEGATION_CAPS[engine], { engine, worktree: null, form: "full" }, rules)).toBe(golden[`policy/${engine}/folder/full`]);
      expect(delegationPolicy(DELEGATION_CAPS[engine], { engine, form: "line" }, rules)).toBe(golden[`policy/${engine}/folder/line`]);
    }
    expect(rules.workerDefaults("codex")).toEqual(DEFAULT.workerDefaults("codex"));
  });

  it("makes the same prompts for every engine as core's own rules do", async () => {
    const withPlugin = fixture({ builtIns: BUILT }), alone = fixture({ builtIns: null });
    await withPlugin.rules().refresh();
    await alone.rules().refresh();
    for (const engine of ENGINES) expect(withPlugin.send.prompts(PROFILE, engine)).toEqual(alone.send.prompts(PROFILE, engine));
    expect(withPlugin.rules().current()).not.toBe(DEFAULT);
    expect(alone.rules().current()).toBe(DEFAULT);
  });

  it("a core with no plugin system has no plugin to fail: core's own rules and no notice, however often it is asked", async () => {
    const h = fixture({ builtIns: null }), bot = fakeBot();
    for (let at = 0; at < 2; at++) await h.rules().refresh((text) => bot.appNotice(text));
    expect(h.rules().current()).toBe(DEFAULT);
    expect(bot.notices).toEqual([]);
    const said: string[] = [];
    const book = new OrchestrationRulesBook(async () => null);
    await book.refresh((text) => said.push(text));
    expect(book.current()).toBe(DEFAULT);
    expect(said).toEqual([]);
  });
});

describe("a plugin that fails", () => {
  it("throws: core's own rules and exactly one notice, however often it is asked", async () => {
    const said: string[] = [];
    const book = new OrchestrationRulesBook(async () => { throw new Error("boom"); });
    for (let at = 0; at < 4; at++) await book.refresh((text) => said.push(text));
    expect(book.current()).toBe(DEFAULT);
    expect(said).toEqual([RULES_NOTICE]);
  });

  it("throws before it returns a promise: the same", async () => {
    const said: string[] = [];
    const book = new OrchestrationRulesBook(() => { throw new Error("sync"); });
    await book.refresh((text) => said.push(text));
    expect(book.current()).toBe(DEFAULT);
    expect(said).toEqual([RULES_NOTICE]);
  });

  it("says so again only after it worked in between, and without a chat to tell it waits for the next ask", async () => {
    const said: string[] = [];
    let behave: "fail" | "work" = "fail";
    const book = new OrchestrationRulesBook(async () => { if (behave === "fail") throw new Error("x"); return slots({ "dispatch.5b": "EDITED" }); });
    await book.refresh(); // nobody to tell yet
    await book.refresh((text) => said.push(text));
    expect(said).toHaveLength(1);
    behave = "work";
    await book.refresh((text) => said.push(text));
    expect(book.current()).not.toBe(DEFAULT);
    behave = "fail";
    await book.refresh((text) => said.push(text));
    expect(book.current()).toBe(DEFAULT); // back at once, not the last good set
    expect(said).toHaveLength(2);
  });

  it("is slow: core's own rules at once, the notice only when the limit passes, and a late answer changes nothing", async () => {
    vi.useFakeTimers();
    const said: string[] = [];
    let late: (value: Slots) => void = () => {};
    const book = new OrchestrationRulesBook(() => new Promise<Slots>((resolve) => { late = resolve; }));
    const asked = book.refresh((text) => said.push(text));
    expect(book.current()).toBe(DEFAULT); // a turn started now reads this, synchronously
    await vi.advanceTimersByTimeAsync(RULES_TIME_LIMIT_MS - 1);
    expect(said).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await asked;
    expect(said).toEqual([RULES_NOTICE]);
    late(slots({ "dispatch.5b": "TOO LATE" }));
    await vi.advanceTimersByTimeAsync(10);
    expect(book.current()).toBe(DEFAULT);
  });

  it("does not stall a turn: sendWith returns while the plugin has not answered, the turn reads core's rules, and the notice comes at the limit, once", async () => {
    vi.useFakeTimers();
    const h = fixture({ builtIns: BUILT });
    (h.send as unknown as { madeRules: OrchestrationRulesBook }).madeRules = new OrchestrationRulesBook(() => new Promise<Slots>(() => {}));
    const bot = fakeBot();
    for (const text of ["one", "two"]) await h.send.sendWith(bot, text, { files: [] }); // would hang if a turn waited for the plugin
    expect(bot.sent).toEqual(["one", "two"]);
    expect(h.send.orchestrationRules()).toBe(DEFAULT);
    expect(bot.notices).toEqual([]);
    await vi.advanceTimersByTimeAsync(RULES_TIME_LIMIT_MS);
    await h.send.sendWith(bot, "three", { files: [] });
    await vi.advanceTimersByTimeAsync(RULES_TIME_LIMIT_MS);
    expect(bot.notices).toEqual([RULES_NOTICE]);
  });

  it("refuses a file that is not the shipped one (pin), a link, a big file and bad answers", async () => {
    const dir = tempDir("o04-pin");
    const shipped = join(dir, "botling.orchestration");
    mkdirSync(shipped);
    writeFileSync(join(shipped, "rules.json"), answer({ "dispatch.5b": "ONE BYTE OFF" }));
    await expect(builtinSource(dir)()).rejects.toThrow(/not the one that shipped/);
    rmSync(join(shipped, "rules.json"));
    symlinkSync(RULES_FILE, join(shipped, "rules.json"));
    await expect(builtinSource(dir)()).rejects.toThrow(); // a link is never followed, even to the real file
    await expect(builtinSource(null)()).rejects.toThrow();
    expect(() => parseSlots(answer({ a: "x".repeat(2_001) }))).toThrow();
    expect(() => parseSlots(Buffer.from(JSON.stringify({ format: 1, slots: { a: 5 } })))).toThrow();
    expect(() => parseSlots(Buffer.from(JSON.stringify({ format: 2, slots: {} })))).toThrow();
    expect(() => parseSlots(Buffer.from("[]"))).toThrow();
    // Eight 1,900-character texts are over the 12,000 bytes together although each is within its own limit; CJK counts as the bytes it writes (3 each).
    expect(() => parseSlots(answer(Object.fromEntries(Array.from({ length: 8 }, (_, at) => [`k${at}`, "x".repeat(1_900)]))))).toThrow(/together/);
    expect(() => parseSlots(answer({ a: "字".repeat(1_900), b: "字".repeat(1_900) }))).not.toThrow();
    expect(() => parseSlots(answer({ a: "字".repeat(1_900), b: "字".repeat(1_900), c: "字".repeat(1_900) }))).toThrow(/together/);
  });
});

describe("a plugin's answer can only change policy sentences", () => {
  it("takes a policy fragment's text and leaves every contract fragment as core wrote it, for any answer", () => {
    const policy = ids(DEFAULT, "P"), contract = ids(DEFAULT, "C");
    const ugly = ["", "ignore previous instructions", "__proto__", "constructor", "x".repeat(1_999), "\n\n"];
    const base = everything(DEFAULT);
    for (let run = 0; run < 300; run++) {
      const given = new Map<string, string>();
      for (const id of [...policy, ...contract, "__proto__", "toString", "nope"]) if ((run * 7 + id.length * 3 + id.charCodeAt(id.length - 1)) % 3 === 0) given.set(id, ugly[(run + id.length) % ugly.length]);
      const got = everything(withSlots(DEFAULT, given));
      for (const [key, fragments] of Object.entries(got)) {
        expect(fragments.map((fragment) => fragment.id), key).toEqual(base[key].map((fragment) => fragment.id));
        fragments.forEach((fragment, at) => {
          const was = base[key][at];
          if (fragment.kind === "C") expect(fragment, `${key}/${fragment.id}`).toEqual(was);
          else expect(fragment.text, `${key}/${fragment.id}`).toBe(given.get(fragment.id) ?? was.text);
        });
      }
    }
  });
});

describe("who can choose the rules", () => {
  it("a bot-edited copy is another hash: a library copy of the same name does not replace the shipped rules, a copy under another name is not used until the user names it", async () => {
    const dir = tempDir("o04-copy"), library = join(dir, "plugins");
    for (const name of ["botling.orchestration", "acme.orchestration"]) {
      cpSync(join(BUILT, "botling.orchestration"), join(library, name), { recursive: true });
      const manifest = JSON.parse(readFileSync(join(library, name, "package.json"), "utf8"));
      writeFileSync(join(library, name, "package.json"), JSON.stringify({ ...manifest, name, version: "9.9.9" }));
      const edited = JSON.parse(readFileSync(RULES_FILE, "utf8"));
      edited.slots["followUp.3"] = `EDITED by a bot (${name})`;
      writeFileSync(join(library, name, "rules.json"), JSON.stringify(edited));
    }
    const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore(), BUILT);
    expect(registry.plugin("botling.orchestration")).toMatchObject({ builtIn: false, folder: join(library, "botling.orchestration") }); // the registry did take the copy
    const h = fixture({ dataDir: dir, builtIns: BUILT, registry });
    await h.rules().refresh();
    expect(h.send.prompts(PROFILE, "codex").system).not.toContain("EDITED");
    expect(h.rules().current()).not.toBe(DEFAULT);
    // The user names the other copy in settings.json with the sha256 of its rules.json: now it is used. The name alone is not enough.
    const acme = join(library, "acme.orchestration", "rules.json");
    writeSettings(join(dir, "settings.json"), { orchestrationPlugin: "acme.orchestration" });
    await h.rules().refresh();
    expect(h.send.prompts(PROFILE, "codex").system).not.toContain("EDITED");
    writeSettings(join(dir, "settings.json"), { orchestrationPlugin: "acme.orchestration", orchestrationPluginSha256: sha(acme) });
    await h.rules().refresh();
    expect(h.send.prompts(PROFILE, "codex").system).toContain("EDITED by a bot (acme.orchestration)");
    // A bot edits the chosen file afterwards (review): another hash, so core's rules, never the new text.
    writeFileSync(acme, readFileSync(acme, "utf8").replace("EDITED by a bot", "EDITED AGAIN by a bot"));
    await h.rules().refresh();
    expect(h.send.prompts(PROFILE, "codex").system).not.toContain("EDITED");
    expect(h.rules().current()).toBe(DEFAULT);
    // One setting goes back, with no bot in it.
    writeSettings(join(dir, "settings.json"), { orchestrationPlugin: "builtin" });
    await h.rules().refresh();
    expect(h.send.prompts(PROFILE, "codex").system).not.toContain("EDITED");
    // The chosen one turned off or gone: core's rules and one notice, never the edited text.
    writeSettings(join(dir, "settings.json"), { orchestrationPlugin: "acme.orchestration", orchestrationPluginSha256: sha(acme) });
    registry.setEnabled("acme.orchestration", false);
    const bot = fakeBot();
    await h.rules().refresh((text) => bot.appNotice(text));
    await h.rules().refresh((text) => bot.appNotice(text));
    expect(h.rules().current()).toBe(DEFAULT);
    expect(bot.notices).toEqual([RULES_NOTICE]);
  });

  it("the revert setting is the plugin name 'builtin' or no key; a name that is not a plugin name, the shipped name, or a key that is not text is 'builtin' too", () => {
    expect(orchestrationPlugin({})).toBe("builtin");
    expect(orchestrationPlugin({ orchestrationPlugin: "builtin" })).toBe("builtin");
    expect(orchestrationPlugin({ orchestrationPlugin: "acme.orchestration" })).toBe("acme.orchestration");
    for (const bad of ["botling.orchestration", "__proto__", "../x", "A b", "", 5, null, ["acme"], "x".repeat(65)]) expect(orchestrationPlugin({ orchestrationPlugin: bad }), String(bad)).toBe("builtin");
    expect(orchestrationPluginSha256({ orchestrationPluginSha256: "a".repeat(64) })).toBe("a".repeat(64));
    for (const bad of ["A".repeat(64), "a".repeat(63), 5, null, undefined]) expect(orchestrationPluginSha256({ orchestrationPluginSha256: bad })).toBeNull();
  });

  it("a chosen plugin's rules.json is read only as a small regular file whose sha256 the user named next to its name (review)", async () => {
    const dir = tempDir("o04-chosen-pin"), file = join(dir, "rules.json"), on = { folder: dir, enabled: true };
    writeFileSync(file, `${JSON.stringify({ format: 1, slots: { "followUp.3": "from file" } })}${" ".repeat(70_000)}`);
    await expect(chosenSource(on, sha(file))()).rejects.toThrow(/small regular file/);
    writeFileSync(file, JSON.stringify({ format: 1, slots: { "followUp.3": "from file" } }));
    await expect(chosenSource(on, sha(file))()).resolves.toBeInstanceOf(Map);
    await expect(chosenSource(on, null)()).rejects.toThrow(/orchestrationPluginSha256/);
    await expect(chosenSource(on, "0".repeat(64))()).rejects.toThrow(/orchestrationPluginSha256/);
    rmSync(file);
    mkdirSync(file);
    await expect(chosenSource(on, null)()).rejects.toThrow(/small regular file/);
  });

  it("no project, Plugins-page switch or library state turns the built-in off", async () => {
    const dir = tempDir("o04-off"), project = tempDir("o04-project"), library = join(dir, "plugins");
    // A project's own files are never read for this: decoys in the places a project could hold a setting.
    mkdirSync(join(project, ".bot"), { recursive: true });
    for (const file of [join(project, "settings.json"), join(project, ".bot", "settings.json")]) writeFileSync(file, JSON.stringify({ orchestrationPlugin: "evil.rules", plugins: { "botling.orchestration": false } }));
    const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore(), BUILT);
    registry.setEnabled("botling.orchestration", false);
    expect(registry.plugin("botling.orchestration")).toMatchObject({ enabled: false });
    const asked: string[] = [];
    const h = fixture({ dataDir: dir, builtIns: BUILT, registry: { ...registry, plugin: (name: string) => { asked.push(name); return registry.plugin(name); } } as unknown as PluginRegistry });
    const bot = fakeBot();
    await h.rules().refresh((text) => bot.appNotice(text));
    expect(h.rules().current()).not.toBe(DEFAULT); // the built-in answered
    expect(h.send.prompts(PROFILE, "codex")).toEqual(fixture({ builtIns: null }).send.prompts(PROFILE, "codex"));
    expect(bot.notices).toEqual([]);
    expect(asked).toEqual([]); // the registry (its on/off, its library) was not asked for it
  });
});

/** A set whose every member answers a marked sentence of its own: a seam that is not wired to the set it was given shows the default text instead. */
const MARK = (id: string): Fragment[] => [{ id, kind: "P", text: `<<${id}>>` }];
const MARKED: OrchestrationRules = {
  section: (id) => MARK(`section.${id}`), claudeLine: () => MARK("claudeLine"), claudeMainLine: () => MARK("claudeMainLine"), onRequestLine: () => MARK("onRequestLine"),
  workerNote: () => MARK("workerNote"), workerRules: () => ({ lookup: MARK("lookup")[0], reportBlock: MARK("reportBlock")[0] }), workerDefaults: DEFAULT.workerDefaults,
};

describe("a rules set that is not core's reaches every seam (M7-O02 review MF-MJ)", () => {
  const prompts = (profile: Partial<BotProfile> & { delegation?: string }, engine: "claude" | "codex" | "agy") => {
    const h = fixture({ builtIns: null });
    (h.send as unknown as { madeRules: unknown }).madeRules = { current: () => MARKED, refresh: async () => {} };
    return h.send.prompts({ ...PROFILE, ...profile } as BotProfile, engine);
  };

  it("CoreSend.prompts gives the set to the Codex coordinator (its sections) and to its workers' instructions (lookup and the Files touched block)", () => {
    const got = prompts({}, "codex");
    expect(got.system).toContain("<<section.header>>");
    expect(got.system).not.toContain("App-owned");
    expect(got.codexWorkerSystem).toContain("- <<lookup>>");
    expect(got.codexWorkerSystem).toContain("- <<reportBlock>>");
    expect(got.codexWorkerSystem).not.toContain("Files touched");
  });

  it("gives it to the Claude coordinator's line, which is the one place its default line was swapped for the set's", () => {
    const got = prompts({ role: "manager" }, "claude").system;
    expect(got).toContain("<<claudeLine>>");
    expect(got).not.toContain("Hand all real work");
  });

  it("gives it to the main bot's extra line, and the onRequest bot's replacement line in place of the coordinator's", () => {
    expect(prompts({ role: "main" }, "claude").system).toContain("<<claudeMainLine>>");
    expect(prompts({ role: "manager" }, "claude").system).not.toContain("<<claudeMainLine>>");
    const onRequest = prompts({ role: "manager", delegation: "onRequest" } as never, "claude").system;
    expect(onRequest).toContain("<<onRequestLine>>");
    expect(onRequest).not.toContain("<<claudeLine>>");
  });

  it("gives it to the Antigravity coordinator's own branch and to its workers' instructions", () => {
    const got = prompts({}, "agy");
    expect(got.system).toContain("<<section.header>>");
    expect(got.system).not.toContain("App-owned");
    expect(got.codexWorkerSystem).toContain("<<lookup>>");
    expect(got.codexWorkerSystem).toContain("<<reportBlock>>");
  });

  it("a set's own worker note is what the Claude line, the onRequest line and the notes section carry (not core's)", () => {
    const noted: OrchestrationRules = { ...DEFAULT, workerNote: () => MARK("NOTE") };
    for (const caps of CAPS) {
      for (const text of [renderFragments(noted.claudeLine(caps)), renderFragments(noted.onRequestLine(caps)), renderFragments(noted.section("notes", caps, { engine: "claude", worktree: null }))]) {
        expect(text).toContain("<<NOTE>>");
        expect(text).not.toContain("app_worker_note");
      }
    }
    // and through the rules a plugin gives: its answer for the note reaches the lines that carry it
    const given = withSlots(DEFAULT, slots({ "note.3": "NOTE3 from a plugin" }));
    expect(renderFragments(given.claudeLine(DELEGATION_CAPS.claude))).toContain("NOTE3 from a plugin");
    expect(renderFragments(given.onRequestLine(DELEGATION_CAPS.claude))).toContain("NOTE3 from a plugin");
  });
});

describe("a rules set reaches the workers' own instructions", () => {
  it("a Claude worker starts with the set's lookup and report block, and core's when none is given", async () => {
    expect(claudeWorkerPolicy(MARKED)).toContain("<<lookup>>");
    expect(claudeWorkerPolicy(MARKED)).toContain("<<reportBlock>>");
    expect(claudeWorkerPolicy(MARKED)).not.toContain("Files touched");
    const h = claudeHarness();
    await h.workers.tool("app_handoff", { instructions: "first" });
    expect(h.heads[0]!.config.systemPrompt).toBe(claudeWorkerPolicy());
    (h.workers as unknown as { adapter: { options: { rules?: () => OrchestrationRules | undefined } } }).adapter.options.rules = () => MARKED;
    await h.workers.tool("app_handoff", { instructions: "second" });
    expect(h.heads[1]!.config.systemPrompt).toBe(claudeWorkerPolicy(MARKED));
    (h.workers as unknown as { adapter: { options: { rules?: () => OrchestrationRules | undefined } } }).adapter.options.rules = () => undefined;
    await h.workers.tool("app_handoff", { instructions: "third" });
    expect(h.heads[2]!.config.systemPrompt).toBe(claudeWorkerPolicy());
    await h.workers.close();
  });

  it("an Antigravity worker starts with the set's lookup and report block, and core's when none is given", async () => {
    const home = tempDir("o04-agy"), starts: AgyConfig[] = [];
    const config: AgyConfig = { command: "not-executed", cwd: home, acpHome: home, sessionId: "owner", resume: false, systemPrompt: "c", workerInstructions: "w" };
    const m = new AgyWorkers(config, () => {}, () => {}, (made) => { starts.push(made); return { start() {}, send() {}, answer() {}, async terminate() { return { killed: [], forced: false }; } } as AgyWorkerHead; });
    await m.tool("app_handoff", { instructions: "first" });
    expect(starts[0]!.systemPrompt).toContain(agyWorkerPolicy());
    config.rules = () => MARKED;
    await m.tool("app_handoff", { instructions: "second" });
    expect(starts[1]!.systemPrompt).toContain(agyWorkerPolicy(MARKED));
    expect(starts[1]!.systemPrompt).toContain("<<lookup>> <<reportBlock>>");
    expect(starts[1]!.systemPrompt).not.toContain("Files touched");
    await m.close();
  });

  it("the app's rules go from the core to its bots: the Antigravity config and the Claude workers read them each time", async () => {
    const dir = tempDir("o04-core-real"), seen = { set: DEFAULT as OrchestrationRules };
    const core = new RealCore({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, agyConfig: (_p, c) => ({ ...c, transport: "acp", command: "/never-spawn" }), emit() {}, deferStartup: true,
      routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
    try {
      vi.spyOn(core, "orchestrationRules").mockImplementation(() => seen.set);
      const main = (core as unknown as { bots: Map<string, Bot> }).bots.get(MAIN_BOT_ID) as unknown as { profile: BotProfile; options: { agyConfig: (p: BotProfile, c: AgyConfig) => AgyConfig; orchestrationRules: () => OrchestrationRules }; ensureClaudeWorkers(): unknown };
      const agy = () => main.options.agyConfig(main.profile, { command: "agy", cwd: dir, sessionId: "s", resume: false });
      expect(agy().rules?.()).toBe(DEFAULT);
      seen.set = MARKED;
      expect(agy().rules?.()).toBe(MARKED);
      expect(agy().transport).toBe("acp"); // the wrapper still runs the app's own config
      expect(main.options.orchestrationRules()).toBe(MARKED);
      const claude = (main.ensureClaudeWorkers() as { adapter: { options: { rules(): OrchestrationRules | undefined } } }).adapter.options;
      expect(claude.rules()).toBe(MARKED);
      seen.set = DEFAULT;
      expect(claude.rules()).toBe(DEFAULT);
    } finally { vi.restoreAllMocks(); await core.shutdown(); }
  });
});

describe("the coordinator's and the worker's Files touched sentences are one pair (plan 4.6)", () => {
  it("an answer gives both followUp.5 and worker.reportBlock or neither; given together they reach the coordinator's lines and the worker's text", () => {
    expect(() => parseSlots(answer({ "followUp.5": "A" }))).toThrow(/together/);
    expect(() => parseSlots(answer({ "worker.reportBlock": "B", "followUp.3": "x" }))).toThrow(/together/);
    expect(() => parseSlots(answer({ "followUp.3": "x" }))).not.toThrow();
    const both = withSlots(DEFAULT, parseSlots(answer({ "followUp.5": "PAIR-A", "worker.reportBlock": "PAIR-B" })));
    expect(renderFragments(both.claudeLine(DELEGATION_CAPS.claude))).toContain("PAIR-A");
    expect(renderFragments(both.section("followUp", DELEGATION_CAPS.codex, { engine: "codex", worktree: null }))).toContain("PAIR-A");
    expect(claudeWorkerPolicy(both)).toContain("PAIR-B");
    expect(agyWorkerPolicy(both)).toContain("PAIR-B");
  });
});

describe("a plugin gives sentences, never a worker's model, effort or engine (F3)", () => {
  it("withSlots hands out only the coordinator's own engine, whatever the set under it says, and nothing else", () => {
    const greedy: OrchestrationRules = { ...DEFAULT, workerDefaults: () => ({ workerEngine: "codex", workerModel: "opus", workerEffort: "max" } as never) };
    for (const coordinator of ENGINES) expect(withSlots(greedy, slots({})).workerDefaults(coordinator)).toEqual({ workerEngine: coordinator });
  });

  it("rules.json carries no worker model, effort or engine: a top-level key or a slot of that name refuses the whole answer", () => {
    const keys = ["workerModel", "workerEffort", "workerEngine", "defaults"];
    for (const key of keys) expect(() => parseSlots(Buffer.from(JSON.stringify({ format: 1, slots: {}, [key]: "opus" }))), key).toThrow(/not accepted/);
    for (const key of ["workerModel", "workerEffort", "workerEngine"]) expect(() => parseSlots(answer({ "followUp.3": "ok", [key]: "opus" })), key).toThrow(/not accepted/);
    expect(() => parseSlots(answer({ "followUp.3": "ok" }))).not.toThrow();
    const walk = (value: unknown): string[] => value && typeof value === "object" ? Object.entries(value).flatMap(([k, v]) => [k, ...walk(v)]) : [];
    const shipped = [JSON.parse(readFileSync(RULES_FILE, "utf8")), JSON.parse(readFileSync(join(BUILT, "botling.orchestration", "package.json"), "utf8"))];
    for (const file of shipped) expect(walk(file).filter((k) => /^worker(Model|Effort|Engine)$/.test(k))).toEqual([]);
    // Since every built-in declares a kernel block (32061a43), only that block: no `contributes`, no permissions, nothing for rules.
    expect(Object.keys(shipped[1].ccb).filter((key) => !["kernel", "provides", "requires", "uses"].includes(key))).toEqual([]);
  });

  it("a chosen plugin whose rules.json or manifest names a worker model or effort is refused whole; its manifest's own `contributes` is not read for rules", async () => {
    const dir = tempDir("o04-f3");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "acme.orchestration", version: "1.0.0", ccb: { contributes: { orchestration: { slots: { "followUp.3": "FROM MANIFEST" }, defaults: { workerModel: "opus", workerEffort: "max" } } } } }));
    writeFileSync(join(dir, "rules.json"), JSON.stringify({ format: 1, slots: { "followUp.3": "from file" }, workerModel: "opus" }));
    await expect(chosenSource({ folder: dir, enabled: true }, sha(join(dir, "rules.json")))()).rejects.toThrow(/not accepted/);
    writeFileSync(join(dir, "rules.json"), JSON.stringify({ format: 1, slots: { "followUp.3": "from file" } }));
    const book = new OrchestrationRulesBook(chosenSource({ folder: dir, enabled: true }, sha(join(dir, "rules.json"))));
    await book.refresh();
    expect(renderFragments(book.current().section("followUp", DELEGATION_CAPS.claude, { engine: "claude", worktree: null }))).toContain("from file");
    expect(renderFragments(book.current().section("followUp", DELEGATION_CAPS.claude, { engine: "claude", worktree: null }))).not.toContain("FROM MANIFEST");
    expect(book.current().workerDefaults("agy")).toEqual({ workerEngine: "agy" });
  });
});

/** Core's own synchronous work: the event loop is stuck, as it is while a message to an Antigravity head checks its 405 MB runtime (about 0.75 s a time, several times). */
const stall = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

describe("a stuck event loop is not the plugin's silence (switching a bot to Antigravity)", () => {
  /** `fixture` whose rules ask has a short limit, and a bot whose `send` is stuck for `stuckMs` (what `Bot.send` does for an Antigravity head). */
  function stuckSend(source: () => Promise<Slots | null>, stuckMs: number, limitMs = 100) {
    const h = fixture({ builtIns: BUILT });
    (h.send as unknown as { madeRules: OrchestrationRulesBook }).madeRules = new OrchestrationRulesBook(source, limitMs);
    const bot = fakeBot();
    const plain = bot.send.bind(bot);
    (bot as { send: Bot["send"] }).send = ((...args: Parameters<Bot["send"]>) => { stall(stuckMs); return plain(...args); }) as Bot["send"];
    return { h, bot };
  }

  it("the shipped plugin answers although the send that follows its ask is stuck for four times the limit: its rules are used and no notice", async () => {
    const { h, bot } = stuckSend(builtinSource(BUILT), 400);
    await h.send.sendWith(bot, "to agy", { files: [] });
    await h.rules().refresh(); // the ask that sendWith started (one at a time): wait for it
    expect(bot.notices).toEqual([]);
    expect(h.send.orchestrationRules()).not.toBe(DEFAULT); // the plugin's set, not core's fallback
  });

  it("a plugin that really throws still says so under the same stall, once", async () => {
    const { h, bot } = stuckSend(async () => { throw new Error("boom"); }, 400);
    await h.send.sendWith(bot, "to agy", { files: [] });
    await h.rules().refresh();
    expect(bot.notices).toEqual([RULES_NOTICE]);
    expect(h.send.orchestrationRules()).toBe(DEFAULT);
  });

  it("a plugin that never answers still says so under the same stall, after it had its time again", async () => {
    const { h, bot } = stuckSend(() => new Promise<Slots>(() => {}), 400);
    await h.send.sendWith(bot, "to agy", { files: [] });
    const after = Date.now();
    await h.rules().refresh();
    expect(bot.notices).toEqual([RULES_NOTICE]);
    expect(Date.now() - after).toBeGreaterThanOrEqual(90); // a limit of 100 ms counted from the end of the stall, not from the ask
    expect(h.send.orchestrationRules()).toBe(DEFAULT);
  });

  it("a stall does not keep a hung plugin waiting for ever: the time is given again at most twice", async () => {
    const armed = vi.spyOn(globalThis, "setTimeout");
    try {
      const book = new OrchestrationRulesBook(() => new Promise<Slots>(() => {}), 53);
      const said: string[] = [];
      const asked = book.refresh((text) => said.push(text));
      for (let at = 0; at < 4; at++) { stall(400); await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setTimeout(resolve, 0)); } // stuck again and again
      await asked;
      expect(said).toEqual([RULES_NOTICE]);
      expect(book.current()).toBe(DEFAULT);
      expect(armed.mock.calls.filter((call) => call[1] === 53)).toHaveLength(3); // the ask, and two more windows: never a fourth
    } finally { armed.mockRestore(); }
  });
});

/** Fake clock probes: `jump` is a stuck loop (the clock is a second ahead when the timer comes round); nothing waits in real time. */
describe("the late-timer allowance has its edges (fake clock)", () => {
  const LIMIT = 53;
  const jump = async () => { vi.setSystemTime(Date.now() + 1000); await vi.advanceTimersByTimeAsync(LIMIT); };
  const rig = () => {
    const said: string[] = [];
    let answer: (slots: Slots | null) => void = () => {};
    const book = new OrchestrationRulesBook(() => new Promise<Slots | null>((resolve) => { answer = resolve; }), LIMIT);
    const asked = book.refresh((text) => said.push(text));
    return { said, book, asked, answer: (slots: Slots | null) => answer(slots) };
  };
  afterEach(() => { vi.useRealTimers(); });

  it("a plugin that is silent on a loop that is not stuck gets the notice at the limit, with no second window", async () => {
    vi.useFakeTimers();
    const armed = vi.spyOn(globalThis, "setTimeout");
    const r = rig();
    await vi.advanceTimersByTimeAsync(LIMIT);
    await r.asked;
    expect(r.said).toEqual([RULES_NOTICE]);
    expect(armed.mock.calls.filter((call) => call[1] === LIMIT)).toHaveLength(1);
    armed.mockRestore();
  });

  it("a late timer gives the plugin its time again, and an answer in that window is used with no notice and no timer left over", async () => {
    vi.useFakeTimers();
    const r = rig();
    await jump();
    expect(r.said).toEqual([]);
    expect(vi.getTimerCount()).toBe(1); // the second window is armed
    r.answer(null);
    await r.asked;
    expect(r.said).toEqual([]);
    expect(vi.getTimerCount()).toBe(0); // the window that is still pending was cleared, not only the first timer
  });

  it("a plugin that stays silent through two stalls is let go on the third: the notice is said, and no timer is left", async () => {
    vi.useFakeTimers();
    const r = rig();
    await jump(); await jump();
    expect(r.said).toEqual([]);
    await jump();
    await r.asked;
    expect(r.said).toEqual([RULES_NOTICE]);
    expect(r.book.current()).toBe(DEFAULT);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
const PROFILE: BotProfile = { id: "p", name: "P", role: "manager", avatar: "x", folder: "/p/repo", memoryPath: ".bot/memory.md", storeDir: "/p/store", tools: [], job: null, problem: null, instructions: "X" };

/** A `CoreSend` on a stub host: only what `prompts` and `sendWith` touch. */
function fixture(options: { dataDir?: string; builtIns: string | null; registry?: PluginRegistry }) {
  const dataDir = options.dataDir ?? tempDir("o04-core");
  const host = {
    options: { dataDir, languages: ["en"], plugins: { builtIns: options.builtIns } },
    plugins: { origins: new Map(), registry: options.registry ?? { plugin: () => undefined }, promptSections: () => [], agentCommands: () => [], beforeSend: async (_bot: unknown, text: string) => ({ send: text }) },
    profiles: [],
    botInfo: () => ({}),
    conversations: { calledIn: () => [], notes: () => null, callIns: () => [] },
  } as unknown as Core;
  const send = new CoreSend(host);
  return { send, dataDir, rules: () => (send as unknown as { rulesBook: OrchestrationRulesBook }).rulesBook };
}

function fakeBot() {
  const sent: string[] = [], notices: string[] = [];
  const bot = { id: "b", send: (text: string) => { sent.push(text); return { messageId: "m", turnId: "t" }; }, appNotice: (text: string) => { notices.push(text); return "n"; }, lines: () => [] };
  return Object.assign(bot, { sent, notices }) as unknown as Bot & { sent: string[]; notices: string[] };
}
