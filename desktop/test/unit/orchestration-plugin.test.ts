// M7-O04: the built-in orchestration plugin carries the rules; a failure falls back to core's own. The built-in's answer is core's default
// byte for byte; a plugin that throws, is slow or is not the shipped file never changes a prompt and never delays a turn; one setting
// goes back to the shipped rules; no project, library copy or Plugins-page switch can replace or turn off the built-in.
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Core } from "../../src/core/server";
import type { Bot } from "../../src/core/bot";
import { CoreSend } from "../../src/core/server/send";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { orchestrationPlugin, writeSettings } from "../../src/core/settings";
import { DEFAULT_ORCHESTRATION_RULES as DEFAULT, SECTION_IDS, type Fragment, type OrchestrationRules } from "../../src/core/orchestration/default-rules";
import { BUILTIN_RULES_SHA256 } from "../../src/core/orchestration/pinned-hash";
import { builtinSource, OrchestrationRulesBook, parseSlots, RULES_NOTICE, RULES_TIME_LIMIT_MS, withSlots, type Slots } from "../../src/core/orchestration/plugin-rules";
import { DELEGATION_CAPS, delegationPolicy, type DelegationCaps } from "../../src/core/prompts/delegation";
import { desktop, tempDir } from "../helpers";

const BUILT = join(desktop, "builtin-plugins");
const RULES_FILE = join(BUILT, "botling.orchestration", "rules.json");
const golden: Record<string, string> = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "orchestration-default-rules-golden.json"), "utf8"));
const ENGINES = ["claude", "codex", "agy"] as const;
const CAPS: DelegationCaps[] = [...Object.values(DELEGATION_CAPS), { ...DELEGATION_CAPS.agy, appTools: new Set(["app_handoff"]) }, { ...DELEGATION_CAPS.codex, steerWorkerRun: false }];
const slots = (entries: Record<string, string>): Slots => new Map(Object.entries(entries));
const answer = (entries: Record<string, string>) => Buffer.from(JSON.stringify({ format: 1, slots: entries }));

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
    // The user names the other copy in settings.json: now it is used. It is another hash and gets no pin, only the user's word.
    writeSettings(join(dir, "settings.json"), { orchestrationPlugin: "acme.orchestration" });
    await h.rules().refresh();
    expect(h.send.prompts(PROFILE, "codex").system).toContain("EDITED by a bot (acme.orchestration)");
    // One setting goes back, with no bot in it.
    writeSettings(join(dir, "settings.json"), { orchestrationPlugin: "builtin" });
    await h.rules().refresh();
    expect(h.send.prompts(PROFILE, "codex").system).not.toContain("EDITED");
    // The chosen one turned off or gone: core's rules and one notice, never the edited text.
    writeSettings(join(dir, "settings.json"), { orchestrationPlugin: "acme.orchestration" });
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

// ---------------------------------------------------------------------------------------------------------------------------------
const PROFILE = { id: "p", name: "P", role: "manager" as const, folder: "/p/repo", memoryPath: ".bot/memory.md", job: null, instructions: "X" };

/** A `CoreSend` on a stub host: only what `prompts` and `sendWith` touch. */
function fixture(options: { dataDir?: string; builtIns: string | null; registry?: PluginRegistry }) {
  const dataDir = options.dataDir ?? tempDir("o04-core");
  const host = {
    options: { dataDir, languages: ["en"], plugins: { builtIns: options.builtIns } },
    plugins: { registry: options.registry ?? { plugin: () => undefined }, promptSections: () => [], agentCommands: () => [], beforeSend: async (_bot: unknown, text: string) => ({ send: text }) },
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
