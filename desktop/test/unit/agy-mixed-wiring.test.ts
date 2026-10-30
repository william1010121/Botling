// Offline only: every engine constructor and every process spawn is replaced before importing Bot.
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const fixture=vi.hoisted(()=>{
 const heads:any[]=[];
 class Head {
  running=false;pid=2147483647;exited=Promise.resolve();completionDependencies:any[]=[];sent:string[]=[];answers:any[]=[];stopped=false;
  constructor(readonly engine:string,readonly config:any,readonly handlers:any){heads.push(this);}
  start(){this.running=true;if(this.engine==='codex'&&this.config.threads){this.config.threads.save('fixture-'+this.config.sessionId,this.config.sessionId);if(this.config.workerInstructions)this.config.threads.markManaged('fixture-'+this.config.sessionId,this.config.sessionId);}queueMicrotask(()=>this.handlers.onItem({kind:'init',sessionId:this.config.sessionId}));}
  send(text:string){this.sent.push(text);}
  answer(...args:any[]){this.answers.push(args);this.answerHandler?.(...args);}
  answerHandler?: (...args:any[])=>void;
  interruptHandler?: ()=>void;
  steer(){return false;}
  emit(item:any){this.handlers.onItem(item);}
  finish(text:string,ok=true){this.emit({kind:'result',ok,text,error:ok?'':'fixture refused',subtype:ok?'end_turn':'permission_denied'});}
  interrupt(){this.interruptHandler?.();queueMicrotask(()=>this.finish('',false));return 'fixture-cancel';}
  async terminate(){this.running=false;if(!this.stopped){this.stopped=true;this.handlers.onExit({code:0,signal:null,stderr:'',expected:true,silent:false});}return {killed:[],forced:false};}
 }
 return {heads,Head};
});
vi.mock('../../src/core/agent/agy-capabilities',()=>({agyWorkerRuntimeEnabled:()=>true,agyMixedRuntimeEnabled:()=>true,agyPairAllowed:(a:string,b:string)=>(a==='agy'&&b==='codex')||(a==='codex'&&b==='agy')}));
vi.mock('../../src/core/agent/agy-acp',()=>({verifyAcpRuntime(){},AgyAcpHead:class extends fixture.Head{constructor(c:any,h:any){super('agy',c,h);}}}));
vi.mock('../../src/core/agent/codex',async original=>({...await original<any>(),CodexHead:class extends fixture.Head{constructor(c:any,h:any){super('codex',c,h);}}}));
vi.mock('../../src/core/agent/head',async original=>({...await original<any>(),ClaudeHead:class{constructor(){throw Error('Claude construction forbidden in offline fixture');}}}));
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
afterEach(async()=>{await Promise.all(managers.splice(0).map(m=>m.close()));for(const b of bots.splice(0))await b.shutdown({tidy:false});fixture.heads.length=0;vi.restoreAllMocks();});
function workspace(){return mkdtempSync(join(tmpdir(),'agy-mixed-offline-'));}
function bot(owner:'agy'|'codex',folder=workspace()){
 const profile=mainProfile(folder);mkdirSync(profile.storeDir,{recursive:true});
 if(!existsSync(join(profile.storeDir,'bot.json')))writeFileSync(join(profile.storeDir,'bot.json'),JSON.stringify({engine:owner,heads:{engines:['codex','agy'],answerWith:owner}}));
 const events:any[]=[];
 const b=new Bot({profile,deferStartup:true,welcome:false,ledger:{record(){},forget(){}} as any,headConfig(){throw Error('Claude forbidden');},
  agyConfig(_p,c){return {...c,transport:'acp',acpHome:join(profile.storeDir,'agy'),command:'/never-spawned'};},
  codexConfig(_p,c){return {command:'/never-spawned',cwd:folder,threads:new CodexThreads(join(profile.storeDir,'codex')),sessionId:c.sessionId,resume:c.resume,instructions:c.systemPrompt,workerInstructions:c.workerInstructions};},
  prompts:(engine,heads)=>botPrompts({profile,engine,heads}),emit:e=>events.push(e),log(){},idleMs:600_000,approvalTimeoutMs:10_000,interruptGraceMs:10});bots.push(b);return {b,folder,events};
}
it.each(['agy','codex'] as const)('routes a successful %s handoff to the other engine and back, without Claude',async owner=>{
 const h=bot(owner),peer=owner==='agy'?'codex':'agy';h.b.send('offline authorized fixture');
 await until(()=>fixture.heads.some(x=>x.engine===owner&&x.sent.length));const lead=fixture.heads.find(x=>x.engine===owner)!;
 lead.finish(`<handoff to="${peer}" kind="task">offline fixture only</handoff>`);
 await until(()=>fixture.heads.some(x=>x.engine===peer&&x.sent.length));const helper=fixture.heads.find(x=>x.engine===peer)!;
 helper.finish('correlated peer evidence');await until(()=>lead.sent.length===2);
 expect(lead.sent[1]).toContain('correlated peer evidence');lead.finish('owner accepts fixture');await settle();
 expect((h.b as any).conductor.records.every((r:any)=>r.state==='done')).toBe(true);
 expect(fixture.heads.every(x=>x.engine!=='claude')).toBe(true);
 expect(()=>(h.b as any).deliverTo('claude','not enabled',null)).toThrow();
});
it('blocked peer result never hands back successful evidence',async()=>{
 const h=bot('agy');h.b.send('offline');await until(()=>fixture.heads[0]?.sent.length);
 const lead=fixture.heads[0];lead.finish('<handoff to="codex" kind="task">offline</handoff>');await until(()=>fixture.heads.some(x=>x.engine==='codex'&&x.sent.length));
 const peer=fixture.heads.find(x=>x.engine==='codex');peer.finish('denied',false);await settle();expect(lead.sent).toHaveLength(1);
 expect(h.events.some(e=>e.type==='turn.finished'&&e.status==='failed')).toBe(true);
});
it('worker transport selection pins engine, permissions, report/run identity and resume without fallback',async()=>{
 const home=workspace(),reports:any[]=[];vi.spyOn(process,'kill').mockImplementation((()=>{throw Object.assign(Error('absent'),{code:'ESRCH'});}) as any);
 const config:any={command:'/never-spawned',cwd:home,acpHome:join(home,'profile'),sessionId:'owner',resume:false,codexWorkerConfig:(c:any)=>({command:'/never-spawned',cwd:home,sessionId:c.sessionId,resume:c.resume,threads:new CodexThreads(join(home,'wrong-shared')),instructions:'',workerInstructions:'must be removed',autoMode:true,bypassPermissions:true,writableRoots:['/'],componentEditor:{must:'be removed'}})};
 const make=(resume:boolean)=>{const m=new AgyWorkers({...config,resume},()=>{},(id,text,run)=>reports.push({id,text,run}),(c,h)=>createAgyWorkerHead(c,h,(a,b)=>new fixture.Head('agy',a,b)));managers.push(m);return m;};
 const m=make(false),a=await m.tool('app_handoff',{instructions:'offline agy',engine:'agy'}),c=await m.tool('app_handoff',{instructions:'offline codex',engine:'codex'});await settle();
 const agy=fixture.heads.find(x=>x.engine==='agy'),codex=fixture.heads.find(x=>x.engine==='codex');
 expect(codex.config).toMatchObject({autoMode:false,bypassPermissions:false,writableRoots:[],workerInstructions:null,componentEditor:null,routinesFile:null,retryLog:null});
 expect(codex.config.threads.folder).toBe(join(config.acpHome,'workers',c.task_id,'codex'));
 codex.config.threads.save('fixture-thread',codex.config.sessionId);
 agy.emit({kind:'permission',requestId:'p',tool:'write',summary:'A',input:{path:'a'}});codex.emit({kind:'permission',requestId:'p',tool:'write',summary:'C',input:{path:'c'}});
 m.answer(`worker:${a.task_id}:1:p`,true,{path:'c'});expect(agy.answers).toEqual([]);
 m.answer(`worker:${a.task_id}:1:p`,false,{path:'a'});m.answer(`worker:${c.task_id}:1:p`,false,{path:'c'});
 agy.finish('refused',false);codex.finish('refused',false);await settle();expect(reports.map(r=>r.run)).toEqual([1,1]);
 expect(m.beginReport(c.task_id,1)).toBe(true);await m.tool('app_task_checkpoint',{task_id:c.task_id,run:1,outcome:'complete',evidence:'fixture acceptance passed'});
 await expect(m.tool('app_send_message',{task_id:c.task_id,run:1,engine:'agy',message:'wrong'})).rejects.toThrow('engine identity');
 await m.close();const resumed=make(true);await resumed.tool('app_send_message',{task_id:c.task_id,run:1,message:'explicit followup'});await settle();
 expect(fixture.heads.at(-1).engine).toBe('codex');expect(fixture.heads.at(-1).config).toMatchObject({resume:true,sessionId:codex.config.sessionId});
 await expect(resumed.tool('app_cancel_task',{task_id:c.task_id,run:1})).rejects.toThrow('Stale');
 await resumed.tool('app_cancel_task',{task_id:c.task_id,run:2});expect(fixture.heads.at(-1).stopped).toBe(true);
 await expect(resumed.tool('app_handoff',{instructions:'forbidden',engine:'claude'})).rejects.toThrow('Claude');
});
it('missing Codex worker mapping fails closed before constructing a replacement head',()=>{
 const home=workspace(),before=fixture.heads.length;
 expect(()=>codexWorkerConfig({command:'none',cwd:home,acpHome:home,sessionId:'missing',resume:true,codexWorkerConfig:()=>({}) as any})).toThrow('mapping missing');
 expect(fixture.heads).toHaveLength(before);
});

