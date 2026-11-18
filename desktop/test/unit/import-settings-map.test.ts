import { describe, expect, it } from "vitest";
import { MAIN_BOT_ID } from "../../src/core/store/records";
import { canonicalJson, PREF_VALUE_CHARS } from "../../src/protocol";
import { mapSettings } from "../../src/server/import/settings-map";

const BOT_A = "11111111-1111-4111-8111-111111111111";
const BOT_B = "22222222-2222-4222-8222-222222222222";
const MAPPED_MAIN = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";

describe("M6-02b: mapSettings", () => {
  it("maps each cluster preference with its right value and omits unset keys", () => {
    const empty = mapSettings({}, new Map());
    expect(empty).toEqual({
      prefs: [],
      machine: {},
      layoutKeys: [],
      oversizedKeys: [],
    });

    const result = mapSettings(
      {
        languageChoice: "zh-Hant",
        appTheme: "light",
        reportTheme: "system",
        defaultEngines: ["claude", "codex"],
        defaultPrimaryEngine: "codex",
        defaultEngineModels: { claude: "opus", codex: "gpt-5" },
        defaultEfforts: { claude: "high", codex: "medium" },
        pinnedBots: [BOT_A.toLowerCase(), BOT_B],
        designatedServer: "should-never-import",
      },
      new Map(),
    );

    expect(result.prefs).toEqual([
      { key: "language", value: "zh-Hant" },
      { key: "theme", value: "light" },
      { key: "reportTheme", value: "system" },
      {
        key: "defaultModels",
        value: {
          engines: ["claude", "codex"],
          primary: "codex",
          models: { claude: "opus", codex: "gpt-5", agy: null },
          efforts: { claude: "high", codex: "medium", agy: null },
        },
      },
      { key: "followedBots", value: [BOT_A, BOT_B] },
    ]);
    expect(result.prefs.some((p) => p.key === "replyLanguage" || p.key === "designatedServer")).toBe(false);
    expect(result.oversizedKeys).toEqual([]);
    expect(result.layoutKeys).toEqual([]);
  });

  it("normalizes removed 2.0 languages via savedLanguage and drops invalid mapped values", () => {
    const removed = mapSettings({ languageChoice: "ja", appTheme: "neon", reportTheme: "sepia" }, new Map());
    expect(removed.prefs).toEqual([{ key: "language", value: "en" }]);

    const invalid = mapSettings({ languageChoice: "xx" }, new Map());
    expect(invalid.prefs).toEqual([]);
  });

  it("remaps pinnedBots ids through idMap, upper-cases UUIDs, deduplicates, and caps at 200", () => {
    const idMap = new Map<string, string>([
      [MAIN_BOT_ID, MAPPED_MAIN.toLowerCase()],
    ]);

    const remapped = mapSettings(
      {
        pinnedBots: [MAIN_BOT_ID.toLowerCase(), BOT_A.toLowerCase(), MAIN_BOT_ID, "not-a-uuid", BOT_A],
      },
      idMap,
    );
    expect(remapped.prefs).toEqual([
      { key: "followedBots", value: [MAPPED_MAIN, BOT_A] },
    ]);

    const emptyList = mapSettings({ pinnedBots: [] }, idMap);
    expect(emptyList.prefs).toEqual([{ key: "followedBots", value: [] }]);

    const manyIds = Array.from({ length: 210 }, (_, i) => {
      const hex = i.toString(16).padStart(12, "0");
      return `00000000-0000-4000-8000-${hex}`;
    });
    const capped = mapSettings({ pinnedBots: manyIds }, new Map());
    const followed = capped.prefs.find((p) => p.key === "followedBots")?.value as string[];
    expect(followed).toHaveLength(200);
    expect(followed[0]).toBe("00000000-0000-4000-8000-000000000000");
    expect(followed[199]).toBe(`00000000-0000-4000-8000-${(199).toString(16).padStart(12, "0").toUpperCase()}`);
  });

  it("keeps machine-local and security settings in machine unchanged and does not mutate input", () => {
    const raw = {
      languageChoice: "en",
      appTheme: "dark",
      reportTheme: "light",
      defaultEngines: ["claude"],
      pinnedBots: [BOT_A],
      claudeBypassPermissions: true,
      codexBypassPermissions: false,
      agyBypassPermissions: true,
      agyAcpPath: "/usr/local/bin/agy",
      claudeWorkerLimit: 8,
      autoApprove: false,
      subagentModelDefault: "sonnet",
      dailyBudget: 5,
    };
    const snapshot = structuredClone(raw);

    const result = mapSettings(raw, new Map());
    expect(raw).toEqual(snapshot);
    expect(result.machine).toEqual({
      claudeBypassPermissions: true,
      codexBypassPermissions: false,
      agyBypassPermissions: true,
      agyAcpPath: "/usr/local/bin/agy",
      claudeWorkerLimit: 8,
      autoApprove: false,
      subagentModelDefault: "sonnet",
      dailyBudget: 5,
    });
    expect(result.prefs.map((p) => p.key)).toEqual([
      "language",
      "theme",
      "reportTheme",
      "defaultModels",
      "followedBots",
    ]);
  });

  it("excludes per-device layout keys from both machine and prefs and lists them", () => {
    const result = mapSettings(
      {
        idleBots: [BOT_A],
        pinnedSubBots: [BOT_B],
        railCollapsed: true,
        rightPanelCollapsed: true,
        mainTabs: { [BOT_A]: "botling.git" },
        pinnedTabs: { [BOT_A]: ["card-bench/bench.tab"] },
        botColors: { [BOT_A]: { avatar: "bot1", color: "#112233" } },
        chatAvatarSizeChoice: 64,
        botLookChoice: "original",
        claudeWorkerLimit: 4,
      },
      new Map(),
    );

    expect(result.prefs).toEqual([]);
    expect(result.machine).toEqual({ claudeWorkerLimit: 4 });
    expect(result.layoutKeys.sort()).toEqual([
      "botColors",
      "botLookChoice",
      "chatAvatarSizeChoice",
      "idleBots",
      "mainTabs",
      "pinnedSubBots",
      "pinnedTabs",
      "railCollapsed",
      "rightPanelCollapsed",
    ]);
  });

  it("leaves out an oversized preference value and lists it", () => {
    const huge = "X".repeat(PREF_VALUE_CHARS + 1);
    const idMap = new Map<string, string>([[MAIN_BOT_ID, huge]]);

    const result = mapSettings(
      {
        languageChoice: "en",
        pinnedBots: [MAIN_BOT_ID],
      },
      idMap,
    );

    expect(result.prefs).toEqual([{ key: "language", value: "en" }]);
    expect(result.oversizedKeys).toEqual(["followedBots"]);
    for (const pref of result.prefs) {
      expect(canonicalJson(pref.value).length).toBeLessThanOrEqual(PREF_VALUE_CHARS);
    }
  });
});
