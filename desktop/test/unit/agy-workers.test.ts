import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgyWorkers,type AgyWorkerHead} from '../../src/core/agent/agy-workers';
import type {HeadHandlers} from '../../src/core/agent/head';
import type {AgyConfig} from '../../src/core/agent/agy';
const managers:AgyWorkers[]=[];
const settle=()=>new Promise<void>(r=>setImmediate(r));
afterEach(async()=>{for(const m of managers.splice(0))await m.close();});
function harness(home=mkdtempSync(join(tmpdir(),'botling-agy-workers-')),resume=false){
 const events:any[]=[],reports:any[]=[],starts:{config:AgyConfig,h:HeadHandlers,sent:any[],answers:any[],stopped:boolean,cleanup?:Promise<void>,cleanupError?:boolean}[]=[];
 const m=new AgyWorkers({command:'not-executed',cwd:home,acpHome:home,sessionId:'owner',resume,systemPrompt:'You are the coordinator',workerInstructions:'Execution fixture context'},i=>events.push(i),(id,text)=>reports.push({id,text}),(config,h)=>{
  const state:{config:AgyConfig,h:HeadHandlers,sent:any[],answers:any[],stopped:boolean,cleanup?:Promise<void>,cleanupError?:boolean}={config,h,sent:[],answers:[],stopped:false};starts.push(state);
  const head:AgyWorkerHead={start(){},send(...args){state.sent.push(args);},answer(...args){state.answers.push(args);},async terminate(){state.stopped=true;await state.cleanup;if(state.cleanupError)throw Error("fixture cleanup failed");return {killed:[],forced:false};}};return head;
 });managers.push(m);return {m,events,reports,starts,home};
}
it('worker tools launch only dedicated ACP sessions and forward permission/refusal/report identity',async()=>{
 const h=harness(),accepted=await h.m.tool('app_handoff',{instructions:'research only',name:'probe'});const id=accepted.task_id,w=h.starts[0]!;
 expect(w.config).toMatchObject({worker:true,resume:false});expect(w.config.systemPrompt).toContain('Do not delegate');
 w.h.onItem({kind:'permission',requestId:'acp:1',tool:'write',summary:'write file',input:{path:'x'}});
 expect(h.events.at(-1)).toMatchObject({requestId:`worker:${id}:1:acp:1`,workerId:id});expect(w.answers).toEqual([]);
 h.m.answer(`worker:${id}:1:acp:1`,false,{path:'x'});expect(w.answers[0][1]).toBe(false);
 w.h.onItem({kind:'init',sessionId:'11111111-2222-4333-8444-555555555555'});w.h.onItem({kind:'result',ok:false,text:'operation refused',error:'Antigravity stopped: permission_denied',subtype:'permission_denied'});
 await settle();expect(w.stopped).toBe(true);expect(h.reports[0].id).toBe(id);expect(h.reports[0].text).toContain('not acceptance');expect(h.reports[0].text).toContain('status="failed"');
 h.m.beginReport(id,1);await h.m.tool('app_task_checkpoint',{task_id:id,run:1,outcome:'blocked',evidence:'fixture report reviewed; next authorized step explicit'});await h.m.tool('app_send_message',{task_id:id,run:1,message:'follow up'});expect(h.starts[1]!.config).toMatchObject({resume:true,sessionId:'11111111-2222-4333-8444-555555555555'});
 w.h.onExit({code:0,signal:null,stderr:'',expected:true,silent:false});expect(h.m.running).toEqual([id]);
 h.m.answer(`worker:${id}:1:acp:1`,true,{});expect(h.starts[1]!.answers).toEqual([]);
});
it('stop clears live worker dependencies; restart retains identity without claiming running jobs',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'task'}),w=h.starts[0]!;
 w.h.onItem({kind:'init',sessionId:'11111111-2222-4333-8444-555555555555'});
 expect(h.m.completionDependencies).toHaveLength(1);await expect(h.m.tool('app_send_message',{task_id:a.task_id,run:1,message:'busy'})).rejects.toThrow('busy');
 await h.m.cancel();expect(w.stopped).toBe(true);expect(h.m.completionDependencies).toEqual([]);
 const restored=harness(h.home,true);await restored.m.tool('app_send_message',{task_id:a.task_id,run:1,message:'resume'});expect(restored.starts[0]!.config.resume).toBe(true);
 const newChat=harness(h.home,false);await expect(newChat.m.tool('app_send_message',{task_id:a.task_id,run:1,message:'resume'})).rejects.toThrow('Unknown');
});

