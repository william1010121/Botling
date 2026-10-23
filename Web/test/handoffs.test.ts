import { beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { HandoffDock } from "../src/handoffs";
import { setLanguage } from "../src/i18n";
import type { ChatState, HandoffView } from "../src/types";

function handoff(overrides: Partial<HandoffView> = {}): HandoffView {
  return {
    id: "H1", from: "claude", to: "codex", fromName: "Claude", toName: "Codex", kind: "task",
    task: "Review the toolbar diff", origin: "Fix the toolbar overlap", round: 1, limit: 6, state: "running",
    lines: [{ who: "claude", name: "Claude", text: "Review the toolbar diff" }],
    ...overrides,
  };
}

function state(overrides: Partial<ChatState> = {}): ChatState {
  return {
    botID: "b1", botName: "Botling", messages: [], working: false, avatar: "", placeholder: "",
    replyingTo: null, pendingFiles: [], components: {}, ...overrides,
  } as ChatState;
}

function setUp(): HandoffDock {
  document.body.innerHTML = `<div id="pin-area"><div class="dock-row"><div class="pin-dock"></div></div></div>`;
  return new HandoffDock(document.querySelector<HTMLElement>(".dock-row")!);
}

const chip = () => document.querySelector<HTMLElement>(".handoff-chip")!;
const panel = () => document.querySelector<HTMLElement>(".handoff-panel")!;
const click = (selector: string) => document.querySelector<HTMLElement>(selector)!.click();

beforeEach(() => {
  sent.length = 0;
  setLanguage("en");
});

describe("the hand-off chip on the pinned strip's row", () => {
  it("stays out of sight with nothing under way", () => {
    const dock = setUp();
    dock.update(state({ handoffs: [handoff({ state: "done" })] }));
    expect(chip().hidden).toBe(true);
    expect(panel().hidden).toBe(true);
  });

  it("one under way: a meter, Hand-off 1/6 and Stop, at the end of the row with the panel above it", () => {
    const dock = setUp();
    dock.update(state({ handoffs: [handoff()] }));
    expect(chip().hidden).toBe(false);
    expect(chip().parentElement?.className).toBe("dock-row");
    expect(panel().nextElementSibling?.className).toBe("dock-row");
    expect(chip().querySelector(".handoff-label")?.textContent).toBe("Hand-off 1/6");
    expect(chip().querySelectorAll(".handoff-meter i")).toHaveLength(6);
    expect(chip().querySelectorAll(".handoff-meter i.on")).toHaveLength(1);
    click(".handoff-stop");
    expect(sent).toContainEqual({ type: "stopHandoff", botID: "b1", handoffID: "H1" });
  });

  it("is in the page's language", () => {
    setLanguage("zh-Hant");
    const dock = setUp();
    dock.update(state({ lang: "zh-Hant", handoffs: [handoff({ round: 2 })] }));
    expect(chip().querySelector(".handoff-label")?.textContent).toBe("交接 2/6");
    dock.update(state({ lang: "zh-Hant", handoffs: [handoff(), handoff({ id: "H2" })] }));
    expect(chip().querySelector(".handoff-label")?.textContent).toBe("2 筆交接進行中");
  });

  it("several under way: both heads' dots, N hand-offs in progress, and a chevron", () => {
    const dock = setUp();
    dock.update(state({ handoffs: [handoff(), handoff({ id: "H2", from: "codex", to: "claude" }), handoff({ id: "H3", state: "waiting" })] }));
    expect(chip().querySelector(".handoff-label")?.textContent).toBe("3 hand-offs in progress");
    expect([...chip().querySelectorAll(".handoff-dots .head-dot")].map((dot) => (dot as HTMLElement).dataset.head)).toEqual(["claude", "codex"]);
    expect(chip().querySelector(".handoff-chevron")).not.toBeNull();
    expect(chip().querySelector(".handoff-stop")).toBeNull();
    expect(panel().hidden).toBe(true);
  });

  it("without hand-off details still shows the rounds line's numbers (an older app, a snapshot)", () => {
    const dock = setUp();
    dock.update(state({ rounds: { text: "Round 2 of 3", stop: "Stop now", kind: "discussion", round: 2, limit: 3 } }));
    expect(chip().querySelector(".handoff-label")?.textContent).toBe("Round 2/3");
    expect(chip().querySelector<HTMLButtonElement>(".handoff-toggle")!.disabled).toBe(true);
  });
});

describe("the hand-off panel", () => {
  const three = [
    handoff(),
    handoff({ id: "H2", from: "codex", to: "claude", task: "Publish the page", state: "waiting", round: 2, origin: "Also publish it",
      lines: [{ who: "codex", name: "Codex", text: "Publish the page" }, { who: "claude", name: "Claude", text: "Published: claude.ai/x" }] }),
    handoff({ id: "H3", task: "Old one", state: "done", round: 3 }),
  ];

  it("opens above the strip and lists each hand-off: who to whom, its task, how it stands, its count", () => {
    const dock = setUp();
    dock.update(state({ handoffs: three }));
    click(".handoff-toggle");
    expect(panel().hidden).toBe(false);
    expect(chip().querySelector(".handoff-toggle")?.getAttribute("aria-expanded")).toBe("true");
    const rows = [...panel().querySelectorAll<HTMLElement>(".handoff-row")];
    expect(rows.map((row) => row.dataset.state)).toEqual(["running", "waiting", "done"]);
    expect(rows.map((row) => row.querySelector(".handoff-task")?.textContent)).toEqual(["Review the toolbar diff", "Publish the page", "Old one"]);
    expect(rows.map((row) => row.querySelector(".handoff-state")?.textContent)).toEqual(["Running", "Waiting reply", "Done"]);
    expect(rows.map((row) => row.querySelector(".handoff-count")?.textContent)).toEqual(["1/6", "2/6", "3/6"]);
    expect([...rows[1].querySelectorAll<HTMLElement>(".handoff-route .head-dot")].map((dot) => dot.dataset.head)).toEqual(["codex", "claude"]);
    expect(rows.every((row) => !row.querySelector(".handoff-detail"))).toBe(true);
    // The chip counts the ones under way; the header says the listed done one has ended.
    expect(panel().querySelector(".handoff-panel-counts")?.textContent).toBe("2 in progress · 1 ended");
    click(".handoff-stop-all");
    expect(sent).toContainEqual({ type: "stopRounds" });
  });

  it("a row opens to the message it came from and what the heads said", () => {
    const dock = setUp();
    dock.update(state({ handoffs: three }));
    click(".handoff-toggle");
    click(".handoff-row[data-id='H2'] .handoff-row-head");
    const row = panel().querySelector<HTMLElement>(".handoff-row[data-id='H2']")!;
    expect(row.classList.contains("expanded")).toBe(true);
    expect(row.querySelector(".handoff-origin")?.textContent).toBe("From your message: Also publish it");
    expect([...row.querySelectorAll(".handoff-lines li")].map((li) => [li.querySelector(".handoff-who")?.textContent, li.querySelector(".handoff-text")?.textContent]))
      .toEqual([["Codex", "Publish the page"], ["Claude", "Published: claude.ai/x"]]);
    // A selected row must never post the global stop action.
    expect(row.querySelector(".handoff-stop-one")?.textContent).toBe("Stop this one");
    click(".handoff-row[data-id='H2'] .handoff-stop-one");
    expect(sent).toEqual([{ type: "stopHandoff", botID: "b1", handoffID: "H2" }]);
    expect(panel().querySelector(".handoff-row[data-id='H1']")?.getAttribute("data-state")).toBe("running");
    // Kept open through the next state, and per chat.
    dock.update(state({ handoffs: three }));
    expect(panel().querySelector(".handoff-row[data-id='H2'] .handoff-detail")).not.toBeNull();
    dock.update(state({ botID: "b2", handoffs: three }));
    expect(panel().hidden).toBe(true);
    dock.update(state({ handoffs: three }));
    expect(panel().hidden).toBe(false);
    click(".handoff-row[data-id='H2'] .handoff-row-head");
    expect(panel().querySelector(".handoff-row[data-id='H2'] .handoff-detail")).toBeNull();
  });

  it("with one under way, its row's button stops just that one", () => {
    const dock = setUp();
    dock.update(state({ handoffs: [handoff()] }));
    click(".handoff-toggle");
    click(".handoff-row-head");
    expect(panel().querySelector(".handoff-stop-one")?.textContent).toBe("Stop this one");
  });

  it("closes once nothing is under way", () => {
    const dock = setUp();
    dock.update(state({ handoffs: three }));
    click(".handoff-toggle");
    dock.update(state({ handoffs: three.map((one) => ({ ...one, state: "done" as const })) }));
    expect(chip().hidden).toBe(true);
    expect(panel().hidden).toBe(true);
  });
});
