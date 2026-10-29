// Offline only: every engine constructor and every process spawn is replaced before importing Bot.
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const fixture=vi.hoisted(()=>{
 const heads:any[]=[];
 class Head {
  running=false;pid=2147483647;exited=Promise.resolve();completionDependencies:any[]=[];sent:string[]=[];answers:any[]=[];stopped=false;
  constructor(readonly engine:string,readonly config:any,readonly handlers:any){heads.push(this);}
  start(){this.running=true;if(this.engine==='codex'&&this.config.threads){this.config.threads.save('fixture-'+this.config.sessionId,this.config.sessionId);if(this.config.workerInstructions)this.config.threads.markManaged('fixture-'+this.config.sessionId,this.config.sessionId);}queueMicrotask(()=>this.handlers.onItem({kind:'init',sessionId:this.config.sessionId}));}
  send(text:string){this.sent.push(text);}
  answer(...args:any[]){this.answers.push(args);}
  steer(){return false;}
  emit(item:any){this.handlers.onItem(item);}
  finish(text:string,ok=true){this.emit({kind:'result',ok,text,error:ok?'':'fixture refused',subtype:ok?'end_turn':'permission_denied'});}
  interrupt(){queueMicrotask(()=>this.finish('',false));return 'fixture-cancel';}
  async terminate(){this.running=false;if(!this.stopped){this.stopped=true;this.handlers.onExit({code:0,signal:null,stderr:'',expected:true,silent:false});}return {killed:[],forced:false};}
 }
 return {heads,Head,runtimeError:''};
});

vi.mock('../../src/core/agent/agy-acp',()=>({verifyAcpRuntime(){if(fixture.runtimeError)throw Error(fixture.runtimeError);},AgyAcpHead:class extends fixture.Head{constructor(c:any,h:any){super('agy',c,h);}}}));
vi.mock('../../src/core/agent/codex',async original=>({...await original<any>(),CodexHead:class extends fixture.Head{constructor(c:any,h:any){super('codex',c,h);}}}));
vi.mock('../../src/core/agent/head',async original=>({...await original<any>(),ClaudeHead:class extends fixture.Head{constructor(c:any,h:any){super('claude',c,h);}}}));
vi.mock('../../src/core/process/tree',async original=>({...await original<any>(),processTreeAdapter:()=>({spawn(){throw Error('All process spawning forbidden in offline fixture');}})}));
vi.mock('../../src/core/process/ledger',async original=>({...await original<any>(),processStartTime:()=> 'fixture-start'}));
import {Bot} from '../../src/core/bot';
import {mainProfile} from '../../src/core/store/workspace';
import {botPrompts} from '../../src/core/prompts';
import {CodexThreads} from '../../src/core/agent/codex';
import {AgyWorkers} from '../../src/core/agent/agy-workers';
import {createAgyWorkerHead,codexWorkerConfig} from '../../src/core/agent/agy-worker-router';
import {until} from '../helpers';
const bots:Bot[]=[],managers:AgyWorkers[]=[];
const settle=()=>new Promise<void>(r=>setImmediate(r));
afterEach(async()=>{await Promise.all(managers.splice(0).map(m=>m.close()));for(const b of bots.splice(0))await b.shutdown({tidy:false});fixture.heads.length=0;fixture.runtimeError="";vi.restoreAllMocks();});
function workspace(){return mkdtempSync(join(tmpdir(),'agy-mixed-offline-'));}
function bot(owner:'agy'|'codex'|'claude',folder=workspace()){
 const profile=mainProfile(folder);mkdirSync(profile.storeDir,{recursive:true});
 if(!existsSync(join(profile.storeDir,'bot.json')))writeFileSync(join(profile.storeDir,'bot.json'),JSON.stringify({engine:owner,heads:{engines:['claude','codex','agy'],answerWith:owner}}));
 const events:any[]=[];
 const b=new Bot({profile,deferStartup:true,welcome:false,ledger:{record(){},forget(){}} as any,headConfig(_p,c){return {...c,command:'/never-spawned',cwd:folder,allowedTools:[]};},
  agyConfig(_p,c){return {...c,transport:'acp',acpHome:join(profile.storeDir,'agy'),command:'/never-spawned'};},
  codexConfig(_p,c){return {command:'/never-spawned',cwd:folder,threads:new CodexThreads(join(profile.storeDir,'codex')),sessionId:c.sessionId,resume:c.resume,instructions:c.systemPrompt,workerInstructions:c.workerInstructions};},
  prompts:(engine,heads)=>botPrompts({profile,engine,heads}),emit:e=>events.push(e),log(){},idleMs:600_000,approvalTimeoutMs:10_000,interruptGraceMs:10});bots.push(b);return {b,folder,events};
}

