// The reply parser against what the Swift code did with the same input (prompts-golden.json: `replies`,
// written by DesktopPromptGoldenExport.swift). Task cards are gone in 2.x: a <task> line is taken out of the body as
// in Swift, but nothing is parsed from it (the golden's `tasks` and `taskScenario` are no longer checked).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseReply, saysNoReply, saysNothing, setPluginTags } from "../../src/core/reply";
import { desktop } from "../helpers";

const golden = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "prompts-golden.json"), "utf8"));

describe("reply parser: the Swift ReplyParser's results", () => {
  for (const [index, sample] of (golden.replies as any[]).entries()) {
    it(`parses reply ${index}: ${JSON.stringify(sample.reply).slice(0, 50)}`, () => {
      // <install-build> and <app-screenshot/> are botling.dev's tags now (and <suggest-component>, <component-spec> botling.component-studio's) (a plugin tag): with that plugin's tags declared, the
      // parse is the Swift one but for those, which leave the text and are handed to the plugin instead of becoming requests.
      setPluginTags(["install-build", "app-screenshot", "suggest-component", "component-spec"]);
      const parsed = parseReply(sample.reply);
      setPluginTags([]);
      const moved = new Set(["installBuild", "appScreenshot", "suggestComponent", "componentSpec"]);
      expect(parsed.body).toBe(sample.body);
      expect(parsed.choices).toEqual(sample.choices);
      expect(parsed).not.toHaveProperty("tasks");
      expect(parsed.reactions).toEqual(sample.reactions);
      expect(parsed.displays).toEqual(sample.displays);
      expect(parsed.requests).toEqual((sample.requests as { kind: string }[]).filter((request) => !moved.has(request.kind)));
      expect((parsed.pluginTags ?? []).map((tag) => tag.tag).sort()).toEqual((sample.requests as { kind: string }[]).filter((request) => moved.has(request.kind)).map((request) => ({ appScreenshot: "app-screenshot", installBuild: "install-build", suggestComponent: "suggest-component", componentSpec: "component-spec" } as Record<string, string>)[request.kind]).sort());
      expect(parsed.completionSignals).toEqual(sample.signals);
      expect(parsed.decisionReference).toBe(sample.decisionReference);
      expect(saysNoReply(sample.reply)).toBe(sample.saysNoReply);
      expect(saysNothing(sample.reply)).toBe(sample.saysNothing);
    });
  }
});
