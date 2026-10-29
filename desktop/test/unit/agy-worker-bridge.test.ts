// Production connection code, offline worker factories; no engine process may start.
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const fixture=vi.hoisted(()=>({workers:[] as any[]}));
vi.mock('../../src/core/agent/agy-capabilities',()=>({agyWorkerRuntimeEnabled:()=>true,agyMixedRuntimeEnabled:()=>true,agyPairAllowed:()=>false}));
vi.mock('../../src/core/process/tree',async original=>({...await original<any>(),processTreeAdapter:()=>({spawn(){throw Error('Real process spawning forbidden');}})}));
vi.mock('../../src/core/agent/agy-worker-router',()=>({createAgyWorkerHead:(config:any,handlers:any)=>{
 const worker={config,handlers,answers:[] as any[],stopped:false,start(){handlers.onItem({kind:'init',sessionId:config.sessionId});},send(){},answer(...args:any[]){this.answers.push(args);},async terminate(){this.stopped=true;return {killed:[],forced:false};}};fixture.workers.push(worker);return worker;
}}));
import {AgyAcpHead} from '../../src/core/agent/agy-acp';
const heads:AgyAcpHead[]=[];
afterEach(async()=>{await Promise.all(heads.splice(0).map(h=>h.terminate()));fixture.workers.length=0;});
const settle=()=>new Promise<void>(r=>setImmediate(r));
async function setup(worker=false){
 const dir=mkdtempSync(join(tmpdir(),'agy-bridge-offline-')),cwd=join(dir,'workspace'),home=join(dir,'profile');mkdirSync(cwd);mkdirSync(home);
 const events:any[]=[],prompts:string[]=[],acknowledged:{available:boolean,ok:boolean,decide:boolean}={available:false,ok:true,decide:true};
 const head=new AgyAcpHead({command:'/never-spawned',cwd,acpHome:home,sessionId:'owner',resume:false,worker,canStartReport:()=>acknowledged.available},{onItem:i=>events.push(i),onExit(){}});heads.push(head);
 await (head as any).connectTools(cwd,home);
 (head as any).protocol={send:async(text:string)=>{
   prompts.push(text);
   if(acknowledged.ok&&acknowledged.decide){const match=/task_id="([^"]+)" run="(\d+)"/.exec(text);if(match){
     const args={task_id:match[1],run:Number(match[2]),outcome:'blocked',evidence:'fixture report reviewed; refusal preserved'};
     (head as any).bridge.grant('botling_app_task_checkpoint',args);
     await (head as any).bridge.invoke('app_task_checkpoint',args);
   }}
   return acknowledged.ok;
 },close(){}};
 return {head,bridge:(head as any).bridge,events,prompts,acknowledged};
}
it('connects both worker engines through exact grants and owner-specific cards, then correlates the report',async()=>{
 const h=await setup(),args={engine:'codex',instructions:'offline fixture only'};
 await expect(h.bridge.invoke('app_handoff',args)).rejects.toThrow('No matching');expect(fixture.workers).toHaveLength(0);
 h.bridge.grant('botling_app_handoff',args);const task=await h.bridge.invoke('app_handoff',args);expect(fixture.workers[0].config.workerEngine).toBe('codex');
 const child=fixture.workers[0];child.handlers.onItem({kind:'permission',requestId:'p',tool:'write',summary:'fixture',input:{path:'x'}});
 const card=h.events.findLast(e=>e.kind==='permission');expect(card.workerId).toBe(task.task_id);h.head.answer(card.requestId,false,{path:'x'});expect(child.answers[0][1]).toBe(false);
 child.handlers.onItem({kind:'result',ok:true,text:'must stay failed',error:'',subtype:'end_turn'});await settle();expect(h.prompts).toEqual([]);expect(h.head.completionDependencies).toHaveLength(1);
 h.acknowledged.available=true;await (h.head as any).drain();await settle();
 expect(h.prompts[0]).toContain(`task_id="${task.task_id}" run="1" engine="codex" status="failed"`);expect(h.head.completionDependencies).toEqual([]);expect(child.stopped).toBe(true);
});
it('uncertain report reconciliation requires a separate exact approval and never replays the worker task',async()=>{
 const h=await setup(),args={instructions:'offline'},task=await(async()=>{h.bridge.grant('botling_app_handoff',args);return h.bridge.invoke('app_handoff',args);})();
 fixture.workers[0].handlers.onItem({kind:'result',ok:true,text:'report',error:'',subtype:'end_turn'});await settle();h.acknowledged.available=true;h.acknowledged.ok=false;await (h.head as any).drain();await settle();
 const reconcile={task_id:task.task_id,run:1,action:'retry'};
 await expect(h.bridge.invoke('app_reconcile_report',reconcile)).rejects.toThrow('No matching');expect(h.prompts).toHaveLength(1);
 h.bridge.grant('botling_app_reconcile_report',reconcile);h.acknowledged.ok=true;const result=await h.bridge.invoke('app_reconcile_report',reconcile);await settle();
 expect(result.taskReplayed).toBe(false);expect(fixture.workers).toHaveLength(1);expect(h.prompts).toHaveLength(2);expect(h.head.completionDependencies).toEqual([]);
});
it('worker profiles expose no nested worker transport even with fixture capability gates',async()=>{
 const h=await setup(true);expect(h.bridge.tools.map((t:any)=>t.name)).toEqual(['read_file','write_file','run_command']);
 h.bridge.grant('botling_app_handoff',{instructions:'forbidden'});await expect(h.bridge.invoke('app_handoff',{instructions:'forbidden'})).rejects.toThrow('Unsupported');expect(fixture.workers).toEqual([]);
});