it('durably queues correlated reports until the matching run is acknowledged',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'task'}),w=h.starts[0]!;
 w.h.onItem({kind:'init',sessionId:'11111111-2222-4333-8444-555555555555'});
 w.h.onItem({kind:'result',ok:true,text:'verified report',error:'',subtype:'end_turn'});await h.m.close();
 const restored=harness(h.home,true);expect(restored.starts).toEqual([]);expect(restored.reports[0].id).toBe(a.task_id);
 restored.m.finishReport(a.task_id,99,true);expect(restored.m.completionDependencies[0]?.state).toBe('reportQueued');
 expect(restored.m.beginReport(a.task_id,1)).toBe(true);await restored.m.tool('app_task_checkpoint',{task_id:a.task_id,run:1,outcome:'blocked',evidence:'fixture report reviewed; next authorized step explicit'});expect(restored.m.completionDependencies).toEqual([]);
 const again=harness(h.home,true);expect(again.reports).toEqual([]);
});

it('ignores events and approvals after a worker has finished',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'task'}),w=h.starts[0]!;
 w.h.onItem({kind:'result',ok:true,text:'report',error:'',subtype:'end_turn'});
 const count=h.events.length;
 w.h.onItem({kind:'permission',requestId:'late',tool:'write',summary:'late',input:{path:'x'}});
 w.h.onItem({kind:'delta',text:'late output'});
 expect(h.events.length).toBe(count);
 h.m.answer(`worker:${a.task_id}:1:late`,true,{path:'x'});expect(w.answers).toEqual([]);
});
it('cannot overwrite a pending report with a new worker run',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'task'}),w=h.starts[0]!;
 w.h.onItem({kind:'result',ok:true,text:'report',error:'',subtype:'end_turn'});
 await expect(h.m.tool('app_send_message',{task_id:a.task_id,run:1,message:'next'})).rejects.toThrow();
 expect(h.starts).toHaveLength(1);
});
it('approval must belong to this worker run and match its actual pending input',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'A'}),b=await h.m.tool('app_handoff',{instructions:'B'});
 const first=h.starts[0]!,second=h.starts[1]!;
 first.h.onItem({kind:'permission',requestId:'same',tool:'write',summary:'A',input:{path:'a'}});
 second.h.onItem({kind:'permission',requestId:'same',tool:'write',summary:'B',input:{path:'b'}});
 h.m.answer(`worker:${a.task_id}:1:missing`,true,{path:'a'});
 h.m.answer(`worker:${b.task_id}:1:same`,true,{path:'a'});
 expect(first.answers).toEqual([]);expect(second.answers).toEqual([]);
 h.m.answer(`worker:${a.task_id}:1:same`,false,{path:'a'});expect(first.answers).toHaveLength(1);
 h.m.answer(`worker:${a.task_id}:1:same`,true,{path:'a'});expect(first.answers).toHaveLength(1);
});

