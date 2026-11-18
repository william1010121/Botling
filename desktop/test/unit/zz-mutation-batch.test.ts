// TEMPORARY (L-010 batch mutation check for bot/dynamic-tabs; removed in the next commit).
// Copies the worktree, then for each mutant patches one src file in the copy, rebuilds out/ (L-017) and runs vitest on that mutant's related files there.
// MUT_DRY=1: only counts that every patch finds its text exactly once (no copy, no run).
import { it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = dirname(desktop);
const T = (name: string) => `test/unit/${name}.test.ts`;
const DT = T("dynamic-tabs"), HD = T("main-tab-header");
const ALL = [DT, HD, T("import-settings-map"), T("core-split-characterization"), T("main-tabs")];

const MT = "src/renderer/main-tabs.ts";
const ST = "src/core/settings.ts";
const APP = "src/renderer/App.tsx";
const TM = "src/renderer/TabMore.tsx";
const CT = "src/contract/views-settings.ts";
const SM = "src/server/import/settings-map.ts";

// [name, file, find, replace, related files]
const M: [string, string, string, string, string[]][] = [
  ["T1 Note is not always shown", MT, "tab.plugin === NOTE_PLUGIN || tab.plugin === WHITEBOARD_PLUGIN", "tab.plugin === WHITEBOARD_PLUGIN", [DT, HD]],
  ["T2 the Whiteboard is not always shown", MT, "tab.plugin === NOTE_PLUGIN || tab.plugin === WHITEBOARD_PLUGIN", "tab.plugin === NOTE_PLUGIN", [DT, HD]],
  ["T3 the tab on screen is not kept", MT, " || (!!current && tabKey(current) === tabKey(tab))", "", [DT, HD]],
  ["T4 a pinned tab is not kept", MT, " || pinned.includes(tabKey(tab))", "", [DT, HD]],
  ["T5 a marked tab is not kept", MT, ' || tab.forRole === "marked"', "", [DT, HD]],
  ["T6 pinnedFor reads the key unguarded", MT, "return pins && Object.hasOwn(pins, botId) ? pins[botId]! : NO_PINS;", "return pins?.[botId] ?? NO_PINS;", [DT]],
  ["T7 current compared by plugin only", MT, "tabKey(current) === tabKey(tab)", "current.plugin === tab.plugin", [DT, HD]],
  ["S1 a pin is not deduplicated", ST, "(now.includes(change.value.tab) ? now : [...now, change.value.tab]).slice(0, PINNED_TABS_MAX)", "[...now, change.value.tab].slice(0, PINNED_TABS_MAX)", [DT]],
  ["S2 apply has no 30 cap", ST, "[...now, change.value.tab]).slice(0, PINNED_TABS_MAX) : now.filter", "[...now, change.value.tab]) : now.filter", [DT]],
  ["S3 the last unpin leaves an empty list", ST, "if (list.length) pins[id] = list; else delete pins[id];", "pins[id] = list;", [DT]],
  ["S4 an empty pinnedTabs object is written", ST, 'set("pinnedTabs", Object.keys(pins).length ? pins : null);', 'set("pinnedTabs", pins);', [DT]],
  ["S5 reader keeps duplicates", ST, "const tabs = [...new Set(list.filter(", "const tabs = [...(list.filter(", [DT]],
  ["S6 reader keeps a long tab", ST, "tab.length > 0 && tab.length <= 320))].slice(0, PINNED_TABS_MAX)", "tab.length > 0))].slice(0, PINNED_TABS_MAX)", [DT]],
  ["S7 reader has no 30 cap", ST, "tab.length <= 320))].slice(0, PINNED_TABS_MAX);\n    if (tabs.length)", "tab.length <= 320))];\n    if (tabs.length)", [DT]],
  ["S8 reader keeps a non-bot key", ST, "if (!/^[0-9A-Fa-f-]{36}$/.test(id) || !Array.isArray(list)) continue;\n    const tabs", "if (!Array.isArray(list)) continue;\n    const tabs", [DT]],
  ["S9 reader keeps a non-string tab", ST, "filter((tab): tab is string => typeof tab === \"string\" && tab.length > 0", "filter((tab): tab is string => tab.length > 0", [DT]],
  ["S10 reader keeps an empty list", ST, "if (tabs.length) out[id.toUpperCase()] = tabs;", "out[id.toUpperCase()] = tabs;", [DT]],
  ["S11 reader reads an array as the object", ST, "if (!value || typeof value !== \"object\" || Array.isArray(value)) return {};\n  const out: Record<string, string[]>", "if (!value || typeof value !== \"object\") return {};\n  const out: Record<string, string[]>", [DT]],
  ["S12 the bot id is not upper-cased on pin", ST, "const id = change.value.botId.toUpperCase();\n      const now", "const id = change.value.botId;\n      const now", [DT]],
  ["S13 apply reads pins unguarded", ST, "const now = Object.hasOwn(pins, id) ? pins[id]! : [];", "const now = pins[id] ?? [];", [DT]],
  ["C1 the contract takes an empty tab", CT, 'key: z.literal("pinTab"), value: z.strictObject({ botId: BotId, tab: z.string().min(1).max(320), pinned', 'key: z.literal("pinTab"), value: z.strictObject({ botId: BotId, tab: z.string().max(320), pinned', [DT]],
  ["C2 the contract takes a long tab", CT, 'tab: z.string().min(1).max(320), pinned: z.boolean()', 'tab: z.string().min(1), pinned: z.boolean()', [DT]],
  ["C3 the contract takes extra keys", CT, 'key: z.literal("pinTab"), value: z.strictObject({', 'key: z.literal("pinTab"), value: z.object({', [DT]],
  ["I1 pinnedTabs is imported from 1.x", SM, '  "pinnedTabs",\n', "", [DT, T("import-settings-map")]],
  ["A1 right-click pins Note too", APP, "onContextMenu={alwaysShown(candidate) ? undefined : (event)", "onContextMenu={(event)", [HD]],
  ["A2 right-click does not prevent the system menu", APP, "{ event.preventDefault(); pinTab(", "{ pinTab(", [HD]],
  ["A3 right-click always pins", APP, "pinTab(bot.id, candidate, !pinnedKeys.includes(tabKey(candidate))); }}>", "pinTab(bot.id, candidate, true); }}>", [HD]],
  ["A4 no pin mark on a pinned tab", APP, "{!alwaysShown(candidate) && pinnedKeys.includes(tabKey(candidate)) && <Icon", "{false && <Icon", [HD]],
  ["A5 Note is listed in the menu", APP, "tabs.filter((candidate) => !alwaysShown(candidate))", "tabs", [HD]],
  ["A6 More tabs shows with nothing to list", APP, "{menuTabs.length > 0 && <MoreTabs", "{<MoreTabs", [HD]],
  ["A7 the header ignores pins", APP, "visibleTabs(tabs, { pinned: pinnedKeys, current: tab })", "visibleTabs(tabs, { pinned: [], current: tab })", [HD]],
  ["A8 the header ignores the tab on screen", APP, "visibleTabs(tabs, { pinned: pinnedKeys, current: tab })", "visibleTabs(tabs, { pinned: pinnedKeys, current: null })", [HD]],
  ["A9 pin asks main for the wrong bot", APP, 'change: { key: "pinTab", value: { botId, tab: tabKey(next), pinned } }', 'change: { key: "pinTab", value: { botId: "00000000-0000-4000-8000-000000000009", tab: tabKey(next), pinned } }', [HD]],
  ["A10 the menu opens a tab with the Whiteboard on", APP, "onOpen={(next) => { setWhiteboardOn(false); chooseTab(bot.id, next); }}", "onOpen={(next) => { setWhiteboardOn(true); chooseTab(bot.id, next); }}", [HD]],
  ["M1 Escape does not close the menu", TM, 'if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }', "", [HD]],
  ["M2 Escape reaches the page", TM, "event.preventDefault(); event.stopPropagation(); setOpen(false);", "event.preventDefault(); setOpen(false);", [HD]],
  ["M3 a press outside does not close", TM, "document.addEventListener(\"pointerdown\", away, true);", "", [HD]],
  ["M4 a press inside closes", TM, "if (!(event.target instanceof Node && slot.current?.contains(event.target))) setOpen(false);", "setOpen(false);", [HD]],
  ["M5 another bot keeps the menu open", TM, "useEffect(() => { setOpen(false); }, [botId]);", "", [HD]],
  ["M6 a row's click keeps the menu open", TM, "onClick={() => { setOpen(false); onOpen(tab); }}", "onClick={() => { onOpen(tab); }}", [HD]],
  ["M7 a pin click opens the tab", TM, "onClick={() => onPin(tab, !on)}", "onClick={() => { onOpen(tab); onPin(tab, !on); }}", [HD]],
  ["M8 a pin click always pins", TM, "onClick={() => onPin(tab, !on)}", "onClick={() => onPin(tab, true)}", [HD]],
  ["M9 the pin's pressed state is lost", TM, "aria-pressed={on} aria-label={pinLabel}", "aria-label={pinLabel}", [HD]],
  ["M10 the pin label does not change", TM, 'say(lang, on ? "tabs.unpin" : "tabs.pin", { name: tab.title })', 'say(lang, "tabs.pin", { name: tab.title })', [HD]],
  ["M11 the button does not toggle", TM, "onClick={() => setOpen(!open)}", "onClick={() => setOpen(true)}", [HD]],
];

const env = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST"))) as NodeJS.ProcessEnv;

function build(cwd: string) {
  const r = spawnSync(process.execPath, ["build.mjs"], { cwd, env: env(), encoding: "utf8", timeout: 300_000 });
  return r.status === 0 ? "" : `BUILD FAILED ${r.status}: ${`${r.stdout}\n${r.stderr}`.slice(-800)}`;
}

function runVitest(cwd: string, filters: string[]) {
  const out = join(cwd, "mutant-report.json");
  rmSync(out, { force: true });
  const r = spawnSync(process.execPath, [join(desktop, "node_modules/vitest/vitest.mjs"), "run", "--reporter=json", `--outputFile=${out}`, "--maxWorkers=2", ...filters], { cwd, env: env(), encoding: "utf8", timeout: 900_000 });
  let json: any = null;
  try { json = JSON.parse(readFileSync(out, "utf8")); } catch { /* no report */ }
  const failed: string[] = json ? json.testResults.flatMap((f: any) => f.assertionResults.filter((a: any) => a.status === "failed").map((a: any) => a.title)) : [];
  return { code: r.status, total: json?.numTotalTests ?? 0, failed, files: json?.testResults?.length ?? 0, tail: json ? "" : `${r.stdout}\n${r.stderr}`.slice(-1500) };
}

it("batch mutation check", () => {
  if (process.env.MUT_DRY) {
    for (const [name, file, find] of M) console.log(`DRY ${name}: ${readFileSync(join(desktop, file), "utf8").split(find).length - 1}x`);
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), "mut-"));
  try {
    cpSync(root, tmp, { recursive: true, filter: (src) => ![".git", "node_modules", "out", "dist", ".bot", "release"].includes(basename(src)) });
    for (const dir of ["desktop", "Web", ""]) if (existsSync(join(root, dir, "node_modules"))) symlinkSync(join(root, dir, "node_modules"), join(tmp, dir, "node_modules"));
    const cwd = join(tmp, "desktop");
    const built = build(cwd);
    const base = runVitest(cwd, ALL);
    console.log(`MUTANT baseline(copy): ${built || "built"}, exit ${base.code}, ${base.files} files, ${base.total} tests, failed ${base.failed.length} ${base.failed.join(" | ")}${base.tail}`);
    if (base.code !== 0 || base.failed.length || base.files < ALL.length) throw new Error("baseline in the copy does not pass: mutation results void");
    const originals = new Map<string, string>();
    for (const [name, file, find, replace, filters] of M) {
      const target = join(cwd, file);
      if (!originals.has(file)) originals.set(file, readFileSync(target, "utf8"));
      const original = originals.get(file)!;
      const n = original.split(find).length - 1;
      if (n !== 1) { console.log(`MUTANT ${name}: PATCH FAILED (found ${n}x)`); continue; }
      writeFileSync(target, original.replace(find, () => replace));
      const failedBuild = build(cwd);
      const r = failedBuild ? { code: -1, total: 0, failed: [] as string[], files: 0, tail: failedBuild } : runVitest(cwd, filters);
      writeFileSync(target, original);
      const verdict = r.total === 0 ? "NOT EVALUATED" : r.failed.length ? "KILLED" : r.code === 0 ? "SURVIVED" : "KILLED(exit only)";
      console.log(`MUTANT ${name}: ${verdict} (${r.total} tests, failed ${r.failed.length}: ${r.failed.slice(0, 3).join(" | ")})${r.tail}`);
    }
    build(cwd);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}, 3_300_000);
