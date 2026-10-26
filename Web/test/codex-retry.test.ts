// While Codex waits to retry a request the API turned away, the typing bubble says so under its dots.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatState } from "../src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const NOW = Date.UTC(2026, 9, 26, 9, 0, 0);
const state = (extra: Partial<ChatState> = {}): ChatState => ({
  botID: "codex-retry", botName: "Codex", messages: [], working: true,
  avatar: "codex-avatar", placeholder: "Message Codex…", replyingTo: null, pendingFiles: [], components: {}, ...extra,
});
const note = () => document.querySelector(".typing .retry-note")?.textContent ?? null;

beforeAll(async () => {
  document.body.innerHTML = `<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>`;
  await import("../src/main");
});
afterEach(() => { vi.useRealTimers(); });

describe("Codex retry note in the typing bubble", () => {
  it("says the attempt and roughly when it goes again, counts down, and goes once the retry is over", () => {
    vi.useFakeTimers({ now: NOW });
    window.ccb.setState(state({ retrying: { attempt: 1, max: 5, reason: "rateLimited", retryAt: NOW + 40_000 } }));
    expect(note()).toBe("Codex is rate limited · retrying in about 40 s (attempt 1/5)");
    expect(document.querySelector(".typing .dots")).not.toBeNull();
    vi.advanceTimersByTime(30_000);
    expect(note()).toBe("Codex is rate limited · retrying in about 10 s (attempt 1/5)");
    vi.advanceTimersByTime(15_000);
    expect(note()).toBe("Codex is rate limited · retrying (attempt 1/5)");

    window.ccb.setState(state({ retrying: { attempt: 2, max: 5, reason: "rateLimited", retryAt: Date.now() + 505_000 } }));
    expect(note()).toBe("Codex is rate limited · retrying in about 8 min (attempt 2/5)");
    window.ccb.setState(state({ retrying: { attempt: 3, max: 5, reason: "connection", retryAt: null } }));
    expect(note()).toBe("Codex lost its connection · retrying (attempt 3/5)");

    window.ccb.setState(state({ retrying: null }));
    expect(note()).toBeNull();
    expect(document.querySelector(".typing .dots")).not.toBeNull();
  });

  it("in Traditional Chinese", () => {
    vi.useFakeTimers({ now: NOW });
    window.ccb.setState(state({ lang: "zh-Hant", retrying: { attempt: 1, max: 5, reason: "rateLimited", retryAt: NOW + 40_000 } }));
    expect(note()).toBe("Codex 被限流，約 40 秒後重試（第 1/5 次）");
    window.ccb.setState(state({ lang: "zh-Hant", retrying: { attempt: 1, max: 5, reason: "rateLimited", retryAt: NOW + 332_000 } }));
    expect(note()).toBe("Codex 被限流，約 6 分鐘後重試（第 1/5 次）");
    window.ccb.setState(state({ lang: "zh-Hant", retrying: { attempt: 2, max: 5, reason: "rateLimited", retryAt: null } }));
    expect(note()).toBe("Codex 被限流，正在重試（第 2/5 次）");
    window.ccb.setState(state({ lang: "zh-Hant", working: false, retrying: null }));
    expect(note()).toBeNull();
  });
});
