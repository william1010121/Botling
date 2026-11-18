// Re-running a command is the app's job (a command card has a built-in refresh button; refresh="2s" repeats it) and a component
// only redraws from new data (ccb.onData). Nothing the app writes may lead a card worker, Maintainer or the component editor
// to build a refresh / re-run button in a component or to look for a ccb re-run API (2026-11-18: slot-heatmap asked for one).
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { cardSystemRules } from "../../src/core/worker-cards";
import { MaintainerDesk } from "../../src/core/maintainer";
import { ComponentLibrary } from "../../src/core/components/library";
import { componentEditorAgent } from "../../src/core/maintainer-text";
import { pluginGuideFiles } from "../../src/core/plugin-guide-text";

/** The sentence every app text that speaks of refreshing keeps: the app re-runs, the component redraws. */
const APP_RERUNS = /the app re-runs the command/;

function rig() {
  const root = tempDir("card-refresh-rule");
  const folder = join(root, "plugins", "ccb-components", "components");
  mkdirSync(join(folder, "status"), { recursive: true });
  writeFileSync(join(folder, "status", "template.html"), "<div>status</div>");
  writeFileSync(join(folder, "status", "about.md"), "A status card.\nData: JSON {}\n");
  const library = new ComponentLibrary(() => [folder]);
  const bot = {
    id: "B1", profile: { name: "Life Bot" }, get components() { return ["status"]; }, get ownComponentNames() { return ["status"]; }, lastAsked: "",
    setComponentList() {}, appMessage() {}, appNotice() { return "n"; }, queueNote() {}, workers: { tellCardWorker() {} },
  } as never;
  const desk = new MaintainerDesk({ root, maintainer: () => null, mainBot: () => bot, bots: () => [bot], library, plugins: () => null, log: () => {} });
  const handed: string[] = [];
  (desk as unknown as { handTo(text: string): void }).handTo = (text) => { handed.push(text); };
  return { desk, bot, handed };
}

describe("re-running a command belongs to the app, not to a component", () => {
  it("the card worker is told the app re-runs a command card, and that it never asks for a refresh / re-run button", () => {
    const rules = cardSystemRules("/p/.bot/card-scripts");
    const step4 = rules.split("\n").find((line) => line.startsWith("4. "))!;
    expect(rules).toMatch(APP_RERUNS);
    expect(step4).toContain("never ask for a refresh, reload or re-run button");
  });

  it("the request Maintainer gets for a described chart says: build no refresh button, there is no re-run API, the app re-runs and the component redraws in onData", () => {
    const r = rig();
    r.desk.requestCardNeed("A slot heatmap with a 重新整理 button that re-runs python3 .bot/card-scripts/lounge-rooms/fetch.py", r.bot, "TASK1");
    expect(r.handed).toHaveLength(1);
    const text = r.handed[0]!;
    expect(text).toContain("Do not build a refresh button");
    expect(text).toContain("no ccb re-run API");
    expect(text).toMatch(APP_RERUNS);
    expect(text).toContain("ccb.onData");
  });

  it("the component editor's agent file and the plugin guide's components reference carry the same rule", () => {
    for (const model of ["sonnet", "opus"]) {
      const agent = componentEditorAgent(model);
      expect(agent, model).toMatch(APP_RERUNS);
      expect(agent, model).toContain("never builds its own refresh or re-run button");
    }
    const components = pluginGuideFiles()["reference/components.md"]!;
    expect(components).toMatch(APP_RERUNS);
    expect(components).toContain("never builds its own refresh or re-run button");
    expect(components).toContain("no ccb call re-runs a command");
    expect(components).toContain("ccb.onData");
  });

  it("a named <component> request that asks for a refresh / re-run button gets the same note; one that does not ask stays as it was", () => {
    const r = rig();
    r.desk.requestComponentChange("status", "add a Refresh button that reloads the data", "Life Bot", r.bot, []);
    r.desk.requestComponentChange("weather", "加一個重新整理的按鈕", "Life Bot", r.bot, []);
    r.desk.requestComponentChange("weather-2", "a weather card for today", "Life Bot", r.bot, []);
    r.desk.requestComponentChange("status", "make it blue", "The user", null, []);
    r.desk.requestComponentChange("status", "請加重跑指令的按鈕", "The user", null, []);
    expect(r.handed).toHaveLength(5);
    for (const index of [0, 1, 4]) {
      expect(r.handed[index], String(index)).toContain("Do not build a refresh button");
      expect(r.handed[index], String(index)).toMatch(APP_RERUNS);
    }
    for (const index of [2, 3]) expect(r.handed[index], String(index)).not.toContain("refresh button");
  });
});
