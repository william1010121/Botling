import { afterEach, expect, it } from "vitest";
import { agyRuntimeStatus } from "../../src/core/agy-runtime-settings";
import { verifyAcpRuntime } from "../../src/core/agent/agy-acp";
import { shell } from "../../src/core/agent/codex-types";

const real = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { value });
afterEach(() => Object.defineProperty(process, "platform", real));

it("on Linux the Antigravity runtime is reported unavailable with a macOS-only message", () => {
  setPlatform("linux");
  const status = agyRuntimeStatus({} as never, "/tmp");
  expect(status.valid).toBe(false);
  expect(status.message).toContain("macOS arm64");
});

it("on Linux launching the Antigravity ACP runtime refuses instead of calling codesign", () => {
  setPlatform("linux");
  // The platform is read once when agy-acp loads (realAcpDeps), so the stub above only reaches code that asks again; the check takes it as a dependency.
  expect(() => verifyAcpRuntime("/opt/agy/agy_acp_server.par", { platform: "linux", arch: "x64" } as never)).toThrow("macOS arm64");
});

// codex-session-characterization folds /bin/zsh to /bin/sh on macOS only, so this is what pins the shell of each platform.
it("shell() asks cmd.exe on Windows, /bin/zsh on macOS and /bin/sh elsewhere", () => {
  setPlatform("win32");
  expect(shell("make test")).toEqual(["cmd.exe", "/d", "/s", "/c", "make test"]);
  setPlatform("darwin");
  expect(shell("make test")).toEqual(["/bin/zsh", "-c", "make test"]);
  setPlatform("linux");
  expect(shell("make test")).toEqual(["/bin/sh", "-c", "make test"]);
});