it('holds concurrency and report delivery until process cleanup finishes',async()=>{
 const h=harness();let clean!:()=>void;
 const a=await h.m.tool('app_handoff',{instructions:'first'}),w=h.starts[0]!;w.cleanup=new Promise<void>(r=>clean=r);
 for(let i=0;i<3;i++)await h.m.tool('app_handoff',{instructions:'other'});
 w.h.onItem({kind:'result',ok:true,text:'report',error:'',subtype:'end_turn'});await settle();
 expect(h.m.running).toHaveLength(4);expect(h.reports).toEqual([]);
 await expect(h.m.tool('app_handoff',{instructions:'fifth'})).resolves.toMatchObject({accepted:true});
 await expect(h.m.tool('app_send_message',{task_id:a.task_id,run:1,message:'race'})).rejects.toThrow('busy');
 clean();await settle();expect(h.reports).toHaveLength(1);expect(h.m.running).toHaveLength(4);
 expect(h.m.beginReport(a.task_id,2)).toBe(false);expect(h.m.beginReport(a.task_id,1)).toBe(true);expect(h.m.beginReport(a.task_id,1)).toBe(false);
 await h.m.tool('app_task_checkpoint',{task_id:a.task_id,run:1,outcome:'blocked',evidence:'fixture report reviewed; next authorized step explicit'});await h.m.tool('app_handoff',{instructions:'sixth'});
 await h.m.tool('app_cancel_task',{task_id:h.m.running[0],run:1});
 await h.m.tool('app_send_message',{task_id:a.task_id,run:1,message:'next'});
 await expect(h.m.tool('app_cancel_task',{task_id:a.task_id,run:1})).rejects.toThrow('Stale');
 w.h.onItem({kind:'permission',requestId:'stale',tool:'write',summary:'old run',input:{}});
 expect(h.events.some(e=>e.requestId?.endsWith(':stale'))).toBe(false);expect(()=>w.config.processStarted?.(0)).toThrow('Stale');
});
it('a cleanup failure is never reported as success or released for continuation',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'task'}),w=h.starts[0]!;w.cleanupError=true;
 w.h.onItem({kind:'result',ok:true,text:'done',error:'',subtype:'end_turn'});await settle();
 expect(h.reports[0].text).toContain('status="cleanup-failed"');expect(h.m.running).toEqual([a.task_id]);
 expect(h.m.beginReport(a.task_id,1)).toBe(false);
 await expect(h.m.tool('app_cancel_task',{task_id:a.task_id,run:1})).rejects.toThrow('cleanup incomplete');
 await expect(h.m.tool('app_send_message',{task_id:a.task_id,run:1,message:'next'})).rejects.toThrow('busy');
 w.cleanupError=false;await h.m.cancel();
});
it('uncertain report delivery is not replayed after restart and foreign owners are rejected',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'task'}),w=h.starts[0]!;
 w.h.onItem({kind:'result',ok:true,text:'report',error:'',subtype:'end_turn'});await settle();expect(h.m.beginReport(a.task_id,1)).toBe(true);await h.m.close();
 const restored=harness(h.home,true);expect(restored.reports).toEqual([]);expect(restored.starts).toEqual([]);expect(restored.m.beginReport(a.task_id,1)).toBe(false);
 await expect(restored.m.tool('app_send_message',{task_id:a.task_id,run:1,message:'retry'})).rejects.toThrow('acknowledged');
 const path=join(h.home,'workers.json'),saved=JSON.parse(readFileSync(path,'utf8'));saved.ownerSessionId='different';writeFileSync(path,JSON.stringify(saved));
 expect(()=>harness(h.home,true)).toThrow('another conversation');
});
it('crashed active state restores identity but cannot resume before cleanup reconciliation',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'task'}),w=h.starts[0]!;
 w.h.onItem({kind:'init',sessionId:'11111111-2222-4333-8444-555555555555'});
 const restored=harness(h.home,true);expect(restored.starts).toEqual([]);expect(restored.reports[0].text).toContain('interrupted');
 expect(restored.m.beginReport(a.task_id,1)).toBe(true);await restored.m.tool('app_task_checkpoint',{task_id:a.task_id,run:1,outcome:'blocked',evidence:'fixture report reviewed; next authorized step explicit'});
 await expect(restored.m.tool('app_send_message',{task_id:a.task_id,run:1,message:'resume'})).rejects.toThrow('cleanup');
 await expect(restored.m.close()).rejects.toThrow('cleanup');managers.splice(managers.indexOf(restored.m),1);
});
it('denial remains failed even if a worker incorrectly emits successful completion',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'task'}),w=h.starts[0]!;
 w.h.onItem({kind:'permission',requestId:'p',tool:'write',summary:'write',input:{path:'x'}});h.m.answer(`worker:${a.task_id}:1:p`,false,{path:'x'});
 w.h.onItem({kind:'result',ok:true,text:'done',error:'',subtype:'end_turn'});await settle();expect(h.reports[0].text).toContain('status="failed"');
});

it('a failed tool call that was not an approval denial does not fail a worker that completes',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'task'}),w=h.starts[0]!;
 w.h.onItem({kind:'toolUse',id:'t1',tool:'Bash',title:'git status',detail:'git status',input:{}} as any);
 w.h.onItem({kind:'toolResult',id:'t1',output:'fatal: not a git repository',failed:true} as any);
 w.h.onItem({kind:'result',ok:true,text:'report written',error:'',subtype:'end_turn'});await settle();
 expect(h.reports[0].text).toContain('status="completed"');expect(h.reports[0].text).not.toContain('blocked by denied');expect(a.task_id).toBeTruthy();
});

