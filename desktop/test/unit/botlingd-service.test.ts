// Botling 3 M6-08 / M6-07c: `botlingd service install | uninstall | status` (LaunchAgent on macOS, systemd user unit on Linux).
// Never runs real launchctl or systemctl and never writes outside temporary directories.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { CORE_EXIT_DATA_DIR_IN_USE } from "../../src/core/store/data-dir-lock";
import {
  DEFAULT_SERVICE_LABEL,
  ServiceError,
  botlingdProgram,
  buildServiceSpec,
  install,
  launchAgentPath,
  launchAgentPlist,
  serviceCommand,
  serviceEnv,
  serviceLabel,
  status,
  systemdUnit,
  systemdUnitPath,
  uninstall,
  type ServiceRunner,
  type ServiceSpec,
} from "../../src/server/service";
import { BotlingdProcess, botlingdCommand, testRoot } from "../botlingd-harness";

const roots: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const fixedSpec: ServiceSpec = {
  program: "/opt/node/bin/node",
  args: ["/opt/botling/out/server/main.cjs", "start"],
  env: { BOTLING_SERVER_DATA_DIR: "/var/lib/botling", BOTLING_SERVICE: "1" },
  dataDir: "/var/lib/botling",
  label: "dev.botling.v3.botlingd",
};

describe("M6-08 botlingd service builders", () => {
  it("builds the macOS LaunchAgent plist for a fixed spec and XML-escapes special characters", () => {
    expect(launchAgentPath("/tmp/fake-home", DEFAULT_SERVICE_LABEL)).toBe(
      "/tmp/fake-home/Library/LaunchAgents/dev.botling.v3.botlingd.plist",
    );
    expect(serviceLabel("dev.botling.v3")).toBe("dev.botling.v3.botlingd");
    expect(launchAgentPlist(fixedSpec)).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "  <key>Label</key>",
        "  <string>dev.botling.v3.botlingd</string>",
        "  <key>ProgramArguments</key>",
        "  <array>",
        "      <string>/opt/node/bin/node</string>",
        "      <string>/opt/botling/out/server/main.cjs</string>",
        "      <string>start</string>",
        "  </array>",
        "  <key>EnvironmentVariables</key>",
        "  <dict>",
        "      <key>BOTLING_SERVER_DATA_DIR</key>",
        "      <string>/var/lib/botling</string>",
        "      <key>BOTLING_SERVICE</key>",
        "      <string>1</string>",
        "  </dict>",
        "  <key>RunAtLoad</key>",
        "  <true/>",
        "  <key>KeepAlive</key>",
        "  <dict>",
        "    <key>SuccessfulExit</key>",
        "    <false/>",
        "  </dict>",
        "  <key>StandardOutPath</key>",
        "  <string>/var/lib/botling/botlingd.service.log</string>",
        "  <key>StandardErrorPath</key>",
        "  <string>/var/lib/botling/botlingd.service.log</string>",
        "  <key>ProcessType</key>",
        "  <string>Background</string>",
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
    );

    const escaped = launchAgentPlist({
      program: "/opt/bin/node&1",
      args: ["/tmp/a<b/main.cjs", "start"],
      env: { BOTLING_SERVER_DATA_DIR: "/tmp/dir&name<1>", BOTLING_SERVICE: "1" },
      dataDir: "/tmp/dir&name<1>",
      label: "dev.botling.v3<test>&1",
    });
    expect(escaped).toContain("<string>dev.botling.v3&lt;test&gt;&amp;1</string>");
    expect(escaped).toContain("<string>/opt/bin/node&amp;1</string>");
    expect(escaped).toContain("<string>/tmp/a&lt;b/main.cjs</string>");
    expect(escaped).toContain("<string>/tmp/dir&amp;name&lt;1&gt;</string>");
    expect(escaped).toContain("<string>/tmp/dir&amp;name&lt;1&gt;/botlingd.service.log</string>");
  });

  it("builds the Linux systemd user unit for a fixed spec and quotes arguments with spaces", () => {
    expect(systemdUnitPath("/tmp/fake-home")).toBe("/tmp/fake-home/.config/systemd/user/botlingd.service");
    expect(systemdUnit(fixedSpec)).toBe(
      [
        "[Unit]",
        "Description=Botling server",
        "",
        "[Service]",
        "ExecStart=/opt/node/bin/node /opt/botling/out/server/main.cjs start",
        'Environment="BOTLING_SERVER_DATA_DIR=/var/lib/botling"',
        'Environment="BOTLING_SERVICE=1"',
        "Restart=on-failure",
        "RestartSec=5",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    );

    const spaced = systemdUnit({
      ...fixedSpec,
      program: "/opt/my node/bin/node",
      args: ["/opt/botling app/out/server/main.cjs", "start"],
      env: { BOTLING_SERVER_DATA_DIR: "/var/lib/botling data", BOTLING_SERVICE: "1" },
    });
    expect(spaced).toContain('ExecStart="/opt/my node/bin/node" "/opt/botling app/out/server/main.cjs" start');
    expect(spaced).toContain('Environment="BOTLING_SERVER_DATA_DIR=/var/lib/botling data"');
  });

  it("carries only data-folder, socket, optional ELECTRON_RUN_AS_NODE=1, and BOTLING_SERVICE=1 in env", () => {
    expect(serviceEnv({
      HOME: "/tmp/ignored-home",
      PATH: "/usr/bin",
      BOTLING_IMPORT_FROM: "/tmp/2x-folder",
      BOTLING_1X_DIR: "/tmp/1x-folder",
      SECRET_TOKEN: "should-not-leak",
      BOTLING_SERVER_DATA_DIR: "/tmp/v3-data",
    })).toEqual({ BOTLING_SERVER_DATA_DIR: "/tmp/v3-data", BOTLING_SERVICE: "1" });

    expect(serviceEnv({
      BOTLING_DATA_DIR: "/tmp/v3-alt",
      BOTLING_SERVER_SOCKET: "/tmp/b.sock",
      ELECTRON_RUN_AS_NODE: "1",
      EXTRA_VAR: "ignored",
    })).toEqual({
      BOTLING_DATA_DIR: "/tmp/v3-alt",
      BOTLING_SERVER_SOCKET: "/tmp/b.sock",
      ELECTRON_RUN_AS_NODE: "1",
      BOTLING_SERVICE: "1",
    });

    const scriptDir = tempDir("prog");
    const realScript = join(scriptDir, "main.cjs");
    const linkedScript = join(scriptDir, "main-link.cjs");
    writeFileSync(realScript, "");
    symlinkSync(realScript, linkedScript);
    const prog = botlingdProgram(linkedScript);
    expect(prog).toEqual({ program: process.execPath, args: [realpathSync(realScript), "start"] });

    const spec = buildServiceSpec({ BOTLING_SERVER_DATA_DIR: "/tmp/v3-data", PATH: "/bin" }, { program: prog });
    expect(spec.dataDir).toBe("/tmp/v3-data");
    expect(spec.label).toBe(DEFAULT_SERVICE_LABEL);
    expect(spec.env).toEqual({ BOTLING_SERVER_DATA_DIR: "/tmp/v3-data", BOTLING_SERVICE: "1" });
  });
});

