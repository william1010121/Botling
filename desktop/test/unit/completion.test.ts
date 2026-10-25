// The completion judge through the core (Phase 5a; 1.x's Bot.checkPromise): off by default; on, a finished
// reply is judged by an isolated `codex exec` (the fake's), the verdict shows under the reply, and an
// unfinished task is continued with 1.x's follow-up (twice without progress: paused); Stop suspends it.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import { CLASSIFIER_PROMPT, FOLLOW_UP } from "../../src/core/promise-check";

const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null) await harness.kill("SIGTERM"); });
const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

describe("completion verification (PromiseCheck)", () => {
  it("judges a finished reply; COMPLETE shows under it; CONTINUE continues the task with 1.x's follow-up, then pauses without progress", async () => {
    const dir = tempDir("judge");
    const c = new CoreHarness(dir, {
      FAKE_CODEX_EXEC_LOG: join(dir, "exec.log"), FAKE_CLAUDE_INPUT: join(dir, "claude-input.log"),
      FAKE_CODEX_JUDGE: "COMPLETE:The tests were run and pass.|CONTINUE:The parser change is not made yet.", FAKE_CODEX_JUDGE_COUNT: join(dir, "judge-count"),
      TMPDIR: tempDir("judge-tmp"),
    });
    harnesses.push(c);
    // Off: nothing is judged.
    let sent = await c.call({ type: "chat.send", botId: MAIN, text: "/say Done." });
    await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lines(join(dir, "exec.log"))).toEqual([]);
    await c.call({ type: "settings.set", change: { key: "completionVerification", value: true } });
    sent = await c.call({ type: "chat.send", botId: MAIN, text: "/say The tests pass." });
    const judged = await until(async () => (await c.chat()).messages.find((m: any) => m.text === "The tests pass." && m.completionVerification?.state === "judged"));
    expect(judged.completionVerification).toEqual({ model: "gpt-6-luna", state: "judged", verdict: "COMPLETE", reason: "The tests were run and pass.", continuationPaused: null });
    const call = lines(join(dir, "exec.log"))[0].args as string[];
    expect(call.slice(0, 4)).toEqual(["exec", "--ignore-user-config", "--ephemeral", "--sandbox"]);
    expect(call).toContain("developer_instructions=" + JSON.stringify(CLASSIFIER_PROMPT));
    const record = JSON.parse(call.at(-1)!.split("\n").slice(1).join("\n"));
    expect(record).toMatchObject({ reply: "The tests pass.", task: "/say The tests pass.", terminalRequired: false, timeZone: expect.any(String) });
    expect(Array.isArray(record.scheduledWakeups)).toBe(true);
    // The judge says unfinished: the task goes on with 1.x's follow-up, said in the chat.
    sent = await c.call({ type: "chat.send", botId: MAIN, text: "/say I will change the parser next." });
    await until(async () => (await c.chat()).messages.some((m: any) => m.role === "notice" && m.text === "Continuing the authorized task: The parser change is not made yet."));
    await until(() => lines(join(dir, "claude-input.log")).some((entry) => String(entry.text).includes(FOLLOW_UP)));
    // Its continuation brought nothing new, twice: paused, with 1.x's notice.
    await until(async () => (await c.chat()).messages.some((m: any) => m.role === "notice" && m.text.startsWith("Automatic continuation paused:")), { timeout: 20_000 });
    const paused = (await c.chat()).messages.findLast((m: any) => m.completionVerification?.continuationPaused);
    expect(paused.completionVerification.verdict).toBe("CONTINUE");
  });
});
