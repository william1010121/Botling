// Math, 2026-11-06: asked for a verbatim .md of its three rounds with Claude, the Antigravity head's worker searched the
// chat archive and could not have built one: each hand-off to Claude was archived as its first line only (the divider
// "Antigravity → Claude: <first line>"), and Claude's replies were archived as "You:", like Antigravity's own. A reader
// of the archive (a head after a restart, a worker it briefs) must find what each head said, in full and by name.
import { describe, expect, it } from "vitest";
import { archiveEntry } from "../../src/core/briefing";
import { Conductor, makeHeads } from "../../src/core/heads";
import type { ChatRecord } from "../../src/core/store/records";

const at = 815624281.266; // 2026-11-06 10:18 in Taipei
const zone = { timeZone: "Asia/Taipei" };

describe("the chat archive of a discussion between two heads", () => {
  it("names the head that wrote a reply", () => {
    const claude: ChatRecord = { id: "c", role: "bot", text: "第 2 輪結論：三點我大致同意。", date: at, engine: "claude" } as ChatRecord;
    const agy: ChatRecord = { id: "a", role: "bot", text: "我和 Claude 深入推演後……", date: at, engine: "agy" } as ChatRecord;
    expect(archiveEntry(claude, zone)).toBe("[2026-11-06 10:18] You (Claude): 第 2 輪結論：三點我大致同意。");
    expect(archiveEntry(agy, zone)).toBe("[2026-11-06 10:18] You (Antigravity): 我和 Claude 深入推演後……");
    // A line with no engine (1.x's, the Swift goldens) stays "You".
    expect(archiveEntry({ id: "x", role: "bot", text: "hi", date: at } as ChatRecord, zone)).toBe("[2026-11-06 10:18] You: hi");
  });

  it("keeps the whole hand-off for the archive while the chat shows its first line", () => {
    const conductor = new Conductor(makeHeads(["claude", "agy"]));
    conductor.userMessage("先跟 claude 討論三輪");
    const task = "Claude，感謝你的第 1 輪剖析。我完全同意你提出的核心觀點：\n1. 狀態契約要多細？\n2. Sketch Proof 怎麼不重複程式碼？";
    const line = conductor.replied("agy", "已派出", { to: "claude", kind: "discuss", task, decisionId: null }, false).find((a) => a.type === "line") as { text: string; archive?: string };
    expect(line.text).toBe("Antigravity → Claude: Claude，感謝你的第 1 輪剖析。我完全同意你提出的核心觀點：");
    expect(line.archive).toBe(`Antigravity → Claude: ${task}`);
  });
});
