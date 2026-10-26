// Claude Code's auto mode for the claude head (1.x's `autoMode`): launched with
// `--permission-mode auto`, its classifier approves safe actions itself, and a call it blocked
// becomes the 1.x card ("Auto mode blocked"), whose Allow lets exactly that call through.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bot } from "../../src/core/bot";
import { ClaudeHead, headArguments } from "../../src/core/agent/head";
import { parseLine, type StreamItem } from "../../src/core/agent/stream";
import { launchSettings } from "../../src/core/settings";
import { ProcessLedger } from "../../src/core/process/ledger";
import { mainProfile } from "../../src/core/store/workspace";
import { botPrompts } from "../../src/core/prompts";
import { tempDir } from "../helpers";

const BLOCK = "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Irreversible Local Destruction] Deletes the build folder. If you have other tasks, carry on.";

describe("auto mode: arguments and setting", () => {
  const base = { command: "claude", cwd: "/", sessionId: "s", resume: false, allowedTools: ["Read"] };

  it("launches with --permission-mode auto when on, acceptEdits when off, default when harmless", () => {
    const mode = (args: string[]) => args[args.indexOf("--permission-mode") + 1];
    expect(mode(headArguments({ ...base, autoMode: true }))).toBe("auto");
    expect(mode(headArguments({ ...base, autoMode: false }))).toBe("acceptEdits");
    expect(mode(headArguments(base))).toBe("acceptEdits");
    expect(mode(headArguments({ ...base, autoMode: true, harmless: true }))).toBe("default");
  });

  it("passes allowed blocked calls as --settings rules", () => {
    const args = headArguments({ ...base, autoMode: true, allowRules: ["Bash(rm -rf build, now)"] });
    expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toEqual({ permissions: { allow: ["Bash(rm -rf build, now)"] } });
    expect(headArguments({ ...base, autoMode: true })).not.toContain("--settings");
  });

  it("is on by default and follows 1.x's autoApprove setting", () => {
    expect(launchSettings({}).autoMode).toBe(true);
    expect(launchSettings({ autoApprove: false }).autoMode).toBe(false);
    expect(launchSettings({ autoApprove: true }).autoMode).toBe(true);
  });
});

describe("auto mode: blocked calls in the stream", () => {
  it("reads the classifier's permission_denied frame, and the tool result that confirms the block", () => {
    expect(parseLine(JSON.stringify({ type: "system", subtype: "permission_denied", decision_reason_type: "classifier", tool_use_id: "t1", tool_name: "Bash", decision_reason: "[Irreversible Local Destruction] Deletes it" })))
      .toEqual([{ kind: "permissionDenied", toolUseId: "t1", tool: "Bash", reason: "[Irreversible Local Destruction] Deletes it", confirmed: false }]);
    // A deny rule's refusal is not the user's to wave through.
    expect(parseLine(JSON.stringify({ type: "system", subtype: "permission_denied", decision_reason_type: "rule", tool_use_id: "t1", tool_name: "Bash" }))).toEqual([]);
    const result = (meta: unknown, parent: string | null = null) => parseLine(JSON.stringify({ type: "user", parent_tool_use_id: parent, tool_result_meta: meta, message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: BLOCK }] } }));
    expect(result([{ id: "t1", non_execution_kind: "automode-blocked" }]).at(-1)).toEqual({ kind: "permissionDenied", toolUseId: "t1", tool: null, reason: "[Irreversible Local Destruction] Deletes the build folder", confirmed: true });
    expect(result([{ id: "t1", non_execution_kind: "automode-unavailable" }]).map((item) => item.kind)).toEqual(["toolResult"]);
    // A subagent's result carries no kind: the words tell.
    expect(result(undefined, "agent-1").at(-1)).toMatchObject({ kind: "permissionDenied", confirmed: true });
  });
});

