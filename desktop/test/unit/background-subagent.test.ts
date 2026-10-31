import { afterEach, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

let core: CoreHarness | undefined;
afterEach(async () => { await core?.kill("SIGKILL"); core = undefined; });

// Background work a subagent started shows in the row too, labeled with the subagent. Event shapes as in
// background-claude-2-1-311.test.ts; a subagent's lines carry `parent_tool_use_id` (the Agent call's id).
const PRELUDE = `import {createInterface} from 'node:readline';
const out = value => process.stdout.write(JSON.stringify(value)+'\\n');
const P = 'toolu_agent';
const use = (id, name, input, parent = P) => out({type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id,name,input,caller:{type:'direct'}}]},parent_tool_use_id:parent});
const result = (id, content, tool_use_result, parent = P) => out({type:'user',message:{role:'user',content:[{tool_use_id:id,type:'tool_result',content,is_error:false}]},parent_tool_use_id:parent,tool_use_result});
const startAgent = () => {
 use('toolu_agent','Agent',{description:'Build the thing',subagent_type:'general-purpose',prompt:'build',run_in_background:true}, null);
 out({type:'system',subtype:'task_started',task_id:'agent1',run_id:'ra',tool_use_id:'toolu_agent',description:'Build the thing',is_backgrounded:true,task_type:'local_agent',subagent_type:'general-purpose',prompt:'build'});
 result('toolu_agent','Async agent launched successfully.\\nagentId: agent1',{status:'async_launched',agentId:'agent1',isAsync:true}, null);
};
const startWork = () => {
 use('toolu_sbash','Bash',{command:'sleep 20',description:'Sleep for 20 seconds',run_in_background:true});
 out({type:'system',subtype:'task_started',task_id:'bsb',run_id:'r2',tool_use_id:'toolu_sbash',description:'Sleep for 20 seconds',is_backgrounded:true,task_type:'local_bash'});
 result('toolu_sbash','Command running in background with ID: bsb. Output is being written to: /tmp/x/bsb.output.',{stdout:'',stderr:'',interrupted:false,backgroundTaskId:'bsb'});
 use('toolu_smon','Monitor',{command:'sleep 30; echo hi',description:'watch it',timeout_ms:300000});
 out({type:'system',subtype:'task_started',task_id:'bsm',run_id:'r3',tool_use_id:'toolu_smon',description:'watch it',is_backgrounded:true,task_type:'local_bash'});
 result('toolu_smon','Monitor started (task bsm)',{taskId:'bsm',timeoutMs:300000,persistent:false});
 use('toolu_sslow','Bash',{command:'sleep 135',description:'Slow'});
 out({type:'system',subtype:'task_started',task_id:'bsl',run_id:'r4',tool_use_id:'toolu_sslow',description:'Slow',is_backgrounded:false,task_type:'local_bash'});
 result('toolu_sslow','Command did not complete within its 120s timeout and was moved to the background (ID: bsl).',{stdout:'',stderr:'',interrupted:false,backgroundTaskId:'bsl',timedOutAfterMs:120000});
 use('toolu_swake','ScheduleWakeup',{delaySeconds:300,reason:'probe',prompt:'probe',noop:false});
 result('toolu_swake','Next wakeup scheduled for 18:36:00 (in 264s).',{scheduledFor:Date.now()+300000,clampedDelaySeconds:300,wasClamped:false});
};
const end = () => out({type:'system',subtype:'task_notification',task_id:'agent1',run_id:'ra',tool_use_id:'toolu_agent',status:'completed',output_file:'',summary:'All done'});
`;

async function run(body: string) {
  const dir = tempDir("background-subagent"), cli = join(dir, "claude.mjs");
  writeFileSync(cli, `${PRELUDE}
createInterface({input:process.stdin}).on('line', () => {
 out({type:'system',subtype:'init',session_id:'fake'});
 ${body}
});`);
  core = new CoreHarness(dir, { BOTLING_FAKE_CLI: cli });
  const { turnId } = await core.call({ type: "chat.send", botId: MAIN, text: "go" });
  await until(() => core!.of("turn.finished").find((entry) => entry.event.type === "turn.finished" && entry.event.turnId === turnId));
  const tasks = async () => ((await core!.chat()).messages.find((message: any) => message.turnId === turnId)?.backgroundTasks ?? []) as any[];
  return { tasks };
}
const summary = (tasks: any[]) => tasks.filter((task) => task.id !== "toolu_agent").map((task) => [task.id, task.kind, task.status, task.owner?.label ?? null]).sort();

it("shows a subagent's background Bash, Monitor, auto-backgrounded command and wake-up, labeled with the subagent, and ends them with it", async () => {
  const { tasks } = await run(`startAgent(); startWork(); out({type:'result',subtype:'success',is_error:false,result:'Launched.',session_id:'fake'}); setTimeout(end, 300);`);
  expect(summary(await tasks())).toEqual([
    ["toolu_sbash", "command", "running", "Build the thing"], ["toolu_smon", "monitor", "running", "Build the thing"],
    ["toolu_sslow", "command", "running", "Build the thing"], ["toolu_swake", "wakeup", "running", "Build the thing"]]);
  expect((await tasks()).find((task) => task.id === "toolu_sbash").owner).toEqual({ kind: "subagent", id: "toolu_agent", label: "Build the thing" });
  await until(async () => summary(await tasks()).every((row) => row[2] !== "running") || undefined);
  expect(summary(await tasks()).map((row) => row[2])).not.toContain("running");
});

it("keeps a subagent's background work that starts after the reply is done", async () => {
  const { tasks } = await run(`startAgent(); out({type:'result',subtype:'success',is_error:false,result:'Launched.',session_id:'fake'}); setTimeout(startWork, 200); setTimeout(end, 700);`);
  await until(async () => (await tasks()).filter((task) => task.owner).length === 4 || undefined);
  expect(summary(await tasks()).every((row) => row[3] === "Build the thing")).toBe(true);
  await until(async () => summary(await tasks()).every((row) => row[2] !== "running") || undefined);
});

it("leaves the main thread's own background work unowned", async () => {
  const { tasks } = await run(`startAgent(); startWork(); use('toolu_mbash','Bash',{command:'sleep 5',run_in_background:true},null); out({type:'system',subtype:'task_started',task_id:'bmb',run_id:'r9',tool_use_id:'toolu_mbash',description:'main',is_backgrounded:true,task_type:'local_bash'}); out({type:'result',subtype:'success',is_error:false,result:'Launched.',session_id:'fake'});`);
  const main = (await tasks()).find((task) => task.id === "toolu_mbash");
  expect(main.owner).toBeUndefined();
});