describe("M6-07c packaged botlingd service", () => {
  const req = createRequire(import.meta.url);
  const v3Config = req(resolve(__dirname, "../../electron-builder.v3.config.cjs")) as { appId: string };

  it("uses --botlingd start and omits ELECTRON_RUN_AS_NODE in packaged form", () => {
    const execPath = "/Applications/Botling 3.app/Contents/MacOS/Botling 3";
    expect(botlingdProgram({ packaged: true, execPath })).toEqual({
      program: execPath,
      args: ["--botlingd", "start"],
    });

    expect(serviceEnv({
      BOTLING_SERVER_DATA_DIR: "/tmp/v3-data",
      BOTLING_SERVER_SOCKET: "/tmp/v3.sock",
      ELECTRON_RUN_AS_NODE: "1",
    }, { packaged: true })).toEqual({
      BOTLING_SERVER_DATA_DIR: "/tmp/v3-data",
      BOTLING_SERVER_SOCKET: "/tmp/v3.sock",
      BOTLING_SERVICE: "1",
    });

    const spec = buildServiceSpec(
      { BOTLING_SERVER_DATA_DIR: "/tmp/v3-data", ELECTRON_RUN_AS_NODE: "1" },
      { packaged: true, appId: v3Config.appId, execPath },
    );
    expect(spec).toEqual({
      program: execPath,
      args: ["--botlingd", "start"],
      env: { BOTLING_SERVER_DATA_DIR: "/tmp/v3-data", BOTLING_SERVICE: "1" },
      dataDir: "/tmp/v3-data",
      label: `${v3Config.appId}.botlingd`,
    });
    expect(spec.label).not.toBe(DEFAULT_SERVICE_LABEL);

    expect(() => buildServiceSpec({ BOTLING_SERVER_DATA_DIR: "/tmp/v3-data" }, { packaged: true })).toThrow(ServiceError);
  });

  it("passes packaged appId through serviceCommand install, status, and uninstall", async () => {
    const macHome = tempDir("pkg-mac-home");
    const execPath = "/Applications/Botling 3.app/Contents/MacOS/Botling 3";
    const expectedLabel = `${v3Config.appId}.botlingd`;
    const expectedPlist = launchAgentPath(macHome, expectedLabel);
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const lines: string[] = [];
    const run: ServiceRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === "print") return { code: 0, out: "\tstate = running\n" };
      return { code: 0, out: "" };
    };

    await serviceCommand(
      ["install"],
      { BOTLING_SERVER_DATA_DIR: "/tmp/v3-data", ELECTRON_RUN_AS_NODE: "1" },
      (line) => lines.push(line),
      { run, options: { platform: "darwin", home: macHome, uid: 501 }, packaged: true, appId: v3Config.appId, execPath },
    );
    expect(lines.pop()).toBe(`installed: botlingd starts at login (${expectedPlist})`);
    expect(existsSync(expectedPlist)).toBe(true);
    const plist = readFileSync(expectedPlist, "utf8");
    expect(plist).toContain(`<string>${expectedLabel}</string>`);
    expect(plist).toContain(`<string>${execPath}</string>`);
    expect(plist).toContain("<string>--botlingd</string>");
    expect(plist).toContain("<string>start</string>");
    expect(plist).not.toContain("ELECTRON_RUN_AS_NODE");
    expect(calls).toEqual([
      { cmd: "launchctl", args: ["bootout", `gui/501/${expectedLabel}`] },
      { cmd: "launchctl", args: ["bootstrap", "gui/501", expectedPlist] },
    ]);

    calls.length = 0;
    await serviceCommand(
      ["status"],
      {},
      (line) => lines.push(line),
      { run, options: { platform: "darwin", home: macHome, uid: 501 }, packaged: true, appId: v3Config.appId },
    );
    expect(lines.pop()).toBe("running");
    expect(calls).toEqual([{ cmd: "launchctl", args: ["print", `gui/501/${expectedLabel}`] }]);

    calls.length = 0;
    await serviceCommand(
      ["uninstall"],
      {},
      (line) => lines.push(line),
      { run, options: { platform: "darwin", home: macHome, uid: 501 }, packaged: true, appId: v3Config.appId },
    );
    expect(lines.pop()).toBe("removed: botlingd no longer starts at login");
    expect(existsSync(expectedPlist)).toBe(false);
    expect(calls).toEqual([{ cmd: "launchctl", args: ["bootout", `gui/501/${expectedLabel}`] }]);
  });
});