it('stopping an active mixed handoff revokes handback and ignores a late successful result',async()=>{
 const h=bot('codex');h.b.send('offline');await until(()=>fixture.heads[0]?.sent.length);
 const lead=fixture.heads[0];lead.finish('<handoff to="agy" kind="task">offline</handoff>');await until(()=>fixture.heads.some(x=>x.engine==='agy'&&x.sent.length));
 const peer=fixture.heads.find(x=>x.engine==='agy'),record=(h.b as any).conductor.records[0];
 expect(h.b.stopHandoff(record.id).stopped).toBe(true);await settle();peer.finish('late success');await settle();
 expect(lead.sent).toHaveLength(1);expect((h.b as any).conductor.records[0].state).toBe('stopped');
});
it('reconstructs both selected engines with distinct saved conversation identities',async()=>{
 const h=bot('agy');h.b.send('first');await until(()=>fixture.heads.some(x=>x.engine==='agy'&&x.sent.length));
 fixture.heads.find(x=>x.engine==='agy').finish('done');await settle();
 (h.b as any).deliverTo('codex','first peer',null);await until(()=>fixture.heads.some(x=>x.engine==='codex'&&x.sent.length));fixture.heads.find(x=>x.engine==='codex').finish('done');await settle();
 const identities=Object.fromEntries(fixture.heads.map(x=>[x.engine,x.config.sessionId]));expect(identities.agy).not.toBe(identities.codex);
 await h.b.shutdown({tidy:false});const count=fixture.heads.length,restored=bot('agy',h.folder);
 restored.b.send('explicit continuation');await until(()=>fixture.heads.length>count&&fixture.heads.at(-1).sent.length);
 expect(fixture.heads.at(-1).config).toMatchObject({sessionId:identities.agy,resume:true});fixture.heads.at(-1).finish('done');await settle();
 (restored.b as any).deliverTo('codex','explicit peer continuation',null);await until(()=>fixture.heads.length>count+1&&fixture.heads.at(-1).sent.length);
 expect(fixture.heads.at(-1).config).toMatchObject({sessionId:identities.codex,resume:true});fixture.heads.at(-1).finish('done');
});
it('mixed Codex refusal cannot be erased by a later successful result',async()=>{
 const h=bot('codex');const turn=h.b.send('offline denied action');await until(()=>fixture.heads[0]?.sent.length);const head=fixture.heads[0];
 head.emit({kind:'permission',requestId:'request',tool:'write',summary:'fixture write',input:{path:'x'}});
 const card=h.b.snapshot().messages.findLast(m=>m.approval);expect(card).toBeDefined();const deny=card!.choices!.findIndex(c=>c.label==="Don't allow");expect(deny).toBeGreaterThanOrEqual(0);h.b.choose(card!.id,deny);
 expect(head.answers[0][1]).toBe(false);head.finish('operation denied',true);await settle();
 expect(h.events.find(e=>e.type==='turn.finished'&&e.turnId===turn.turnId).status).toBe('failed');
});
it('app_handoff from an agy turn dispatches immediately without an approval card',async()=>{
 const {AgyMcpBridge}=await import('../../src/core/agent/agy-mcp');
 const h=bot('agy'),priorHeads=fixture.heads.length,turn=h.b.send('offline authorized request');await until(()=>fixture.heads.slice(priorHeads).some(x=>x.engine==='agy'&&x.sent.length));
 const lead=fixture.heads.slice(priorHeads).find(x=>x.engine==='agy')!,privatePath=join(h.folder,'.private-profile');mkdirSync(privatePath);
 const dispatch=vi.fn(async()=>({task_id:'task-auto',status:'accepted'}));
 const bridge=new AgyMcpBridge(h.folder,privatePath,dispatch,undefined,undefined,undefined,item=>lead.emit(item));
 try{
  const endpoint=await bridge.start();bridge.beginTurn();
  const res=await fetch(endpoint.url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'app_handoff',arguments:{instructions:'authorized auto',name:'auto'}}})}).then(r=>r.json());
  expect(res).toMatchObject({result:{isError:false}});
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(h.b.snapshot().messages.some(m=>m.approval?.tool==='app_handoff')).toBe(false);
  lead.finish('accepted');await until(()=>h.events.some(e=>e.type==='turn.finished'&&e.turnId===turn.turnId));
 }finally{await bridge.close();}
});
it.each([false,true])('worker-owned handback waits for its report and respects stop=%s',async stop=>{
 const h=bot('codex');h.b.send('offline');await until(()=>fixture.heads[0]?.sent.length);const lead=fixture.heads[0];
 lead.finish('<handoff to="agy" kind="task">offline worker task</handoff>');await until(()=>fixture.heads.some(x=>x.engine==='agy'&&x.sent.length));const peer=fixture.heads.find(x=>x.engine==='agy');
 peer.completionDependencies=[{id:'worker',run:1,state:'running',task:'offline',callback:'app_task_result'}];
 peer.emit({kind:'toolUse',id:'worker',tool:'Agent',title:'Delegate fixture',detail:'offline',parent:null,input:{description:'fixture',prompt:'offline',subagent_type:'agy-worker',run_in_background:true}});
 peer.emit({kind:'subagentStarted',id:'worker',description:'fixture',type:'agy-worker',prompt:'offline',background:true,execution:{run:1}});
 peer.emit({kind:'managedPending',pending:true});peer.finish('worker accepted');await settle();expect(lead.sent).toHaveLength(1);
 if(stop)h.b.stopHandoff((h.b as any).conductor.records[0].id);
 peer.completionDependencies=[{id:'worker',run:1,state:'reportQueued',task:'offline',callback:'app_task_result'}];
 peer.emit({kind:'subagentEnded',id:'worker',status:'completed',summary:'fixture evidence'});
 peer.emit({kind:'backgroundTurn',taskId:'worker'});peer.finish('correlated worker evidence');peer.completionDependencies=[];peer.emit({kind:'managedPending',pending:false});await settle();
 expect(lead.sent.length).toBe(stop?1:2);if(!stop){expect(lead.sent[1]).toContain('correlated worker evidence');lead.finish('accepted');}
});
it('simultaneous head cards with the same RPC id cannot approve the other engine',async()=>{
 const h=bot('agy');h.b.send('first');await until(()=>fixture.heads.some(x=>x.engine==='agy'&&x.sent.length));
 (h.b as any).deliverTo('codex','second',null);await until(()=>fixture.heads.some(x=>x.engine==='codex'&&x.sent.length));
 const a=fixture.heads.find(x=>x.engine==='agy'),c=fixture.heads.find(x=>x.engine==='codex');
 a.emit({kind:'permission',requestId:'same',tool:'write',summary:'agy only',input:{path:'a'}});c.emit({kind:'permission',requestId:'same',tool:'write',summary:'codex only',input:{path:'c'}});
 const cards=h.b.snapshot().messages.filter(m=>m.approval);expect(cards).toHaveLength(2);
 const cc=cards.find(m=>m.text.includes('codex only'))!,ac=cards.find(m=>m.text.includes('agy only'))!;
 expect(cc.choices!.map(c=>c.label)).toEqual(['Allow once',"Don't allow"]);
 h.b.choose(cc.id,1);expect(c.answers).toHaveLength(1);expect(a.answers).toEqual([]);
 h.b.choose(ac.id,1);expect(a.answers).toHaveLength(1);expect(c.answers).toHaveLength(1);a.finish('denied',false);c.finish('denied',true);
});
it('chat send to agy is accepted immediately while the agy turn is blocked on an approval',async()=>{
 const h=bot('agy');h.b.send('first');await until(()=>fixture.heads.some(x=>x.engine==='agy'&&x.sent.length));
 const lead=fixture.heads.find(x=>x.engine==='agy')!;
 lead.emit({kind:'permission',requestId:'blocked-1',tool:'write_file',summary:'write',input:{path:'a'}});
 await until(()=>h.b.snapshot().messages.some(m=>!!m.approval));
 const started=Date.now(),second=h.b.send('while blocked',{to:'agy'});
 expect(second.messageId).toBeTruthy();expect(Date.now()-started).toBeLessThan(200);
 expect(h.b.snapshot().messages.some(m=>m.text==='while blocked')).toBe(true);
 expect(h.events.some(e=>e.type==='turn.finished')).toBe(false);
});
