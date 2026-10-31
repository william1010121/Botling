import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import { saveProjectRow } from "../../src/core/projects";
import { tempDir } from "../helpers";

const PROJECT = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0";
const QUESTION = "DD43524E-1FC7-4DD6-9A50-4A129ADD64AA";
const lead = "**Codex 慢，主因是它的工作方式，不是啟動。** 我抽查過，設定值和程式位置都對得上。";
const labels = ["降低 handoff／review 上限，並把 Codex 預設 effort 改成 low", "先加 TTFT 計時，再決定怎麼改", "只精簡 Codex 的提示和 tool schema"];

async function withQuestion(choices: unknown[], check: (core: Core, file: string, dir: string) => void, text = lead) {
  const dir = tempDir("waiting-preview");
  const folder = tempDir("waiting-preview-project");
  mkdirSync(join(folder, ".bot"), { recursive: true });
  saveProjectRow(dir, { id: PROJECT, name: "botling", folder, avatar: "triangle" });
  const store = join(dir, "projects", PROJECT);
  mkdirSync(store, { recursive: true });
  const file = join(store, "chat.json");
  writeFileSync(file, JSON.stringify([{ id: QUESTION, role: "bot", text, date: 814897456.479, choices }]));
  const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  try { check(core, file, dir); } finally { await core.shutdown(); }
}

describe("waiting question preview", () => {
  it("retains a directly stated question so Yes / No choices have context", async () => {
    await withQuestion([{ label: "Yes" }, { label: "No" }], core => {
      expect(core.waiting().items.find(item => item.botId === PROJECT)?.text).toBe("Publish now? — 1. Yes / 2. No");
    }, "Publish now?");
  });

  it("falls back to recorded text when choice labels are missing, and does not create waiting without choices", async () => {
    await withQuestion([{ recommended: false }], core => {
      expect(core.waiting().items.find(item => item.botId === PROJECT)?.text).toBe(lead);
    });
    await withQuestion([], core => {
      expect(core.waiting().items.filter(item => item.botId === PROJECT)).toEqual([]);
    });
  });
  it("bounds a long preview and preserves previously ignored questions", async () => {
    await withQuestion([{ label: "X".repeat(500) }], (core, _file, dir) => {
      const text = core.waiting().items.find(item => item.botId === PROJECT)!.text;
      expect(text).toHaveLength(400);
      expect(text.endsWith("…")).toBe(true);
      for (const preview of [lead, text]) {
        writeFileSync(join(dir, "settings.json"), JSON.stringify({ ignoredWaiting: [`${PROJECT}-${preview}`] }));
        expect(core.waiting().items.filter(item => item.botId === PROJECT)).toEqual([]);
      }
    });
  });

  it("shows the three recorded choices instead of the declarative lead, without answering or changing waiting", async () => {
    await withQuestion(labels.map(label => ({ label, recommended: false })), (core, file) => {
      const before = readFileSync(file, "utf8");
      const items = core.waiting().items.filter(item => item.botId === PROJECT);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ messageId: QUESTION, text: labels.map((label, i) => `${i + 1}. ${label}`).join(" / ") });
      expect(readFileSync(file, "utf8")).toBe(before);
    });
  });
});
