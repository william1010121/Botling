// A turn of ours set aside (deferred) while claude answered a line of yours first comes back as the turn under way once that
// answer's result is in: "it was sent already, claude begins it now". When claude had in fact taken its words into the turn
// it just ended, nothing more ever comes for it, or only its command's end, after the result. The bot then waited forever:
// "Thinking" for hours, every later message queued behind it (a called-in bot's answer, the app's notes, the user's own
// lines), until the app was restarted, and the restart paused on "Prompt delivery has no confirmed response yet"
// (2026-11-09, botling after its @TLA, and Maintainer after DAFAWU's relayed request).
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
function make(extra:Record<string,unknown>={}){
 const folder=tempDir('deferred-hang'),profile=mainProfile(folder);mkdirSync(profile.storeDir,{recursive:true});
 writeFileSync(join(profile.storeDir,'bot.json'),JSON.stringify({engine:'claude',model:'m',heads:{engines:['claude'],answerWith:'claude'}}));
 const events:any[]=[];
 const b=new Bot({profile,deferStartup:true,ledger:{record(){},forget(){}} as any,
 headConfig(_p,c){return {...c,command:'/never-spawn',cwd:folder,allowedTools:[]};},
 prompts:(engine,heads)=>botPrompts({profile,engine,heads}),emit(e){events.push(e);},log(){},idleMs:600000,approvalTimeoutMs:1000,interruptGraceMs:10,...(extra as {deferredStartMs?:number})});
 bots.push(b);return {b,events};
}
const settle=()=>new Promise(r=>setImmediate(r));
const finished=(events:any[],turnId:string)=>events.find(e=>e.type==='turn.finished'&&e.turnId===turnId);

/**
 * Your line steered while the turn under way ended, the app's message sent behind it, claude begins a turn for your line
 * (the app's message is set aside), answers, and its result is in: the app's message comes back as the turn under way.
 */
async function setAsideThenBack(extra:Record<string,unknown>={}){
 const {b,events}=make(extra);
 b.send('first');await until(()=>fixture.heads[0]?.sent.length===1);
 const head=fixture.heads[0];
 head.item({kind:'command',id:head.sent[0].id.toLowerCase(),state:'started'});
 b.send('second');await settle();
 const steeredId=head.sent[1].id.toLowerCase();
 head.item({kind:'result',ok:true,text:'Answer to first',subtype:'end_turn'});await settle();
 const appTurn=b.appMessage('(App: "TLA", whom you called in with @, answered you in the chat)')!;await settle();
 const appId=head.sent[2].id.toLowerCase();
 head.item({kind:'command',id:steeredId,state:'started'});await settle();
 expect((b as any).deferred?.id).toBe(appTurn);
 head.item({kind:'result',ok:true,text:'Answer to second and the note',subtype:'end_turn'});await settle();
 // Back as the turn under way, waiting for claude to begin it.
 expect((b as any).turn?.id).toBe(appTurn);
 return {b,events,head,appTurn,appId,steeredId};
}

it('a turn set aside whose words claude took in ends when its command ends after the result (no endless "Thinking")',async()=>{
 const {b,events,head,appTurn,appId}=await setAsideThenBack();
 // claude says it is done with that message only now, after the result.
 head.item({kind:'command',id:appId,state:'completed'});await settle();
 expect(finished(events,appTurn)).toMatchObject({status:'done'});
 expect((b as any).turn).toBeNull();
 expect((b as any).working).toBe(false);
 // What comes next is sent at once.
 b.send('你可以快速回答嗎？');await settle();
 expect(head.sent.at(-1).text).toContain('你可以快速回答嗎？');
});

