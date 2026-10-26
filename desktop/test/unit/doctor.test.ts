import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Doctor, DoctorModel, DOCTOR_TIMEOUT_MS, cliVersion, compareVersions, evaluate, locateExecutable, parseAuth, parseLatest, runCommand, type CommandResult, type Run } from "../../src/core/doctor";
import { DoctorView, EventEnvelope, PROTOCOL_VERSION, RENDERER_COMMANDS, parseInbound, type Outbound } from "../../src/contract";
import { copyDoctorFix } from "../../src/main/doctor-copy";
import { Core } from "../../src/core/server";
import { apply, type WorkspaceView } from "../../src/renderer/store";
import { tempDir, until } from "../helpers";

const result = (output: string, exitCode = 0, timedOut = false): CommandResult => ({ output, exitCode, timedOut });
const signedIn = { state: "signedIn", how: "ChatGPT" } as const;

describe("Doctor parity with the Swift CLI self-check", () => {
  it("compares CLI versions numerically with zero-filled parts and keeps npm errors unavailable", () => {
    expect(cliVersion("2.1.304 (Claude Code)")).toBe("2.1.304");
    expect(cliVersion("codex-cli 0.163.0")).toBe("0.163.0");
    expect(cliVersion("command not found")).toBeNull();
    expect(compareVersions("2.1.111.0", "2.1.111")).toBe(0);
    expect(compareVersions("2.2", "2.1.111")).toBeGreaterThan(0);
    expect(compareVersions("2.1.90", "2.1.111")).toBeLessThan(0);
    expect(compareVersions("10.0", "9.9.9")).toBeGreaterThan(0);
    expect(parseLatest("2.1.305\n")).toBe("2.1.305");
    expect(parseLatest("npm error code ENOTFOUND\nnetwork request failed")).toBeNull();
    expect(parseLatest("")).toBeNull();
  });

  it("reads both login formats without retaining the Codex API key or Claude account email", () => {
    expect(parseAuth("claude", 'notice\n{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"synthetic@example.test"}', 0)).toEqual({ state: "signedIn", how: "Claude subscription (max)" });
    expect(parseAuth("claude", '{"loggedIn":true,"authMethod":"api_key"}', 0)).toEqual({ state: "signedIn", how: "API key" });
    expect(parseAuth("claude", '{"loggedIn":false}', 1)).toEqual({ state: "signedOut" });
    expect(parseAuth("claude", "unknown command", 1)).toEqual({ state: "unknown" });
    expect(parseAuth("codex", "Logged in using an API key - synthetic-secret", 0)).toEqual({ state: "signedIn", how: "API key" });
    expect(parseAuth("codex", "Logged in using ChatGPT", 0)).toEqual(signedIn);
    expect(parseAuth("codex", "Authenticated with a workspace token", 0)).toMatchObject({ state: "signedIn" });
    expect(parseAuth("codex", "Not logged in", 1)).toEqual({ state: "signedOut" });
    expect(parseAuth("codex", "Error loading config.toml", 1)).toEqual({ state: "unknown" });
  });

  it("distinguishes required/optional missing tools, unsupported versions, sign-out, unknown and newer releases", () => {
    expect(evaluate("claude", null, null, { state: "unknown" }, null)).toMatchObject({ status: "failing", isRequired: true, fix: "npm i -g @anthropic-ai/claude-code@latest" });
    expect(evaluate("codex", null, null, { state: "unknown" }, null)).toMatchObject({ status: "warning", isRequired: false, fix: "npm i -g @openai/codex@latest" });
    expect(evaluate("claude", "/u/bin/claude", result("2.1.90"), signedIn, null)).toMatchObject({ status: "failing", minimum: "2.1.111", fix: "'/u/bin/claude' update" });
    expect(evaluate("codex", "/u/bin/codex", result("0.98.2"), signedIn, null)).toMatchObject({ status: "failing", minimum: "0.99.0", fix: "npm i -g @openai/codex@latest" });
    expect(evaluate("claude", "/u/bin/claude", result("2.1.304"), { state: "signedOut" }, null)).toMatchObject({ status: "failing", fix: "'/u/bin/claude' auth login" });
    expect(evaluate("codex", "/u/bin/codex", result("0.163.0"), { state: "unknown" }, null)).toMatchObject({ status: "warning", fix: "'/u/bin/codex' login" });
    expect(evaluate("claude", "/u/bin/claude", result("2.1.304", 1, true), signedIn, null)).toMatchObject({ status: "warning", version: null, summary: expect.stringContaining("did not answer in 10 s"), fix: null });
    expect(evaluate("claude", "/u/bin/claude", result("2.1.304"), signedIn, "2.1.305")).toMatchObject({ status: "ok", latest: "2.1.305", summary: "Signed in with ChatGPT. 2.1.305 is available.", fix: "'/u/bin/claude' update" });
    expect(evaluate("claude", "/u/bin/claude", result("2.1.304"), signedIn, "2.1.304").fix).toBeNull();
  });

  it("runs only version/auth probes at the 10-second bound; startup skips npm and an offline rerun still returns two rows", async () => {
    const run = vi.fn<Run>(async (path, args) => args[0] === "--version" ? result(path.endsWith("claude") ? "2.1.304 (Claude Code)" : "codex-cli 0.163.0") : result(path.endsWith("claude") ? '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}' : "Logged in using ChatGPT"));
    const latest = vi.fn(async () => null);
    const doctor = new Doctor({ locate: tool => `/u/bin/${tool}`, run, latest });
    const rows = await doctor.check(false);
    expect(rows.map(row => [row.tool, row.status, row.auth])).toEqual([["claude", "ok", "Claude subscription (pro)"], ["codex", "ok", "ChatGPT"]]);
    expect(run.mock.calls).toEqual(expect.arrayContaining([
      ["/u/bin/claude", ["--version"], DOCTOR_TIMEOUT_MS], ["/u/bin/claude", ["auth", "status"], DOCTOR_TIMEOUT_MS],
      ["/u/bin/codex", ["--version"], DOCTOR_TIMEOUT_MS], ["/u/bin/codex", ["login", "status"], DOCTOR_TIMEOUT_MS],
    ]));
    expect(run).toHaveBeenCalledTimes(4); expect(latest).not.toHaveBeenCalled();
    const offline = await new Doctor({ locate: () => null, run, latest }).check(true);
    expect(offline.map(row => row.status)).toEqual(["failing", "warning"]);
    expect(latest.mock.calls).toHaveLength(2);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("shares concurrent checks, upgrades an in-flight offline run on page entry and warns only for required failures", async () => {
    let finish!: (rows: ReturnType<typeof evaluate>[]) => void;
    const check = vi.fn((_latest: boolean) => new Promise<ReturnType<typeof evaluate>[]>(resolve => { finish = resolve; }));
    const model = new DoctorModel({ check });
    const first = model.run(false), second = model.run(false), page = model.run(true);
    expect(model.view().isRunning).toBe(true); expect(check).toHaveBeenCalledTimes(1);
    finish([evaluate("claude", "/u/claude", result("9.9.9"), signedIn, null), evaluate("codex", null, null, { state: "unknown" }, null)]);
    await Promise.all([first, second]);
    await until(() => check.mock.calls.length === 2);
    expect(check.mock.calls.map(call => call[0])).toEqual([false, true]);
    finish([evaluate("claude", null, null, { state: "unknown" }, null)]);
    await page;
    expect(model.view()).toMatchObject({ includedLatest: true, isRunning: false, needsAttention: true, checkedAt: expect.any(Number) });
  });

  it("resolves executable installs and authoritative missing overrides without a shell", () => {
    const dir = tempDir("doctor-path"); const bin = join(dir, "bin"); mkdirSync(bin);
    const cli = join(bin, "claude"); writeFileSync(cli, "#!/bin/sh\nexit 0\n"); chmodSync(cli, 0o755);
    expect(locateExecutable("claude", { PATH: bin })).toBe(cli);
    expect(locateExecutable(join(dir, "missing"), { PATH: bin })).toBeNull();
    expect(locateExecutable("missing", { PATH: "." })).toBeNull();
  });

  it("captures stdout/stderr/exit status, stops a hanging command and handles an absent executable", async () => {
    expect(await runCommand(process.execPath, ["-e", "process.stdout.write('out');process.stderr.write('err');process.exitCode=3"], 1000)).toMatchObject({ output: expect.stringContaining("out"), exitCode: 3, timedOut: false });
    const started = Date.now();
    expect(await runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], 60)).toMatchObject({ timedOut: true });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await runCommand("/nonexistent/doctor-cli", [], 100)).toBeNull();
  });

  it("copies only the current core-generated repair command and rejects arbitrary renderer text", () => {
    const write = vi.fn();
    const view = new DoctorModel().view();
    expect(copyDoctorFix("claude", view, write)).toEqual({ copied: false });
    expect(write).not.toHaveBeenCalled();
    const check = evaluate("claude", "/u/bin/claude", result("2.1.304"), { state: "signedOut" }, null);
    expect(copyDoctorFix("claude", { ...view, checks: [check] }, write)).toEqual({ copied: true });
    expect(write).toHaveBeenCalledExactlyOnceWith("'/u/bin/claude' auth login");
    expect(RENDERER_COMMANDS.has("doctor.copy")).toBe(true);
    expect(parseInbound({ v: PROTOCOL_VERSION, id: "copy", cmd: { type: "doctor.copy", tool: "claude" } }).ok).toBe(true);
    expect(parseInbound({ v: PROTOCOL_VERSION, id: "copy", cmd: { type: "doctor.copy", tool: "claude", text: "arbitrary" } }).ok).toBe(false);
  });

  it("wires activation, renderer commands, snapshots, events and warning state through the real core", async () => {
    const emitted: Outbound[] = [];
    const latest = vi.fn(async () => null);
    const doctor = new Doctor({ locate: () => null, latest });
    const core = new Core({ dataDir: tempDir("doctor-core"), doctor, headConfig: (_profile, session) => ({ command: process.execPath, cwd: tempDir("doctor-head"), sessionId: session.sessionId, resume: false, allowedTools: [] }), emit: message => emitted.push(message), deferStartup: true, routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0, oneX: { folder: null, process: /never/ } });
    const call = async (cmd: unknown) => {
      const id = `doctor-${emitted.length}`;
      await core.receive({ v: PROTOCOL_VERSION, id, cmd });
      const answer = await until(() => emitted.find(message => "id" in message && message.id === id));
      expect(answer).toMatchObject({ ok: true });
      return (answer as { result: any }).result;
    };
    try {
      for (const type of ["doctor.view", "doctor.run"] as const) expect(RENDERER_COMMANDS.has(type)).toBe(true);
      expect(parseInbound({ v: PROTOCOL_VERSION, id: "bad", cmd: { type: "doctor.run", includeLatest: true, command: "install" } }).ok).toBe(false);
      expect(core.snapshot().doctor?.checks).toEqual([]);
      await call({ type: "boot.commit" });
      await until(() => !core.doctor.view().isRunning && core.doctor.view().checks.length === 2);
      expect(latest).not.toHaveBeenCalled();
      expect(core.snapshot().doctor).toMatchObject({ needsAttention: true, includedLatest: false });
      const view = DoctorView.parse(await call({ type: "doctor.run", includeLatest: true }));
      expect(view).toMatchObject({ needsAttention: true, includedLatest: true });
      expect(await call({ type: "doctor.view" })).toEqual(view);
      expect(latest).toHaveBeenCalledTimes(2);
      const event = emitted.filter(message => "event" in message && message.event.type === "doctor.updated").at(-1)!;
      expect(EventEnvelope.safeParse(event).success).toBe(true);
      expect(apply({ chat: null } as WorkspaceView, (event as EventEnvelope).event).doctor).toEqual(view);
    } finally { await core.shutdown(); }
  });
});