it('cleans real owned process groups and verifies reconstructed-manager recovery before resume',async()=>{
 const {processTreeAdapter}=await import('../../src/core/process/tree');
 const home=mkdtempSync(join(tmpdir(),'agy-worker-process-')),reports:any[]=[],groups:any[]=[];
 const make=(resume:boolean)=>{
  const manager=new AgyWorkers({command:'no-agent',cwd:home,acpHome:home,sessionId:'owner',resume},()=>{},(id,text,run)=>reports.push({id,text,run}),(config,handlers)=>{
   const own:any[]=[];
   return {start(){for(let i=0;i<2;i++){const p=processTreeAdapter().spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:home,env:{PATH:process.env.PATH}});own.push(p);groups.push(p);config.processStarted?.(p.pid);}handlers.onItem({kind:'init',sessionId:'11111111-2222-4333-8444-555555555555'});},send(){},answer(){},async terminate(){await Promise.all(own.map(p=>p.terminate({graceMs:50})));return {killed:[],forced:false};}};
  });managers.push(manager);return manager;
 };
 const m=make(false);
 try{
  const a=await m.tool('app_handoff',{instructions:'offline protocol fixture'});const restored=make(true);
  expect(restored.beginReport(a.task_id,1)).toBe(true);await restored.tool('app_task_checkpoint',{task_id:a.task_id,run:1,outcome:'blocked',evidence:'fixture report reviewed; next authorized step explicit'});
  await expect(restored.tool('app_send_message',{task_id:a.task_id,run:1,message:'resume'})).rejects.toThrow('cleanup');
  // The original app-owned manager stops both its server-shaped and tool-shaped groups.
  await m.cancel();for(const p of groups)expect(()=>process.kill(-p.pid,0)).toThrow();
  const resumed=await restored.tool('app_send_message',{task_id:a.task_id,run:1,message:'explicit continuation'});expect(resumed.run).toBe(2);
  await restored.cancel();for(const p of groups)expect(()=>process.kill(-p.pid,0)).toThrow();
 }finally{await Promise.all(groups.map(p=>p.terminate({graceMs:50})));}
});
it('cancel closes pending approval cards and stale answers cannot reach the stopped worker',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'task'}),w=h.starts[0]!;
 w.h.onItem({kind:'permission',requestId:'p',tool:'write',summary:'write',input:{}});
 await h.m.tool('app_cancel_task',{task_id:a.task_id,run:1});
 expect(h.events.some(e=>e.kind==='permissionCancelled'&&e.requestId===`worker:${a.task_id}:1:p`)).toBe(true);
 h.m.answer(`worker:${a.task_id}:1:p`,true,{});expect(w.answers).toEqual([]);expect(h.m.completionDependencies).toEqual([]);
});
// Replay "Build resume PDF": `which xelatex pdflatex lualatex tectonic` exited 1 and `git status` 128 on the
// way to a valid PDF; the head ended the turn normally but reported it as tool_failed, and the card said Failed.
it('a worker whose turn ended normally after failed tool calls is completed, not failed',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'Compile the LaTeX attachment into a PDF'}),w=h.starts[0]!;
 w.h.onItem({kind:'toolUse',id:'t1',tool:'other',title:'botling_run_command',detail:'which xelatex pdflatex lualatex tectonic',input:{}} as any);
 w.h.onItem({kind:'toolResult',id:'t1',output:'{"exitCode":1,"output":"/opt/homebrew/bin/pdflatex\\n"}',failed:true} as any);
 w.h.onItem({kind:'toolUse',id:'t2',tool:'other',title:'botling_run_command',detail:'git status --short',input:{}} as any);
 w.h.onItem({kind:'toolResult',id:'t2',output:'{"exitCode":128,"output":"fatal: not a git repository"}',failed:true} as any);
 w.h.onItem({kind:'result',ok:false,text:'### Execution Report\n\n**Status:** Completed successfully',error:'Antigravity stopped: tool_failed',subtype:'tool_failed'});await settle();
 expect(h.events.find(e=>e.kind==='subagentEnded'&&e.id===a.task_id)).toMatchObject({status:'completed'});
 expect(h.reports[0].text).toContain('status="completed"');expect(h.reports[0].text).toContain('Completed successfully');
});

