// Parsed-item and acceptance boundaries, real index/step files, no provider processes.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { Bot } from "../../src/core/bot";
import { drainBots } from "../../src/core/hot-swap";
import type { CodexItem } from "../../src/core/agent/codex";
import { BotStore } from "../../src/core/store/bot-store";
import { readSubagentRows } from "../subagent-disk";
import { mainProfile } from "../../src/core/store/workspace";
import { ProcessLedger } from "../../src/core/process/ledger";

const roots: string[] = [], bots: Bot[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  vi.restoreAllMocks();
  for (const bot of bots.splice(0)) await bot.shutdown({ tidy:false });
  vi.clearAllTimers(); vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});
});
function fixture(primary?: Bot) {
  const root=tempDir('subagent-journal'); roots.push(root);
  const profile=mainProfile(root), events: any[]=[], log=vi.fn();
  const bot=new Bot({profile,primary,engine:primary?'codex':'claude',deferStartup:true,welcome:false,
    headConfig(){throw Error('No CLI in persistence tests');},prompts(){throw Error('No turn');},
    ledger:new ProcessLedger(join(root,'ledger.json')),emit:event=>events.push(event),log,
    approvalTimeoutMs:100,idleMs:100,interruptGraceMs:100});
  bots.push(bot);
  const folder=primary?join(primary.profile.storeDir,'partner-codex'):profile.storeDir;
  const file=join(folder,'subagents.json');
  const send=(item:CodexItem)=>(bot as any).onSubagentItem(item);
  const start=(id='worker')=>send({kind:'subagentStarted',id,description:'Worker',type:'codex-worker',prompt:'Work',background:false});
  const text=(value:string,id='worker')=>send({kind:'subagentText',parent:id,text:value});
  return {bot,folder,file,steps:join(folder,'subagents'),disk:()=>readSubagentRows(file),send,start,text,events,log};
}
it('coalesces running progress at 500ms while critical state is durable before return',async()=>{
  const f=fixture(); f.start();
  expect(f.disk()[0].status).toBe('running');
  for(let i=0;i<20;i++){f.text(`delta-${i}`);await vi.advanceTimersByTimeAsync(20);}
  expect(f.disk()[0].steps).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.disk()).toEqual(f.bot.subagents.list);
  await f.bot.flushForSwap();
  expect(readSubagentRows(f.file)).toEqual(f.bot.subagents.list);
});
it.each(['completed','failed','stopped'])('publishes %s only after its pending progress and terminal status commit',async status=>{
  const f=fixture();f.start();f.text('final evidence');
  f.send({kind:'subagentEnded',id:'worker',status,summary:'final report'});
  expect(f.disk()[0]).toMatchObject({status,result:'final report',steps:[{title:'final evidence'}]});
  expect(f.events.findLast(e=>e.type==='subagent.updated').subagent.status).toBe(status);
  await f.bot.shutdown({tidy:false});
  expect(readSubagentRows(f.file)).toEqual(f.bot.subagents.list);
});
it('persists execution identity/tool completion and late ended-worker metadata',async()=>{
  const f=fixture();f.start();
  f.send({kind:'subagentExecution',id:'worker',execution:{run:1,threadId:'t',turnId:'u',ownerSessionId:'s'}});
  f.send({kind:'toolUse',id:'read',tool:'Read',title:'Read',detail:'file',parent:'worker',input:{}});
  f.send({kind:'toolResult',id:'read',output:'done',failed:false,parent:'worker'} as CodexItem);
  expect(f.disk()[0]).toMatchObject({execution:{threadId:'t'},steps:[{id:'read',done:true}]});
  f.send({kind:'subagentEnded',id:'worker',status:'completed',summary:'report'});
  f.text('late evidence');f.send({kind:'subagentOutput',id:'worker',counter:'run',tokens:456});
  expect(f.disk()).toEqual(f.bot.subagents.list);
});
it('failed step append throws before publishing; retry includes terminal state and another worker progress',async()=>{
  const f=fixture(); f.start();f.start('other');await f.bot.flushForSwap();
  f.text('pending evidence');
  rmSync(f.steps,{recursive:true,force:true});writeFileSync(f.steps,'blocked');
  const events=f.events.length;
  expect(()=>f.send({kind:'subagentEnded',id:'worker',status:'completed',summary:'final'})).toThrow();
  expect(f.events.slice(events).some(e=>e.type==='subagent.updated')).toBe(false);
  expect(readSubagentRows(f.file).find((r:any)=>r.id==='worker')!.status).toBe('running');
  rmSync(f.steps);
  f.text('concurrent progress','other');await vi.advanceTimersByTimeAsync(1000);
  expect(f.disk()).toEqual(f.bot.subagents.list);
});
it('shutdown flushes appended steps and both heads',async()=>{
  const f=fixture(),p=fixture(f.bot);(f.bot as any).partners.set(p.bot.engine,p.bot);
  f.start();p.start();f.text('primary');p.text('partner');
  await f.bot.shutdown({tidy:false});
  for(const current of [f,p]){
    expect(readSubagentRows(current.file)).toEqual(current.bot.subagents.list);
  }
});
it('a failed index write rejects shutdown but preserves chat; explicit retry succeeds',async()=>{
  const f=fixture(),p=fixture(f.bot);(f.bot as any).partners.set(p.bot.engine,p.bot);
  f.start();p.start();await f.bot.flushForSwap();f.text('primary');p.text('partner');
  const savedCheckpoint=readFileSync(f.file);
  rmSync(f.file);mkdirSync(f.file);
  await expect(f.bot.shutdown({tidy:false})).rejects.toThrow();
  expect(existsSync(join(f.folder,'chat.json'))).toBe(true);
  rmSync(f.file,{recursive:true});writeFileSync(f.file,savedCheckpoint);
  await f.bot.shutdown({tidy:false});expect(readSubagentRows(f.file)).toEqual(f.bot.subagents.list);
});
it('core handover waits for both heads and refuses success on persistence failure',async()=>{
  const f=fixture(),p=fixture(f.bot);(f.bot as any).partners.set(p.bot.engine,p.bot);f.start();p.start();await f.bot.flushForSwap();
  f.text('pending');p.text('partner');rmSync(f.steps,{recursive:true,force:true});writeFileSync(f.steps,'blocked');
  await expect(drainBots([f.bot],{timeoutMs:0,boundaryMs:0})).rejects.toThrow();
  expect(readSubagentRows(p.file)).toEqual(p.bot.subagents.list);
  rmSync(f.steps);await f.bot.flushForSwap();expect(f.disk()).toEqual(f.bot.subagents.list);
});
it('message acceptance keeps durable chat and worker state',async()=>{
  const f=fixture();f.start();f.bot.holdForSwap(true);
  const accepted=f.bot.send('queued synthetic message');
  expect(accepted.messageId).toBeTruthy();
  expect(JSON.parse(readFileSync(join(f.folder,'chat.json'),'utf8')).some((r:any)=>r.role==='user'&&r.text==='queued synthetic message')).toBe(true);
  expect(f.disk()[0].status).toBe('running');
  await f.bot.flushForSwap();expect(readSubagentRows(f.file)).toEqual(f.bot.subagents.list);
});
it('chat write failures are not accepted and shutdown still rejects',async()=>{
  const f=fixture();f.bot.holdForSwap(true);
  const file=join(f.folder,'chat.json');if(existsSync(file))rmSync(file);mkdirSync(file,{recursive:true});
  expect(()=>f.bot.send('must not acknowledge')).toThrow();
  await expect(f.bot.shutdown({tidy:false})).rejects.toThrow();
  rmSync(file,{recursive:true});
});

