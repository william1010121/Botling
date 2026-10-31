import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const session = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : '11111111-2222-4333-8444-555555555555';
const emit = e => process.stdout.write(JSON.stringify(e) + '\n');
if (process.env.FAKE_AGY_INPUT) appendFileSync(process.env.FAKE_AGY_INPUT, JSON.stringify({ args }) + '\n');
if (process.env.FAKE_AGY_SILENT === '1') process.exit(1);
let init = false, step = 0;
for await (const line of createInterface({input: process.stdin})) {
 const event = JSON.parse(line);
 if (process.env.FAKE_AGY_INPUT) appendFileSync(process.env.FAKE_AGY_INPUT, line + '\n');
 if (event.event !== 'user') process.exit(2);
 if (!init) { emit({event:'init',conversation_id:session,init:{permission_mode:process.env.FAKE_AGY_MODE ?? 'request-review'}}); init=true; }
 const prompt=event.message.content;
 if (prompt.includes('AGY_HANG')) await new Promise(()=>{setInterval(()=>{},1000);});
 const response=prompt.includes('AGY_ERROR')||prompt.includes('AGY_DENIED')?'':prompt.includes('AGY_DELEGATE')?'<new-bot name="unsafe-fallback">Do work</new-bot>':'AGY_REPLY';
 emit({event:'step_update',step_update:{conversation_id:session,step_index:step++,state:'DONE',step_type:'agent_response',text_delta:response}});
 emit({event:'result',result:{conversation_id:session,status:prompt.includes('AGY_ERROR')?'ERROR':'SUCCESS',response,denied_actions:prompt.includes('AGY_DENIED')?[{action:'command',display_name:'RunCommand'}]:undefined,error:prompt.includes('AGY_ERROR')?'model unavailable':undefined}});
}
