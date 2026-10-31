import { afterEach, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

let core: CoreHarness | undefined;
afterEach(async () => { await core?.kill("SIGKILL"); core = undefined; });

// The event shapes are copied from a real `claude -p --output-format stream-json --verbose` run (2.1.311).
for (const partner of [false, true]) it(`keeps a background command, a Monitor, a wake-up and a cron job in the reply that started them${partner ? " (Claude as the second head)" : ""}`, async () => {
  const dir = tempDir("background-claude-shapes"), cli = join(dir, "claude.mjs");
  if (partner) {
    mkdirSync(join(dir, "main"), { recursive: true });
    writeFileSync(join(dir, "main", "bot.json"), JSON.stringify({ engine: "codex", heads: { engines: ["codex", "claude"], answerWith: "claude" } }));
  }
  writeFileSync(cli, `import {createInterface} from 'node:readline';
const out = value => process.stdout.write(JSON.stringify(value)+'\\n');
const use = (id, name, input) => out({type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id,name,input,caller:{type:'direct'}}]},parent_tool_use_id:null});
const result = (id, content, tool_use_result) => out({type:'user',message:{role:'user',content:[{tool_use_id:id,type:'tool_result',content,is_error:false}]},parent_tool_use_id:null,tool_use_result});
createInterface({input:process.stdin}).on('line', () => {
 out({type:'system',subtype:'init',session_id:'fake'});
 use('toolu_wake','ScheduleWakeup',{delaySeconds:300,reason:'probe',prompt:'probe',noop:false});
 result('toolu_wake','Next wakeup scheduled for 18:36:00 (in 264s).',{scheduledFor:Date.now()+300000,clampedDelaySeconds:300,wasClamped:false});
 use('toolu_cron','CronCreate',{cron:'7 * * * *',prompt:'probe',recurring:true});
 result('toolu_cron','Scheduled recurring job 9d93dfa3',{id:'9d93dfa3',humanSchedule:'Every hour at :07',recurring:true,durable:false,nextFireAt:Date.now()+3600000.7192});
 use('toolu_mon','Monitor',{command:'sleep 30; echo hi',description:'probe monitor',timeout_ms:300000});
 out({type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'bmon',run_id:'r1',task_type:'local_bash',description:'probe monitor'}]});
 out({type:'system',subtype:'task_started',task_id:'bmon',run_id:'r1',tool_use_id:'toolu_mon',description:'probe monitor',is_backgrounded:true,task_type:'local_bash'});
 result('toolu_mon','Monitor started (task bmon)',{taskId:'bmon',timeoutMs:300000,persistent:false});
 use('toolu_bash','Bash',{command:'sleep 20',description:'Sleep for 20 seconds',run_in_background:true});
 out({type:'system',subtype:'task_started',task_id:'bbash',run_id:'r2',tool_use_id:'toolu_bash',description:'Sleep for 20 seconds',is_backgrounded:true,task_type:'local_bash'});
 result('toolu_bash','Command running in background with ID: bbash. Output is being written to: /tmp/x/bbash.output.',{stdout:'',stderr:'',interrupted:false,backgroundTaskId:'bbash'});
 out({type:'result',subtype:'success',is_error:false,result:'Started everything.',session_id:'fake'});
});`);
  core = new CoreHarness(dir, { BOTLING_FAKE_CLI: cli });
  const { turnId } = await core.call({ type: "chat.send", botId: MAIN, text: "go" });
  await until(() => core!.of("turn.finished").find((entry) => entry.event.type === "turn.finished" && entry.event.turnId === turnId));
  const reply = (await core.chat()).messages.find((message: any) => message.turnId === turnId);
  expect(reply.backgroundTasks.map((task: any) => [task.id, task.kind, task.status]).sort()).toEqual([
    ["toolu_bash", "command", "running"], ["toolu_cron", "cron", "running"], ["toolu_mon", "monitor", "running"], ["toolu_wake", "wakeup", "running"]]);
});

// A command that outlives Bash's 120 s timeout is moved to the background by claude: `task_started` said
// `is_backgrounded: false`, then only `task_updated` (patch) and the tool result (`backgroundTaskId`,
// `timedOutAfterMs`) say so. Real events, claude 2.1.311.
it("keeps a command claude moved to the background after its timeout, and ends it with its notification", async () => {
  const dir = tempDir("background-claude-auto"), cli = join(dir, "claude.mjs");
  writeFileSync(cli, `import {createInterface} from 'node:readline';
const out = value => process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line', () => {
 out({type:'system',subtype:'init',session_id:'fake'});
 out({type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'toolu_slow',name:'Bash',input:{command:'python3 -c "import time; time.sleep(135)"',description:'Sleep 135 seconds then print done'},caller:{type:'direct'}}]},parent_tool_use_id:null});
 out({type:'system',subtype:'task_started',task_id:'bslow',run_id:'r1',tool_use_id:'toolu_slow',description:'Sleep 135 seconds then print done',is_backgrounded:false,task_type:'local_bash'});
 out({type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'bslow',run_id:'r1',task_type:'local_bash',description:'Sleep 135 seconds then print done'}]});
 out({type:'system',subtype:'task_updated',task_id:'bslow',run_id:'r1',patch:{is_backgrounded:true}});
 out({type:'user',message:{role:'user',content:[{tool_use_id:'toolu_slow',type:'tool_result',content:'Command did not complete within its 120s timeout and was moved to the background (ID: bslow).',is_error:false}]},parent_tool_use_id:null,tool_use_result:{stdout:'',stderr:'',interrupted:false,noOutputExpected:false,backgroundTaskId:'bslow',timedOutAfterMs:120000}});
 out({type:'result',subtype:'success',is_error:false,result:'Moved to the background.',session_id:'fake'});
 setTimeout(() => out({type:'system',subtype:'task_notification',task_id:'bslow',run_id:'r1',tool_use_id:'toolu_slow',status:'completed',output_file:'',summary:'Background command "Sleep" completed (exit code 0)'}), 300);
});`);
  core = new CoreHarness(dir, { BOTLING_FAKE_CLI: cli });
  const { turnId } = await core.call({ type: "chat.send", botId: MAIN, text: "go" });
  await until(() => core!.of("turn.finished").find((entry) => entry.event.type === "turn.finished" && entry.event.turnId === turnId));
  const find = async () => (await core!.chat()).messages.find((message: any) => message.turnId === turnId);
  expect((await find()).backgroundTasks).toEqual([expect.objectContaining({ id: "toolu_slow", kind: "command" })]);
  await until(async () => (await find()).backgroundTasks?.[0]?.status === "completed" || undefined);
});
