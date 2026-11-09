// A message the app sent to claude that claude takes into the turn under way ("absorbed_mid_turn") never gets a turn of its
// own: claude reports its command_lifecycle "completed" (before that turn's result) and nothing else. The app's turn for it
// must end then. Before this, it waited forever: the bot showed "thinking", every later app message queued behind it, and the
// user's messages after that too, until the app was restarted (2026-11-05, botling bot, turn of message D8EA3991).
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
function make(interruptGraceMs=10){
 const folder=tempDir('absorbed'),profile=mainProfile(folder);mkdirSync(profile.storeDir,{recursive:true});
 writeFileSync(join(profile.storeDir,'bot.json'),JSON.stringify({engine:'claude',model:'m',heads:{engines:['claude'],answerWith:'claude'}}));
 const events:any[]=[];
 const b=new Bot({profile,deferStartup:true,ledger:{record(){},forget(){}} as any,
 headConfig(_p,c){return {...c,command:'/never-spawn',cwd:folder,allowedTools:[]};},
 prompts:(engine,heads)=>botPrompts({profile,engine,heads}),emit(e){events.push(e);},log(){},idleMs:600000,approvalTimeoutMs:1000,interruptGraceMs});
 bots.push(b);return {b,events};
}
const settle=()=>new Promise(r=>setImmediate(r));
const finished=(events:any[],turnId:string)=>events.find(e=>e.type==='turn.finished'&&e.turnId===turnId);

/** The 2026-11-05 order: your line read only after the turn under way ended, an app message sent meanwhile, then folded. */
async function folded(){
 const {b,events}=make();
 b.send('first');await until(()=>fixture.heads[0]?.sent.length===1);
 const head=fixture.heads[0];
 // Your second line goes into the turn under way (steering)…
 b.send('second');await settle();
 expect(head.sent).toHaveLength(2);
 const steeredId=head.sent[1].id.toLowerCase();
 // …but claude ended that turn before it read it.
 head.item({kind:'result',ok:true,text:'Answer to first',subtype:'end_turn'});await settle();
 // The app's own message goes now (a worker's report, the "carry on" note): sent, waiting for its turn.
 const appTurn=b.appMessage('(App: a report)')!;await settle();
 expect(head.sent).toHaveLength(3);
 const appId=head.sent[2].id.toLowerCase();
 // claude begins a turn for your line: the app's message waits (deferred)…
 head.item({kind:'command',id:steeredId,state:'started'});await settle();
 // …and claude takes it into that same turn: no "started" for it, only its end, before the turn's result.
 head.item({kind:'command',id:appId,state:'completed'});
 head.item({kind:'result',ok:true,text:'Answer to second and the report',subtype:'end_turn'});await settle();
 return {b,events,head,appTurn};
}

it('an app message claude took into the turn under way ends with that turn; the bot is free again',async()=>{
 const {b,events,appTurn}=await folded();
 await until(()=>finished(events,appTurn),{what:'the absorbed turn ended',timeout:1000});
 expect(finished(events,appTurn)).toMatchObject({status:'done'});
 expect((b as any).turn).toBeNull();
 expect((b as any).deferred).toBeNull();
 expect((b as any).working).toBe(false);
});

it('the next message after it gets a turn of its own at once (nothing waits behind a turn that never comes)',async()=>{
 const {b,events,head}=await folded();
 const report=b.appMessage('(App: the next report)')!;await settle();
 expect(head.sent.at(-1).text).toContain('the next report');
 head.item({kind:'command',id:head.sent.at(-1).id.toLowerCase(),state:'started'});
 head.item({kind:'result',ok:true,text:'Said it',subtype:'end_turn'});await settle();
 expect(finished(events,report)).toMatchObject({status:'done'});
 // No interrupt went to a claude that had nothing to stop (it would swallow the next real result).
 expect(head.interrupts).toBe(0);
});

it('an absorbed message whose turn was then stopped ends as stopped, not answered',async()=>{
 const {b,events}=make();
 b.send('first');await until(()=>fixture.heads[0]?.sent.length===1);
 const head=fixture.heads[0];
 b.send('second');await settle();
 const steeredId=head.sent[1].id.toLowerCase();
 head.item({kind:'result',ok:true,text:'Answer to first',subtype:'end_turn'});await settle();
 const appTurn=b.appMessage('(App: a report)')!;await settle();
 const appId=head.sent[2].id.toLowerCase();
 head.item({kind:'command',id:steeredId,state:'started'});await settle();
 head.item({kind:'command',id:appId,state:'cancelled'});await settle();
 expect(finished(events,appTurn)).toMatchObject({status:'stopped'});
 expect((b as any).deferred).toBeNull();
});

