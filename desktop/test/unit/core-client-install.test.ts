import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

class Child extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); pid = 4242;
  postMessage = vi.fn();
}
const children: Child[] = [];
vi.mock("electron", () => ({
  utilityProcess: { fork: () => { const child = new Child(); children.push(child); return child; } },
  MessageChannelMain: class {},
}));
const { CoreClient } = await import("../../src/main/core-client");
afterEach(() => { children.length = 0; });

// Execute the real main install branch with inert installation dependencies. This keeps the
// confirmation comparison in the regression without starting Electron or touching any profile.
const main = readFileSync(new URL("../../src/main/main.ts", import.meta.url), "utf8");
const start = main.indexOf('    if (op === "installBuild")');
const end = main.indexOf('    if (op === "quit")', start);
if (start < 0 || end < start) throw Error("Main install handler not found");
function setup(mode: string, blocked = false) {
  const hotInstaller = {
    plan: vi.fn(async () => ({ plan: { mode, blocked, reasons: ["verification refused"] } })),
    verified: vi.fn(() => ({ zip: "/verified.zip", version: "2.0.1" })),
    install: vi.fn(async () => ({ ok: true })),
  };
  const installer = { stageLocal: vi.fn(async () => {}) };
  const restart = vi.fn(async () => {});
  const handler = new Function("op", "args", "hotInstaller", "withInstallRequest", "installer", "restartWithContinuation", "setImmediate", "app", main.slice(start, end));
  const received: Record<string, string>[] = [];
  const core = new CoreClient({ script: "/fake/core.cjs", env: {}, audit: () => {}, onEvent: () => {},
    app: async (op, args) => {
      received.push(args);
      return handler(op, args, hotInstaller, (fn: () => unknown) => fn(), installer, restart, () => {}, {});
    },
  });
  core.start();
  const child = children.at(-1)!;
  const send = async (modeValue: unknown) => {
    child.emit("message", { botling: "app", id: 7, op: "installBuild", args: {
      path: "/candidate.app", requester: "bot", note: "upgrade", from: "old", to: "new", mode: modeValue, untrusted: "drop",
    } });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalled());
    return child.postMessage.mock.calls.at(-1)![0];
  };
  return { send, received, hotInstaller, installer, restart };
}
it.each(["restart", "hot"])("delivers confirmed %s mode through CoreClient to the actual main handler", async mode => {
  const t = setup(mode);
  expect(await t.send(mode)).toEqual({ botling: "appDone", id: 7, ok: true });
  expect(t.received).toEqual([{ path: "/candidate.app", requester: "bot", note: "upgrade", from: "old", to: "new", mode }]);
  expect(t.installer.stageLocal).toHaveBeenCalledTimes(mode === "restart" ? 1 : 0);
  expect(t.restart).toHaveBeenCalledTimes(mode === "restart" ? 1 : 0);
  expect(t.hotInstaller.install).toHaveBeenCalledTimes(mode === "hot" ? 1 : 0);
});
it.each(["hot", undefined, 1, "invalid"])("rejects stale or invalid confirmation %s before staging", async mode => {
  const t = setup("restart");
  expect(await t.send(mode)).toMatchObject({ ok: false, error: "Install mode changed since confirmation. Ask again with the current build." });
  expect(t.installer.stageLocal).not.toHaveBeenCalled();
  expect(t.restart).not.toHaveBeenCalled();
  expect(t.hotInstaller.install).not.toHaveBeenCalled();
});
it("retains authenticated-plan refusal even with a matching mode", async () => {
  const t = setup("restart", true);
  expect(await t.send("restart")).toMatchObject({ ok: false, error: "verification refused" });
  expect(t.installer.stageLocal).not.toHaveBeenCalled();
  expect(t.restart).not.toHaveBeenCalled();
});
