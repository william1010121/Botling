// M7-S66 review (serverwave 5e78e3d2): `Core.event` (moved to `CoreEvents`, core/server/events.ts) sends the envelope with the next
// event number, then plugins hear the event, then the change listeners, in that order; a `turn.started` reaches `reportStarts`.
// The event number lives in `CoreEvents.seq`: `Core.seq` reads it, `Core.nextSeq()` (M7-S69) and `event` move the same counter,
// and each Core has its own. The phone and machines views go through the same owner. No other test in the repo catches these.
// Made from the review probe .bot/artifacts/v3-split/probe-s66-event.test.ts; Core has no `seq` setter any more (M7-S70b).
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import { coreProcessOptions } from "../../src/core/core-process";
import { fakeCli, tempDir } from "../helpers";

const opened: Core[] = [];
afterEach(async () => { for (const core of opened.splice(0)) await core.shutdown().catch(() => {}); });

function open(trail: string[], out: any[]): Core {
  const dir = tempDir("core-event-order");
  const env = { BOTLING_AGENT: "fake", BOTLING_FAKE_CLI: fakeCli, BOTLING_COMPONENT_SCAN_MS: "0", BOTLING_WAITING_SCAN_MS: "0", BOTLING_ROUTINE_TICK_MS: "0", BOTLING_WATCH_MS: "0", BOTLING_QUIT_TIDY_MS: "0" };
  const base = coreProcessOptions({ env, dataDir: dir, outDir: join(dir, "unused-out"), emit: (m: any) => { trail.push("emit"); out.push(m); }, log: () => {}, node: null, sealer: null, app: null });
  const core = new Core({ ...base, plugins: null });
  opened.push(core);
  return core;
}

describe("Core.event", () => {
  it("emits with the next seq, then plugins hear it, then the change listeners, in that order", () => {
    const trail: string[] = []; const out: any[] = [];
    const core = open(trail, out) as any;
    const startSeq = core.seq;
    const original = core.pluginEvent.bind(core);
    core.pluginEvent = (e: unknown) => { trail.push("plugin"); return original(e); };
    const heard: unknown[] = [];
    core.onChange((change: unknown) => { trail.push("listener"); heard.push(change); });
    trail.length = 0; out.length = 0;
    core.event({ type: "turn.started", botId: "B1", turnId: "T1" });
    core.event({ type: "turn.started", botId: "B1", turnId: "T2" });
    expect(out.map((m) => m.seq)).toEqual([startSeq + 1, startSeq + 2]);
    expect(core.seq).toBe(startSeq + 2);
    expect(trail).toEqual(["emit", "plugin", "listener", "emit", "plugin", "listener"]);
    expect(heard).toEqual([{ botId: "B1" }, { botId: "B1" }]);
  });

  it("a turn.started tells reportStarts", () => {
    const core = open([], []) as any;
    core.coreAgents.reportStarts = new Set<string>(); // the field lives on CoreAgents (M7-S64); Core's reportStarts is a getter only
    core.event({ type: "turn.started", botId: "B1", turnId: "T9" });
    expect([...core.reportStarts]).toEqual(["T9"]);
  });

  it("the seq is CoreEvents' field: Core.seq reads it, nextSeq and event move the same counter, and a second Core has its own", () => {
    const out: any[] = [];
    const a = open([], out) as any, b = open([], []) as any;
    const other = b.seq;
    a.coreEvents.seq = 41;
    expect(a.seq).toBe(41);
    expect(a.nextSeq()).toBe(42);
    out.length = 0;
    a.event({ type: "turn.started", botId: "B1", turnId: "T1" });
    expect(out.map((m) => m.seq)).toEqual([43]);
    expect([a.seq, a.coreEvents.seq]).toEqual([43, 43]);
    expect(b.seq).toBe(other);
    expect(() => { a.seq = 7; }).toThrow(TypeError); // no setter on Core: only the owner and its transitions move it
    expect(a.seq).toBe(43);
  });

  it("mobileView/machinesView/attachMobile/attachRelay go through the owner", () => {
    const core = open([], []) as any;
    expect(core.mobileDesk).toBeNull(); expect(core.relay).toBeNull();
    expect(() => core.mobileOr()).toThrow("The phone connection is not set up.");
    const desk = { view: () => ({ enabled: true, routes: [], devices: [] }) };
    core.attachMobile(desk);
    expect(core.mobileDesk).toBe(desk);
    expect(core.mobileView()).toEqual({ enabled: true, routes: [], devices: [] });
    const relay = { devices: () => [{ id: "d", label: "L", pairedAt: 1, expiresAt: 2, botIds: ["x"] }], view: () => ({ state: "off" }) };
    core.attachRelay(relay);
    expect(core.relay).toBe(relay);
    const view = core.mobileView();
    expect(view.devices).toEqual([{ id: "d", label: "L", pairedAt: 1, expiresAt: 2, botIds: ["x"], via: "relay" }]);
    expect(view.relay).toEqual({ state: "off" });
    expect(core.machinesView()).toEqual({ enabled: false, relay: { url: null, state: "off" }, machines: [] });
    expect(() => core.machinesOr()).toThrow("Workers on other machines are not available here.");
  });
});