it('a worker that stopped early, was cancelled or wrote no report after a failed tool is still failed',async()=>{
 for(const [subtype,text] of [['max_tokens','partial report'],['cancelled','partial report'],['permission_denied','partial report'],['tool_failed','  ']]){
  const h=harness(),a=await h.m.tool('app_handoff',{instructions:'task'}),w=h.starts[0]!;
  w.h.onItem({kind:'result',ok:false,text,error:`Antigravity stopped: ${subtype}`,subtype});await settle();
  expect(h.events.find(e=>e.kind==='subagentEnded'&&e.id===a.task_id),subtype).toMatchObject({status:'failed'});
 }
});

it('worker crash produces one failed report only after cleanup',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'task'}),w=h.starts[0]!;let clean!:()=>void;w.cleanup=new Promise<void>(r=>clean=r);
 w.h.onExit({code:1,signal:null,stderr:'fixture crashed',expected:false,silent:false});await settle();expect(h.reports).toEqual([]);
 clean();await settle();expect(h.reports).toHaveLength(1);expect(h.reports[0].text).toContain('status="failed"');
 w.h.onExit({code:1,signal:null,stderr:'late exit',expected:false,silent:false});await settle();expect(h.reports).toHaveLength(1);expect(h.m.completionDependencies[0]).toMatchObject({id:a.task_id,run:1,state:'reportQueued'});
});

