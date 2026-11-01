import {afterEach,expect,it,vi} from 'vitest';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
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

let system='system v1';
function make(engine:'claude'|'codex'='claude'){
 const folder=tempDir('prompt-hash'),profile=mainProfile(folder);mkdirSync(profile.storeDir,{recursive:true});
 writeFileSync(join(profile.storeDir,'bot.json'),JSON.stringify({engine,heads:{engines:[engine],answerWith:engine}}));
 const b=new Bot({profile,deferStartup:true,welcome:false,ledger:{record(){},forget(){}} as any,
 headConfig(_p,c){return {...c,command:'/never-spawn',cwd:folder,allowedTools:[]};},
 codexConfig(_p,c){return {command:'/never-spawn',cwd:folder,threads:new CodexThreads(join(folder,'threads')),sessionId:c.sessionId,resume:c.resume,model:c.codexModel,effort:c.effort,instructions:c.systemPrompt,workerInstructions:null};},
 prompts:(engine,heads)=>({...botPrompts({profile,engine,heads}),system}),emit(){},log(){},idleMs:600000,approvalTimeoutMs:1000,interruptGraceMs:10});bots.push(b);return b;
}
const headJSON=(b:Bot)=>JSON.parse(readFileSync(join((b as any).profile.storeDir,'head.json'),'utf8'));
const dividers=(b:Bot)=>(b.snapshot() as any,(b as any).chat.filter((r:any)=>r.role==='divider').map((r:any)=>r.text));
/** One turn, then a restart that keeps the session (a model change), so the next message decides resume or not. */
async function firstThenRestart(b:Bot){
 b.send('first');await until(()=>fixture.heads[0]?.sent.length);
 fixture.heads[0].endTurn();await new Promise(r=>setImmediate(r));
 b.configure({model:'other'});
}
afterEach(()=>{system='system v1';});

it('records the system prompt hash in head.json when a session starts',async()=>{
 const b=make();b.send('first');await until(()=>fixture.heads[0]?.sent.length);
 expect(headJSON(b)).toMatchObject({sessionId:fixture.heads[0].config.sessionId,started:true,promptHash:expect.stringMatching(/^[0-9a-f]{16}$/)});
 fixture.heads[0].endTurn();
});

it('same hash: resumes the session, no briefing, no divider',async()=>{
 const b=make();await firstThenRestart(b);
 b.send('second');await until(()=>fixture.heads[1]?.sent.length);
 expect(fixture.heads[1].config).toMatchObject({sessionId:fixture.heads[0].config.sessionId,resume:true});
 expect(fixture.heads[1].sent[0]).not.toContain('Read ');
 expect(dividers(b)).not.toContain('New session (instructions updated)');
 fixture.heads[1].endTurn();
});

it('different hash: a new session with the wake briefing (memory and recent chat), a divider, and the new hash kept',async()=>{
 const b=make();await firstThenRestart(b);
 const before=headJSON(b);
 system='system v2';
 b.send('second');await until(()=>fixture.heads[1]?.sent.length);
 const second=fixture.heads[1];
 expect(second.config.resume).toBe(false);
 expect(second.config.sessionId).not.toBe(fixture.heads[0].config.sessionId);
 expect(second.config.systemPrompt).toBe('system v2');
 expect(second.sent[0]).toContain('memory.md');
 expect(second.sent[0]).toContain('first');
 expect(second.sent[0]).toContain('second');
 expect(dividers(b)).toContain('New session (instructions updated)');
 expect(headJSON(b).promptHash).not.toBe(before.promptHash);
 expect(headJSON(b).sessionId).toBe(second.config.sessionId);
 second.endTurn();
});

it('older data without a hash counts as different (once)',async()=>{
 const b=make();await firstThenRestart(b);
 delete (b as any).session.promptHash;
 b.send('second');await until(()=>fixture.heads[1]?.sent.length);
 expect(fixture.heads[1].config.resume).toBe(false);
 expect(dividers(b)).toContain('New session (instructions updated)');
 expect(headJSON(b).promptHash).toMatch(/^[0-9a-f]{16}$/);
 fixture.heads[1].endTurn();await new Promise(r=>setImmediate(r));
 b.configure({model:'again'});b.send('third');await until(()=>fixture.heads[2]?.sent.length);
 expect(fixture.heads[2].config).toMatchObject({resume:true,sessionId:fixture.heads[1].config.sessionId});
 fixture.heads[2].endTurn();
});

it('Restart bot forces a new session even when the hash is the same, after the running turn',async()=>{
 const b=make();b.send('first');await until(()=>fixture.heads[0]?.sent.length);
 expect(b.restartNow()).toEqual({restart:'next-message'});
 expect(fixture.heads[0].stops).toBe(0);
 fixture.heads[0].endTurn();await new Promise(r=>setImmediate(r));
 b.send('second');await until(()=>fixture.heads[1]?.sent.length);
 expect(fixture.heads[0].stops).toBe(1);
 expect(fixture.heads[1].config.resume).toBe(false);
 expect(fixture.heads[1].config.sessionId).not.toBe(fixture.heads[0].config.sessionId);
 expect(fixture.heads[1].sent[0]).toContain('first');
 expect(dividers(b)).toContain('New session (instructions updated)');
 expect(dividers(b)).not.toContain('Restarted → manual restart');
 fixture.heads[1].endTurn();
});

it('Restart bot while asleep: the next wake is a new session, once',async()=>{
 const b=make();b.send('first');await until(()=>fixture.heads[0]?.sent.length);
 fixture.heads[0].endTurn();await new Promise(r=>setImmediate(r));
 b.configure({model:'x'});b.send('second');await until(()=>fixture.heads[1]?.sent.length);
 fixture.heads[1].endTurn();await new Promise(r=>setImmediate(r));
 (b as any).head.finish();
 expect(b.restartNow()).toEqual({restart:'asleep'});
 b.send('third');await until(()=>fixture.heads[2]?.sent.length);
 expect(fixture.heads[2].config.resume).toBe(false);
 fixture.heads[2].endTurn();await new Promise(r=>setImmediate(r));
 b.configure({model:'y'});b.send('fourth');await until(()=>fixture.heads[3]?.sent.length);
 expect(fixture.heads[3].config.resume).toBe(true);
 fixture.heads[3].endTurn();
});

it('Codex keeps resuming on a different hash (its resume refreshes instructions itself)',async()=>{
 const b=make('codex');b.send('first');await until(()=>fixture.heads[0]?.sent.length);
 fixture.heads[0].endTurn();await new Promise(r=>setImmediate(r));
 b.configure({codexModel:'m2'});system='system v2';
 b.send('second');await until(()=>fixture.heads[1]?.sent.length);
 expect(fixture.heads[1].config).toMatchObject({resume:true,sessionId:fixture.heads[0].config.sessionId});
 fixture.heads[1].endTurn();
});
