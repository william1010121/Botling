import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ expose: vi.fn(), send: vi.fn(), on: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: mock.expose }, ipcRenderer: { send: mock.send, on: mock.on } }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());
it.each([{ argv: [] }, { argv: ["--unrelated=1"] }])("exposes no trace capability without the main-provided argument (%j)", async ({ argv }) => {
  vi.stubGlobal("process", { ...process, isMainFrame: true, argv });
  await import("../../src/preload/preload");
  expect(mock.expose.mock.calls.map(call => call[0])).toEqual(["botling"]);
});
it("exposes only the trace IPC sink for the opted-in main frame", async () => {
  vi.stubGlobal("process", { ...process, isMainFrame: true, argv: ["--botling-test-trace=1"] });
  await import("../../src/preload/preload");
  const capability = mock.expose.mock.calls.find(call => call[0] === "__botlingTestTrace")![1];
  capability.emit({ fixture: true });
  expect(mock.send).toHaveBeenCalledExactlyOnceWith("botling:test-trace", { fixture: true });
});
it("does not expose a trace capability in subframes even with the argument", async () => {
  vi.stubGlobal("process", { ...process, isMainFrame: false, argv: ["--botling-test-trace=1"] });
  await import("../../src/preload/preload");
  expect(mock.expose.mock.calls.map(call => call[0])).toEqual(["botling"]);
});