it('coordinator exposes delegation only and checkpoint needs its own exact grant',async()=>{
 const h=await setup();expect(h.bridge.tools.map((t:any)=>t.name)).not.toContain('run_command');
 const args={instructions:'research only'};h.bridge.grant('botling_app_handoff',args);
 const a=await h.bridge.invoke('app_handoff',args);
 fixture.workers[0].handlers.onItem({kind:'result',ok:true,text:'research result',error:'',subtype:'end_turn'});await settle();
 const decision={task_id:a.task_id,run:1,outcome:'complete',evidence:'research accepted'};
 await expect(h.bridge.invoke('app_task_checkpoint',decision)).rejects.toThrow('No matching');
 expect(h.head.completionDependencies).toHaveLength(1);
});

it('report scheduling gives one reconciliation and retains an unresolved report',async()=>{
 const h=await setup(),args={instructions:'research only'};h.bridge.grant('botling_app_handoff',args);
 const a=await h.bridge.invoke('app_handoff',args);h.acknowledged.decide=false;
 fixture.workers[0].handlers.onItem({kind:'result',ok:true,text:'evidence only',error:'',subtype:'end_turn'});await settle();
 h.acknowledged.available=true;await (h.head as any).drain();await settle();
 expect(h.prompts).toHaveLength(2);expect(h.head.completionDependencies).toMatchObject([{id:a.task_id,run:1}]);
 expect(h.events.some(e=>e.summary?.includes('unresolved'))).toBe(true);
});
it('the report turn can continue its own task through the approval-bound bridge',async()=>{
 const h=await setup(),args={instructions:'research only'};h.bridge.grant('botling_app_handoff',args);
 const a=await h.bridge.invoke('app_handoff',args);
 (h.head as any).protocol.send=async()=>{
  const next={task_id:a.task_id,run:1,message:'same research scope: missing evidence'};
  await expect(h.bridge.invoke('app_send_message',next)).rejects.toThrow('No matching');
  h.bridge.grant('botling_app_send_message',next);
  expect(await h.bridge.invoke('app_send_message',next)).toMatchObject({task_id:a.task_id,run:2});return true;
 };
 fixture.workers[0].handlers.onItem({kind:'result',ok:true,text:'partial research',error:'',subtype:'end_turn'});await settle();
 h.acknowledged.available=true;await (h.head as any).drain();await settle();
 expect(fixture.workers).toHaveLength(2);expect(h.head.completionDependencies).toMatchObject([{id:a.task_id,run:2,state:'running'}]);
});
