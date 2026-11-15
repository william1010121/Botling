// The rail layout store (M7-05a), without a page: what counts as a stored layout, the one-time migration from the old settings keys, and
// how a change in an old key is told from this store's own write coming back.
import { describe, expect, it, vi } from "vitest";
import { LAYOUT_STORAGE_KEY } from "../../src/renderer/sidebar-names";
import { layoutOfSettings, RailLayoutStore, readLayout, type LayoutStorage, type RailLayout } from "../../src/renderer/sidebar-layout";

const layout = (over: Partial<RailLayout> = {}): RailLayout => ({ railCollapsed: false, pinnedBots: [], idleBots: [], ...over });
const fakeStorage = (held?: unknown) => {
  const writes: unknown[] = [];
  return { writes, get: vi.fn(async () => held), set: vi.fn(async (_key: string, value: unknown) => { writes.push(value); }) };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("readLayout", () => {
  it("accepts exactly a layout and fails closed for anything else", () => {
    expect(readLayout(layout({ pinnedBots: ["a", "b"], railCollapsed: true }))).toEqual(layout({ pinnedBots: ["a", "b"], railCollapsed: true }));
    for (const bad of [null, undefined, "x", 3, [], {}, { railCollapsed: true }, layout({ railCollapsed: "yes" as never }), { ...layout(), pinnedBots: "a" }, { ...layout(), idleBots: [1] },
      { ...layout(), pinnedBots: new Array(201).fill("a").map((id, index) => `${id}${index}`) }, { ...layout(), idleBots: [""] }, { ...layout(), pinnedBots: ["x".repeat(101)] }]) {
      expect(readLayout(bad), JSON.stringify(bad)).toBeNull();
    }
  });
  it("does not read a key through the prototype", () => {
    const inherited = Object.create({ railCollapsed: false, pinnedBots: [], idleBots: [] });
    expect(readLayout(inherited)).toBeNull();
    expect(readLayout(JSON.parse('{"__proto__":{"railCollapsed":true},"railCollapsed":false,"pinnedBots":[],"idleBots":[]}'))).toEqual(layout());
  });
  it("drops duplicate ids", () => {
    expect(readLayout({ ...layout(), pinnedBots: ["a", "a", "b"] })?.pinnedBots).toEqual(["a", "b"]);
  });
});

describe("layoutOfSettings", () => {
  it("is the default for a missing or wrong key", () => {
    expect(layoutOfSettings(undefined)).toEqual(layout());
    expect(layoutOfSettings({ railCollapsed: "true", pinnedBots: "x", idleBots: [3] })).toEqual(layout());
    expect(layoutOfSettings({ railCollapsed: true, pinnedBots: ["a"], idleBots: ["b"] })).toEqual({ railCollapsed: true, pinnedBots: ["a"], idleBots: ["b"] });
  });
});

describe("RailLayoutStore", () => {
  it("waits for both the storage's answer and the page's settings before it settles", async () => {
    const storage = fakeStorage();
    const store = new RailLayoutStore();
    store.attach(storage);
    await tick();
    expect(store.current()).toBeNull();
    store.observe(layout({ pinnedBots: ["a"] }));
    expect(store.current()).toEqual(layout({ pinnedBots: ["a"] }));
    expect(storage.get).toHaveBeenCalledWith(LAYOUT_STORAGE_KEY);
  });
  it("copies the old keys into an empty storage once, and a stored layout wins", async () => {
    const empty = fakeStorage();
    const first = new RailLayoutStore();
    first.observe(layout({ idleBots: ["d"] }));
    first.attach(empty);
    await tick();
    expect(empty.writes).toEqual([layout({ idleBots: ["d"] })]);
    const kept = fakeStorage(layout({ pinnedBots: ["p"] }));
    const second = new RailLayoutStore();
    second.observe(layout({ idleBots: ["d"] }));
    second.attach(kept);
    await tick();
    expect(second.current()).toEqual(layout({ pinnedBots: ["p"] }));
    expect(kept.writes).toEqual([]);
  });
  it("stays on the old keys when the storage cannot be read, with one warning", async () => {
    const warn = vi.fn();
    const store = new RailLayoutStore(warn);
    store.observe(layout());
    store.attach({ get: async () => { throw new Error("no\nstorage"); }, set: async () => {} });
    await tick();
    store.observe(layout({ pinnedBots: ["a"] }));
    expect(store.current()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("no storage");
    expect(store.change({ pinnedBots: ["a"] }, () => { throw new Error("must not mirror"); })).toBe(false);
  });
  it("a late answer of a storage that was detached does not settle the next one", async () => {
    let release!: (value: unknown) => void;
    const slow: LayoutStorage = { get: () => new Promise((resolve) => { release = resolve; }), set: async () => {} };
    const store = new RailLayoutStore();
    store.observe(layout());
    store.attach(slow);
    store.detach(slow);
    const next = fakeStorage(layout({ pinnedBots: ["n"] }));
    store.attach(next);
    release(layout({ pinnedBots: ["old"] }));
    await tick();
    expect(store.current()).toEqual(layout({ pinnedBots: ["n"] }));
  });
  it("a change goes to the storage and to the old key, only for the keys that changed", async () => {
    const storage = fakeStorage();
    const store = new RailLayoutStore();
    store.observe(layout());
    store.attach(storage);
    await tick();
    const mirror = vi.fn();
    expect(store.change({ pinnedBots: ["a"], idleBots: [] }, mirror)).toBe(true);
    expect(mirror.mock.calls).toEqual([["pinnedBots", ["a"]]]);
    expect(storage.writes.at(-1)).toEqual(layout({ pinnedBots: ["a"] }));
  });
});
