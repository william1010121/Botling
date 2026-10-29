import {afterEach,expect,it,vi} from 'vitest';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const fixture=vi.hoisted(()=>{
 const heads:any[]=[];
 class Head {
  running=false;pid=0;exited=Promise.resolve();completionDependencies:any[]=[];sent:string[]=[];stops=0;
  constructor(readonly config:any,readonly handlers:any){heads.push(this);}
  start(){this.running=true;queueMicrotask(()=>this.handlers.onItem({kind:'init',sessionId:this.config.sessionId}));}
  send(text:string){this.sent.push(text);}
  steer(text:string){this.sent.push(text);return true;}
  endTurn(){this.handlers.onItem({kind:'result',ok:true,text:'Finished',subtype:'end_turn'});}
  finish(){this.stops++;this.running=false;this.handlers.onExit({code:0,signal:null,stderr:'',expected:true,silent:false});}
  async terminate(){this.finish();return {killed:[],forced:false};}
 }
 return {heads,Head};
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
afterEach(async()=>{for(const b of bots.splice(0))await b.shutdown({tidy:false});fixture.heads.length=0;});
function make(engine:'claude'|'codex'|'agy'){
 const folder=tempDir('composer-lifecycle'),profile=mainProfile(folder);mkdirSync(profile.storeDir,{recursive:true});
 writeFileSync(join(profile.storeDir,'bot.json'),JSON.stringify({engine,model:'old',agyModel:'old',heads:{engines:[engine],answerWith:engine,codexModel:'old'}}));
 const b=new Bot({profile,deferStartup:true,welcome:false,ledger:{record(){},forget(){}} as any,
 headConfig(_p,c){return {...c,command:'/never-spawn',cwd:folder,allowedTools:[]};},
 agyConfig(_p,c){return {...c,transport:'acp',command:'/never-spawn'};},
 codexConfig(_p,c){return {command:'/never-spawn',cwd:folder,threads:new CodexThreads(join(folder,'threads')),sessionId:c.sessionId,resume:c.resume,model:c.codexModel,effort:c.effort,instructions:c.systemPrompt,workerInstructions:null};},
 prompts:(engine,heads)=>botPrompts({profile,engine,heads}),emit(){},log(){},idleMs:600000,approvalTimeoutMs:1000,interruptGraceMs:10});bots.push(b);return b;
}
it.each(['claude','codex','agy'] as const)('busy %s applies model reset and effort only on a new turn, preserving session identity',async engine=>{
 const b=make(engine);b.send('first');await until(()=>fixture.heads[0]?.sent.length);
 const first=fixture.heads[0],session=first.config.sessionId;
 b.configure({[engine==='claude'?'model':engine==='codex'?'codexModel':'agyModel']:null});
 expect(first.stops).toBe(0);
 b.send('second');await new Promise(r=>setImmediate(r));
 expect(first.sent).toHaveLength(1); // Never steer into the old model.
 first.endTurn();await until(()=>fixture.heads[1]?.sent.length);
 const second=fixture.heads[1];expect(first.stops).toBe(1);
 expect(second.config).toMatchObject({sessionId:session,resume:true});
 expect(second.config.model).toBeNull();
 b.configure({effort:'high'});expect(second.stops).toBe(0);
 b.send('third');await new Promise(r=>setImmediate(r));expect(second.sent).toHaveLength(1);
 second.endTurn();await until(()=>fixture.heads[2]?.sent.length);
 expect(fixture.heads[2].config).toMatchObject({sessionId:session,resume:true,effort:'high'});
 fixture.heads[2].endTurn();
});
it('does not silently send a new user turn on the old model while a worker prevents safe restart',async()=>{
 const b=make('claude');b.send('first');await until(()=>fixture.heads[0]?.sent.length);
 const first=fixture.heads[0];first.endTurn();await new Promise(r=>setImmediate(r));
 const busy=vi.spyOn((b as any).subagents,'running','get').mockReturnValue([{id:'active-worker',background:true,status:'running'}]);
 try {
  b.configure({model:'new-runtime-model'});b.send('use the new model');await new Promise(r=>setImmediate(r));
  expect(first.sent).toHaveLength(1);expect(first.stops).toBe(0);
  expect(JSON.stringify(b.snapshot())).toContain('waiting for active work');
 } finally {busy.mockRestore();}
 b.send('retry after worker finishes');await until(()=>fixture.heads[1]?.sent.length);
 expect(fixture.heads[1].config.model).toBe('new-runtime-model');expect(first.stops).toBe(1);fixture.heads[1].endTurn();
});
