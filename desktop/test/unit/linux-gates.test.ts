import { afterEach, expect, it } from "vitest";
import { agyRuntimeStatus } from "../../src/core/agy-runtime-settings";
import { verifyAcpRuntime } from "../../src/core/agent/agy-acp";

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
  expect(() => verifyAcpRuntime("/opt/agy/agy_acp_server.par")).toThrow("macOS arm64");
});