it('commits both parent step and child status/identity for nested Agent results',async()=>{
  const f=fixture();f.start('parent');
  f.send({kind:'toolUse',id:'child',tool:'Agent',title:'Delegate',detail:'work',parent:'parent',input:{prompt:'Nested task'}});
  expect(f.disk().find(row=>row.id==='child').status).toBe('running');
  f.send({kind:'toolResult',id:'child',output:'Nested report',failed:false,parent:'parent',launch:{agentId:'nested-agent',background:false}} as CodexItem);
  const disk=f.disk();
  expect(disk.find(row=>row.id==='child')).toMatchObject({status:'completed',result:'Nested report',agentID:'nested-agent'});
  expect(disk.find(row=>row.id==='parent').steps[0]).toMatchObject({done:true,output:'Nested report'});
  await f.bot.flushForSwap();expect(readSubagentRows(f.file)).toEqual(f.bot.subagents.list);
});

it('shutdown appends progress still waiting for its 500ms timer to the subagent file',async()=>{
  const f=fixture();f.start();f.text('last words before quit');
  expect(existsSync(join(f.steps,'worker.jsonl'))).toBe(false); // coalesced, not yet appended
  await f.bot.shutdown({tidy:false});
  expect(readFileSync(join(f.steps,'worker.jsonl'),'utf8')).toContain('last words before quit');
});
it('a restarted bot loads the index without steps; opening one subagent reads just its file, skipping bad lines',async()=>{
  const f=fixture();f.start();f.start('other');
  f.text('first');f.text('second');f.text('other words','other');
  f.send({kind:'subagentEnded',id:'worker',status:'completed',summary:'done'});
  await f.bot.shutdown({tidy:false});bots.length=0;
  const worker=join(f.steps,'worker.jsonl');
  writeFileSync(worker,readFileSync(worker,'utf8')+'{corrupt\n');
  rmSync(join(f.steps,'other.jsonl')); // a missing file is an empty history
  const profile=mainProfile(roots[0]!),events:any[]=[];
  const lock=new ProjectLock(roots[0]!,roots[0]!,{folder:null,process:/never-match-test/});
  const bot=new Bot({profile,engine:'claude',deferStartup:true,welcome:false,headConfig(){throw Error('No CLI');},prompts(){throw Error('No turn');},
    ledger:new ProcessLedger(join(roots[0]!,'ledger2.json')),emit:e=>events.push(e),log:vi.fn(),approvalTimeoutMs:100,idleMs:100,interruptGraceMs:100,lock});
  bots.push(bot);
  expect(bot.subagents.list.map(s=>s.id)).toEqual(['worker','other']);
  expect(bot.subagents.list.every(s=>s.steps.length===0)).toBe(true);
  expect(bot.subagents.list[0]).toMatchObject({stepCount:2,status:'completed',result:'done'});
  const view=bot.subagentView('worker').subagent;
  expect(view.steps.map(s=>s.title)).toEqual(['first','second']);
  expect(bot.subagentView('other').subagent.steps).toEqual([]);
});
