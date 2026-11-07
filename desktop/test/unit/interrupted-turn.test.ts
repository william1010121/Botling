// A line you send while claude works goes into its turn with priority "now": claude cuts that turn off and ends it with
// result subtype "error_during_execution", then answers your line. That cut-off is the app's own doing, not an error:
// before this, it showed as a bot bubble that said only "error_during_execution" (2026-11-07, DaFaJi chat, 21:55 and 22:10).
// The user's decision: an interrupted reply shows no bubble. Words it had already written stay; the raw subtype never shows.
import {afterEach,expect,it,vi} from 'vitest';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const fixture=vi.hoisted(()=>{
 const heads:any[]=[];
 class Head {
  running=false;pid=0;exited=Promise.resolve();completionDependencies:any[]=[];sent:{text:string;id:string}[]=[];interrupts=0;
  constructor(readonly config:any,readonly handlers:any){heads.push(this);}
  start(){this.running=true;queueMicrotask(()=>this.handlers.onItem({kind:'init',sessionId:this.config.sessionId}));}
  send(text:string,id:string){this.sent.push({text,id});}
  interrupt(){this.interrupts++;}
  item(item:any){this.handlers.onItem(item);}
  finish(){this.running=false;this.handlers.onExit({code:0,signal:null,stderr:'',expected:true,silent:false});}
  async terminate(){this.finish();return {killed:[],forced:false};}
 }
 return {heads,Head};
});
vi.mock('../../src/core/agent/head',async original=>({...await original<any>(),ClaudeHead:class extends fixture.Head{}}));
import {Bot} from '../../src/core/bot';
import {mainProfile} from '../../src/core/store/workspace';
import {botPrompts} from '../../src/core/prompts';
import {tempDir,until} from '../helpers';
const bots:Bot[]=[];
afterEach(async()=>{for(const b of bots.splice(0))await b.shutdown({tidy:false});fixture.heads.length=0;});
function make(){
 const folder=tempDir('interrupted'),profile=mainProfile(folder);mkdirSync(profile.storeDir,{recursive:true});
 writeFileSync(join(profile.storeDir,'bot.json'),JSON.stringify({engine:'claude',model:'m',heads:{engines:['claude'],answerWith:'claude'}}));
 const events:any[]=[];
 const b=new Bot({profile,deferStartup:true,ledger:{record(){},forget(){}} as any,
 headConfig(_p,c){return {...c,command:'/never-spawn',cwd:folder,allowedTools:[]};},
 prompts:(engine,heads)=>botPrompts({profile,engine,heads}),emit(e){events.push(e);},log(){},idleMs:600000,approvalTimeoutMs:1000,interruptGraceMs:10});
 bots.push(b);return {b,events};
}
const settle=()=>new Promise(r=>setImmediate(r));
const CUT_OFF={kind:'result',ok:false,text:'',error:'error_during_execution',subtype:'error_during_execution'};
const botLines=(b:Bot)=>((b as any).records as any[]).filter(r=>r.role==='bot');

/** You wrote 'first', then 'second' while claude worked on it; `before` is what claude did before it was cut off. */
async function cutOff(before:any[]){
 const {b,events}=make();
 b.send('first');await until(()=>fixture.heads[0]?.sent.length===1);
 const head=fixture.heads[0];
 for(const item of before)head.item(item);
 await settle();
 b.send('second');await settle();
 expect(head.sent).toHaveLength(2);
 const steeredId=head.sent[1].id.toLowerCase();
 head.item(CUT_OFF);await settle();
 head.item({kind:'command',id:steeredId,state:'started'});await settle();
 head.item({kind:'result',ok:true,text:'Answer to second',subtype:'success'});await settle();
 return {b,events};
}

it('a turn cut off for your new line, with nothing written yet, shows no bubble',async()=>{
 const {b}=await cutOff([]);
 expect(botLines(b).map(r=>r.text)).toEqual(['Answer to second']);
});

it('a turn cut off after it wrote words keeps those words, never the raw subtype',async()=>{
 const {b}=await cutOff([{kind:'delta',text:'Half an answer'}]);
 const texts=botLines(b).map(r=>r.text);
 expect(texts).toEqual(['Half an answer','Answer to second']);
 expect(botLines(b).some(r=>r.error)).toBe(false);
});

it('a turn cut off after it ran tools but wrote nothing shows no bubble',async()=>{
 const {b}=await cutOff([{kind:'toolUse',id:'t1',tool:'Bash',title:'ls',detail:'',parent:null,input:{}},{kind:'toolResult',id:'t1',output:'',failed:false,parent:null,launch:null}]);
 expect(botLines(b).map(r=>r.text)).toEqual(['Answer to second']);
});

it('an error_during_execution nobody caused still shows as a failed reply',async()=>{
 const {b}=make();
 b.send('first');await until(()=>fixture.heads[0]?.sent.length===1);
 fixture.heads[0].item(CUT_OFF);await settle();
 expect(botLines(b)).toHaveLength(1);
 expect(botLines(b)[0]).toMatchObject({text:'error_during_execution',state:'failed'});
});
