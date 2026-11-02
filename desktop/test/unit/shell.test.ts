// Running a command in the user's shell per platform, through injected platform/env/filesystem.
import { describe, expect, it } from "vitest";
import { commandShell, type ShellDeps } from "../../src/core/shell";

const machine = (platform: NodeJS.Platform, files: string[], env: Record<string, string> = {}, extra: Partial<ShellDeps> = {}): ShellDeps => ({
  platform, env,
  isExecutable: (path) => files.includes(path),
  readFile: (path) => { if (path === "/etc/shells") return "# comment\n/bin/sh\n/bin/zsh\nnologin\n/bin/bash\n"; throw new Error("ENOENT"); },
  userShell: () => undefined,
  ...extra,
});

describe("commandShell", () => {
  it("macOS: /bin/zsh -lc, as before", () => {
    expect(commandShell("echo hi", machine("darwin", ["/bin/zsh"], { SHELL: "/bin/bash" }))).toEqual(["/bin/zsh", ["-lc", "echo hi"]]);
    expect(commandShell("echo hi", machine("darwin", []))).toEqual(["/bin/sh", ["-lc", "echo hi"]]);
  });

  it("Linux: the user's login shell when it takes -lc, else /bin/sh", () => {
    expect(commandShell("x", machine("linux", ["/usr/bin/zsh"], { SHELL: "/usr/bin/zsh" }))).toEqual(["/usr/bin/zsh", ["-lc", "x"]]);
    expect(commandShell("x", machine("linux", ["/usr/bin/nu"], { SHELL: "/usr/bin/nu" }))).toEqual(["/bin/sh", ["-lc", "x"]]);
    expect(commandShell("x", machine("linux", [], { SHELL: "/gone/bash" }))).toEqual(["/bin/sh", ["-lc", "x"]]);
    expect(commandShell("x", machine("linux", [], {}))).toEqual(["/bin/sh", ["-lc", "x"]]);
  });

  it("Windows: COMSPEC /d /s /c with no login flags", () => {
    expect(commandShell("dir", machine("win32", [], { ComSpec: "C:\\Windows\\System32\\cmd.exe" }))).toEqual(["C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", "dir"]]);
    expect(commandShell("dir", machine("win32", []))).toEqual(["cmd.exe", ["/d", "/s", "/c", "dir"]]);
  });
});
