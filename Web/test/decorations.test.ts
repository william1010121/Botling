import { beforeEach, describe, expect, it, vi } from "vitest";
import { sent } from "../src/bridge";
import { DecorationLayer, type DecorationRenderer } from "../src/decorations";
import type { ChatState, DecorationView } from "../src/types";

// Message decorations (chat extension v2): the page places what a plugin draws among the messages,
// folds and reveals the lines, and the plugin only draws inside its element.

globalThis.CSS ??= { escape: (value: string) => value } as unknown as typeof CSS;

const ids = ["u", "a", "b", "c", "d"];
let rows: Map<string, HTMLElement>;
const row = (id: string) => rows.get(id) ?? null;
const order = () => [...document.getElementById("messages")!.children].map((el) => (el as HTMLElement).dataset.id ?? `[${(el as HTMLElement).dataset.key}]`);
const state = (decorations: DecorationView[], extra: Partial<ChatState> = {}): ChatState => ({
  botID: "bot", botName: "Bot", working: false, avatar: "", placeholder: "", replyingTo: null, pendingFiles: [], components: {},
  messages: ids.map((id) => ({ id, role: id === "u" ? "user" : "bot", text: id, stamp: null, avatar: null, choices: null, chosen: null, answer: null, open: false, attachments: null, replyTo: null, replyPreview: null, openable: false })),
  decorations, ...extra,
});
const fold = (key: string, lines: string[], data: unknown = key): DecorationView => ({ plugin: "p", key, fold: lines, data });
const folded = () => ids.filter((id) => row(id)!.classList.contains("decoration-folded"));

function renderer(): DecorationRenderer & { drawn: string[]; gone: string[]; updates: number } {
  const out = {
    drawn: [] as string[], gone: [] as string[], updates: 0,
    draw: (root: HTMLElement, decoration: DecorationView) => { out.drawn.push(decoration.key); root.textContent = String(decoration.data); },
    removed: (decoration: DecorationView) => { out.gone.push(decoration.key); },
    update: () => { out.updates++; },
  };
  return out;
}

beforeEach(() => {
  document.body.innerHTML = `<div id="messages"></div>`;
  rows = new Map(ids.map((id) => {
    const element = document.createElement("div");
    element.className = "row";
    element.dataset.id = id;
    document.getElementById("messages")!.append(element);
    return [id, element];
  }));
});

describe("DecorationLayer", () => {
  it("puts a folding decoration before its first line, folds the lines, and keeps the rows where they are", () => {
    const layer = new DecorationLayer();
    const drawing = renderer();
    layer.register("p", drawing);
    layer.update(state([fold("k", ["a", "b"], "Summary")]), row);
    expect(order()).toEqual(["u", "[k]", "a", "b", "c", "d"]);
    expect(folded()).toEqual(["a", "b"]);
    expect(document.querySelector(".decoration-extra")?.textContent).toBe("Summary");
    expect(drawing.drawn).toEqual(["k"]);
    expect(drawing.updates).toBe(1);
    layer.update(state([fold("k", ["a", "b"], "Ready")]), row);
    expect(document.querySelector(".decoration-extra")?.textContent).toBe("Ready");
    expect(order()).toEqual(["u", "[k]", "a", "b", "c", "d"]);
  });

  it("puts an `after` decoration after its line without folding anything", () => {
    const layer = new DecorationLayer();
    layer.register("p", renderer());
    layer.update(state([{ plugin: "p", key: "chip", after: "u", data: "Building…" }]), row);
    expect(order()).toEqual(["u", "[chip]", "a", "b", "c", "d"]);
    expect(folded()).toEqual([]);
  });

  it("unfolds what one folded before the next folds the same lines, and tells the plugin it went", () => {
    const layer = new DecorationLayer();
    const drawing = renderer();
    layer.register("p", drawing);
    layer.update(state([fold("unread", ["b", "c"])]), row);
    layer.update(state([fold("interval", ["b", "c"])]), row);
    expect(folded()).toEqual(["b", "c"]);
    expect(order()).toEqual(["u", "a", "[interval]", "b", "c", "d"]);
    expect(drawing.gone).toEqual(["unread"]);
    layer.update(state([]), row);
    expect(folded()).toEqual([]);
    expect(order()).toEqual(ids);
  });

  it("draws nothing for a plugin with no renderer, or while you watch a subagent, or once the plugin unloads", () => {
    const layer = new DecorationLayer();
    layer.update(state([fold("k", ["a"])]), row);
    expect(order()).toEqual(ids);
    const dispose = layer.register("p", renderer());
    expect(order()).toEqual(["u", "[k]", "a", "b", "c", "d"]);
    layer.update(state([fold("k", ["a"])], { subagent: { id: "s" } as ChatState["subagent"] }), row);
    expect([order(), folded()]).toEqual([ids, []]);
    layer.update(state([fold("k", ["a"])]), row);
    dispose();
    expect([order(), folded()]).toEqual([ids, []]);
  });

  it("reveals one folded line in place for as long as the decoration stays, and only its own lines", () => {
    vi.useFakeTimers();
    try {
      const layer = new DecorationLayer();
      let reveal: ((id: string) => void) | null = null;
      layer.register("p", { draw: (_root, _decoration, context) => { reveal = context.reveal; } });
      layer.update(state([fold("k", ["a", "b"])]), row);
      reveal!("b");
      reveal!("d");
      expect(folded()).toEqual(["a"]);
      expect(row("b")!.classList.contains("source-live-flash")).toBe(true);
      layer.update(state([fold("k", ["a", "b"])]), row);
      expect(folded()).toEqual(["a"]);
      vi.advanceTimersByTime(2_100);
      expect(row("b")!.classList.contains("source-live-flash")).toBe(false);
      // A new decoration (another key) starts folded again.
      layer.update(state([fold("k2", ["a", "b"])]), row);
      expect(folded()).toEqual(["a", "b"]);
    } finally { vi.useRealTimers(); }
  });

  it("a renderer that throws is reported by the guard; the chat goes on", () => {
    const failures: string[] = [];
    const layer = new DecorationLayer((plugin, run) => { try { return run(); } catch { failures.push(plugin); return undefined; } });
    layer.register("p", { draw: () => { throw new Error("boom"); } });
    layer.update(state([fold("k", ["a"])]), row);
    expect(failures).toEqual(["p"]);
    expect(order()).toEqual(["u", "[k]", "a", "b", "c", "d"]);
  });

  it("opens a task as its chip does", () => {
    const layer = new DecorationLayer();
    let open: ((id: string) => void) | null = null;
    layer.register("p", { draw: (_root, _decoration, context) => { open = context.openTask; } });
    layer.update(state([fold("k", ["a"])]), row);
    open!("T1");
    expect(sent.at(-1)).toEqual({ type: "selectTask", id: "T1" });
  });
});
