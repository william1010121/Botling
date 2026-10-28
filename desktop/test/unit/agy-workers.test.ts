import {afterEach,expect,it} from 'vitest';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgyWorkers,type AgyWorkerHead} from '../../src/core/agent/agy-workers';
import type {HeadHandlers} from '../../src/core/agent/head';
import type {AgyConfig} from '../../src/core/agent/agy';
const managers:AgyWorkers[]=[];
afterEach(async()=>{for(const m of managers.splice(0))await m.close();});
function harness(home=mkdtempSync(join(tmpdir(),'botling-agy-workers-')),resume=false){
 const events:any[]=[],reports:any[]=[],starts:{config:AgyConfig,h:HeadHandlers,sent:any[],answers:any[],stopped:boolean}[]=[];
 const m=new AgyWorkers({command:'not-executed',cwd:home,acpHome:home,sessionId:'owner',resume},i=>events.push(i),(id,text)=>reports.push({id,text}),(config,h)=>{
  const state={config,h,sent:[] as any[],answers:[] as any[],stopped:false};starts.push(state);
  const head:AgyWorkerHead={start(){},send(...args){state.sent.push(args);},answer(...args){state.answers.push(args);},async terminate(){state.stopped=true;return {killed:[],forced:false};}};return head;
 });managers.push(m);return {m,events,reports,starts,home};
}
it('worker tools launch only dedicated ACP sessions and forward permission/refusal/report identity',async()=>{
 const h=harness(),accepted=await h.m.tool('app_handoff',{instructions:'research only',name:'probe'});const id=accepted.task_id,w=h.starts[0]!;
 expect(w.config).toMatchObject({worker:true,resume:false});expect(w.config.systemPrompt).toContain('Do not delegate');
 w.h.onItem({kind:'permission',requestId:'acp:1',tool:'write',summary:'write file',input:{path:'x'}});
 expect(h.events.at(-1)).toMatchObject({requestId:`worker:${id}:1:acp:1`,workerId:id});expect(w.answers).toEqual([]);
 h.m.answer(`worker:${id}:1:acp:1`,false,{path:'x'});expect(w.answers[0][1]).toBe(false);
 w.h.onItem({kind:'init',sessionId:'11111111-2222-4333-8444-555555555555'});w.h.onItem({kind:'result',ok:false,text:'operation refused',error:'Antigravity stopped: permission_denied',subtype:'permission_denied'});
 expect(w.stopped).toBe(true);expect(h.reports[0].id).toBe(id);expect(h.reports[0].text).toContain('not acceptance');expect(h.reports[0].text).toContain('status="failed"');
 await h.m.tool('app_send_message',{task_id:id,message:'follow up'});expect(h.starts[1]!.config).toMatchObject({resume:true,sessionId:'11111111-2222-4333-8444-555555555555'});
 w.h.onExit({code:0,signal:null,stderr:'',expected:true,silent:false});expect(h.m.running).toEqual([id]);
 h.m.answer(`worker:${id}:1:acp:1`,true,{});expect(h.starts[1]!.answers).toEqual([]);
});
it('stop clears live worker dependencies; restart retains identity without claiming running jobs',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'task'}),w=h.starts[0]!;
 w.h.onItem({kind:'init',sessionId:'11111111-2222-4333-8444-555555555555'});
 expect(h.m.completionDependencies).toHaveLength(1);await expect(h.m.tool('app_send_message',{task_id:a.task_id,message:'busy'})).rejects.toThrow('busy');
 await h.m.cancel();expect(w.stopped).toBe(true);expect(h.m.completionDependencies).toEqual([]);
 const restored=harness(h.home,true);await restored.m.tool('app_send_message',{task_id:a.task_id,message:'resume'});expect(restored.starts[0]!.config.resume).toBe(true);
 const newChat=harness(h.home,false);await expect(newChat.m.tool('app_send_message',{task_id:a.task_id,message:'resume'})).rejects.toThrow('Unknown');
});

it('durably queues correlated reports until the matching run is acknowledged',async()=>{
 const h=harness(),a=await h.m.tool('app_handoff',{instructions:'task'}),w=h.starts[0]!;
 w.h.onItem({kind:'init',sessionId:'11111111-2222-4333-8444-555555555555'});
 w.h.onItem({kind:'result',ok:true,text:'verified report',error:'',subtype:'end_turn'});await h.m.close();
 const restored=harness(h.home,true);expect(restored.starts).toEqual([]);expect(restored.reports[0].id).toBe(a.task_id);
 restored.m.acknowledgeReport(a.task_id,99);expect(restored.m.completionDependencies[0]?.state).toBe('reportQueued');
 restored.m.acknowledgeReport(a.task_id,1);expect(restored.m.completionDependencies).toEqual([]);
 const again=harness(h.home,true);expect(again.reports).toEqual([]);
});
