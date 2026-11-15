// @vitest-environment node
// Slot names and their 2.x aliases (M7-02a; Web/src/plugin-kernel/slot-names.ts): one table, used by the main process's
// contribution list and the renderer's kernel. A slot and its alias are the same slot: one registration, two lookups.
import { describe, expect, it } from "vitest";
import { Kernel, ROOT_SLOTS, SLOT_ALIASES, canonicalSlot, legacySlotId, slotForms, slotName } from "../../../Web/src/plugin-kernel";
import { CORE_PLUGIN, CORE_SLOTS, ContributionKernel, slotNameOf, slotOf } from "../../src/core/plugins/kernel-list";
import { HOOKS, MENU_SLOTS, STATUS_SLOTS, VIEW_SLOTS, type Contribution } from "../../src/core/plugins/contributions";

const everyTwoX = [
  ...VIEW_SLOTS.map((where) => ({ group: "view", where })),
  ...MENU_SLOTS.map((where) => ({ group: "menu", where })),
  ...STATUS_SLOTS.map((where) => ({ group: "statusItem", where })),
];

describe("the alias table", () => {
  it("names every 2.x view place, menu and status place exactly once, and nothing else", () => {
    for (const { group, where } of everyTwoX) {
      const rows = SLOT_ALIASES.filter((alias) => alias.group === group && alias.legacy === where);
      expect(rows, `${group}/${where}`).toHaveLength(1);
    }
    expect(SLOT_ALIASES).toHaveLength(everyTwoX.length);
  });

  it("gives each slot one new name, no two slots the same name, and `commandPalette` is `app/palette`", () => {
    const names = SLOT_ALIASES.map((alias) => alias.name);
    expect(new Set(names).size).toBe(names.length);
    expect(SLOT_ALIASES.find((alias) => alias.group === "menu" && alias.legacy === "commandPalette")?.name).toBe("app/palette");
    // The card's table.
    const view = Object.fromEntries(SLOT_ALIASES.filter((alias) => alias.group === "view").map((alias) => [alias.legacy, alias.name]));
    expect(view).toEqual({ "settings.section": "settings/section", quickSettings: "settings/quick", "rightPanel.section": "panel/section", "rightPanel.takeover": "panel/takeover",
      rightPanel: "panel/main", bottomPanel: "app/bottom", chatHeader: "chat/header", composerBar: "composer/bar", mainTab: "main/tab", main: "app/main", window: "app/overlay" });
    // Menus keep their names (but `commandPalette`).
    for (const alias of SLOT_ALIASES.filter((one) => one.group === "menu" && one.legacy !== "commandPalette")) expect(alias.name).toBe(alias.legacy);
  });

  it("goes from the 2.x id to the new name and back for each slot, and every 2.x id is a slot the core owns", () => {
    for (const alias of SLOT_ALIASES) {
      const id = legacySlotId(alias);
      expect(CORE_SLOTS, id).toContain(id);
      expect(slotName(id)).toBe(alias.name);
      expect(canonicalSlot(alias.name)).toBe(id);
      expect(canonicalSlot(id)).toBe(id);
      expect(slotForms(alias.name)).toEqual(alias.name === id ? [id] : [id, alias.name]);
    }
  });

  it("leaves a name it does not know as it is: the kinds without a new name, and the new-only root slots", () => {
    for (const hook of HOOKS) { expect(canonicalSlot(`hook/${hook}`)).toBe(`hook/${hook}`); expect(slotName(`hook/${hook}`)).toBe(`hook/${hook}`); }
    expect(canonicalSlot("command")).toBe("command");
    expect(canonicalSlot("not/a-slot")).toBe("not/a-slot");
    expect(canonicalSlot("app/rail")).toBe("app/rail");
    expect(canonicalSlot("app/side")).toBe("app/side");
    // Inherited object keys are not names.
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(canonicalSlot(key)).toBe(key);
  });

  it("holds the five root slots, three of which are 2.x view places", () => {
    expect([...ROOT_SLOTS]).toEqual(["app/rail", "app/main", "app/side", "app/bottom", "app/overlay"]);
    expect(ROOT_SLOTS.map(canonicalSlot)).toEqual(["app/rail", "view/main", "app/side", "view/bottomPanel", "view/window"]);
  });
});

