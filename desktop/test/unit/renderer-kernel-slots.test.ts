// @vitest-environment jsdom
// The renderer kernel's slots (M7-02a): the `:shell` instance owns the five root slots, KernelSlot draws a slot's contributions in
// registration order and drops one with its plugin (the kernel's undo), and ShellFrame draws the page as its own layout in `app/main`'s
// place (no `:shell` contribution to `app/main` since M7-07a: the chat column is botling.chat's, chat-main-slot.test.ts). The page's DOM
// through ShellFrame is in app-dom-golden.test.ts.
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROOT_SLOTS } from "../../../Web/src/plugin-kernel";
import type { Client } from "../../src/renderer/client";
import { CHAT_SURFACE, rendererKernel, SHELL_SURFACE } from "../../src/renderer/renderer-kernel";
import { KernelSlot } from "../../src/renderer/shell/KernelSlot";
import { ShellFrame } from "../../src/renderer/shell/ShellFrame";

const unmounts: (() => Promise<void>)[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  // What is drawn goes first, so a plugin's unload is not heard by a page that is still up.
  for (const unmount of unmounts.splice(0)) await unmount();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount(node: ReactNode): Promise<{ host: HTMLElement; root: Root; render: (next: ReactNode) => Promise<void>; unmount: () => Promise<void> }> {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } host.remove(); };
  unmounts.push(unmount);
  await act(async () => root.render(node));
  return { host, root, render: async (next) => { await act(async () => root.render(next)); }, unmount };
}

/** A plugin in the renderer kernel that contributes `entries` (component entries) to `slot` and is unloaded after the test. */
function contributor(name: string, slot: string, texts: string[], extra: Record<string, unknown> = {}) {
  rendererKernel.install({ name, contributes: { slots: [slot] } });
  void rendererKernel.load(name, (plugin) => {
    for (const text of texts) rendererKernel.contribute(plugin, slot, { kind: "component", render: () => createElement("i", { "data-text": text }, text), ...extra });
  });
  cleanups.push(async () => { await rendererKernel.requestUnload(name); rendererKernel.uninstall(name); });
}

describe("the renderer kernel's own instances", () => {
  it("has `:shell` owning the five root slots and `:chat` (loaded while App is up) as the only other instance it declares", () => {
    // `:chat` is not loaded here (App loads it: composer-quote.ts); `:shell` is loaded from the start.
    expect(rendererKernel.plugins()).toEqual([SHELL_SURFACE]);
    expect(rendererKernel.declaredOwner("composer.insertQuote")).toBeNull();
    expect(rendererKernel.state(CHAT_SURFACE)).toBe("absent");
    expect(rendererKernel.state(SHELL_SURFACE)).toBe("active");
    for (const slot of ROOT_SLOTS) expect(rendererKernel.slotOwner(slot), slot).toBe(SHELL_SURFACE);
    // The three that are 2.x view places are those places.
    expect(rendererKernel.slotOwner("view/main")).toBe(SHELL_SURFACE);
    expect(rendererKernel.slotOwner("view/bottomPanel")).toBe(SHELL_SURFACE);
    expect(rendererKernel.slotOwner("view/window")).toBe(SHELL_SURFACE);
    expect(rendererKernel.slotOwner("app/rail")).toBe(SHELL_SURFACE);
    expect(rendererKernel.slotOwner("app/side")).toBe(SHELL_SURFACE);
  });
});