it('keeps coordinator instructions out of execution workers',async()=>{
 const h=harness();await h.m.tool('app_handoff',{instructions:'research only'});
 expect(h.starts[0]!.config.systemPrompt).toContain('research/design-only');
 expect(h.starts[0]!.config.systemPrompt).toContain('Execution fixture context');
 expect(h.starts[0]!.config.systemPrompt).not.toContain('You are the coordinator');
});
it('requires a task/run checkpoint or same-task continuation, not mere report delivery',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'research only'});
 h.starts[0]!.h.onItem({kind:'result',ok:true,text:'evidence',error:'',subtype:'end_turn'});await settle();
 expect(h.m.beginReport(a.task_id,1)).toBe(true);
 await expect(h.m.tool('app_task_checkpoint',{task_id:a.task_id,run:2,outcome:'complete',evidence:'wrong run'})).rejects.toThrow('Stale');
 await expect(h.m.tool('app_task_checkpoint',{task_id:a.task_id,run:1,outcome:'complete',evidence:''})).rejects.toThrow();
 await h.m.tool('app_handoff',{instructions:'independent'});
 expect(h.m.completionDependencies.some(x=>x.id===a.task_id)).toBe(true);
 await h.m.tool('app_task_checkpoint',{task_id:a.task_id,run:1,outcome:'complete',evidence:'research findings satisfy scope; no implementation authorized'});
 expect(h.m.completionDependencies.some(x=>x.id===a.task_id)).toBe(false);
});
it('continues the same task during its report turn and rejects stale checkpoint',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'research'});
 h.starts[0]!.h.onItem({kind:'result',ok:true,text:'one missing fact',error:'',subtype:'end_turn'});await settle();
 expect(h.m.beginReport(a.task_id,1)).toBe(true);
 const next=await h.m.tool('app_send_message',{task_id:a.task_id,run:1,message:'same scope: supply missing fact'});
 expect(next).toMatchObject({task_id:a.task_id,run:2});
 await expect(h.m.tool('app_task_checkpoint',{task_id:a.task_id,run:1,outcome:'complete',evidence:'stale'})).rejects.toThrow('Stale');
});
it('allows one reconciliation turn then retains unresolved evidence without looping',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'research'});
 h.starts[0]!.h.onItem({kind:'result',ok:true,text:'report',error:'',subtype:'end_turn'});await settle();
 h.m.beginReport(a.task_id,1);h.m.finishReport(a.task_id,1,true);
 expect(h.reports).toHaveLength(2);expect(h.m.beginReport(a.task_id,1)).toBe(true);
 h.m.finishReport(a.task_id,1,true);
 expect(h.reports).toHaveLength(2);expect(h.m.beginReport(a.task_id,1)).toBe(false);
 expect(h.m.completionDependencies).toHaveLength(1);
 expect(h.events.some(e=>e.summary?.includes('unresolved'))).toBe(true);
 await h.m.close();const restored=harness(h.home,true);
 expect(restored.reports).toEqual([]);expect(restored.m.completionDependencies).toHaveLength(1);
 await restored.m.tool('app_task_checkpoint',{task_id:a.task_id,run:1,outcome:'blocked',evidence:'missing acceptance evidence; authorized alternatives exhausted'});
 expect(restored.m.completionDependencies).toEqual([]);
});
it('requires an active other task for a dependency checkpoint',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'research'});
 h.starts[0]!.h.onItem({kind:'result',ok:true,text:'report',error:'',subtype:'end_turn'});await settle();h.m.beginReport(a.task_id,1);
 await expect(h.m.tool('app_task_checkpoint',{task_id:a.task_id,run:1,outcome:'waiting_dependency',evidence:'missing',dependency_task_id:a.task_id})).rejects.toThrow();
 const b=await h.m.tool('app_handoff',{instructions:'separate authorized prerequisite'});
 await h.m.tool('app_task_checkpoint',{task_id:a.task_id,run:1,outcome:'waiting_dependency',evidence:'await prerequisite',dependency_task_id:b.task_id});
 expect(h.m.completionDependencies.map(x=>x.id)).toEqual([b.task_id]);
});
it('treats a blank or null dependency_task_id on a non-dependency checkpoint as omitted',async()=>{
 for(const blank of ['',' ',null]){
  const h=harness(),a=await h.m.tool('app_handoff',{instructions:'read-only status'});
  h.starts[0]!.h.onItem({kind:'result',ok:true,text:'report',error:'',subtype:'end_turn'});await settle();h.m.beginReport(a.task_id,1);
  await h.m.tool('app_task_checkpoint',{task_id:a.task_id,run:1,outcome:'complete',evidence:'status report satisfies the read-only request',dependency_task_id:blank});
  expect(h.m.completionDependencies.some(x=>x.id===a.task_id)).toBe(false);
 }
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'read-only status'});
 h.starts[0]!.h.onItem({kind:'result',ok:true,text:'report',error:'',subtype:'end_turn'});await settle();h.m.beginReport(a.task_id,1);
 await expect(h.m.tool('app_task_checkpoint',{task_id:a.task_id,run:1,outcome:'complete',evidence:'x',dependency_task_id:'some-id'})).rejects.toThrow('requires waiting_dependency');
 await expect(h.m.tool('app_task_checkpoint',{task_id:a.task_id,run:1,outcome:'waiting_dependency',evidence:'x',dependency_task_id:''})).rejects.toThrow('dependency_task_id');
});
it('stale or duplicate report-turn completion cannot consume another run or exhaust reconciliation',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'task'});
 h.starts[0]!.h.onItem({kind:'result',ok:true,text:'report',error:'',subtype:'end_turn'});await settle();
 h.m.beginReport(a.task_id,1);h.m.finishReport(a.task_id,99,true);
 await h.m.tool('app_send_message',{task_id:a.task_id,run:1,message:'same scope'});
 h.starts[1]!.h.onItem({kind:'result',ok:true,text:'next',error:'',subtype:'end_turn'});await settle();
 h.m.beginReport(a.task_id,2);h.m.finishReport(a.task_id,1,true);
 h.m.finishReport(a.task_id,2,true);h.m.finishReport(a.task_id,2,true);
 expect(h.reports).toHaveLength(3);expect(h.m.beginReport(a.task_id,2)).toBe(true);
});
it('uncertain-delivery acknowledgement is not task acceptance and cannot bypass a checkpoint',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'research only'});
 h.starts[0]!.h.onItem({kind:'result',ok:true,text:'report',error:'',subtype:'end_turn'});await settle();h.m.beginReport(a.task_id,1);
 await expect(h.m.tool('app_reconcile_report',{task_id:a.task_id,run:1,action:'acknowledge'})).rejects.toThrow('active');
 h.m.finishReport(a.task_id,1,false);
 await expect(h.m.tool('app_task_checkpoint',{task_id:a.task_id,run:1,outcome:'complete',evidence:'not confirmed'})).rejects.toThrow('delivered');
 await h.m.tool('app_reconcile_report',{task_id:a.task_id,run:1,action:'acknowledge'});
 expect(h.m.completionDependencies).toHaveLength(1);
 const reconstructed=harness(h.home,true);expect(reconstructed.reports).toEqual([]);expect(reconstructed.m.completionDependencies).toHaveLength(1);
 await h.m.tool('app_task_checkpoint',{task_id:a.task_id,run:1,outcome:'waiting_user',evidence:'Need explicit implementation authorization; research complete'});
 expect(h.m.completionDependencies).toEqual([]);
 const persisted=JSON.parse(readFileSync(join(h.home,'workers.json'),'utf8'));
 expect(persisted.workers[0].checkpoint).toMatchObject({outcome:'waiting_user'});
});