describe("a slot and its alias are one slot", () => {
  const kernelWith = () => {
    const kernel = new Kernel({ slotName: canonicalSlot });
    kernel.install({ name: ":owner", provides: { slots: ["chat/link", "app/main", "app/rail"] } });
    kernel.install({ name: "p", contributes: { slots: ["view/main", "menu/chat/link"] } });
    void kernel.load(":owner", (plugin) => { for (const slot of ["chat/link", "app/main", "app/rail"]) kernel.provideSlot(plugin, slot); });
    return kernel;
  };

  it("finds a contribution to the 2.x name under the new name, and the reverse", () => {
    const kernel = kernelWith();
    void kernel.load("p", (plugin) => {
      kernel.contribute(plugin, "menu/chat/link", "by-2x");
      kernel.contribute(plugin, "app/main", "by-new");
    });
    expect(kernel.entries("chat/link").map((one) => one.entry)).toEqual(["by-2x"]);
    expect(kernel.entries("menu/chat/link").map((one) => one.entry)).toEqual(["by-2x"]);
    expect(kernel.entries("app/main").map((one) => one.entry)).toEqual(["by-new"]);
    expect(kernel.entries("view/main").map((one) => one.entry)).toEqual(["by-new"]);
    // One registration each, held under the 2.x id.
    expect(kernel.allContributions().map((one) => one.slot)).toEqual(["menu/chat/link", "view/main"]);
    expect(kernel.slotOwner("chat/link")).toBe(":owner");
    expect(kernel.slotOwner("menu/chat/link")).toBe(":owner");
    expect(kernel.declaredOwner("view/main")).toBe(":owner");
  });

  it("refuses a second owner of the same slot under its other name; a slot declared by both names is one slot", () => {
    const kernel = kernelWith();
    expect(() => kernel.install({ name: ":other", provides: { slots: ["view/main"] } })).toThrow(/already provided by ":owner"/);
    expect(() => kernel.install({ name: ":other", provides: { slots: ["menu/chat/link"] } })).toThrow(/already provided/);
    // Declared by both names, it is still one slot.
    kernel.install({ name: ":dup", provides: { slots: ["app/overlay", "view/window"] } });
    void kernel.load(":dup", (plugin) => { kernel.provideSlot(plugin, "app/overlay"); });
    expect(kernel.slotOwner("view/window")).toBe(":dup");
  });

  it("takes a contribution back with its plugin, under either name", async () => {
    const kernel = kernelWith();
    void kernel.load("p", (plugin) => { kernel.contribute(plugin, "chat/link", "x"); });
    expect(kernel.entries("menu/chat/link")).toHaveLength(1);
    await kernel.requestUnload("p");
    expect(kernel.entries("chat/link")).toHaveLength(0);
    expect(kernel.entries("menu/chat/link")).toHaveLength(0);
  });

  it("refuses a contribution to a slot the plugin did not declare, whichever name names it", () => {
    const kernel = kernelWith();
    kernel.install({ name: "q", contributes: { slots: ["app/rail"] } });
    void kernel.load("q", (plugin) => { kernel.contribute(plugin, "view/main", "no"); kernel.contribute(plugin, "app/main", "no"); kernel.contribute(plugin, "app/rail", "yes"); });
    expect(kernel.entries("app/main")).toHaveLength(0);
    expect(kernel.entries("app/rail").map((one) => one.entry)).toEqual(["yes"]);
  });
});

describe("the main process's contribution list under both names", () => {
  const contributions: Contribution[] = [
    { kind: "view", where: "mainTab", id: "t.tab", title: "T", roles: "any" },
    { kind: "view", where: "chatHeader", id: "t.head", title: "H" },
    { kind: "view", where: "bottomPanel", id: "t.bottom", title: "B" },
    { kind: "menu", menu: "commandPalette", id: "t.cmd", title: "Cmd" },
    { kind: "menu", menu: "chat/link", id: "t.link", title: "Link" },
    { kind: "statusItem", where: "chatHeader", id: "t.status", title: "S" },
    { kind: "statusItem", where: "botRow", id: "t.row", title: "R" },
  ] as unknown as Contribution[];

  it("answers each contribution's new name and finds it there as well as under its 2.x id", () => {
    const list = new ContributionKernel();
    expect(list.reconcile([{ name: "t.plugin", contributions }])).toHaveLength(contributions.length);
    expect(contributions.map(slotNameOf)).toEqual(["main/tab", "chat/header", "app/bottom", "app/palette", "chat/link", "chat/status", "bot/row"]);
    for (const contribution of contributions) {
      const byId = list.kernel.entries(slotOf(contribution)).map((one) => one.entry);
      const byName = list.kernel.entries(slotNameOf(contribution)).map((one) => one.entry);
      expect(byName, slotNameOf(contribution)).toEqual(byId);
      expect(byName).toContain(contribution);
    }
    // The registrations stay under the 2.x ids (the step-1 goldens and event logs read them there).
    expect(list.kernel.allContributions().map((one) => one.slot)).toEqual(contributions.map(slotOf));
    expect(list.kernel.slotOwner("app/palette")).toBe(CORE_PLUGIN);
  });
});
