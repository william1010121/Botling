import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Bot} from '../../src/core/bot';
import {botPrompts} from '../../src/core/prompts';
import {ProcessLedger} from '../../src/core/process/ledger';
import {mainProfile} from '../../src/core/store/workspace';
import {tempDir,until} from '../helpers';
const bots:Bot[]=[];
afterEach(async()=>{for(const b of bots.splice(0))await b.shutdown({tidy:false});});
const session='11111111-2222-4333-8444-555555555555';
function harness(){
 const dir=tempDir('agy-recovery'),profile=mainProfile(dir),launches:any[]=[],events:any[]=[];
 mkdirSync(profile.storeDir,{recursive:true});const settings=join(profile.storeDir,'bot.json');
 writeFileSync(settings,JSON.stringify({engine:'agy',heads:{engines:['agy'],answerWith:'agy'},agyConversation:session}));
 const make=()=>{const b=new Bot({profile,deferStartup:true,welcome:false,ledger:new ProcessLedger(join(dir,'ledger.json')),headConfig(){throw Error('No other agent');},agyConfig(_p,c){launches.push(c);return c;},prompts:()=>botPrompts({profile,engine:'agy'}),emit:e=>events.push(e),log(){},approvalTimeoutMs:100,idleMs:60000,interruptGraceMs:10});bots.push(b);return b;};
 const say=async(b:Bot)=>{const {turnId}=b.send('explicit next message');await until(()=>events.some(e=>e.type==='turn.finished'&&e.turnId===turnId));};
 return {make,launches,events,say,saved:()=>JSON.parse(readFileSync(settings,'utf8'))};
}
it('preserves failed resume identity and recovery across next message and restart',async()=>{
 const h=harness(),b=h.make(),head={pid:-1,running:false};(b as any).head=head;
 (b as any).onExit(head,{code:1,signal:null,stderr:'resume failed',expected:false,silent:true});
 expect(h.saved()).toMatchObject({agyConversation:session,agyRecovery:{sessionId:session,state:'resume-required'}});
 await h.say(b);expect(h.launches).toHaveLength(1);expect(h.launches[0]).toMatchObject({sessionId:session,resume:true});
 await b.shutdown({tidy:false});await h.say(h.make());expect(h.launches).toHaveLength(2);expect(h.launches[1]).toMatchObject({sessionId:session,resume:true});
 expect(h.saved()).toMatchObject({agyConversation:session,agyRecovery:{state:'resume-required'}});
});
it('refuses engine selection and clears identity only on intentional new-session',async()=>{
 const h=harness(),b=h.make();await expect(b.setHeads(['agy'])).rejects.toThrow('pre-task policy barrier');
 (b as any).newSession();expect(h.saved().agyConversation).toBeUndefined();expect(h.saved().agyRecovery).toBeUndefined();
});
it('never imports persistent allow rules into ACP approval cards',async()=>{
 const h=harness(),b=h.make(),answers:any[]=[];
 (b as any).alwaysAllowed=['Antigravity tool'];
 const head={running:true,answer:(...args:any[])=>answers.push(args)};
 (b as any).ask(head,{kind:'permission',requestId:'acp:7',tool:'Antigravity tool',summary:'write a file',input:{}},null);
 expect(answers).toEqual([]);
 const card=(b as any).records.findLast((r:any)=>r.permissionTool==='Antigravity tool');
 expect(card.choices.map((c:any)=>c.action)).toEqual(['allowOnce','deny']);
 b.choose(card.id,1);expect(answers[0][1]).toBe(false);
});

it('engine switching retains agy identity; only an intentional new chat clears it',()=>{
 const h=harness(),b=h.make();(b as any).becomeEngine('codex');expect(h.saved().agyConversation).toBe(session);
 (b as any).becomeEngine('agy');expect((b as any).session).toMatchObject({sessionId:session,started:true});
 (b as any).newSession();expect(h.saved().agyConversation).toBeUndefined();
});

it('rejects mixed-engine selection before runtime provisioning or partner startup',async()=>{
 const h=harness(),b=h.make();await expect(b.setHeads(['codex','agy'])).rejects.toThrow('mixed-engine');expect(h.launches).toEqual([]);expect(b.settingsView().engines).toEqual(['agy']);
});

