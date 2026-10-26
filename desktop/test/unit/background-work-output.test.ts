import { afterEach, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import { backgroundTaskOutput, backgroundOutputFile } from "../../src/core/background-work";
import { parseLine } from "../../src/core/agent/stream";
import { RENDERER_COMMANDS } from "../../src/contract";
import { toSwiftDate } from "../../src/core/store/records";

const origin = "6A0B0000-0000-4000-8000-0000000000AA";
let core: CoreHarness | undefined;
afterEach(async () => { await core?.kill("SIGKILL"); core = undefined; });
it("reads chip output by stored message/task identity, with 1.x tails, reports and fallback text", async () => {
  const dir = tempDir("background-chip");
  mkdirSync(join(dir, "main"), { recursive: true });
  const output = join(dir, "command.log");
  writeFileSync(output, "discard\n" + Array.from({ length: 9 }, (_, i) => `\u001b[32mline ${i}\u001b[0m\n`).join("") + "old\rfinal\n\n");
  const tasks = [
    { id: "command", kind: "command", status: "completed", outputFile: output, summary: "summary" },
    { id: "report", kind: "agent", status: "completed", summary: "Found 3 things." },
    { id: "monitor", kind: "monitor", status: "running" },
    { id: "cron", kind: "cron", status: "completed", schedule: "0 9 * * *", recurring: false, summary: "Fired.", detail: "Check results" },
  ].map((task) => ({ title: task.id, startedAt: toSwiftDate(), ...task }));
  writeFileSync(join(dir, "main", "chat.json"), JSON.stringify([{ id: origin, role: "bot", text: "Started.", date: toSwiftDate(), backgroundTasks: tasks }]));
  expect(RENDERER_COMMANDS.has("task.output")).toBe(true);
  core = new CoreHarness(dir);
  const get = (messageId: string, taskId: string) => core!.call({ type: "task.output", botId: MAIN, messageId, taskId });
  expect(await get(origin, "command")).toEqual({ text: "line 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nfinal" });
  expect(await get(origin, "report")).toEqual({ text: "Found 3 things." });
  expect(await get(origin, "monitor")).toEqual({ text: "The app restarted while this ran; it was killed." });
  expect(await get(origin, "cron")).toEqual({ text: "cron 0 9 * * * (once) · Fired.\n\nCheck results" });
  expect(await get("other", "command")).toEqual({ text: "" });
  expect(await get(origin, "missing")).toEqual({ text: "" });
  // Renderer may identify a stored task, never provide a file path.
  await expect(core.call({ type: "task.output", botId: MAIN, messageId: origin, taskId: "command", path: output })).rejects.toThrow("bad_request");
});

it("publishes the running chip and its completed report through real core events", async () => {
  core = new CoreHarness(tempDir("background-agent-chip"), { FAKE_CLAUDE_BG_DELAY_MS: "600" });
  const { turnId } = await core.call({ type: "chat.send", botId: MAIN, text: "/bgagent" });
  await until(() => core!.of("turn.finished").find((entry) => entry.event.type === "turn.finished" && entry.event.turnId === turnId));
  const started = (await core.chat()).messages.find((message: any) => message.turnId === turnId);
  expect(started.backgroundTasks).toEqual([expect.objectContaining({ kind: "agent", status: "running", title: "Research the API" })]);
  const taskId = started.backgroundTasks[0].id;
  expect(await core.call({ type: "task.output", botId: MAIN, messageId: started.id, taskId })).toEqual({ text: "Working; nothing to show yet." });
  const ended = await until(() => core!.of("message.updated").find((entry) => entry.event.type === "message.updated"
    && entry.event.message.id === started.id && entry.event.message.backgroundTasks?.[0]?.status === "completed"));
  expect((ended.event as any).message.backgroundTasks[0].ended).toEqual(expect.any(Number));
  expect(await core.call({ type: "task.output", botId: MAIN, messageId: started.id, taskId })).toEqual({ text: "Found 3 things" });
});

it("keeps a command's structured output path in its originating record, without exposing it to the page", async () => {
  const dir = tempDir("background-command-chip"), output = join(dir, "build.log"), cli = join(dir, "command.mjs");
  writeFileSync(output, "Build succeeded.\n");
  writeFileSync(cli, `import {createInterface} from 'node:readline';
const out = value => process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line', () => {
 out({type:'system',subtype:'init',session_id:'fake'});
 out({type:'assistant',message:{content:[{type:'tool_use',id:'command',name:'Bash',input:{command:'build',run_in_background:true}}]}});
 out({type:'system',subtype:'task_started',task_type:'local_bash',is_backgrounded:true,tool_use_id:'command',description:'Build'});
 out({type:'user',message:{content:[{type:'tool_result',tool_use_id:'command',content:'Started.'}]},tool_use_result:{backgroundTaskId:'bg1',outputFile:${JSON.stringify(output)}}});
 out({type:'result',subtype:'success',is_error:false,result:'Building.',session_id:'fake'});
});`);
  core = new CoreHarness(dir, { BOTLING_FAKE_CLI: cli });
  const { turnId } = await core.call({ type: "chat.send", botId: MAIN, text: "build" });
  await until(() => core!.of("turn.finished").find((entry) => entry.event.type === "turn.finished" && entry.event.turnId === turnId));
  const reply = (await core.chat()).messages.find((message: any) => message.turnId === turnId);
  expect(reply.backgroundTasks).toEqual([expect.objectContaining({ id: "command", kind: "command", status: "running" })]);
  expect(JSON.stringify(reply.backgroundTasks)).not.toContain(output);
  expect(await core.call({ type: "task.output", botId: MAIN, messageId: reply.id, taskId: "command" })).toEqual({ text: "Build succeeded." });
});

it("bounds large tails and falls back when command output disappears", async () => {
  const dir = tempDir("background-tail"), output = join(dir, "huge.log");
  writeFileSync(output, "prefix".repeat(10_000) + "\n" + "🧪".repeat(301) + "\nlast\n");
  const base = { id: "b", kind: "command" as const, title: "Build", status: "completed" as const, startedAt: toSwiftDate() };
  expect(await backgroundTaskOutput({ ...base, outputFile: output })).toBe("🧪".repeat(300) + "…\nlast");
  expect(await backgroundTaskOutput({ ...base, outputFile: join(dir, "gone"), summary: "Saved report" })).toBe("Saved report");
  expect(await backgroundTaskOutput(base)).toBe("No output was kept.");
});

it("uses a running subagent's last four steps and an ended subagent's report", async () => {
  const task = { id: "a", kind: "agent" as const, title: "Research", status: "running" as const, startedAt: toSwiftDate() };
  const agent = { id: "a", description: "Research", prompt: "Research", background: true, status: "running" as const, startedAt: toSwiftDate(),
    steps: [{ id: "0", kind: "text" as const, title: "old" }, { id: "1", kind: "text" as const, title: "Reading\nmore" },
      { id: "2", kind: "message" as const, title: "message", detail: "Please check" }, { id: "3", kind: "tool" as const, title: "Read docs" }, { id: "4", kind: "subagent" as const, title: "Ask worker" }].map((step) => ({ ...step, failed: false, done: true })) };
  expect(await backgroundTaskOutput(task, agent)).toBe("· Reading\n← Please check\n› Read docs\n› Ask worker");
  expect(await backgroundTaskOutput(task, { ...agent, status: "completed", result: "Found it" })).toBe("Found it");
  expect(await backgroundTaskOutput({ ...task, kind: "monitor" })).toBe("Watching; no event yet.");
  expect(await backgroundTaskOutput({ ...task, kind: "command" })).toBe("No output yet.");
  expect(await backgroundTaskOutput({ ...task, status: "stopped" })).toBe("The bot's process ended before this reported back.");
});

it("recognizes the structured and legacy CLI output-file forms used by 1.x", () => {
  for (const key of ["outputFile", "output_file", "outputPath"]) {
    const items = parseLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c", content: "Started" }] }, tool_use_result: { [key]: "/tmp/build log" } }));
    expect(items[0]).toMatchObject({ kind: "toolResult", launch: { outputFile: "/tmp/build log" } });
  }
  expect(backgroundOutputFile("Output is being written to: /tmp/build log. You will be notified.")).toBe("/tmp/build log");
  expect(backgroundOutputFile("output_file: /tmp/agent.output\nMore")).toBe("/tmp/agent.output");
});
