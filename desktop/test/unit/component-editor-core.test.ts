// Core-owned identity -> Codex transport -> real child process (fake Claude protocol) -> report.
// Headless: no Electron windows, live service, shared data, or real component edits.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CoreHarness, MAIN } from "../core-harness";
import { alive, tempDir, until } from "../helpers";
import { MAINTAINER_ID } from "../../src/core/store/records";
import { deniedNote } from "../../src/core/worker-core";

const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const c of harnesses.splice(0)) await c.kill("SIGTERM"); });
const lines = (file: string): any[] => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
function core() {
  const dir = tempDir("component-editor-core");
  const c = new CoreHarness(dir, { FAKE_CLAUDE_LOG: join(dir, "claude.log"), FAKE_CODEX_INPUT: join(dir, "codex.log"), BOTLING_QUIT_TIDY_MS: "0" });
  harnesses.push(c);
  return { c, dir };
}
async function turn(c: CoreHarness, botId: string, text: string) {
  const sent = await c.call({ type: "chat.send", botId, text });
  return until(() => c.of("turn.finished").find((e: any) => e.event.turnId === sent.turnId));
}
async function report(c: CoreHarness, needle: string) {
  return until(async () => (await c.chat(MAINTAINER_ID)).messages.find((m: any) => m.role === "bot" && m.text === `The worker finished: ${needle}`));
}

describe("Maintainer component editor through the built core", () => {
  it("launches the app's existing Claude editor and reports, then resumes its same session/task; shutdown ends the child", async () => {
    const { c, dir } = core();
    await c.call({ type: "heads.set", botId: MAINTAINER_ID, engines: ["codex"] });
    await turn(c, MAINTAINER_ID, "/component-editor /say editor checked");
    await report(c, "editor checked");
    const event = c.of("subagent.updated").find((e: any) => e.event.botId === MAINTAINER_ID && e.event.subagent.type === "ccb-core:component-editor")!;
    const id = (event.event as any).subagent.id;
    const detail = (await c.call({ type: "subagent.view", botId: MAINTAINER_ID, subagentId: id })).subagent;
    expect(detail).toMatchObject({ type: "ccb-core:component-editor", engine: "claude", model: "sonnet", status: "completed", result: "editor checked", execution: { run: 1 } });
    const first = lines(join(dir, "claude.log"))[0];
    expect(first.cwd).toBe(join(dir, "plugins"));
    expect(first.args).toEqual(expect.arrayContaining(["--model", "sonnet", "--tools", "Read,Write,Edit,Bash"]));
    expect(first.args.join(" ")).toContain("AskUserQuestion,Agent,Task,SendMessage");
    expect(first.args).not.toContain("--plugin-dir");
    const registryFile = join(dir, "codex-threads", `${detail.execution.ownerSessionId.toLowerCase()}.workers.json`);
    expect(JSON.parse(readFileSync(registryFile, "utf8"))).toContainEqual(expect.objectContaining({ id, role: "component-editor", thread: first.session }));
    await turn(c, MAINTAINER_ID, `/editor-message ${id} /say correction checked`);
    await report(c, "correction checked");
    const starts = lines(join(dir, "claude.log"));
    expect(starts).toHaveLength(1); // Corrections reuse the live Claude session.
    expect((await c.call({ type: "subagent.view", botId: MAINTAINER_ID, subagentId: id })).subagent).toMatchObject({ status: "completed", result: "correction checked", execution: { run: 2 } });
    await c.kill("SIGTERM");
    await until(() => !alive(first.pid));
  });

  it.each([0, 1])("keeps the child's approval after the coordinator turn ends and forwards choice %s", async choice => {
    const { c } = core();
    await c.call({ type: "heads.set", botId: MAINTAINER_ID, engines: ["codex"] });
    await turn(c, MAINTAINER_ID, "/component-editor /tool echo editor");
    const card = await until(async () => (await c.chat(MAINTAINER_ID)).messages.find((m: any) => m.approval && m.chosen === null));
    expect(card.approval.tool).toBe("Bash");
    expect(card.choices.map((item: any) => item.action)).toEqual(["allowOnce", "deny"]);
    await c.call({ type: "chat.choose", botId: MAINTAINER_ID, messageId: card.id, index: choice });
    // A denial no longer fails the run; its report says so first (decision D2).
    const evidence = choice === 0 ? "Let me run that. \n\nAllowed: ran echo editor" : `${deniedNote(1)}\nLet me run that. \n\nDenied: The user did not allow it.`;
    await report(c, evidence);
    expect(await c.call({ type: "chat.choose", botId: MAINTAINER_ID, messageId: card.id, index: 0 })).toEqual({ accepted: false });
  });

  it("refuses Main and an ordinary bot without launching a Claude editor", async () => {
    const { c, dir } = core();
    const other = await c.call({ type: "bots.create", name: "Editor helper", job: "Ordinary bot" });
    for (const botId of [MAIN, other.botId]) {
      await c.call({ type: "heads.set", botId, engines: ["codex"] });
      const ended: any = await turn(c, botId, "/component-editor /say must not run");
      expect(ended.event.text).toContain("Only the app-created Maintainer");
      expect(c.of("subagent.updated").some((e: any) => e.event.botId === botId)).toBe(false);
    }
    expect(lines(join(dir, "claude.log")).filter(start => start.cwd === join(dir, "plugins") || start.args.includes("--tools"))).toHaveLength(0);
  });

  it("reports a Claude process crash once, without substituting a generic worker", async () => {
    const { c, dir } = core();
    await c.call({ type: "heads.set", botId: MAINTAINER_ID, engines: ["codex"] });
    await turn(c, MAINTAINER_ID, "/component-editor /crash");
    await until(async () => (await c.chat(MAINTAINER_ID)).messages.some((m: any) => m.text.startsWith("The worker stopped: Claude component-editor failed:")));
    const ended = c.of("subagent.updated").filter((e: any) => e.event.subagent.status === "failed");
    expect(new Set(ended.map((e: any) => e.event.subagent.id)).size).toBe(1);
    expect(lines(join(dir, "claude.log"))).toHaveLength(1);
    expect(lines(join(dir, "codex.log")).some(input => input.kind === "worker")).toBe(false);
  });

});
