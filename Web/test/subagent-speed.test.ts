import { afterEach, describe, expect, it, vi } from "vitest";
import { showMainSpeed, speedText, subagentSpeedElement } from "../src/subagent-speed";
import { fillSubagentBar } from "../src/subagent";
import type { ChatState, SubagentHeaderView } from "../src/types";
const header = (extra: Partial<SubagentHeaderView> = {}): SubagentHeaderView => ({
  id: "child", title: "Review", owner: "Main", status: "running", type: null,
  tokenSpeed: { tokPerSec: 25, estimated: false }, ...extra,
});
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });
describe("token speed display (the value is computed in the core)", () => {
  it("formats the core value for every engine, with no ticker and no wall-clock recomputation", () => {
    vi.useFakeTimers(); vi.setSystemTime(1_004_000);
    const bar = document.createElement("div"); document.body.append(bar);
    for (const engine of ["claude", "codex", "agy"]) {
      fillSubagentBar(bar, header({ engine }));
      expect(bar.querySelector(".subagent-speed")?.textContent).toBe("25.0 tok/s");
      vi.advanceTimersByTime(60_000);
      expect(bar.querySelector(".subagent-speed")?.textContent).toBe("25.0 tok/s");
      expect(vi.getTimerCount()).toBe(0);
    }
  });
  it("marks estimates, shows a dash without data, and <0.1 for tiny values", () => {
    expect(speedText({ tokPerSec: 25, estimated: true })).toBe("≈ 25.0 tok/s (est.)");
    expect(speedText(null)).toBe("— tok/s");
    expect(speedText({ tokPerSec: 0.01, estimated: false })).toBe("<0.1 tok/s");
  });
  it("explains the definition, and the estimate's limits", () => {
    const label = subagentSpeedElement(header());
    expect(label.title).toContain("generation time");
    expect(label.getAttribute("aria-label")).toContain(label.title);
    expect(subagentSpeedElement(header({ tokenSpeed: { tokPerSec: 9, estimated: true } })).title).toContain("no per-request timing");
  });
  it("puts the head's speed on the latest bot message's header line, not above the composer", () => {
    document.body.innerHTML = '<div id="composer-slot"></div><div id="list">'
      + '<div class="row bot"><div class="speaker-column"><div class="speaker">botling · Claude</div><div class="bubble">old</div></div></div>'
      + '<div class="row bot"><div class="speaker-column"><div class="speaker">botling · Claude</div><div class="bubble">new</div></div></div></div>';
    const list = document.getElementById("list")!;
    showMainSpeed({ tokenSpeed: { tokPerSec: 12.34, estimated: false } } as ChatState, list);
    showMainSpeed({ tokenSpeed: { tokPerSec: 12.34, estimated: false } } as ChatState, list);
    const lines = [...list.querySelectorAll(".speaker")].map((node) => node.textContent);
    expect(lines).toEqual(["botling · Claude", "botling · Claude · 12.3 tok/s"]);
    expect(document.getElementById("main-speed")).toBeNull();
    expect(document.querySelector("#composer-slot")?.previousElementSibling).toBeNull();
    showMainSpeed({ tokenSpeed: null } as ChatState, list);
    expect(list.querySelector(".speaker-speed")).toBeNull();
    expect(list.querySelectorAll(".speaker")[1].textContent).toBe("botling · Claude");
  });
  it("adds a header line holding only the speed when the message has none", () => {
    document.body.innerHTML = '<div id="list"><div class="row bot"><div class="bot-column"><div class="bubble">hi</div></div></div></div>';
    const list = document.getElementById("list")!;
    showMainSpeed({ tokenSpeed: { tokPerSec: 5, estimated: false } } as ChatState, list);
    expect(list.querySelector(".bot-column")?.firstElementChild?.textContent).toBe("5.0 tok/s");
    showMainSpeed({ tokenSpeed: null } as ChatState, list);
    expect(list.querySelector(".speaker")).toBeNull();
  });
});
