// Antigravity workers' own model and effort (Settings → Models & workers, and each bot's panel): a worker run starts on
// the chosen ones, read when it starts; one left unset ("Same as head") uses the head's.
import {afterEach,expect,it} from 'vitest';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgyWorkers,agyWorkerModelEffort,type AgyWorkerHead} from '../../src/core/agent/agy-workers';
import type {AgyConfig} from '../../src/core/agent/agy';
const managers:AgyWorkers[]=[];
afterEach(async()=>{for(const m of managers.splice(0))await m.close();});

it('uses the workers\' choice, and the head\'s model or effort for what is left unset',()=>{
  const head={model:'gemini-head',effort:'medium'};
  expect(agyWorkerModelEffort(head)).toEqual({model:'gemini-head',effort:'medium'});
  expect(agyWorkerModelEffort({...head,workerChoice:()=>({model:'gemini-flash',effort:'low'})})).toEqual({model:'gemini-flash',effort:'low'});
  expect(agyWorkerModelEffort({...head,workerChoice:()=>({model:null,effort:'high'})})).toEqual({model:'gemini-head',effort:'high'});
  expect(agyWorkerModelEffort({...head,workerChoice:()=>({model:'  gemini-pro ',effort:null})})).toEqual({model:'gemini-pro',effort:'medium'});
  // A blank model, or a level Antigravity does not take, is no choice.
  expect(agyWorkerModelEffort({...head,workerChoice:()=>({model:'   ',effort:'xhigh'})})).toEqual({model:'gemini-head',effort:'medium'});
  expect(agyWorkerModelEffort({model:undefined,effort:undefined,workerChoice:()=>({})})).toEqual({model:null,effort:null});
  // A choice that cannot be read is none.
  expect(agyWorkerModelEffort({...head,workerChoice:()=>{throw Error('bot gone');}})).toEqual({model:'gemini-head',effort:'medium'});
  // A Codex worker started from an Antigravity bot keeps the head's (the choice is Antigravity's).
  expect(agyWorkerModelEffort({...head,workerChoice:()=>({model:'gemini-flash',effort:'low'})},'codex')).toEqual({model:'gemini-head',effort:'medium'});
});

it('a worker run starts on the choice read when it starts, and the runtime reports that effort',async()=>{
  const home=mkdtempSync(join(tmpdir(),'botling-agy-worker-choice-'));
  let choice:{model?:string|null;effort?:string|null}={model:'gemini-flash',effort:'low'};
  const starts:AgyConfig[]=[];
  const m=new AgyWorkers({command:'not-executed',cwd:home,acpHome:home,sessionId:'owner',resume:false,systemPrompt:'You are the coordinator',workerInstructions:'fixture',model:'gemini-head',effort:'high',workerChoice:()=>choice},()=>{},()=>{},(config)=>{
    starts.push(config);
    const head:AgyWorkerHead={start(){},send(){},answer(){},async terminate(){return {killed:[],forced:false};}};return head;
  });managers.push(m);
  await m.tool('app_handoff',{instructions:'first'});
  expect(starts[0]).toMatchObject({worker:true,model:'gemini-flash',effort:'low'});
  choice={};
  await m.tool('app_handoff',{instructions:'second'});
  expect(starts[1]).toMatchObject({worker:true,model:'gemini-head',effort:'high'});
});

// Its row, the workers menu and its own view show the model it runs on, as Claude's and Codex's workers do.
it('a worker\'s opening runtime names its chosen model; with none chosen, the model its conversation started on',async()=>{
  const home=mkdtempSync(join(tmpdir(),'botling-agy-worker-model-'));
  let choice:{model?:string|null;effort?:string|null}={model:'gemini-flash',effort:'low'};
  const events:any[]=[];const handlers:any[]=[];
  const m=new AgyWorkers({command:'not-executed',cwd:home,acpHome:home,sessionId:'owner',resume:false,systemPrompt:'You are the coordinator',workerInstructions:'fixture',effort:'high',workerChoice:()=>choice},i=>events.push(i),()=>{},(_config,h)=>{
    handlers.push(h);
    const head:AgyWorkerHead={start(){},send(){},answer(){},async terminate(){return {killed:[],forced:false};}};return head;
  });managers.push(m);
  const first=await m.tool('app_handoff',{instructions:'first'});
  expect(events.find(e=>e.kind==='subagentRuntime'&&e.id===first.task_id)).toMatchObject({runtime:{engine:'agy',reasoningEffort:'low'},model:'gemini-flash'});
  // "Same as head" with no head model: Antigravity's own default, which ACP names when the conversation starts.
  choice={};
  const second=await m.tool('app_handoff',{instructions:'second'});
  expect(events.filter(e=>e.kind==='subagentRuntime'&&e.id===second.task_id).every(e=>!e.model)).toBe(true);
  handlers[1].onItem({kind:'init',sessionId:'11111111-2222-4333-8444-555555555555',model:'gemini-3.8-flash-high'});
  expect(events.filter(e=>e.kind==='subagentRuntime'&&e.id===second.task_id).at(-1)).toMatchObject({runtime:{engine:'agy',reasoningEffort:'high'},model:'gemini-3.8-flash-high'});
});
