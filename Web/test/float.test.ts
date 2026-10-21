import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sent } from "../src/bridge";
import { FloatLayer, clampFloatSize, defaultFloatWidth, floatCells, floatRect, floatWidth, isNarrow, lineHeight, snapCorner } from "../src/float";
import { PinArea } from "../src/pins";
import type { ChatState, ComponentInfo, FloatingPinView, PinView } from "../src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const components: Record<string, ComponentInfo> = {
  build: { template: "<div>build</div>", version: 1, working: false, updated: false, hasPrevious: false, title: "建置進度" },
};

function pin(overrides: Partial<PinView> = {}): PinView {
  return {
    id: "P1", name: "build", headline: "Building 40%", chip: { text: "40%", tone: "warning" }, size: "2x2", refresh: "interval", minutes: 15, seconds: 5,
    display: { name: "build", data: `{"progress":40}`, command: "make status", folder: "/p", status: "done", ranAt: "10:42" },
    float: { corner: "topRight", width: 280, height: 160, collapsed: false },
    floatMenu: "stop",
    ...overrides,
  };
}

function floating(...pins: PinView[]): FloatingPinView[] {
  return pins.map((p) => ({ botID: "b1", botName: "Release bot", pin: p }));
}

function state(overrides: Partial<ChatState> = {}): ChatState {
  return {
    botID: "b2", botName: "Other bot", messages: [], working: false, avatar: "", placeholder: "",
    replyingTo: null, pendingFiles: [], components, pins: [], pinChoices: [], board: false, floating: floating(pin()), ...overrides,
  };
}

function setUp(): FloatLayer {
  document.body.innerHTML = `<main id="scroller"></main><section id="board"></section><div id="pin-area"></div><div id="composer-slot"></div>`;
  return new FloatLayer(document.body);
}

const pointer = (type: string, x: number, y: number) => new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });

function viewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  window.dispatchEvent(new Event("resize"));
}