describe("M6-08 service install / uninstall / status with injected runner", () => {
  it("installs and uninstalls macOS LaunchAgent into a temp HOME", async () => {
    const home = tempDir("mac-home");
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const run: ServiceRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      return args[0] === "bootout" ? { code: 113, out: "Could not find service" } : { code: 0, out: "" };
    };

    const written = await install(fixedSpec, run, { platform: "darwin", home, uid: 501 });
    const expectedPath = join(home, "Library", "LaunchAgents", `${fixedSpec.label}.plist`);
    expect(written).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(statSync(expectedPath).mode & 0o777).toBe(0o644);
    expect(readFileSync(expectedPath, "utf8")).toBe(launchAgentPlist(fixedSpec));
    expect(calls).toEqual([
      { cmd: "launchctl", args: ["bootout", `gui/501/${fixedSpec.label}`] },
      { cmd: "launchctl", args: ["bootstrap", "gui/501", expectedPath] },
    ]);

    calls.length = 0;
    await uninstall(run, { platform: "darwin", home, uid: 501, label: fixedSpec.label });
    expect(existsSync(expectedPath)).toBe(false);
    expect(calls).toEqual([{ cmd: "launchctl", args: ["bootout", `gui/501/${fixedSpec.label}`] }]);
  });

  it("installs and uninstalls Linux systemd user unit into a temp HOME", async () => {
    const home = tempDir("linux-home");
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const run: ServiceRunner = async (cmd, args) => { calls.push({ cmd, args }); return { code: 0, out: "" }; };

    const written = await install(fixedSpec, run, { platform: "linux", home });
    const expectedPath = join(home, ".config", "systemd", "user", "botlingd.service");
    expect(written).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(statSync(expectedPath).mode & 0o777).toBe(0o644);
    expect(readFileSync(expectedPath, "utf8")).toBe(systemdUnit(fixedSpec));
    expect(calls).toEqual([
      { cmd: "systemctl", args: ["--user", "daemon-reload"] },
      { cmd: "systemctl", args: ["--user", "enable", "--now", "botlingd.service"] },
    ]);

    calls.length = 0;
    await uninstall(run, { platform: "linux", home });
    expect(existsSync(expectedPath)).toBe(false);
    expect(calls).toEqual([
      { cmd: "systemctl", args: ["--user", "disable", "--now", "botlingd.service"] },
      { cmd: "systemctl", args: ["--user", "daemon-reload"] },
    ]);
  });

  it("maps launchctl and systemctl status outputs to the three status texts and CLI outputs", async () => {
    const macHome = tempDir("mac-status");
    const plist = launchAgentPath(macHome, DEFAULT_SERVICE_LABEL);
    const lines: string[] = [];
    const out = (line: string) => { lines.push(line); };

    expect(await status(async () => ({ code: 113, out: "Could not find service" }), { platform: "darwin", home: macHome, uid: 501 })).toBe("not installed");

    await serviceCommand(
      ["install"],
      { BOTLING_SERVER_DATA_DIR: "/tmp/v3-data" },
      out,
      { run: async () => ({ code: 0, out: "" }), options: { platform: "darwin", home: macHome, uid: 501 }, program: { program: fixedSpec.program, args: fixedSpec.args } },
    );
    expect(lines.pop()).toBe(`installed: botlingd starts at login (${plist})`);

    expect(await status(async () => ({ code: 0, out: "\tstate = waiting\n\tlast exit code = 0\n" }), { platform: "darwin", home: macHome, uid: 501 })).toBe("installed, not running");
    expect(await status(async () => ({ code: 113, out: "Could not find service" }), { platform: "darwin", home: macHome, uid: 501 })).toBe("installed, not running");
    await serviceCommand(["status"], {}, out, { run: async () => ({ code: 0, out: "\tstate = running\n\tpid = 4242\n" }), options: { platform: "darwin", home: macHome, uid: 501 } });
    expect(lines.pop()).toBe("running");

    await serviceCommand(["uninstall"], {}, out, { run: async () => ({ code: 0, out: "" }), options: { platform: "darwin", home: macHome, uid: 501 } });
    expect(lines.pop()).toBe("removed: botlingd no longer starts at login");

    const linuxHome = tempDir("linux-status");
    const unit = systemdUnitPath(linuxHome);
    expect(await status(async () => ({ code: 3, out: "inactive\n" }), { platform: "linux", home: linuxHome })).toBe("not installed");
    mkdirSync(join(linuxHome, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(unit, "unit");
    expect(await status(async () => ({ code: 3, out: "inactive\n" }), { platform: "linux", home: linuxHome })).toBe("installed, not running");
    expect(await status(async () => ({ code: 0, out: "active\n" }), { platform: "linux", home: linuxHome })).toBe("running");
  });

  it("refuses unsupported platforms with exit code 2", async () => {
    const home = tempDir("win-home");
    const noop: ServiceRunner = async () => ({ code: 0, out: "" });
    for (const fn of [() => install(fixedSpec, noop, { platform: "win32", home }), () => uninstall(noop, { platform: "win32", home }), () => status(noop, { platform: "win32", home })]) {
      await expect(fn()).rejects.toMatchObject({ name: ServiceError.name, exitCode: 2, message: "botlingd service is for macOS and Linux." });
    }
  });
});

describe("M6-08 botlingd start with BOTLING_SERVICE=1 when folder is in use", () => {
  const daemonRoot = testRoot("botlingd-service-lock");
  const running: BotlingdProcess[] = [];

  afterAll(async () => {
    for (const daemon of running) await daemon.stop("SIGKILL");
    rmSync(daemonRoot, { recursive: true, force: true });
  });

  it("exits 0 with BOTLING_SERVICE=1 when another botlingd holds the folder, and exits 75 without it", async () => {
    const dataDir = join(daemonRoot, "data");
    const daemon = new BotlingdProcess(dataDir);
    running.push(daemon);
    await daemon.ready();

    const normalSecond = botlingdCommand(dataDir, ["start"]);
    expect(normalSecond.code).toBe(CORE_EXIT_DATA_DIR_IN_USE);
    expect(normalSecond.stderr).toMatch(/already uses/);

    const serviceSecond = botlingdCommand(dataDir, ["start"], { BOTLING_SERVICE: "1" });
    expect(serviceSecond.code).toBe(0);
    expect(serviceSecond.stderr).toMatch(/already uses/);

    expect(botlingdCommand(dataDir, ["service", "bogus"]).code).toBe(2);
    expect(botlingdCommand(dataDir, ["service", "status", "extra"]).code).toBe(2);
  }, 60_000);
});