it('retains the recovery obligation after checkpoint while a reconstructed process group is live',async()=>{
 const {processTreeAdapter}=await import('../../src/core/process/tree');
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'task'});
 const processGroup=processTreeAdapter().spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:h.home,env:{PATH:process.env.PATH}});
 let restored:ReturnType<typeof harness>|undefined;
 try{
  h.starts[0]!.config.processStarted?.(processGroup.pid);
  h.starts[0]!.h.onItem({kind:'init',sessionId:'11111111-2222-4333-8444-555555555555'});
  restored=harness(h.home,true);
  expect(restored.m.beginReport(a.task_id,1)).toBe(true);
  await restored.m.tool('app_task_checkpoint',{task_id:a.task_id,run:1,outcome:'blocked',evidence:'execution interrupted; cleanup remains unverified'});
  expect(restored.m.running).toEqual([a.task_id]);
  expect(restored.m.completionDependencies).toMatchObject([{id:a.task_id,state:'running'}]);
  for(let i=0;i<3;i++)await restored.m.tool('app_handoff',{instructions:'independent'});
  await expect(restored.m.tool('app_cancel_task',{task_id:a.task_id,run:1})).rejects.toThrow('cleanup');
  expect(restored.m.completionDependencies.some(d=>d.id===a.task_id)).toBe(true);
  await processGroup.terminate({graceMs:50});
  await restored.m.tool('app_cancel_task',{task_id:a.task_id,run:1});
  expect(restored.m.running).not.toContain(a.task_id);
  expect(restored.m.completionDependencies.some(d=>d.id===a.task_id)).toBe(false);
 }finally{await processGroup.terminate({graceMs:50});}
});
it('retains the recovery obligation with missing process registration and refuses cancellation',async()=>{
 const h=harness();for(let i=0;i<4;i++)await h.m.tool('app_handoff',{instructions:'crash before registration'});
 const restored=harness(h.home,true),id=h.m.running[0]!;
 try{
  expect(restored.m.beginReport(id,1)).toBe(true);
  await restored.m.tool('app_task_checkpoint',{task_id:id,run:1,outcome:'complete',evidence:'assessment does not prove process cleanup'});
  expect(restored.m.running).toHaveLength(4);expect(restored.m.completionDependencies).toHaveLength(4);
  await expect(restored.m.tool('app_cancel_task',{task_id:id,run:1})).rejects.toThrow('cleanup');
  await expect(restored.m.tool('app_send_message',{task_id:id,run:1,message:'continue'})).rejects.toThrow('cleanup');
  await expect(restored.m.close()).rejects.toThrow('cleanup');
  expect(restored.m.completionDependencies).toHaveLength(4);
 }finally{managers.splice(managers.indexOf(restored.m),1);}
});

it('has no concurrent worker cap: 6 workers start and a resume succeeds with 5 running',async()=>{
 const h=harness(),ids:string[]=[];
 for(let i=0;i<6;i++)ids.push((await h.m.tool('app_handoff',{instructions:`task ${i}`})).task_id);
 expect(h.m.running).toHaveLength(6);expect(h.starts).toHaveLength(6);
 const w=h.starts[0]!;w.h.onItem({kind:'init',sessionId:'11111111-2222-4333-8444-555555555555'});w.h.onItem({kind:'result',ok:true,text:'report',error:'',subtype:'end_turn'});await settle();
 expect(h.m.running).toHaveLength(5);h.m.beginReport(ids[0],1);
 await h.m.tool('app_task_checkpoint',{task_id:ids[0],run:1,outcome:'blocked',evidence:'fixture report reviewed; next authorized step explicit'});
 await expect(h.m.tool('app_send_message',{task_id:ids[0],run:1,message:'again'})).resolves.toMatchObject({accepted:true});
 expect(h.m.running).toHaveLength(6);
});
