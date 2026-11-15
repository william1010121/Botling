// The rail layout store (M7-05a), without a page: what counts as a stored layout, the one-time migration from the old settings keys, and
// how a change in an old key is told from this store's own write coming back.
import { describe, expect, it, vi } from "vitest";
import { LAYOUT_STORAGE_KEY } from "../../src/renderer/sidebar-names";
import { layoutOfSettings, RailLayoutStore, readLayout, readSeen, type LayoutStorage, type RailLayout } from "../../src/renderer/sidebar-layout";

const layout = (over: Partial<RailLayout> = {}): RailLayout => ({ railCollapsed: false, pinnedBots: [], idleBots: [], ...over });
const fakeStorage = (held?: unknown) => {
  const writes: unknown[] = [];
  return { writes, get: vi.fn(async () => held), set: vi.fn(async (_key: string, value: unknown) => { writes.push(value); }) };
};
/** What the store writes: the layout with the old keys as it last took them in (`seen`). */
const record = (layoutValue: RailLayout, seen: RailLayout = layoutValue) => ({ ...layoutValue, seen });
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
  it("ignores the `seen` record beside a layout, and reads it on its own", () => {
    const withSeen = record(layout({ pinnedBots: ["a"] }), layout({ idleBots: ["x"] }));
    expect(readLayout(withSeen)).toEqual(layout({ pinnedBots: ["a"] }));
    expect(readSeen(withSeen)).toEqual(layout({ idleBots: ["x"] }));
    for (const none of [layout(), null, "x", [], { ...layout(), seen: "no" }, { ...layout(), seen: { railCollapsed: true } }, Object.create({ seen: layout() })]) expect(readSeen(none), JSON.stringify(none)).toBeNull();
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
    expect(empty.writes).toEqual([record(layout({ idleBots: ["d"] }))]);
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
    expect(readLayout(storage.writes.at(-1))).toEqual(layout({ pinnedBots: ["a"] }));
  });

  it("drops every write that came back up to the echo it recognises, and no older one stays waiting (A, B, C written, only C comes back)", async () => {
    const store = new RailLayoutStore();
    store.observe(layout());
    store.attach(fakeStorage());
    await tick();
    for (const id of ["A", "B", "C"]) store.change({ idleBots: [id] }, () => {});
    store.observe(layout({ idleBots: ["C"] })); // A and B's echoes were never seen (the page only saw the last value)
    store.observe(layout({ idleBots: ["A"] })); // a later write of A by someone else is a change, not our old echo
    expect(store.current()?.idleBots).toEqual(["A"]);
  });
  it("keeps the echoes that have not come back yet waiting (A, B written, A's echo comes back: B's is still ours)", async () => {
    const store = new RailLayoutStore();
    store.observe(layout());
    store.attach(fakeStorage());
    await tick();
    store.change({ idleBots: ["A"] }, () => {});
    store.change({ idleBots: ["B"] }, () => {});
    store.observe(layout({ idleBots: ["A"] }));
    expect(store.current()?.idleBots).toEqual(["B"]);
    store.observe(layout({ idleBots: ["B"] }));
    expect(store.current()?.idleBots).toEqual(["B"]);
  });
  it("an old handle's detach after a new attach leaves the new one attached", async () => {
    const warn = vi.fn();
    const store = new RailLayoutStore(warn);
    const first = fakeStorage(layout({ pinnedBots: ["old"] }));
    const second = fakeStorage(layout({ pinnedBots: ["new"] }));
    store.observe(layout());
    store.attach(first);
    store.attach(second);
    await tick();
    store.detach(first); // the first plugin instance's undo runs late
    expect(store.current()).toEqual(layout({ pinnedBots: ["new"] }));
    expect(store.change({ idleBots: ["x"] }, () => {})).toBe(true);
    expect(second.writes.length).toBeGreaterThan(0);
    store.detach(second);
    expect(store.current()).toBeNull();
  });
  it("an old handle's read error after a new attach does not mark the new one failed, and warns of nothing", async () => {
    const warn = vi.fn();
    const store = new RailLayoutStore(warn);
    let fail!: (error: Error) => void;
    const first: LayoutStorage = { get: () => new Promise((_resolve, reject) => { fail = reject; }), set: async () => {} };
    const second = fakeStorage(layout({ pinnedBots: ["new"] }));
    store.observe(layout());
    store.attach(first);
    store.attach(second);
    fail(new Error("late"));
    await tick();
    expect(warn).not.toHaveBeenCalled();
    expect(store.current()).toEqual(layout({ pinnedBots: ["new"] }));
    // The warning is still available to the handle that is attached.
    const third = new RailLayoutStore(warn);
    third.observe(layout());
    third.attach({ get: async () => { throw new Error("real"); }, set: async () => {} });
    await tick();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("the old keys changed while no store was watching (M7-05a review F1)", () => {
  /** A first run that stored `idleBots: [X]` and saw it come back, then ended. */
  const firstRun = async (storage: ReturnType<typeof fakeStorage>) => {
    const first = new RailLayoutStore();
    first.observe(layout());
    first.attach(storage);
    await tick();
    first.change({ idleBots: ["X"] }, () => {});
    first.observe(layout({ idleBots: ["X"] }));
    first.detach();
  };
  /** The storage as the first run left it (a fake keeps no state: it answers with the last write). */
  const left = (storage: ReturnType<typeof fakeStorage>) => fakeStorage(storage.writes.at(-1));

  it("a later start takes over what the old keys changed meanwhile, and stores it", async () => {
    const run = fakeStorage();
    await firstRun(run);
    expect(readSeen(run.writes.at(-1))).toEqual(layout({ idleBots: ["X"] })); // the echo moved `seen`, and it was stored
    const next = left(run);
    const second = new RailLayoutStore();
    second.observe(layout({ idleBots: [] })); // send.ts took X out of Idle while the window was closed
    second.attach(next);
    await tick();
    expect(second.current()).toEqual(layout());
    expect(next.writes.at(-1)).toEqual(record(layout(), layout()));
    const later = vi.fn();
    second.change({ idleBots: ["Z"] }, later);
    expect(later).toHaveBeenCalledWith("idleBots", ["Z"]);
  });
  it("only the keys the old keys changed are taken over; the others keep the stored layout", async () => {
    const stored = record(layout({ railCollapsed: true, pinnedBots: ["p"], idleBots: ["X"] }), layout({ railCollapsed: true, pinnedBots: ["p"], idleBots: ["X"] }));
    const next = fakeStorage(stored);
    const store = new RailLayoutStore();
    store.observe(layout({ railCollapsed: true, pinnedBots: ["q"], idleBots: ["X"] })); // only pinnedBots changed
    store.attach(next);
    await tick();
    expect(store.current()).toEqual(layout({ railCollapsed: true, pinnedBots: ["q"], idleBots: ["X"] }));
    // A key that differs from the stored layout but not from `seen` is the stored layout's own change (a write whose mirror was lost): it stays.
    const kept = new RailLayoutStore();
    kept.observe(layout({ idleBots: [] }));
    kept.attach(fakeStorage(record(layout({ idleBots: ["Y"] }), layout())));
    await tick();
    expect(kept.current()).toEqual(layout({ idleBots: ["Y"] }));
  });
  it("a layout stored without the record (an older run) is trusted as it is, and nothing is written at the start", async () => {
    const next = fakeStorage(layout({ pinnedBots: ["p"] }));
    const store = new RailLayoutStore();
    store.observe(layout({ pinnedBots: ["q"] }));
    store.attach(next);
    await tick();
    expect(store.current()).toEqual(layout({ pinnedBots: ["p"] }));
    expect(next.writes).toEqual([]);
    // From the first change on the record is kept.
    store.change({ idleBots: ["i"] }, () => {});
    expect(next.writes.at(-1)).toEqual(record(layout({ pinnedBots: ["p"], idleBots: ["i"] }), layout({ pinnedBots: ["q"] })));
  });
  it("a record that is not a layout is no record", async () => {
    const next = fakeStorage({ ...layout({ pinnedBots: ["p"] }), seen: { railCollapsed: true } });
    const store = new RailLayoutStore();
    store.observe(layout({ pinnedBots: ["q"] }));
    store.attach(next);
    await tick();
    expect(store.current()).toEqual(layout({ pinnedBots: ["p"] }));
  });
});

describe("a foreign write that lands between our write and its echo (M7-05a review F2)", () => {
  it("the old key has the last word once all our writes are back", async () => {
    const store = new RailLayoutStore();
    store.observe(layout({ idleBots: ["Y"] }));
    store.attach(fakeStorage());
    await tick();
    store.change({ idleBots: ["Y", "X"] }, () => {});
    store.observe(layout({ idleBots: [] }));
    expect(store.current()?.idleBots).toEqual([]);
    store.observe(layout({ idleBots: ["Y", "X"] }));
    expect(store.current()?.idleBots).toEqual(["Y", "X"]);
  });
  it("with another write of ours still waiting, an echo does not overrule the column", async () => {
    const store = new RailLayoutStore();
    store.observe(layout());
    store.attach(fakeStorage());
    await tick();
    store.change({ idleBots: ["A"] }, () => {});
    store.change({ idleBots: ["A", "B"] }, () => {});
    store.observe(layout({ idleBots: ["A"] }));
    expect(store.current()?.idleBots).toEqual(["A", "B"]);
  });
});