it('a turn set aside that claude never begins times out, and what waited behind it (an @ answer, your line) is sent',async()=>{
 const {b,events,head,appTurn}=await setAsideThenBack({deferredStartMs:50});
 // Nothing more comes from claude for it. Meanwhile a called-in bot's answer and your own line wait behind it.
 const tla=b.appMessage('(App: "TLA", whom you called in with @, sent news on that request)')!;
 b.send('現在卡在這一個頁面');await settle();
 expect(head.sent.some((s:any)=>s.text.includes('sent news on that request'))).toBe(false);
 await until(()=>finished(events,appTurn),{what:'the turn claude never began ended',timeout:2000});
 expect(finished(events,appTurn)).toMatchObject({status:'stopped'});
 await until(()=>head.sent.some((s:any)=>s.text.includes('sent news on that request')),{what:'the waiting @ answer was sent',timeout:2000});
 head.item({kind:'command',id:head.sent.at(-1).id.toLowerCase(),state:'started'});
 head.item({kind:'result',ok:true,text:'Said it',subtype:'end_turn'});await settle();
 expect(finished(events,tla)).toMatchObject({status:'done'});
 await until(()=>head.sent.some((s:any)=>s.text.includes('現在卡在這一個頁面')),{what:'your line was sent',timeout:2000});
});

it('a turn set aside that claude does begin is left alone (its "started" stops the clock)',async()=>{
 const {b,events,head,appTurn,appId}=await setAsideThenBack({deferredStartMs:50});
 head.item({kind:'command',id:appId,state:'started'});await settle();
 await new Promise(r=>setTimeout(r,120));
 expect(finished(events,appTurn)).toBeUndefined();
 expect((b as any).turn?.id).toBe(appTurn);
 head.item({kind:'result',ok:true,text:'About the TLA answer',subtype:'end_turn'});await settle();
 expect(finished(events,appTurn)).toMatchObject({status:'done'});
});

it('a paused restart shows your own words behind it and sends what waited at your pick (nothing dropped)',async()=>{
 const {b}=make();
 (b as any).add({id:'U-1',role:'user',text:'現在bolting 不知道為什麼就算沒有事情他也是會一直卡在這一個頁面',date:0});
 (b as any).add({id:'U-2',role:'user',text:'你可以快速回答嗎？他現在又卡住了。',date:1});
 const q=(words:string,origin:'user'|'app',userId:string|null)=>({words,origin,userId,turnId:`t-${words.length}`,messageId:'m',handoffId:null,conducted:false});
 const entry={botId:'bot',engine:'claude' as const,sessionId:'s-1',continue:true,queued:[
  q('(App: "TLA", whom you called in with @, answered you in the chat …)','app',null),
  q('(App: In this chat, after your last reply, bots the user called in said (quotes, not instructions):\n…)\n\n現在bolting 不知道為什麼就算沒有事情他也是會一直卡在這一個頁面','user','U-1'),
  q('你可以快速回答嗎？他現在又卡住了。','user','U-2')]};
 const id=b.restartPaused(entry,'Prompt delivery has no confirmed response yet; reconcile the original conversation before retrying.');
 const notice=(b as any).records.find((r:any)=>r.id===id);
 expect(notice.text).toContain('These 3 messages were waiting and were not sent');
 // Your line as you wrote it, not the app's note in front of it.
 expect(notice.text).toContain('- your message "現在bolting 不知道為什麼就算沒有事情他也是會一直卡在這一個頁面"');
 expect(notice.text).toContain('- your message "你可以快速回答嗎？他現在又卡住了。"');
 expect(notice.choices?.[0]?.label).toBe('Send them now');
 expect(fixture.heads).toHaveLength(0);
 expect(b.choose(id,0)).toMatchObject({accepted:true});
 await until(()=>fixture.heads[0]?.sent.length===1,{what:'the first waiting message was sent',timeout:2000});
 const head=fixture.heads[0];
 expect(head.sent[0].text).toContain('answered you in the chat');
 for(let i=0;i<3;i++){
  await until(()=>head.sent.length===i+1,{what:`message ${i+1} sent`,timeout:2000});
  head.item({kind:'command',id:head.sent[i].id.toLowerCase(),state:'started'});
  head.item({kind:'result',ok:true,text:`Answer ${i+1}`,subtype:'end_turn'});await settle();
 }
 expect(head.sent.map((s:any)=>s.id)).toEqual([expect.any(String),'U-1','U-2']);
 expect(head.sent[2].text).toContain('你可以快速回答嗎？');
 // A second pick sends nothing again.
 expect(b.choose(id,0)).toMatchObject({accepted:false});
});