it.each(['claude','codex','agy'] as const)('sends once to chosen %s and routes independent tasks to the other engines',async owner=>{
 const h=bot(owner);h.b.send('primary-only task');await until(()=>fixture.heads.some(x=>x.sent.length));
 expect(fixture.heads.filter(x=>x.sent.length).map(x=>x.engine)).toEqual([owner]);
 const peers=(['claude','codex','agy'] as const).filter(x=>x!==owner);
 for(const peer of peers) h.b.send('independent '+peer,{to:peer});
 await until(()=>fixture.heads.filter(x=>x.sent.length).length===3);
 expect(h.b.snapshot().runs.map(x=>x.head).sort()).toEqual(['agy','claude','codex']);
 for(const head of fixture.heads)head.finish('done '+head.engine);
 await settle();
});

it.each([['claude','codex'],['claude','agy'],['codex','claude'],['codex','agy'],['agy','claude'],['agy','codex']] as const)('correlates %s → %s handoff and returns evidence once',async(owner,peer)=>{
 const h=bot(owner);h.b.send('authorized research only');await until(()=>fixture.heads.some(x=>x.engine===owner&&x.sent.length));
 const lead=fixture.heads.find(x=>x.engine===owner);lead.finish(`<handoff to="${peer}" kind="task">Research only. No implementation. Report findings.</handoff>`);
 await until(()=>fixture.heads.some(x=>x.engine===peer&&x.sent.length));const helper=fixture.heads.find(x=>x.engine===peer);
 expect(helper.sent[0]).toContain('Research only. No implementation.');
 helper.finish('peer evidence');await until(()=>lead.sent.length===2);
 expect(lead.sent[1]).toContain('peer evidence');lead.finish('accepted findings');await settle();
 expect((h.b as any).conductor.records.every((r:any)=>r.state==='done')).toBe(true);
 helper.finish('duplicate late result');await settle();expect(lead.sent).toHaveLength(2);
});
it('keeps concurrent handoffs separate when their replies finish out of order',async()=>{
 const h=bot('claude');h.b.send('task A');await until(()=>fixture.heads.some(x=>x.engine==='claude'&&x.sent.length));
 const lead=fixture.heads.find(x=>x.engine==='claude');lead.finish('<handoff to="codex" kind="task">scope A</handoff>');
 await until(()=>fixture.heads.some(x=>x.engine==='codex'&&x.sent.length));
 h.b.send('task B');await until(()=>lead.sent.length===2);lead.finish('<handoff to="agy" kind="task">scope B</handoff>');
 await until(()=>fixture.heads.some(x=>x.engine==='agy'&&x.sent.length));
 const records=(h.b as any).conductor.records;expect(records).toHaveLength(2);
 const agy=fixture.heads.find(x=>x.engine==='agy'),codex=fixture.heads.find(x=>x.engine==='codex');
 agy.finish('evidence B');await until(()=>lead.sent.length===3);expect(lead.sent[2]).toContain('evidence B');lead.finish('accept B');
 await settle();codex.finish('evidence A');await until(()=>lead.sent.length===4);expect(lead.sent[3]).toContain('evidence A');lead.finish('accept A');await settle();
 expect(records.every((r:any)=>r.state==='done')).toBe(true);
});
it('stops only the selected chain and ignores its late report while another peer continues',async()=>{
 const h=bot('claude');h.b.send('task A');await until(()=>fixture.heads[0]?.sent.length);
 const lead=fixture.heads[0];lead.finish('<handoff to="codex" kind="task">scope A</handoff>');await until(()=>fixture.heads.some(x=>x.engine==='codex'&&x.sent.length));
 h.b.send('task B');await until(()=>lead.sent.length===2);lead.finish('<handoff to="agy" kind="task">scope B</handoff>');await until(()=>fixture.heads.some(x=>x.engine==='agy'&&x.sent.length));
 const first=(h.b as any).conductor.records[0];expect(h.b.stopHandoff(first.id).stopped).toBe(true);await settle();
 fixture.heads.find(x=>x.engine==='codex').finish('late cancelled evidence');await settle();expect(lead.sent).toHaveLength(2);
 fixture.heads.find(x=>x.engine==='agy').finish('surviving evidence');await until(()=>lead.sent.length===3);expect(lead.sent[2]).toContain('surviving evidence');lead.finish('accepted');
});
it('separates permission cards with identical provider ids across three engines',async()=>{
 const h=bot('claude');for(const to of ['claude','codex','agy'] as const)h.b.send('authorized task '+to,{to});
 await until(()=>fixture.heads.filter(x=>x.sent.length).length===3);
 for(const head of fixture.heads)head.emit({kind:'permission',requestId:'same',tool:'write',summary:head.engine+' only',input:{path:head.engine}});
 const cards=h.b.snapshot().messages.filter(m=>m.approval);expect(cards).toHaveLength(3);
 for(const engine of ['agy','claude','codex']){
  const card=cards.find(m=>m.text.includes(engine+' only'))!;h.b.choose(card.id,card.choices!.length-1);
  expect(fixture.heads.find(x=>x.engine===engine).answers).toHaveLength(1);
 }
 for(const head of fixture.heads){expect(head.answers[0][1]).toBe(false);expect(head.answers[0][2]).toEqual({path:head.engine});head.finish('refused',false);}
});
it('preserves history and primary selection over settings migration and restart',async()=>{
 const h=bot('codex');const settings=join(mainProfile(h.folder).storeDir,'bot.json');
 h.b.send('history to keep');await until(()=>fixture.heads.some(x=>x.sent.length));fixture.heads[0].finish('saved answer');await settle();
 const before=h.b.snapshot().messages.map(m=>[m.id,m.text]);const starts=fixture.heads.length;
 h.b.setAnswerWith('agy');await h.b.setHeads(['claude','codex','agy']);expect(h.b.heads.answerWith).toBe('agy');
 await h.b.shutdown({tidy:false});bots.splice(bots.indexOf(h.b),1);
 const raw=JSON.parse(readFileSync(settings,'utf8'));raw.heads.answerWith='both';writeFileSync(settings,JSON.stringify(raw));
 const resumed=bot('codex',h.folder);expect(resumed.b.heads.answerWith).toBe('codex');
 expect(JSON.parse(readFileSync(settings,'utf8')).heads.answerWith).toBe('codex');expect(fixture.heads).toHaveLength(starts);expect(resumed.b.snapshot().messages.map(m=>[m.id,m.text])).toEqual(before);
});
it('keeps explicit primary selection available when delegation is disabled',async()=>{
 const h=bot('claude');(h.b as any).headsSettings.handoffs=false;h.b.send('explicit agy',{to:'agy'});
 await until(()=>fixture.heads.some(x=>x.engine==='agy'&&x.sent.length));fixture.heads[0].finish('<handoff to="codex" kind="task">must not delegate</handoff>');await settle();
 expect(fixture.heads.map(x=>x.engine)).toEqual(['agy']);
});