describe("KernelSlot", () => {
  it("draws two contributions in registration order and drops one when its plugin unloads", async () => {
    contributor("slot.first", "app/side", ["one", "two"]);
    contributor("slot.second", "app/side", ["three"]);
    const page = await mount(createElement(KernelSlot, { slot: "app/side" }));
    expect([...page.host.querySelectorAll("i")].map((node) => node.textContent)).toEqual(["one", "two", "three"]);
    await act(async () => { await rendererKernel.requestUnload("slot.first"); });
    expect([...page.host.querySelectorAll("i")].map((node) => node.textContent)).toEqual(["three"]);
    await act(async () => { await rendererKernel.requestUnload("slot.second"); });
    expect(page.host.innerHTML).toBe("");
  });

  it("draws a contribution made under the other name, and one added while it is up", async () => {
    const page = await mount(createElement(KernelSlot, { slot: "view/bottomPanel" }));
    expect(page.host.innerHTML).toBe("");
    await act(async () => { contributor("slot.late", "app/bottom", ["late"]); await new Promise((done) => setTimeout(done, 0)); });
    expect([...page.host.querySelectorAll("i")].map((node) => node.textContent)).toEqual(["late"]);
  });

  it("draws no element of its own: an empty slot leaves the DOM as it was", async () => {
    const page = await mount(createElement("div", { id: "outer" }, createElement(KernelSlot, { slot: "app/rail" }), createElement("b", null, "after")));
    expect(page.host.innerHTML).toBe('<div id="outer"><b>after</b></div>');
  });

  it("draws a plugin's frame entry through SlotFrame, and nothing for one when the page gave it no client", async () => {
    contributor("slot.frames", "app/side", [], {});
    rendererKernel.install({ name: "slot.framed", contributes: { slots: ["app/side"] } });
    void rendererKernel.load("slot.framed", (plugin) => { rendererKernel.contribute(plugin, "app/side", { kind: "frame", frame: "slot", plugin: "acme.tool", view: "acme.tool.view", title: "Acme" }); });
    cleanups.push(async () => { await rendererKernel.requestUnload("slot.framed"); rendererKernel.uninstall("slot.framed"); });
    const client = { request: vi.fn(async () => ({ title: "t", source: "", settings: {} })), onEvent: () => () => {} } as unknown as Client;
    const without = await mount(createElement(KernelSlot, { slot: "app/side" }));
    expect(without.host.querySelector(".plugin-slot")).toBeNull();
    const withClient = await mount(createElement(KernelSlot, { slot: "app/side", frames: { client } }));
    const slot = withClient.host.querySelector(".plugin-slot");
    expect(slot?.getAttribute("data-plugin")).toBe("acme.tool");
    expect(slot?.getAttribute("data-view")).toBe("acme.tool.view");
  });
});

describe("ShellFrame", () => {
  const page = (text: string) => createElement("main", { className: "shell" }, text);

  it("draws the page with no wrapper and holds no `:shell` contribution to `app/main` for it (M7-07a: the legacy contribution is gone)", async () => {
    const shown = await mount(createElement(ShellFrame, { legacy: page("hello") }));
    expect(shown.host.innerHTML).toBe('<main class="shell">hello</main>');
    expect(rendererKernel.entries("app/main")).toEqual([]);
    expect(rendererKernel.entries("view/main")).toEqual([]);
    expect(rendererKernel.allContributions().filter(({ plugin, slot }) => plugin === SHELL_SURFACE && slot === "view/main")).toEqual([]);
  });

  it("draws the page as it is now without registering again, and takes the frame's own claim back when it goes", async () => {
    const shown = await mount(createElement(ShellFrame, { legacy: page("one") }));
    const first = rendererKernel.entries("app/bottom")[0]!.registration.id;
    await shown.render(createElement(ShellFrame, { legacy: page("two") }));
    expect(shown.host.innerHTML).toBe('<main class="shell">two</main>');
    expect(rendererKernel.entries("app/bottom").map((one) => one.registration.id)).toEqual([first]);
    // The page's own state is kept across draws (the element is not replaced).
    const node = shown.host.querySelector("main");
    await shown.render(createElement(ShellFrame, { legacy: page("three") }));
    expect(shown.host.querySelector("main")).toBe(node);
    await shown.unmount();
    expect(rendererKernel.entries("app/bottom")).toHaveLength(0);
    expect(rendererKernel.registrations(SHELL_SURFACE, "contribution")).toHaveLength(0);
  });

  it("keeps two frames apart: each draws its own page", async () => {
    const a = await mount(createElement(ShellFrame, { legacy: page("A") }));
    const b = await mount(createElement(ShellFrame, { legacy: page("B") }));
    expect(a.host.textContent).toBe("A");
    expect(b.host.textContent).toBe("B");
    expect(rendererKernel.entries("app/bottom")).toHaveLength(2);
    await a.unmount();
    expect(b.host.textContent).toBe("B");
    expect(rendererKernel.entries("app/bottom")).toHaveLength(1);
  });

  it("draws the other root slots around the page in layout order, so a plugin in one of them shows", async () => {
    contributor("slot.rail", "app/rail", ["rail"]);
    contributor("slot.over", "app/overlay", ["over"]);
    const shown = await mount(createElement(ShellFrame, { legacy: page("main") }));
    expect(shown.host.innerHTML).toBe('<i data-text="rail">rail</i><main class="shell">main</main><i data-text="over">over</i>');
  });

  it("draws the page directly when the kernel does not take it (the shell instance is not up)", async () => {
    await rendererKernel.requestUnload(SHELL_SURFACE);
    cleanups.push(async () => { await rendererKernel.load(SHELL_SURFACE); });
    expect(rendererKernel.state(SHELL_SURFACE)).toBe("absent");
    const shown = await mount(createElement(ShellFrame, { legacy: page("direct") }));
    expect(shown.host.innerHTML).toBe('<main class="shell">direct</main>');
  });
});
