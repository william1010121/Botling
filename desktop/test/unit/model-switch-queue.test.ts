// A model or effort change waits only for the work of the head it changes, and a message sent while
// that head's own work runs is queued (with a card) and sent on the new settings once the work ends.
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
import {toSwiftDate} from '../../src/core/store/records';
import {tempDir,until} from '../helpers';
const bots:Bot[]=[];
afterEach(async()=>{for(const b of bots.splice(0))await b.shutdown({tidy:false});fixture.heads.length=0;});
function make(engine:'claude'|'codex'|'agy',engines:string[]=[engine]){
 const folder=tempDir('model-switch-queue'),profile=mainProfile(folder);mkdirSync(profile.storeDir,{recursive:true});
 writeFileSync(join(profile.storeDir,'bot.json'),JSON.stringify({engine,model:'old',agyModel:'old',heads:{engines,answerWith:engine,codexModel:'old'}}));
 const b=new Bot({profile,deferStartup:true,welcome:false,ledger:{record(){},forget(){}} as any,
 headConfig(_p,c){return {...c,command:'/never-spawn',cwd:folder,allowedTools:[]};},
 agyConfig(_p,c){return {...c,transport:'acp',command:'/never-spawn'};},
 codexConfig(_p,c){return {command:'/never-spawn',cwd:folder,threads:new CodexThreads(join(folder,'threads')),sessionId:c.sessionId,resume:c.resume,model:c.codexModel,effort:c.effort,instructions:c.systemPrompt,workerInstructions:null};},
 prompts:(engine,heads)=>botPrompts({profile,engine,heads}),emit(){},log(){},idleMs:600000,approvalTimeoutMs:1000,interruptGraceMs:10});bots.push(b);return b;
}
const settle=()=>new Promise(r=>setImmediate(r));
/** A reply of `engine` in the chat with a background task still running (e.g. an Antigravity worker). */
function runningTask(b:Bot,engine:string,id:string){
 (b as any).records.push({id:`reply-${id}`,role:'bot',text:'',date:toSwiftDate(),state:'done',engine,backgroundTasks:[{id,kind:'agent',title:'worker',status:'running',startedAt:toSwiftDate()}]});
}
const texts=(b:Bot)=>b.snapshot().messages.map((m:any)=>m.text);
async function idleFirstTurn(b:Bot){
 b.send('first');await until(()=>fixture.heads[0]?.sent.length);
 const first=fixture.heads[0];first.endTurn();await settle();return first;
}

it('a partner head\'s background task in the shared chat does not hold back a Claude model change',async()=>{
 const b=make('claude',['claude','agy']);
 const first=await idleFirstTurn(b);
 runningTask(b,'agy','agy-worker-1');
 b.configure({model:'new-model'});b.send('use the new model');
 await until(()=>fixture.heads[1]?.sent.length);
 expect(first.stops).toBe(1);
 expect(fixture.heads[1].config.model).toBe('new-model');
 expect(fixture.heads[1].sent.at(-1)).toContain('use the new model');
 expect(texts(b).join('\n')).not.toContain('waiting for active work');
 // The partner's task was not marked stopped by Claude's restart.
 expect(((b as any).records.find((r:any)=>r.id==='reply-agy-worker-1').backgroundTasks[0]).status).toBe('running');
});

it('its own background task queues the message with a card, then sends it on the new model when the task ends',async()=>{
 const b=make('claude',['claude','agy']);
 const first=await idleFirstTurn(b);
 runningTask(b,'claude','own-task');
 b.configure({model:'new-model'});b.send('use the new model');await settle();
 expect(first.sent).toHaveLength(1);expect(first.stops).toBe(0);
 const card=texts(b).find(t=>t.includes('waiting for active work'));
 expect(card).toContain('queued');
 // Nothing failed: the message is not marked failed and asks for no resend.
 expect(texts(b).join('\n')).not.toContain('Send this message again');
 (b as any).endBackground('own-task','completed',null);
 await until(()=>fixture.heads[1]?.sent.length);
 expect(first.stops).toBe(1);
 expect(fixture.heads[1].config.model).toBe('new-model');
 expect(fixture.heads[1].sent.at(-1)).toContain('use the new model');
 expect(texts(b).join('\n')).not.toContain('waiting for active work');
});

it('messages sent while one is queued go after it, in order',async()=>{
 const b=make('claude');
 const first=await idleFirstTurn(b);
 runningTask(b,'claude','own-task');
 b.configure({model:'new-model'});b.send('one');await settle();b.send('two');await settle();
 expect(first.sent).toHaveLength(1);
 (b as any).endBackground('own-task','completed',null);
 await until(()=>fixture.heads[1]?.sent.length);
 expect(fixture.heads[1].sent[0]).toContain('one');expect(fixture.heads[1].sent.join()).not.toContain('two');
 fixture.heads[1].endTurn();await until(()=>fixture.heads[1].sent.length>1);
 expect(fixture.heads[1].sent[1]).toContain('two');
});

it('a host still counts the workers it carries: an Antigravity head with workers queues, then sends when they finish',async()=>{
 const b=make('agy');
 const first=await idleFirstTurn(b);
 first.handlers.onItem({kind:'managedPending',pending:true});
 b.configure({agyModel:'new-model'});b.send('use the new model');await settle();
 expect(first.sent).toHaveLength(1);expect(first.stops).toBe(0);
 expect(texts(b).join('\n')).toContain('waiting for active work');
 first.handlers.onItem({kind:'managedPending',pending:false});
 await until(()=>fixture.heads[1]?.sent.length);
 expect(fixture.heads[1].config.model).toBe('new-model');
 expect(fixture.heads[1].sent.at(-1)).toContain('use the new model');
});

it('taking back the queued message removes its card and restarts nothing',async()=>{
 const b=make('claude');
 const first=await idleFirstTurn(b);
 runningTask(b,'claude','own-task');
 b.configure({model:'new-model'});const queued=b.send('never mind');await settle();
 expect(texts(b).join('\n')).toContain('waiting for active work');
 await b.stop((queued as any).turnId ?? (b as any).queue[0].id);
 expect(texts(b).join('\n')).not.toContain('waiting for active work');
 expect(first.stops).toBe(0);expect(first.sent).toHaveLength(1);
});