describe("auto mode: the blocked-call card", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

  function harness() {
    const dir = tempDir("auto-mode");
    const profile = mainProfile(dir);
    mkdirSync(profile.storeDir, { recursive: true });
    writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine: "claude" }));
    const events: any[] = [];
    const bot = new Bot({ profile, deferStartup: true, welcome: false,
      ledger: new ProcessLedger(join(dir, "ledger.json")),
      headConfig() { throw new Error("No CLI needed"); },
      prompts: () => botPrompts({ profile, engine: "claude" }),
      emit: (event) => events.push(event), log() {},
      approvalTimeoutMs: 60_000, idleMs: 60_000, interruptGraceMs: 10,
    });
    const head = new ClaudeHead({ command: process.execPath, cwd: dir, sessionId: "s", resume: false, allowedTools: [] }, { onItem() {}, onExit() {} });
    head.running = true;
    (bot as any).head = head;
    const allow = vi.spyOn(head, "allow").mockImplementation(() => {});
    vi.spyOn(head, "send").mockImplementation(() => {});
    // What the app tells claude: a turn of its own ("app"), with no line in the chat.
    const sent = vi.spyOn(bot as any, "deliverTo");
    const answer = vi.spyOn(head, "answer").mockImplementation(() => {});
    const feed = (...items: StreamItem[]) => { for (const item of items) (bot as any).onItem(head, item); };
    const block = (id: string, command: string) => feed(
      { kind: "toolUse", id, tool: "Bash", title: `Run ${command}`, detail: command, parent: null, input: { command } },
      { kind: "permissionDenied", toolUseId: id, tool: "Bash", reason: "[Irreversible Local Destruction] Deletes the build folder", confirmed: false },
      { kind: "permissionDenied", toolUseId: id, tool: null, reason: "", confirmed: true },
    );
    const cards = () => (bot as any).records.filter((record: any) => record.permissionTool);
    cleanups.push(async () => { head.running = false; await bot.shutdown({ tidy: false }); });
    return { bot, head, allow, sent, answer, feed, block, cards };
  }

  it("shows one card for the blocked call, with the classifier's reason, and no approval waiting", () => {
    const h = harness();
    h.block("t1", "rm -rf build");
    // The tool result repeats the block: still one card.
    h.feed({ kind: "permissionDenied", toolUseId: "t1", tool: null, reason: "", confirmed: true });
    expect(h.cards()).toHaveLength(1);
    const card = h.cards()[0];
    expect(card.text).toBe("Auto mode blocked `Bash`:\n\n~~~\nrm -rf build\n~~~\n\nReason: [Irreversible Local Destruction] Deletes the build folder");
    expect(card.choices.map((choice: any) => [choice.label, choice.action])).toEqual([["Allow once", "allowOnce"], ["Always allow this command", "alwaysAllow"], ["Don't allow", "deny"]]);
    expect(h.answer).not.toHaveBeenCalled();
    // A frame alone (no verdict confirmed by its result) shows nothing.
    h.feed({ kind: "permissionDenied", toolUseId: "t2", tool: "Bash", reason: "x", confirmed: false });
    expect(h.cards()).toHaveLength(1);
  });

  it("Allow once gives claude exactly that rule and tells it to retry", () => {
    const h = harness();
    h.block("t1", "rm -rf build");
    expect(h.bot.choose(h.cards()[0].id, 0)).toEqual({ accepted: true });
    expect(h.allow).toHaveBeenCalledWith(["Bash(rm -rf build)"]);
    expect(h.sent.mock.calls.at(-1)![1]).toContain("(App: The user allowed `rm -rf build` (Bash), which auto mode blocked. It is allowed now: run it again as it was, then carry on.)");
    expect((h.bot as any).alwaysAllowed).toEqual([]);
    // A second block of the same call after the rule was given: allowing again cannot help.
    h.block("t3", "rm -rf build");
    const again = h.cards().at(-1);
    expect(again.choices.map((choice: any) => choice.label)).toEqual(["I'll run it myself", "Don't allow"]);
    expect(again.text).toContain("Allowing it again would not help.");
  });

  it("Always allow keeps the rule; Don't allow tells claude not to try again", () => {
    const h = harness();
    h.block("t1", "rm -rf build");
    h.bot.choose(h.cards()[0].id, 1);
    expect((h.bot as any).alwaysAllowed).toEqual(["Bash(rm -rf build)"]);
    expect((h.bot as any).allowRules).toEqual(["Bash(rm -rf build)"]);
    h.block("t2", "git push --force");
    h.bot.choose(h.cards().at(-1).id, 2);
    expect(h.allow).toHaveBeenCalledTimes(1);
    expect(h.sent.mock.calls.at(-1)![1]).toContain("(App: The user did not allow `git push --force` (Bash), which auto mode blocked. Do not try it again;");
  });
});
