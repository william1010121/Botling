// Parsed-item and acceptance boundaries, real durable journal/files, no provider processes.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { Bot } from "../../src/core/bot";
import { drainBots } from "../../src/core/hot-swap";
import { ProjectLock } from "../../src/core/store/lock";
import type { CodexItem } from "../../src/core/agent/codex";
import { BotStore } from "../../src/core/store/bot-store";
import { decodeHistoryCheckpoint, readHistory } from "../../src/core/durable/history-journal";
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
  const lock=new ProjectLock(root,root,{folder:null,process:/never-match-test/});
  const release=vi.spyOn(lock,'release');
  const bot=new Bot({profile,primary,engine:primary?'codex':'claude',deferStartup:true,welcome:false,
    headConfig(){throw Error('No CLI in persistence tests');},prompts(){throw Error('No turn');},
    ledger:new ProcessLedger(join(root,'ledger.json')),emit:event=>events.push(event),log,
    approvalTimeoutMs:100,idleMs:100,interruptGraceMs:100,lock});
  bots.push(bot);
  const folder=primary?join(primary.profile.storeDir,'partner-codex'):profile.storeDir;
  const file=join(folder,'subagents.json');
  const send=(item:CodexItem)=>(bot as any).onSubagentItem(item);
  const start=(id='worker')=>send({kind:'subagentStarted',id,description:'Worker',type:'codex-worker',prompt:'Work',background:false});
  const text=(value:string,id='worker')=>send({kind:'subagentText',parent:id,text:value});
  return {bot,folder,file,journal:file+'.journal',disk:()=>readHistory(file) as any[],send,start,text,events,release,log};
}
it('coalesces running progress at 500ms while critical state is durable before return',async()=>{
  const f=fixture(); f.start();
  expect(f.disk()[0].status).toBe('running');
  for(let i=0;i<20;i++){f.text(`delta-${i}`);await vi.advanceTimersByTimeAsync(20);}
  expect(f.disk()[0].steps).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.disk()).toEqual(f.bot.subagents.list);
  await f.bot.flushForSwap();
  expect(decodeHistoryCheckpoint(JSON.parse(readFileSync(f.file,"utf8"))).rows).toEqual(f.bot.subagents.list);
});
it.each(['completed','failed','stopped'])('publishes %s only after its pending progress and terminal status commit',async status=>{
  const f=fixture();f.start();f.text('final evidence');
  f.send({kind:'subagentEnded',id:'worker',status,summary:'final report'});
  expect(f.disk()[0]).toMatchObject({status,result:'final report',steps:[{title:'final evidence'}]});
  expect(f.events.findLast(e=>e.type==='subagent.updated').subagent.status).toBe(status);
  await f.bot.shutdown({tidy:false});
  expect(decodeHistoryCheckpoint(JSON.parse(readFileSync(f.file,"utf8"))).rows).toEqual(f.bot.subagents.list);
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
it('failed durable commit throws before publishing; retry includes terminal state and another worker progress',async()=>{
  const f=fixture(); f.start();f.start('other');await f.bot.flushForSwap();
  rmSync(f.journal,{recursive:true});writeFileSync(f.journal,'blocked');
  const events=f.events.length;
  expect(()=>f.send({kind:'subagentEnded',id:'worker',status:'completed',summary:'final'})).toThrow();
  expect(f.events.slice(events).some(e=>e.type==='subagent.updated')).toBe(false);
  expect(decodeHistoryCheckpoint(JSON.parse(readFileSync(f.file,"utf8"))).rows.find((r:any)=>r.id==='worker')!.status).toBe('running');
  rmSync(f.journal);mkdirSync(f.journal);
  f.text('concurrent progress','other');await vi.advanceTimersByTimeAsync(1000);
  expect(f.disk()).toEqual(f.bot.subagents.list);
});
it('shutdown awaits checkpoint and flushes both heads before releasing their locks',async()=>{
  const f=fixture(),p=fixture(f.bot);f.bot.partner=p.bot;
  f.start();p.start();f.text('primary');p.text('partner');
  await f.bot.shutdown({tidy:false});
  for(const current of [f,p]){
    expect(decodeHistoryCheckpoint(JSON.parse(readFileSync(current.file,"utf8"))).rows).toEqual(current.bot.subagents.list);
    expect(current.release).toHaveBeenCalledTimes(1);
  }
});
it('a failed checkpoint rejects shutdown but preserves chat and releases both locks; explicit retry succeeds',async()=>{
  const f=fixture(),p=fixture(f.bot);f.bot.partner=p.bot;
  f.start();p.start();await f.bot.flushForSwap();f.text('primary');p.text('partner');
  const savedCheckpoint=readFileSync(f.file);
  rmSync(f.file);mkdirSync(f.file);
  await expect(f.bot.shutdown({tidy:false})).rejects.toThrow();
  expect(f.release).toHaveBeenCalledTimes(1);expect(p.release).toHaveBeenCalledTimes(1);
  expect(existsSync(join(f.folder,'chat.json'))).toBe(true);
  rmSync(f.file,{recursive:true});writeFileSync(f.file,savedCheckpoint);
  await f.bot.shutdown({tidy:false});expect(decodeHistoryCheckpoint(JSON.parse(readFileSync(f.file,"utf8"))).rows).toEqual(f.bot.subagents.list);
});
it('core handover waits for both heads and refuses success on persistence failure',async()=>{
  const f=fixture(),p=fixture(f.bot);f.bot.partner=p.bot;f.start();p.start();await f.bot.flushForSwap();
  f.text('pending');p.text('partner');rmSync(f.journal,{recursive:true});writeFileSync(f.journal,'blocked');
  await expect(drainBots([f.bot],{timeoutMs:0,boundaryMs:0})).rejects.toThrow();
  expect(decodeHistoryCheckpoint(JSON.parse(readFileSync(p.file,"utf8"))).rows).toEqual(p.bot.subagents.list);
  rmSync(f.journal);mkdirSync(f.journal);await f.bot.flushForSwap();expect(f.disk()).toEqual(f.bot.subagents.list);
});
it('message acceptance keeps durable chat and worker state without waiting for full-history checkpoint',async()=>{
  const f=fixture();f.start();f.bot.holdForSwap(true);
  const accepted=f.bot.send('queued synthetic message');
  expect(accepted.messageId).toBeTruthy();
  expect(JSON.parse(readFileSync(join(f.folder,'chat.json'),'utf8')).some((r:any)=>r.role==='user'&&r.text==='queued synthetic message')).toBe(true);
  expect(f.disk()[0].status).toBe('running');
  // No full-history checkpoint has run: the journal is the durable acceptance boundary.
  expect(existsSync(f.file)).toBe(false);
  await f.bot.flushForSwap();expect(decodeHistoryCheckpoint(JSON.parse(readFileSync(f.file,"utf8"))).rows).toEqual(f.bot.subagents.list);
});
it('chat write failures are not accepted and shutdown still releases the lock',async()=>{
  const f=fixture();f.bot.holdForSwap(true);
  const file=join(f.folder,'chat.json');if(existsSync(file))rmSync(file);mkdirSync(file,{recursive:true});
  expect(()=>f.bot.send('must not acknowledge')).toThrow();
  await expect(f.bot.shutdown({tidy:false})).rejects.toThrow();expect(f.release).toHaveBeenCalledTimes(1);
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
  await f.bot.flushForSwap();expect(decodeHistoryCheckpoint(JSON.parse(readFileSync(f.file,"utf8"))).rows).toEqual(f.bot.subagents.list);
});
