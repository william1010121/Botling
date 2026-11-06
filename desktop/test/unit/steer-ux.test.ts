// Steering UX: an inserted message is the default wherever the engine can take it (Claude with an approval open or a
// foreground subagent at work, Codex always); where it cannot (an Antigravity head, app-origin messages, a message
// queued ahead), the message waits in the bot's queue and its line says "Queued" until it is sent.
import {afterEach,expect,it,vi} from 'vitest';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const fixture=vi.hoisted(()=>{
 const heads:any[]=[];
 class Head {
  running=false;pid=0;exited=Promise.resolve();completionDependencies:any[]=[];sent:string[]=[];sentOptions:any[]=[];steered:string[]=[];
  constructor(readonly config:any,readonly handlers:any){heads.push(this);}
  start(){this.running=true;queueMicrotask(()=>this.handlers.onItem({kind:'init',sessionId:this.config.sessionId}));}
  send(text:string,_id?:string,_images?:string[],options?:any){this.sent.push(text);this.sentOptions.push(options);}
  steer(text:string){this.steered.push(text);return true;}
  endTurn(){this.handlers.onItem({kind:'result',ok:true,text:'Finished',subtype:'end_turn'});}
  finish(){this.running=false;this.handlers.onExit({code:0,signal:null,stderr:'',expected:true,silent:false});}
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
 const folder=tempDir('steer-ux'),profile=mainProfile(folder);mkdirSync(profile.storeDir,{recursive:true});
 writeFileSync(join(profile.storeDir,'bot.json'),JSON.stringify({engine,model:'m',agyModel:'m',heads:{engines:[engine],answerWith:engine,codexModel:'m'}}));
 const b=new Bot({profile,deferStartup:true,ledger:{record(){},forget(){}} as any,
 headConfig(_p,c){return {...c,command:'/never-spawn',cwd:folder,allowedTools:[]};},
 agyConfig(_p,c){return {...c,transport:'acp',command:'/never-spawn'};},
 codexConfig(_p,c){return {command:'/never-spawn',cwd:folder,threads:new CodexThreads(join(folder,'threads')),sessionId:c.sessionId,resume:c.resume,model:c.codexModel,effort:c.effort,instructions:c.systemPrompt,workerInstructions:null};},
 prompts:(engine,heads)=>botPrompts({profile,engine,heads}),emit(){},log(){},idleMs:600000,approvalTimeoutMs:1000,interruptGraceMs:10});bots.push(b);return b;
}
const settle=()=>new Promise(r=>setImmediate(r));
async function working(engine:'claude'|'codex'|'agy'){
 const b=make(engine);
 b.send('first');await until(()=>fixture.heads[0]?.sent.length);
 return {b,head:fixture.heads[0]};
}
const line=(b:Bot,text:string)=>b.snapshot().messages.find((m:any)=>m.role==='user'&&m.text.includes(text)) as any;

it('baseline: Claude takes a message into its turn',async()=>{
 const {b,head}=await working('claude');
 b.send('second');await settle();
 expect(head.sent).toHaveLength(2);
});

it('Claude takes your message in at once (priority now), the first one as an ordinary message',async()=>{
 const {b,head}=await working('claude');
 b.send('second');await settle();
 expect(head.sentOptions[0]?.now).toBeFalsy();
 expect(head.sentOptions[1]).toEqual({now:true});
});

it('Claude takes a message into its turn even with an approval open',async()=>{
 const {b,head}=await working('claude');
 (b as any).approvals.set('a1',{});
 b.send('second');await settle();
 expect(head.sent).toHaveLength(2);expect(head.sent[1]).toContain('second');
 expect(line(b,'second').queued).toBeFalsy();
});

it('Claude takes a message into its turn while a foreground subagent works',async()=>{
 const {b,head}=await working('claude');
 (b as any).subagents.list.push({id:'fg',description:'d',prompt:'p',status:'running',background:false,startedAt:0,steps:[]});
 b.send('second');await settle();
 expect(head.sent).toHaveLength(2);expect(head.sent[1]).toContain('second');
});

it('Claude still queues behind a message already waiting, so the order holds',async()=>{
 const {b,head}=await working('claude');
 (b as any).queue.push({open:true,sent:false,origin:'user',userId:null,words:'older',messageId:'m0',resolve(){}});
 b.send('second');await settle();
 expect(head.sent).toHaveLength(1);
});

it('Codex takes a message with turn/steer even with an approval open',async()=>{
 const {b,head}=await working('codex');
 (b as any).approvals.set('a1',{});
 b.send('second');await settle();
 expect(head.steered).toHaveLength(1);expect(head.steered[0]).toContain('second');
});

it('an Antigravity head queues the message, marks its line Queued, and clears the mark when it is sent',async()=>{
 const {b,head}=await working('agy');
 b.send('second');await settle();
 expect(head.sent).toHaveLength(1);
 expect(line(b,'second').queued).toBe(true);
 expect(line(b,'first').queued).toBeFalsy();
 head.endTurn();
 await until(()=>head.sent.length>1);
 expect(head.sent[1]).toContain('second');
 await until(()=>!line(b,'second').queued);
});
