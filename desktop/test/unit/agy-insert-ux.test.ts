// An Antigravity head takes your message into its turn at its next tool call (agy-mid-turn-insert.test.ts): until
// then the line says "Queued" and the message waits in the bot's queue; once delivered it is inserted like Claude's
// and Codex's; a turn that ends without another tool call sends it as the next turn, once.
import {afterEach,expect,it,vi} from 'vitest';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const fixture=vi.hoisted(()=>{
 const heads:any[]=[];
 class Head {
  running=false;pid=0;exited=Promise.resolve();completionDependencies:any[]=[];sent:string[]=[];steered:string[]=[];
  constructor(readonly config:any,readonly handlers:any){heads.push(this);}
  start(){this.running=true;queueMicrotask(()=>this.handlers.onItem({kind:'init',sessionId:this.config.sessionId}));}
  send(text:string){this.sent.push(text);}
  steer(text:string){this.steered.push(text);return true;}
  endTurn(){this.handlers.onItem({kind:'result',ok:true,text:'Finished',subtype:'end_turn'});}
  finish(){this.running=false;this.handlers.onExit({code:0,signal:null,stderr:'',expected:true,silent:false});}
  async terminate(){this.finish();return {killed:[],forced:false};}
 }
 return {heads,Head};
});
vi.mock('../../src/core/agent/head',async original=>({...await original<any>(),ClaudeHead:class extends fixture.Head{}}));
vi.mock('../../src/core/agent/codex',async original=>({...await original<any>(),CodexHead:class extends fixture.Head{}}));
vi.mock('../../src/core/agent/agy-acp',()=>({verifyAcpRuntime(){},AgyAcpHead:class extends fixture.Head{
 offered:{id:string,text:string}[]=[];withdrawn:string[]=[];
 offerInsert(id:string,text:string){this.offered.push({id,text});return true;}
 withdrawInsert(id:string){this.withdrawn.push(id);this.offered=this.offered.filter(o=>o.id!==id);return true;}
 deliver(){for(const {id} of this.offered.splice(0))this.handlers.onItem({kind:'inserted',id});}
}}));
import {Bot} from '../../src/core/bot';
import {mainProfile} from '../../src/core/store/workspace';
import {botPrompts} from '../../src/core/prompts';
import {CodexThreads} from '../../src/core/agent/codex';
import {tempDir,until} from '../helpers';
const bots:Bot[]=[];
afterEach(async()=>{for(const b of bots.splice(0))await b.shutdown({tidy:false});fixture.heads.length=0;});
function make(engine:'claude'|'codex'|'agy'){
 const folder=tempDir('agy-insert-ux'),profile=mainProfile(folder);mkdirSync(profile.storeDir,{recursive:true});
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

it('a message while Antigravity works is offered to its turn and shows Queued until delivered',async()=>{
 const {b,head}=await working('agy');
 b.send('*web search 一下');await settle();
 expect(head.offered).toHaveLength(1);expect(head.offered[0].text).toContain('web search 一下');
 expect(line(b,'web search').queued).toBe(true);
 head.deliver();
 await until(()=>!line(b,'web search').queued);
 head.endTurn();await settle();await settle();
 // Delivered into the turn: never sent again as a turn of its own.
 expect(head.sent).toHaveLength(1);
 // The reply shows after the line it now answers.
 const roles=b.snapshot().messages.map((m:any)=>m.role==='user'?m.text:m.role);
 expect(roles.indexOf('*web search 一下')).toBeLessThan(roles.lastIndexOf('bot'));
});

it('an offered message not delivered by the end of the turn is sent as the next turn, once',async()=>{
 const {b,head}=await working('agy');
 b.send('second');await settle();
 expect(head.offered).toHaveLength(1);
 head.offered.length=0; // the head drops what it did not deliver when the turn ends
 head.endTurn();
 await until(()=>head.sent.length>1);
 expect(head.sent[1]).toContain('second');
 head.deliver();await settle();
 expect(head.sent).toHaveLength(2);
 await until(()=>!line(b,'second').queued);
});

it('taking back a queued message withdraws its offer',async()=>{
 const {b,head}=await working('agy');
 b.send('second');await settle();
 const waiting=(b as any).queue[0];
 await b.stop(waiting.id);
 expect(head.withdrawn).toHaveLength(1);
 head.deliver();await settle();
 expect(head.offered).toHaveLength(0);
});