it('fails closed on unavailable provider or invalid ACP runtime before dispatch',async()=>{
 const h=bot('claude');fixture.runtimeError='runtime signature rejected';
 expect(()=>(h.b as any).deliverTo('agy','must not run',null)).toThrow('runtime signature rejected');
 expect(fixture.heads).toHaveLength(0);expect(h.b.peers).toHaveLength(2);
 fixture.runtimeError='';(h.b as any).options.agyConfig=(_p:any,c:any)=>({...c,transport:undefined});
 expect(()=>(h.b as any).deliverTo('agy','must not run',null)).toThrow('pre-task policy barrier');
 (h.b as any).options.codexConfig=undefined;
 expect(()=>(h.b as any).deliverTo('codex','must not run',null)).toThrow('Codex is not available');
 expect(fixture.heads).toHaveLength(0);expect(h.b.peers).toHaveLength(2);
});
it('routes Stop to every engine by turn id without stopping independent peers',async()=>{
 const h=bot('claude');for(const to of ['claude','codex','agy'] as const)h.b.send('independent '+to,{to});
 await until(()=>fixture.heads.filter(x=>x.sent.length).length===3);
 const runs=h.b.snapshot().runs;
 for(const engine of ['agy','codex','claude']){
  const run=runs.find(r=>r.head===engine)!;expect((await h.b.stop(run.turnId)).stopped).toBe(true);
  await settle();expect(h.b.snapshot().runs.some(r=>r.turnId===run.turnId)).toBe(false);
 }
 expect(h.b.snapshot().runs).toEqual([]);
});
it('supplies Antigravity the same explicit delegation scope and recipient protocol',()=>{
 const h=bot('agy');const prompt=(h.b as any).prompts().system;
 expect(prompt).toContain('one primary recipient');expect(prompt).toContain('claude, codex');
 expect(prompt).toContain('authorized phase, exact scope');expect(prompt).not.toContain('mixed-engine sessions are disabled');
});