it('a line steered into a turn and taken in there leaves nothing behind (no turn of its own is made later)',async()=>{
 const {b}=make();
 b.send('first');await until(()=>fixture.heads[0]?.sent.length===1);
 const head=fixture.heads[0];
 b.send('second');await settle();
 const steeredId=head.sent[1].id.toLowerCase();
 head.item({kind:'command',id:steeredId,state:'completed'});
 head.item({kind:'result',ok:true,text:'Answer to both',subtype:'end_turn'});await settle();
 expect((b as any).steered.size).toBe(0);
 // A late "started" for it (it cannot come after its end, but if it did) makes no turn that waits forever.
 head.item({kind:'command',id:steeredId,state:'started'});await settle();
 expect((b as any).turn).toBeNull();
});

it('a steered line claude reads into the turn under way, saying "started" for it, is no turn of its own: that turn still ends (spec/models/turns, silentsteer)',async()=>{
 const {b,events}=make();
 const first=b.send('first').turnId!;await until(()=>fixture.heads[0]?.sent.length===1);
 const head=fixture.heads[0];
 const id=(i:number)=>head.sent[i].id.toLowerCase();
 head.item({kind:'command',id:id(0),state:'started'});
 // Two lines of yours go into the turn under way.
 b.send('second');await settle();b.send('third');await settle();
 expect(head.sent).toHaveLength(3);
 // claude reads the second into that turn and says "started" for it (3353d2d9), then ends the turn.
 head.item({kind:'command',id:id(1),state:'started'});await settle();
 head.item({kind:'command',id:id(1),state:'completed'});
 head.item({kind:'result',ok:true,text:'Answer to first and second',subtype:'end_turn'});
 head.item({kind:'command',id:id(0),state:'completed'});await settle();
 expect(finished(events,first)).toMatchObject({status:'done'});
 // The third, unread when that turn ended, gets a turn of its own, which ends with its result.
 head.item({kind:'command',id:id(2),state:'started'});await settle();
 expect((b as any).turn).not.toBeNull();
 head.item({kind:'result',ok:true,text:'Answer to third',subtype:'end_turn'});
 head.item({kind:'command',id:id(2),state:'completed'});await settle();
 expect((b as any).turn).toBeNull();
 expect((b as any).deferred).toBeNull();
 // Nothing waits behind a turn that never ends: the next message goes at once.
 b.appMessage('(App: a report)');await settle();
 expect(head.sent.at(-1).text).toContain('a report');
});

it('while a stopped turn drains, nothing begins: the turn set aside does not come back to take the stopped turn\'s end (drainnext)',async()=>{
 // claude ends the stopped turn in time however slow this run is (no tree kill).
 const {b,events}=make(600000);
 b.send('first');await until(()=>fixture.heads[0]?.sent.length===1);
 const head=fixture.heads[0];
 const id=(i:number)=>head.sent[i].id.toLowerCase();
 head.item({kind:'command',id:id(0),state:'started'});
 b.send('second');await settle();
 head.item({kind:'result',ok:true,text:'Answer to first',subtype:'end_turn'});head.item({kind:'command',id:id(0),state:'completed'});await settle();
 const appTurn=b.appMessage('(App: a report)')!;await settle();
 b.holdForSwap(true);
 // claude begins your second line: the app's turn is set aside, and you stop the second.
 head.item({kind:'command',id:id(1),state:'started'});await settle();
 const second=(b as any).turn.id;
 void b.stop(second);await settle();
 // The swap is called off while claude still ends the stopped turn: the app's turn stays aside.
 b.holdForSwap(false);await settle();
 expect((b as any).turn).toBeNull();
 head.item({kind:'command',id:id(2),state:'completed'});
 head.item({kind:'result',ok:false,text:'',subtype:'error_during_execution'});await settle();
 expect(finished(events,appTurn)).toMatchObject({status:'done'});
 expect((b as any).turn).toBeNull();
 expect((b as any).draining).toBeNull();
});
