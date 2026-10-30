// Shell detection per platform, through injected platform/env/filesystem.
import { describe, expect, it } from "vitest";
import { commandShell, installedShells, interactiveArgs, type ShellDeps } from "../../src/core/shell";

const machine = (platform: NodeJS.Platform, files: string[], env: Record<string, string> = {}, extra: Partial<ShellDeps> = {}): ShellDeps => ({
  platform, env,
  isExecutable: (path) => files.includes(path),
  readFile: (path) => { if (path === "/etc/shells") return "# comment\n/bin/sh\n/bin/zsh\nnologin\n/bin/bash\n"; throw new Error("ENOENT"); },
  userShell: () => undefined,
  ...extra,
});

describe("installedShells", () => {
  it("POSIX: the account shell first, then /etc/shells, only what is executable", () => {
    const deps = machine("darwin", ["/bin/zsh", "/bin/bash", "/bin/sh", "/usr/local/bin/fish"], { SHELL: "/bin/bash" }, { userShell: () => "/bin/zsh" });
    expect(installedShells(deps)).toEqual({ shells: ["/bin/zsh", "/bin/sh", "/bin/bash", "/usr/local/bin/fish"], defaultShell: "/bin/zsh" });
  });

  it("POSIX: $SHELL when the OS does not say, /bin/sh as the last resort", () => {
    expect(installedShells(machine("linux", ["/usr/bin/fish", "/bin/sh"], { SHELL: "/usr/bin/fish" })).defaultShell).toBe("/usr/bin/fish");
    expect(installedShells(machine("linux", ["/bin/sh"])).defaultShell).toBe("/bin/sh");
  });

  it("POSIX: a configured shell that is missing is not the default", () => {
    expect(installedShells(machine("linux", ["/bin/sh", "/bin/bash"], { SHELL: "/gone" })).defaultShell).toBe("/bin/sh");
  });

  it("does not offer a relative configured shell", () => {
    expect(installedShells(machine("linux", ["bin/bash", "/bin/sh"], { SHELL: "bin/bash" })).shells).toEqual(["/bin/sh"]);
  });

  it("throws when nothing is installed", () => {
    expect(() => installedShells(machine("linux", []))).toThrow("No installed interactive shell found.");
  });

  it("Windows: COMSPEC, then pwsh, Windows PowerShell and cmd, deduplicated ignoring case", () => {
    const cmd = "C:\\Windows\\System32\\cmd.exe";
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const env = { ComSpec: cmd, SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", Path: "C:\\Windows\\System32;relative\\bin" };
    const result = installedShells(machine("win32", [cmd, pwsh, ps], env));
    expect(result).toEqual({ shells: [cmd, pwsh, ps], defaultShell: cmd });
    // COMSPEC missing: the next one found leads.
    expect(installedShells(machine("win32", [pwsh, ps], { ...env, ComSpec: "" })).defaultShell).toBe(pwsh);
  });

  it("Windows: never reads /etc/shells or uses POSIX paths", () => {
    const deps = machine("win32", ["/bin/sh"], {}, { readFile: () => { throw new Error("must not read"); } });
    expect(() => installedShells(deps)).toThrow();
  });
});

describe("interactiveArgs", () => {
  it("login and interactive only on POSIX", () => {
    expect(interactiveArgs({ platform: "darwin" })).toEqual(["-l", "-i"]);
    expect(interactiveArgs({ platform: "linux" })).toEqual(["-l", "-i"]);
    expect(interactiveArgs({ platform: "win32" })).toEqual([]);
  });
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
