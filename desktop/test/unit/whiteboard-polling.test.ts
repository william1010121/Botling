// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Whiteboard } from "../../src/renderer/Whiteboard";
import type { Client } from "../../src/renderer/client";
import type { WhiteboardView } from "../../src/contract";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let hidden = false;
let finish: (view: WhiteboardView) => void;
const request = vi.fn(() => new Promise<WhiteboardView>(resolve => { finish = resolve; }));
beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  request.mockClear();
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers(); vi.restoreAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});
const mount = () => act(async () => root.render(createElement(Whiteboard, {
  client: { request } as unknown as Client, bots: [], waiting: { items: [], doing: {} },
  components: {}, look: "original", now: 0, mainMessages: [], mainBotId: "main",
  statusOf: () => ({ key: "asleep", text: "Asleep" }), onOpenChat: () => {}, onError: () => {},
})));
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const visibility = (value: boolean) => act(async () => {
  hidden = value; document.dispatchEvent(new Event("visibilitychange"));
});
const resolve = (stamp: string) => act(async () => { finish({ bots: [], stamp }); });

it("does no hidden polling and refreshes immediately on return with the last stamp", async () => {
  await mount(); await resolve("first");
  await visibility(true); await advance(30_000);
  expect(request).toHaveBeenCalledTimes(1);
  await visibility(false);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith({ type: "whiteboard.view", since: "first" });
});
it("allows only one outstanding request, including hide/show while it is pending", async () => {
  await mount(); await advance(30_000);
  await visibility(true); await visibility(false);
  expect(request).toHaveBeenCalledTimes(1);
  await resolve("slow"); await advance(5_000);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith({ type: "whiteboard.view", since: "slow" });
});
it("defers an initially hidden board and disposes pending work on unmount", async () => {
  hidden = true; await mount(); await advance(30_000);
  expect(request).not.toHaveBeenCalled();
  await visibility(false);
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  root = createRoot(host);
  await resolve("late"); await advance(30_000);
  await visibility(true); await visibility(false);
  expect(request).toHaveBeenCalledTimes(1);
});

it("retries a failed request after the refresh delay", async () => {
  request.mockRejectedValueOnce(new Error("temporarily unavailable"));
  await mount();
  await advance(4_999); expect(request).toHaveBeenCalledTimes(1);
  await advance(1); expect(request).toHaveBeenCalledTimes(2);
  await resolve("recovered"); await advance(5_000);
  expect(request).toHaveBeenLastCalledWith({ type: "whiteboard.view", since: "recovered" });
});
