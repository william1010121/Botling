// Reviewer probes (M7-05a review): while the mirror lives, the old settings keys are what the core reads and writes. The column's
// layout must not drift away from them.
import { describe, expect, it, vi } from "vitest";
import { RailLayoutStore, type RailLayout } from "../../src/renderer/sidebar-layout";

const layout = (over: Partial<RailLayout> = {}): RailLayout => ({ railCollapsed: false, pinnedBots: [], idleBots: [], ...over });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const memory = () => {
  let held: unknown;
  return { get: vi.fn(async () => held), set: vi.fn(async (_key: string, value: unknown) => { held = value; }) };
};

describe("the rail layout and the old keys (reviewer probes)", () => {
  it("P1: a change the core made in an old key while no window was open is taken over at the next start", async () => {
    const storage = memory();
    const first = new RailLayoutStore();
    first.observe(layout());
    first.attach(storage);
    await tick();
    const mirror = vi.fn();
    first.change({ idleBots: ["X"] }, mirror);
    first.observe(layout({ idleBots: ["X"] })); // our write came back
    await tick();
    first.detach(storage); // the window closes; the core keeps running
    // A message to X arrives (core/server/send.ts): idleBots without X. Nobody observes it.
    const second = new RailLayoutStore();
    second.attach(storage);
    second.observe(layout({ idleBots: [] }));
    await tick();
    expect(second.current()?.idleBots).toEqual([]);
    // And the next change in the column does not put X back into the core's Idle.
    const later = vi.fn();
    second.change({ idleBots: [...(second.current()?.idleBots ?? []), "Z"] }, later);
    expect(later).toHaveBeenCalledWith("idleBots", ["Z"]);
  });

  it("P2: a foreign write that lands between our write and its echo does not leave the column and the old key apart", async () => {
    const store = new RailLayoutStore();
    store.observe(layout({ idleBots: ["Y"] }));
    store.attach(memory());
    await tick();
    store.change({ idleBots: ["Y", "X"] }, () => {});
    // The core's send.ts ran first ([]); then our write [Y, X] was applied: that is what the old key holds at the end.
    store.observe(layout({ idleBots: [] }));
    store.observe(layout({ idleBots: ["Y", "X"] }));
    expect(store.current()?.idleBots).toEqual(["Y", "X"]);
  });
});
