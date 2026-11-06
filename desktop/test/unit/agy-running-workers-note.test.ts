// Math, 2026-11-06 10:23: the Antigravity head was asked "did you really record it?" while the worker it had sent
// to write antigravity_claude_complete_discussion.md was still at work (the file held only its "# Testing write"
// probe). The turn it got carried no word of that worker, and it answered "already written, word for word" with
// no tool call; the report turn of another worker then said "all background agents have stopped".
// Each turn the head sends must name its workers still at work. Offline: no engine process may start.
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const fixture=vi.hoisted(()=>({workers:[] as any[]}));
vi.mock('../../src/core/agent/agy-capabilities',()=>({agyWorkerRuntimeEnabled:()=>true}));
vi.mock('../../src/core/process/tree',async original=>({...await original<any>(),processTreeAdapter:()=>({spawn(){throw Error('Real process spawning forbidden');}})}));
vi.mock('../../src/core/agent/agy-worker-router',()=>({createAgyWorkerHead:(config:any,handlers:any)=>{
 const worker={config,handlers,start(){handlers.onItem({kind:'init',sessionId:config.sessionId});},send(){},answer(){},async terminate(){return {killed:[],forced:false};}};fixture.workers.push(worker);return worker;
}}));
import {AgyAcpHead} from '../../src/core/agent/agy-acp';
const heads:AgyAcpHead[]=[];
afterEach(async()=>{await Promise.all(heads.splice(0).map(h=>h.terminate()));fixture.workers.length=0;});
const settle=()=>new Promise<void>(r=>setImmediate(r));
async function setup(){
 const dir=mkdtempSync(join(tmpdir(),'agy-running-note-')),cwd=join(dir,'workspace'),home=join(dir,'profile');mkdirSync(cwd);mkdirSync(home);
 const prompts:string[]=[];
 const head=new AgyAcpHead({command:'/never-spawned',cwd,acpHome:home,sessionId:'owner',resume:false,canStartReport:()=>true},{onItem(){},onExit(){}});heads.push(head);
 await (head as any).connectTools(cwd,home);
 const bridge=(head as any).bridge;
 (head as any).protocol={send:async(text:string)=>{
   prompts.push(text);
   const match=/task_id="([^"]+)" run="(\d+)"/.exec(text);
   if(match){const args={task_id:match[1],run:Number(match[2]),outcome:'complete',evidence:'fixture report reviewed'};bridge.grant('botling_app_task_checkpoint',args);await bridge.invoke('app_task_checkpoint',args);}
   return true;
 },close(){}};
 const handoff=async(name:string)=>{const args={name,instructions:'offline fixture only'};bridge.grant('botling_app_handoff',args);return (await bridge.invoke('app_handoff',args)).task_id as string;};
 return {head,prompts,handoff};
}

it('a user turn names the workers still at work, so the head does not call their deliverables done',async()=>{
 const h=await setup();
 const writer=await h.handoff('Generate Complete Claude Discussion Markdown');
 h.head.send('claude 的對話你真的有記錄下來嗎？','u1');await settle();
 const turn=h.prompts.at(-1)!;
 expect(turn).toContain('claude 的對話你真的有記錄下來嗎？');
 expect(turn).toContain(`"Generate Complete Claude Discussion Markdown" (task_id ${writer})`);
 expect(turn).toMatch(/still at work/);
});

it('the report turn of one worker names the others still at work; a worker that has reported is not named again',async()=>{
 const h=await setup();
 const synthesis=await h.handoff('Synthesize All Discussions and Pipeline');
 const writer=await h.handoff('Generate Complete Claude Discussion Markdown');
 fixture.workers[0].handlers.onItem({kind:'result',ok:true,text:'synthesis written',error:'',subtype:'end_turn'});await settle();
 await (h.head as any).drain();await settle();
 const report=h.prompts.find(p=>p.includes(`task_id="${synthesis}"`))!;
 expect(report).toContain(`(task_id ${writer})`);
 expect(report).not.toContain(`(task_id ${synthesis})`);
 fixture.workers[1].handlers.onItem({kind:'result',ok:true,text:'discussion written',error:'',subtype:'end_turn'});await settle();
 await (h.head as any).drain();await settle();
 h.head.send('好了嗎','u2');await settle();
 const after=h.prompts.at(-1)!;
 expect(after).toContain('好了嗎');
 expect(after).not.toMatch(/still at work/);
});