beforeEach(() => {
  sent.length = 0;
  document.body.innerHTML = "";
  document.body.className = "";
  viewport(1000, 800);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("where a floating card goes", () => {
  it("snaps to the corner nearest where it was let go", () => {
    expect(snapCorner(900, 100, 1000, 800)).toBe("topRight");
    expect(snapCorner(100, 100, 1000, 800)).toBe("topLeft");
    expect(snapCorner(900, 700, 1000, 800)).toBe("bottomRight");
    expect(snapCorner(100, 700, 1000, 800)).toBe("bottomLeft");
  });

  it("sits in its corner and never over the input box", () => {
    const view = { width: 1000, height: 800 };
    // At the top it is placed by its top, at the bottom by its bottom (it grows away from its corner).
    expect(floatRect({ corner: "topRight", width: 280, height: 160, collapsed: false }, view, 700)).toEqual({ left: 708, top: 12, bottom: null, width: 280, maxHeight: 160 });
    expect(floatRect({ corner: "bottomLeft", width: 280, height: 160, collapsed: false }, view, 700)).toEqual({ left: 12, top: null, bottom: 112, width: 280, maxHeight: 160 });
    // A short window: no taller than there is room above the input box.
    const short = floatRect({ corner: "topRight", width: 280, height: 480, collapsed: false }, { width: 1000, height: 300 }, 250);
    expect(short.top! + short.maxHeight).toBeLessThanOrEqual(250 - 12);
    // A second card in the same corner goes below (above, at the bottom) the first.
    expect(floatRect({ corner: "topRight", width: 280, height: 160, collapsed: false }, view, 700, 172).top).toBe(184);
    expect(floatRect({ corner: "bottomRight", width: 280, height: 160, collapsed: false }, view, 700, 172).bottom).toBe(284);
    // Folded, one line.
    expect(floatRect({ corner: "topRight", width: 280, height: 160, collapsed: true }, view, 700).maxHeight).toBe(lineHeight);
  });

  it("not resized, it is wide enough for a card's full layout and as tall as its content allows", () => {
    const view = { width: 1000, height: 800 };
    const fresh = floatRect({ corner: "topRight", collapsed: false }, view, 700, 0, defaultFloatWidth(components.build));
    expect(fresh.width).toBe(floatWidth);
    // Its height is its content's (CSS), up to the most a card may be.
    expect(fresh.maxHeight).toBe(480);
    // A component made for wide tiles (Sizes: 4x2) gets a wider card, within limits and the window.
    expect(defaultFloatWidth({ ...components.build, sizes: ["4x2"] })).toBe(640);
    expect(defaultFloatWidth({ ...components.build, sizes: ["1x1"] })).toBe(floatWidth);
    expect(floatRect({ corner: "topRight", collapsed: false }, { width: 400, height: 800 }, 700, 0, 640).width).toBe(400 - 24);
    // Resized, its width is kept and its height is the most it grows to.
    expect(floatRect({ corner: "topRight", width: 300, height: 220, collapsed: false }, view, 700, 0, 640)).toMatchObject({ width: 300, maxHeight: 220 });
  });

  it("keeps its size within limits and tells the component its cells", () => {
    expect(clampFloatSize(50, 2000)).toEqual({ width: 200, height: 480 });
    expect(clampFloatSize(300, 200)).toEqual({ width: 300, height: 200 });
    expect(floatCells(280, 160)).toBe("2x1");
    expect(floatCells(600, 450)).toBe("4x3");
    expect(isNarrow(639)).toBe(true);
    expect(isNarrow(640)).toBe(false);
  });
});

describe("a floating card", () => {
  it("draws the pin's component over any bot's chat, under the header an opened pin has", () => {
    const layer = setUp();
    layer.update(state());
    const card = document.querySelector<HTMLElement>(".float-card")!;
    expect(card.dataset.id).toBe("P1");
    expect(card.dataset.corner).toBe("topRight");
    // The shared header: icon, the component's own name (not its folder's), status, ↻ and ⋯.
    const head = card.querySelector<HTMLElement>(".float-head")!;
    expect(head.classList.contains("pin-head")).toBe(true);
    expect(head.querySelector(".pin-head-title")?.textContent).toBe("建置進度");
    expect(head.querySelector(".pin-head-status")?.textContent).toBe("40%");
    expect(head.querySelector<HTMLElement>(".pin-head-status")?.dataset.tone).toBe("warning");
    expect([...head.querySelectorAll(".pin-head-tools button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Refresh (Updated 10:42)", "More"]);
    expect(card.title).toContain("Release bot");
    expect(card.title).toContain("建置進度");
    const frame = card.querySelector<HTMLIFrameElement>(".float-body iframe.component-frame")!;
    expect(frame).not.toBeNull();
    // Told it is pinned, as when opened above the input box, and drawn at its content's height.
    expect(frame.srcdoc).toContain(`data-surface="pinned"`);
    expect(frame.srcdoc).not.toMatch(/<html[^>]*data-fill/);
    expect(frame.srcdoc).toContain(`data-size="2x1"`);
    expect(card.style.width).toBe("280px");
    expect(card.style.height).toBe("");
    expect(card.style.maxHeight).toBe("160px");
    // None: nothing floats.
    layer.update(state({ floating: [] }));
    expect(document.querySelector(".float-card")).toBeNull();
  });

  it("not resized, it is as tall as its component's content and wide enough for its full layout", () => {
    const layer = setUp();
    layer.update(state({ floating: floating(pin({ float: { corner: "bottomRight", collapsed: false } })) }));
    const card = document.querySelector<HTMLElement>(".float-card")!;
    expect(card.style.width).toBe(`${floatWidth}px`);
    expect(card.style.height).toBe("");
    expect(card.style.maxHeight).toBe("480px");
    // At the bottom it is held by its bottom edge, above the input box.
    expect(card.style.top).toBe("");
    expect(card.style.bottom).not.toBe("");
    // The frame reports its content's height: that is its height.
    const frame = card.querySelector<HTMLIFrameElement>(".component-frame")!;
    window.dispatchEvent(new MessageEvent("message", { data: { ccb: "size", height: 210 }, source: frame.contentWindow }));
    expect(frame.style.height).toBe("210px");
  });

  it("folds to one line on a click of its head, and stays folded", () => {
    const layer = setUp();
    layer.update(state());
    const card = document.querySelector<HTMLElement>(".float-card")!;
    const head = card.querySelector<HTMLElement>(".float-head")!;
    head.dispatchEvent(pointer("pointerdown", 900, 20));
    head.dispatchEvent(pointer("pointerup", 900, 20));
    window.dispatchEvent(pointer("pointerup", 900, 20));
    expect(card.classList.contains("collapsed")).toBe(true);
    expect(sent).toContainEqual({ type: "setPinFloat", id: "P1", collapsed: true });
    const frame = card.querySelector(".component-frame");
    layer.update(state({ floating: floating(pin({ float: { corner: "topRight", width: 280, height: 160, collapsed: true } })) }));
    expect(card.classList.contains("collapsed")).toBe(true);
    expect(card.style.height).toBe(`${lineHeight}px`);
    // Its frame stays loaded while folded.
    expect(card.querySelector(".component-frame")).toBe(frame);
  });

  it("dragged across the window, it snaps to the nearest corner", () => {
    const layer = setUp();
    layer.update(state());
    const card = document.querySelector<HTMLElement>(".float-card")!;
    const head = card.querySelector<HTMLElement>(".float-head")!;
    head.dispatchEvent(pointer("pointerdown", 900, 20));
    window.dispatchEvent(pointer("pointermove", 500, 300));
    window.dispatchEvent(pointer("pointermove", 100, 600));
    window.dispatchEvent(pointer("pointerup", 100, 600));
    expect(card.dataset.corner).toBe("bottomLeft");
    expect(sent).toContainEqual({ type: "setPinFloat", id: "P1", corner: "bottomLeft" });
    // A drag is not a click: it did not fold.
    expect(card.classList.contains("collapsed")).toBe(false);
  });

  it("resizes by its inner corner, within limits", () => {
    const layer = setUp();
    layer.update(state());
    const card = document.querySelector<HTMLElement>(".float-card")!;
    const handle = card.querySelector<HTMLElement>(".float-resize")!;
    expect(handle.dataset.edge).toBe("bottomLeft");
    handle.dispatchEvent(pointer("pointerdown", 708, 172));
    window.dispatchEvent(pointer("pointermove", 608, 232));
    window.dispatchEvent(pointer("pointerup", 608, 232));
    expect(card.style.width).toBe("380px");
    // That height is now the most it grows to: shorter content, a shorter card.
    expect(card.style.maxHeight).toBe("220px");
    expect(card.style.height).toBe("");
    expect(sent).toContainEqual({ type: "setPinFloat", id: "P1", width: 380, height: 220 });
  });

  it("in a narrow window it shows as a chip instead", () => {
    const layer = setUp();
    viewport(600, 800);
    layer.update(state());
    const layerElement = document.querySelector<HTMLElement>(".float-layer")!;
    expect(layerElement.classList.contains("narrow")).toBe(true);
    const card = document.querySelector<HTMLElement>(".float-card")!;
    expect(card.style.height).toBe(`${lineHeight}px`);
    viewport(1000, 800);
    expect(layerElement.classList.contains("narrow")).toBe(false);
    expect(card.style.height).toBe("");
    expect(card.style.maxHeight).toBe("160px");
  });

  it("keeps a live frame when new data comes and sends it the data", () => {
    const layer = setUp();
    layer.update(state());
    const card = document.querySelector<HTMLElement>(".float-card")!;
    const frame = card.querySelector<HTMLIFrameElement>(".component-frame")!;
    const posts: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((data: unknown) => { posts.push(data); });
    window.dispatchEvent(new MessageEvent("message", { data: { ccb: "live" }, source: frame.contentWindow }));
    const next = pin({ chip: { text: "70%", tone: "warning" }, display: { ...pin().display, data: `{"progress":70}`, ranAt: "10:43" } });
    layer.update(state({ floating: floating(next) }));
    expect(document.querySelector(".float-card")).toBe(card);
    expect(card.querySelector(".component-frame")).toBe(frame);
    expect(posts).toContainEqual({ ccbData: `{"progress":70}` });
    expect(card.querySelector(".pin-head-status")?.textContent).toBe("70%");
    expect(card.querySelectorAll(".float-body")).toHaveLength(1);
  });

  it("refreshes every few seconds only while the window is shown", () => {
    const layer = setUp();
    layer.update(state());
    const now = 1_000_000;
    // First seen: counted from now.
    expect(layer.refreshDue(now)).toBe(0);
    expect(layer.refreshDue(now + 4000)).toBe(0);
    expect(layer.refreshDue(now + 5000)).toBe(1);
    expect(sent).toContainEqual({ type: "pinCommand", id: "P1", command: "make status", folder: "/p", force: true, live: true });
    sent.length = 0;
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    expect(layer.refreshDue(now + 20000)).toBe(0);
    expect(sent).toEqual([]);
    hidden.mockRestore();
    expect(layer.refreshDue(now + 20000)).toBe(1);
    // About.md's `Refresh: every 2s` counts too; a running one waits.
    sent.length = 0;
    layer.update(state({ floating: floating(pin({ refresh: "shown", seconds: null, display: { ...pin().display, every: 2, status: "running" } })) }));
    expect(layer.refreshDue(now + 60000)).toBe(0);
    // The card itself does not also rerun it (no data-every on it).
    expect(document.querySelector(".float-card .command-card[data-every]")).toBeNull();
  });
});

describe("the pin's menu", () => {
  function area(pins: PinView[]): PinArea {
    document.body.innerHTML = `<main id="scroller"></main><section id="board"></section><div id="pin-area"></div><div id="composer-slot"></div>`;
    const area = new PinArea(document.getElementById("pin-area")!, document.getElementById("board")!);
    area.update(state({ pins, floating: [] }));
    return area;
  }
  const entries = () => [...document.querySelectorAll<HTMLButtonElement>(".pin-menu button")];
  const openMenu = () => document.querySelector(".pin-chip")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

  it("floats a pin in the corner, or stops it", () => {
    area([pin({ float: null, floatMenu: "float" })]);
    openMenu();
    entries().find((e) => e.textContent === "Float in corner")!.click();
    expect(sent).toContainEqual({ type: "floatPin", id: "P1", floating: true });
    area([pin()]);
    openMenu();
    entries().find((e) => e.textContent === "Stop floating")!.click();
    expect(sent).toContainEqual({ type: "floatPin", id: "P1", floating: false });
  });

  it("says when two float already", () => {
    area([pin({ float: null, floatMenu: "full" })]);
    openMenu();
    const full = entries().find((e) => e.textContent?.startsWith("Float in corner"))!;
    expect(full.textContent).toBe("Float in corner (2 floating already)");
    expect(full.disabled).toBe(true);
  });

  it("a floating card's own menu folds it and stops it floating", () => {
    const layer = setUp();
    layer.update(state());
    document.querySelector<HTMLButtonElement>(".float-card [aria-label='More']")!.click();
    expect([...document.querySelectorAll(".pin-menu .refresh-interval-pick")].map((e) => e.getAttribute("aria-label"))).toContain("Every 5 sec");
    entries().find((e) => e.textContent === "Stop floating")!.click();
    expect(sent).toContainEqual({ type: "floatPin", id: "P1", floating: false });
  });
});

describe("a floating pin shown in all bots", () => {
  const entries = () => [...document.querySelectorAll<HTMLButtonElement>(".pin-menu button")];
  const more = () => document.querySelector<HTMLButtonElement>(".float-card [aria-label='More']")!.click();

  it("in another bot's chat, carries its own bot's name in its header and runs in that bot's folder", () => {
    const layer = setUp();
    layer.update(state({ botID: "b2", botName: "Main", floating: [{ botID: "b1", botName: "ClaudeCodeBot", global: true, pin: pin({ display: { ...pin().display, folder: "/code/ClaudeCodeBot" } }) }] }));
    const card = document.querySelector<HTMLElement>(".float-card")!;
    expect(card.classList.contains("global")).toBe(true);
    const owner = card.querySelector<HTMLElement>(".float-head .float-owner")!;
    expect(owner.textContent).toBe("ClaudeCodeBot");
    expect(owner.querySelector("svg")).not.toBeNull();
    // Between the status and the tools, in the one shared header.
    expect(owner.nextElementSibling?.classList.contains("pin-head-tools")).toBe(true);
    expect(card.getAttribute("aria-label")).toBe("建置進度, floating in all bots, from ClaudeCodeBot");
    // ↻ runs its command in its own bot's folder, whichever chat shows it.
    card.querySelector<HTMLButtonElement>("[aria-label^='Refresh']")!.click();
    expect(sent).toContainEqual(expect.objectContaining({ type: "pinCommand", id: "P1", command: "make status", folder: "/code/ClaudeCodeBot" }));
  });

  it("one floating only in its own bot's chat has no owner mark", () => {
    const layer = setUp();
    layer.update(state());
    expect(document.querySelector(".float-owner")).toBeNull();
    expect(document.querySelector(".float-card")!.classList.contains("global")).toBe(false);
  });

  it("switching to another bot's chat, a pin floating only in its own goes", () => {
    const layer = setUp();
    layer.update(state({ botID: "b1", botName: "Release bot" }));
    expect(document.querySelectorAll(".float-card")).toHaveLength(1);
    // Swift gives the other chat only its own floats and those shown in all bots.
    layer.update(state({ botID: "b2", botName: "Other bot", floating: [] }));
    expect(document.querySelector(".float-card")).toBeNull();
  });

  it("stacks first, in the order Swift gives, and the mark follows a promotion", () => {
    const layer = setUp();
    layer.update(state({ floating: [{ botID: "b1", botName: "ClaudeCodeBot", global: true, pin: pin({ id: "G" }) }, { botID: "b2", botName: "Other bot", pin: pin({ id: "OWN" }) }] }));
    expect([...document.querySelectorAll<HTMLElement>(".float-card")].map((c) => c.dataset.id)).toEqual(["G", "OWN"]);
    expect([...document.querySelectorAll<HTMLElement>(".float-card")].map((c) => !!c.querySelector(".float-owner"))).toEqual([true, false]);
    // Promoted: the mark comes, the frame stays.
    const frame = document.querySelector(".float-card[data-id='OWN'] iframe");
    layer.update(state({ floating: [{ botID: "b1", botName: "ClaudeCodeBot", global: true, pin: pin({ id: "G" }) }, { botID: "b2", botName: "Other bot", global: true, pin: pin({ id: "OWN" }) }] }));
    expect(document.querySelector(".float-card[data-id='OWN'] .float-owner")?.textContent).toBe("Other bot");
    expect(document.querySelector(".float-card[data-id='OWN'] iframe")).toBe(frame);
  });

  it("its menu shows it in all bots, or only in its own again", () => {
    const layer = setUp();
    layer.update(state());
    more();
    expect(entries().map((e) => e.textContent)).toContain("Show in all bots");
    entries().find((e) => e.textContent === "Show in all bots")!.click();
    expect(sent).toContainEqual({ type: "setPinGlobal", id: "P1", global: true });
    layer.update(state({ floating: [{ botID: "b1", botName: "ClaudeCodeBot", global: true, pin: pin() }] }));
    more();
    expect(entries().map((e) => e.textContent)).not.toContain("Show in all bots");
    entries().find((e) => e.textContent === "Only in ClaudeCodeBot")!.click();
    expect(sent).toContainEqual({ type: "setPinGlobal", id: "P1", global: false });
  });

  it("says which chat has no room when it cannot be shown in all bots", () => {
    const layer = setUp();
    layer.update(state({ floating: [{ botID: "b1", botName: "Release bot", blocked: "Garden", pin: pin() }] }));
    more();
    const item = entries().find((e) => e.textContent?.startsWith("Show in all bots"))!;
    expect(item.textContent).toBe("Show in all bots (Garden has 2 floating)");
    expect(item.disabled).toBe(true);
  });
});
