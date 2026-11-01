// Claude Code's own safety checks ask even with --permission-mode bypassPermissions (claude 2.1.311: an `rm` on a
// variable that may be empty, after a `cd`). The request says so (`decision_reason_type: "safetyCheck"`), and the
// card has to say it too: the user chose bypass, so a bare "Wants to use Bash" reads as Botling's permissions broken.
// The answer stays the user's (the CLI marks it `classifier_approvable: false`), and no Always allow is offered
// (`suppress_always_allow_rule`).
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bot } from "../../src/core/bot";
import { ClaudeHead } from "../../src/core/agent/head";
import { parseLine, type StreamItem } from "../../src/core/agent/stream";
import { ProcessLedger } from "../../src/core/process/ledger";
import { mainProfile } from "../../src/core/store/workspace";
import { botPrompts } from "../../src/core/prompts";
import { tempDir } from "../helpers";

const COMMAND = "cd /work/04-會議/slides\nD=/private/tmp/pg; rm -f $D/*; ls $D";
const REASON = "Dangerous rm operation on possibly-empty variable path: $D/* in `rm -f $D/*` (rewrite it as \"${D:?}\"/* or use a literal path)";
// As claude 2.1.311 sent it to a bypassPermissions head with `--permission-prompt-tool stdio` (a native subagent's adds agent_id).
const REQUEST = { type: "control_request", request_id: "187888ac-3f29-45dc-abb4-0d46dd89c860", request: {
  subtype: "can_use_tool", tool_name: "Bash", display_name: "Bash", input: { command: COMMAND, description: "Rebuild and render pages" },
  description: "Rebuild and render pages", permission_suggestions: [], decision_reason: REASON, decision_reason_type: "safetyCheck",
  classifier_approvable: false, tool_use_id: "toolu_01EPELGKvJTzg9f3TbpoGVxT", suppress_always_allow_rule: true,
} };

describe("Claude Code's safety check in the stream", () => {
  it("keeps the reason and that no always rule may cover it", () => {
    expect(parseLine(JSON.stringify(REQUEST))).toEqual([{ kind: "permission", requestId: REQUEST.request_id, tool: "Bash", summary: COMMAND,
      input: { command: COMMAND, description: "Rebuild and render pages" }, safetyCheck: REASON, noAlways: true }]);
  });

  it("leaves an ordinary request as it was", () => {
    const plain = { ...REQUEST, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } } };
    expect(parseLine(JSON.stringify(plain))).toEqual([{ kind: "permission", requestId: REQUEST.request_id, tool: "Bash", summary: "ls", input: { command: "ls" } }]);
  });
});

describe("the card for a safety check", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

  function harness() {
    const dir = tempDir("safety-check");
    const profile = mainProfile(dir);
    mkdirSync(profile.storeDir, { recursive: true });
    writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine: "claude" }));
    const bot = new Bot({ profile, deferStartup: true, welcome: false,
      ledger: new ProcessLedger(join(dir, "ledger.json")),
      headConfig() { throw new Error("No CLI needed"); },
      prompts: () => botPrompts({ profile, engine: "claude" }),
      emit() {}, log() {},
      approvalTimeoutMs: 60_000, idleMs: 60_000, interruptGraceMs: 10,
    });
    const head = new ClaudeHead({ command: process.execPath, cwd: dir, sessionId: "s", resume: false, allowedTools: [] }, { onItem() {}, onExit() {} });
    head.running = true;
    (bot as any).head = head;
    vi.spyOn(head, "send").mockImplementation(() => {});
    const answer = vi.spyOn(head, "answer").mockImplementation(() => {});
    const cards = () => (bot as any).records.filter((record: any) => record.permissionTool);
    cleanups.push(async () => { head.running = false; await bot.shutdown({ tidy: false }); });
    return { bot, head, answer, cards };
  }
  const asked = () => parseLine(JSON.stringify(REQUEST))[0] as Extract<StreamItem, { kind: "permission" }>;

  it("says Claude Code's safety check asks even with permissions bypassed, why, and offers no Always allow", () => {
    const h = harness();
    (h.bot as any).ask(h.head, asked(), null);
    const card = h.cards()[0];
    expect(card.text).toBe(`Wants to use \`Bash\`:\n\n~~~\n${COMMAND}\n~~~\n\nClaude Code's own safety check asks about this even when permissions are bypassed: ${REASON}`);
    expect(card.choices.map((choice: any) => choice.action)).toEqual(["allowOnce", "deny"]);
    expect(h.bot.choose(card.id, 0)).toEqual({ accepted: true });
    expect(h.answer).toHaveBeenCalledWith(REQUEST.request_id, true, REQUEST.request.input, undefined);
  });

  it("is the same for an app-managed worker's request, answered to that worker", () => {
    const h = harness();
    const worker = vi.fn();
    (h.bot as any).claudeWorkerHost = { answer: worker, close: async () => {} };
    const requestId = `worker:${"a".repeat(8)}-aaaa-aaaa-aaaa-${"a".repeat(12)}:1:${REQUEST.request_id}`;
    (h.bot as any).onWorkerOutput({ ...asked(), requestId, workerId: "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12) });
    const card = h.cards()[0];
    expect(card.text).toContain(`Claude Code's own safety check asks about this even when permissions are bypassed: ${REASON}`);
    expect(card.choices.map((choice: any) => choice.action)).toEqual(["allowOnce", "deny"]);
    expect(h.bot.choose(card.id, 1)).toEqual({ accepted: true });
    expect(worker).toHaveBeenCalledWith(requestId, false, REQUEST.request.input, expect.any(String));
  });
});
