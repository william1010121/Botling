// A head that takes a model/effort change in place is switched before the next message, with no
// restart and no wait for its work; one that cannot (or fails) restarts or queues as before.
import {afterEach,expect,it,vi} from 'vitest';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const fixture=vi.hoisted(()=>{
 const heads:any[]=[];
 const hot={can:true,result:true as boolean|'throw',calls:[] as any[]};
 class Head {
  running=false;pid=0;exited=Promise.resolve();completionDependencies:any[]=[];sent:string[]=[];stops=0;
  constructor(readonly config:any,readonly handlers:any){heads.push(this);}
  start(){this.running=true;queueMicrotask(()=>this.handlers.onItem({kind:'init',sessionId:this.config.sessionId}));}
  send(text:string){this.sent.push(text);}
  steer(text:string){this.sent.push(text);return true;}
  canApplySettings(){return hot.can;}
  async applySettings(target:any){hot.calls.push(target);if(hot.result==='throw')throw new Error('boom');return hot.can&&hot.result;}
  endTurn(){this.handlers.onItem({kind:'result',ok:true,text:'Finished',subtype:'end_turn'});}
  finish(){this.stops++;this.running=false;this.handlers.onExit({code:0,signal:null,stderr:'',expected:true,silent:false});}
  async terminate(){this.finish();return {killed:[],forced:false};}
 }
 return {heads,Head,hot};
});
vi.mock('../../src/core/agent/head',async original=>({...await original<any>(),ClaudeHead:class extends fixture.Head{}}));
vi.mock('../../src/core/agent/codex',async original=>({...await original<any>(),CodexHead:class extends fixture.Head{}}));
vi.mock('../../src/core/agent/agy-acp',()=>({verifyAcpRuntime(){},AgyAcpHead:class extends fixture.Head{}}));
import {Bot} from '../../src/core/bot';
import {mainProfile} from '../../src/core/store/workspace';
import {botPrompts} from '../../src/core/prompts';
import {CodexThreads} from '../../src/core/agent/codex';
import {tempDir,until} from '../helpers';
const bots:Bot[]=[];
afterEach(async()=>{for(const b of bots.splice(0))await b.shutdown({tidy:false});fixture.heads.length=0;Object.assign(fixture.hot,{can:true,result:true,calls:[]});});
function make(engine:'claude'|'codex'|'agy'){
 const folder=tempDir('hot-switch'),profile=mainProfile(folder);mkdirSync(profile.storeDir,{recursive:true});
 writeFileSync(join(profile.storeDir,'bot.json'),JSON.stringify({engine,model:'opus',agyModel:'old',heads:{engines:[engine],answerWith:engine,codexModel:'old'}}));
 const b=new Bot({profile,deferStartup:true,welcome:false,ledger:{record(){},forget(){}} as any,
 headConfig(_p,c){return {...c,command:'/never-spawn',cwd:folder,allowedTools:[]};},
 agyConfig(_p,c){return {...c,transport:'acp',command:'/never-spawn'};},
 codexConfig(_p,c){return {command:'/never-spawn',cwd:folder,threads:new CodexThreads(join(folder,'threads')),sessionId:c.sessionId,resume:c.resume,model:c.codexModel,effort:c.effort==='max'?'xhigh':c.effort,instructions:c.systemPrompt,workerInstructions:null};},
 prompts:(engine,heads)=>botPrompts({profile,engine,heads}),emit(){},log(){},idleMs:600000,approvalTimeoutMs:1000,interruptGraceMs:10});bots.push(b);return b;
}
const settle=()=>new Promise(r=>setImmediate(r));
const texts=(b:Bot)=>b.snapshot().messages.map((m:any)=>m.text);
async function idleFirstTurn(b:Bot){
 b.send('first');await until(()=>fixture.heads[0]?.sent.length);
 const first=fixture.heads[0];first.endTurn();await settle();return first;
}
function busy(b:Bot){return vi.spyOn((b as any).subagents,'running','get').mockReturnValue([{id:'active-worker',background:true,status:'running'}]);}

it('Claude switches model in place while its subagent works: no restart, no queue, a divider',async()=>{
 const b=make('claude');const first=await idleFirstTurn(b);const spy=busy(b);
 try {
  b.configure({model:'sonnet'});b.send('on sonnet please');
  await until(()=>first.sent.length===2);
  expect(fixture.hot.calls.at(-1)).toMatchObject({model:'sonnet'});
  expect(first.stops).toBe(0);expect(fixture.heads).toHaveLength(1);
  expect(first.sent[1]).toContain('on sonnet please');
  expect(first.sent[1]).not.toContain('restarted you');
  expect(texts(b)).toContain('Switched → Sonnet');
  expect(texts(b).join('\n')).not.toContain('waiting for active work');
 } finally {spy.mockRestore();}
 // Done: the next message neither switches nor restarts again.
 first.endTurn();await settle();const calls=fixture.hot.calls.length;
 b.send('again');await until(()=>first.sent.length===3);
 expect(fixture.hot.calls.length).toBe(calls);expect(first.stops).toBe(0);
});

it('Codex switches model and effort in place: the target is what a new head would start with',async()=>{
 const b=make('codex');const first=await idleFirstTurn(b);
 b.configure({codexModel:'gpt-new'});b.configure({efforts:{codex:'xhigh'}});
 b.send('next');await until(()=>first.sent.length===2);
 expect(fixture.hot.calls.at(-1)).toEqual({model:'gpt-new',effort:'xhigh'});
 expect(first.stops).toBe(0);
});

it('a refused switch falls back to the restart when the head is idle',async()=>{
 fixture.hot.result=false;
 const b=make('claude');const first=await idleFirstTurn(b);
 b.configure({model:'sonnet'});b.send('next');
 await until(()=>fixture.heads[1]?.sent.length);
 expect(first.stops).toBe(1);expect(fixture.heads[1].config.model).toBe('sonnet');
 expect(texts(b)).toContain('Restarted → Sonnet');
});

it('a switch that throws falls back too, and with its own work running the message is queued, never sent on the old model',async()=>{
 fixture.hot.result='throw';
 const b=make('claude');const first=await idleFirstTurn(b);const spy=busy(b);
 try {
  b.configure({model:'sonnet'});b.send('next');await settle();await settle();
  expect(first.sent).toHaveLength(1);expect(first.stops).toBe(0);
  expect(texts(b).join('\n')).toContain('waiting for active work');
 } finally {spy.mockRestore();}
 (b as any).checkSettingsHold();
 await until(()=>fixture.heads[1]?.sent.length);
 expect(fixture.heads[1].config.model).toBe('sonnet');expect(fixture.heads[1].sent.at(-1)).toContain('next');
});

it('a change the head cannot take in place is queued at once while its work runs (no switch tried)',async()=>{
 fixture.hot.can=false;
 const b=make('claude');const first=await idleFirstTurn(b);const spy=busy(b);
 try {
  b.configure({efforts:{claude:'low'}});b.send('next');await settle();
  expect(fixture.hot.calls).toHaveLength(0);expect(first.sent).toHaveLength(1);
  expect(texts(b).join('\n')).toContain('waiting for active work');
 } finally {spy.mockRestore();}
});

it('a plugin restart still waiting is not dropped by a model switch in place',async()=>{
 const b=make('claude');const first=await idleFirstTurn(b);
 (b as any).restartFor({told:'loading new plugins',shown:'loading new plugins'});
 b.configure({model:'sonnet'});b.send('next');
 await until(()=>fixture.heads[1]?.sent.length);
 expect(first.stops).toBe(1);
});