it('lets settings remove the storage owner while retaining two selected recipients',async()=>{
 const h=bot('claude');await h.b.setHeads(['codex','agy']);expect(h.b.settingsView().engines).toEqual(['codex','agy']);
 expect(h.b.heads.answerWith).toBe('codex');h.b.send('selected remaining owner');await until(()=>fixture.heads.some(x=>x.sent.length));
 expect(fixture.heads.filter(x=>x.sent.length).map(x=>x.engine)).toEqual(['codex']);fixture.heads[0].finish('done');
});

// Combined integration: real Bot peer routing and durable journal, offline provider events.
import {RestartJournal, RESTART_FILE} from '../../src/core/restart-continuation';
it.each(['claude','codex','agy'] as const)('recovers all original peer sessions once with %s as storage owner',async owner=>{
 const h=bot(owner);
 for(const to of ['claude','codex','agy'] as const)h.b.send('unfinished authorized research '+to,{to});
 await until(()=>fixture.heads.filter(x=>x.sent.length).length===3);
 for(const head of fixture.heads){head.restartTurn='original-provider-turn';head.emit({kind:'stepText',text:'Confirmed original work'});}
 const entries=h.b.restartEntries();expect(entries).toHaveLength(3);expect(entries.every(e=>!e.blocked)).toBe(true);
 const journal=new RestartJournal(h.folder);journal.prepare(entries);journal.ready();
 await h.b.shutdown({tidy:false});bots.splice(bots.indexOf(h.b),1);
 const before=fixture.heads.length,resumed=bot(owner,h.folder),notice=vi.fn();
 journal.recover(entry=>{
  const durable=JSON.parse(readFileSync(join(h.folder,RESTART_FILE),'utf8'));
  expect(durable.entries.find((e:any)=>e.engine===entry.engine).state).toBe('claimed');
  resumed.b.adoptRestart(entry);
 },notice);
 await until(()=>fixture.heads.slice(before).filter(x=>x.sent.length).length===3);
 expect(notice).not.toHaveBeenCalled();
 for(const entry of entries){
  const head=fixture.heads.slice(before).find(x=>x.engine===entry.engine);
  expect(head.config).toMatchObject({sessionId:entry.sessionId,resume:true});
  expect(head.sent).toHaveLength(1);expect(head.sent[0]).toContain('permissions and cancellations');
  head.finish('recovered original work');
 }
 await settle();
 const duplicate=vi.fn();new RestartJournal(h.folder).recover(duplicate,notice);expect(duplicate).not.toHaveBeenCalled();
 expect(resumed.b.peers).toHaveLength(2);
});