it('successful agy handoff tags cannot route another engine',()=>{
 const h=harness(),b=h.make() as any,routes:string[]=[];
 const intercept=vi.spyOn(Bot.prototype as any,'route').mockImplementation(function(this:any,turn:any){routes.push(this.engine);turn.open=false;turn.resolve('stopped');return turn;});
 try {
  for(const target of ['claude','codex']){
   const turn=b.newTurn('app','offline regression',null);turn.reply.add({kind:'delta',text:`<handoff to="${target}" kind="task">offline fixture</handoff>`});
   b.finishTurn(turn,'done');
  }
  expect(routes).toEqual([]);expect(b.partner).toBeNull();expect(h.launches).toEqual([]);
 }finally{intercept.mockRestore();}
});
it('restored conductor card actions cannot route Claude from agy',()=>{
 const h=harness(),b=h.make() as any,routes:string[]=[];
 const intercept=vi.spyOn(Bot.prototype as any,'route').mockImplementation(function(this:any,turn:any){routes.push(this.engine);turn.open=false;turn.resolve('stopped');return turn;});
 try{
  b.conduct([{type:'card',text:'restored choice',choices:[{label:'Go with Claude',pick:{goWith:'claude'}}]}]);
  const card=b.records.findLast((r:any)=>r.text==='restored choice');b.choose(card.id,0);
  expect(routes).toEqual([]);expect(b.partner).toBeNull();
 }finally{intercept.mockRestore();}
});

it('direct and stale partner execution cannot bypass the agy route barrier',()=>{
 const h=harness(),b=h.make() as any;
 for(const target of ['claude','codex']){
  expect(()=>b.makePartner(target)).toThrow('cross-engine');
  expect(()=>b.deliverTo(target,'offline',null)).toThrow('cross-engine');
 }
 const stale=h.make() as any;stale.options.primary=b;stale.engine='claude';b.partner=stale;
 expect(()=>b.makePartner('claude')).toThrow('cross-engine');
 expect(()=>b.deliverTo('claude','offline',null)).toThrow('cross-engine');
 expect(()=>stale.route(stale.newTurn('app','offline',null))).toThrow('cross-engine');
 let sent=false;stale.head={running:true,send(){sent=true;}};expect(()=>stale.ensureHead()).toThrow('cross-engine');
 const pending=stale.newTurn('app','offline',null);pending.sent=true;pending.head=stale.head;stale.turn=pending;
 expect(stale.hearNow('must not steer',[])).toBe(false);b.tell('claude','must not queue',[]);expect(sent).toBe(false);expect(stale.pendingNote).toBeFalsy();stale.turn=null;stale.head=null;b.partner=null;stale.options.primary=null;
 expect(h.launches).toEqual([]);
});
it('reverse Codex to agy routing is also blocked without affecting the legacy pair policy',()=>{
 const h=harness(),b=h.make() as any;b.becomeEngine('codex');b.headsSettings.engines=['codex'];
 expect(()=>b.deliverTo('agy','offline',null)).toThrow('cross-engine');
 expect(b.allowsEngineRoute('claude','codex')).toBe(true);expect(h.launches).toEqual([]);
});

it('restored conductor handoffs stop rather than dispatching a forbidden engine',()=>{
 const h=harness(),b=h.make() as any;
 const actions=b.conductor.replied('agy','offline',{to:'claude',kind:'task',task:'offline',decisionId:null},false,null);
 expect(actions.some((a:any)=>a.type==='ask')).toBe(true);
 b.conduct(actions);expect(b.partner).toBeNull();expect(b.conductor.records.every((r:any)=>r.state==='stopped')).toBe(true);expect(b.rounds).toBeNull();expect(h.launches).toEqual([]);
});

it('keeps Token Flow history valid for an agy owner without attributing agy counters to another engine',async()=>{
 const {tokenFlowHistory}=await import('../../src/core/token-flow-history');
 const {TokenFlowHistoryView}=await import('../../src/contract');
 const {readSubagent}=await import('../../src/core/subagents');
 const b=harness().make();
 const row={id:'agy-child',description:'unsupported metering',startedAt:100,endedAt:200,status:'completed',outputTokenCounters:{'message:agy':99},prompt:'',steps:[]};
 b.subagents.list.push(readSubagent(row)!);
 const partner=join(b.profile.storeDir,'partner-codex');mkdirSync(partner,{recursive:true});
 writeFileSync(join(partner,'subagents.json'),JSON.stringify([{...row,id:'saved-codex',outputTokenCounters:{'message:codex':20}}]));
 const view=TokenFlowHistoryView.parse(await tokenFlowHistory(b));
 expect(view.rows.map(r=>[r.id,r.head])).toEqual([['saved-codex','codex']]);
 expect(b.partner).toBeNull();
});
