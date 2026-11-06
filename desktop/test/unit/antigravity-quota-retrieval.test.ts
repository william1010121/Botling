import { afterEach, expect, it, vi } from 'vitest';
import { AgyAcpProtocol } from '../../src/core/agent/agy-acp';
import { registerAntigravityQuotaReader, refreshAntigravityQuota } from '../../src/core/antigravity-quota';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conversation, generation, usage } from './agy-db-fixture';
import { AntigravityQuotaView } from '../../src/contract';
import { UsageBook, usageView } from '../../src/core/usage';
const view = (fraction: number, seen = Date.now()): AntigravityQuotaView => ({ status: 'available', source: 'antigravity_acp', seen, buckets: [{ group: 'Gemini', label: 'Weekly', remainingFraction: fraction, resetsAt: Date.parse('2026-10-02T08:22:00Z') }, { group: 'Claude & GPT (shared)', label: 'Daily', remainingAmount: '1234' }] });
const clients: AgyAcpProtocol[] = [];
afterEach(()=>{clients.splice(0).forEach(c=>c.close());vi.useRealTimers();});
const tick=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
async function harness(acpHome?: string){
 const frames:any[]=[],items:any[]=[],fatal=vi.fn();
 const c=new AgyAcpProtocol({command:'unused',cwd:'/owned',sessionId:'s',resume:false,acpHome},f=>frames.push(f),i=>items.push(i),fatal);clients.push(c);
 const reply=(result:any)=>c.receive({jsonrpc:'2.0',id:frames.findLast(f=>f.id&&f.method).id,result});
 const ready=c.start();reply({protocolVersion:1,agentInfo:{name:'antigravity-acp',version:'1.4.3'}});await tick();reply({sessionId:'s'});await tick();reply({configOptions:[{id:'mode',currentValue:'default'}]});await tick();reply({configOptions:[{id:'mode',currentValue:'default'}]});await ready;items.length=0;
 const update=(text:string)=>c.receive({jsonrpc:'2.0',method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
 return {c,frames,items,fatal,reply,update};
}
it('never sends /usage: a quota read spends no turn, and the account slash commands stay refused',async()=>{
 const h=await harness('/registry-core/agy-acp/profile');
 expect((await refreshAntigravityQuota('/registry-core')).status).toBe('unavailable');
 expect(h.frames.filter(f=>f.method==='session/prompt')).toEqual([]);expect(h.items).toEqual([]);
 await expect(h.c.send('/usage','u')).rejects.toThrow('slash commands');await expect(h.c.send('/logout','u')).rejects.toThrow('slash commands');
});
it('refreshes UsageBook through a scoped reader, with no credential or task launch',async()=>{
 const release=registerAntigravityQuotaReader('/quota-test',async()=>view(.91));
 try{const book=new UsageBook('/quota-test');await book.refresh();expect(usageView(book.view()).antigravity?.status).toBe('available');expect((await refreshAntigravityQuota('/other')).status).toBe('unavailable');}finally{release();}
});
it('counts a turn from agy\'s conversation file (retries included), not the prompt\'s usage block',async()=>{
 const home=mkdtempSync(join(tmpdir(),'agy-turn-'));
 try{
  const db=conversation(home,'s');db.add(generation({usage:usage({input:1,output:1})}));
  const h=await harness(home);const task=h.c.send('hi','turn-1');await tick();h.reply({configOptions:[{id:'mode',currentValue:'default'}]});await tick();
  const ok=usage({input:500,output:80,cacheRead:2000});
  db.add(generation({usage:ok,attempts:[usage({input:500,output:30}),ok]}));db.db.close();
  h.update('hello');h.reply({stopReason:'end_turn',usage:{inputTokens:9,outputTokens:9}});await task;
  expect(h.items.filter(i=>i.kind==='usage')).toEqual([{kind:'usage',totalCost:0,tokens:{input:1000,output:110,cacheRead:2000,cacheWrite:0}}]);
  expect(h.items.find(i=>i.kind==='request')?.request.sample.outputTokens).toBe(110);
 }finally{rmSync(home,{recursive:true,force:true});}
});
it('keeps the prompt\'s usage block when agy wrote no record for the turn',async()=>{
 const h=await harness();const task=h.c.send('hi','turn-2');await tick();h.reply({configOptions:[{id:'mode',currentValue:'default'}]});await tick();
 h.update('hello');h.reply({stopReason:'end_turn',usage:{inputTokens:30,cachedReadTokens:10,outputTokens:5,thoughtTokens:2}});await task;
 expect(h.items.filter(i=>i.kind==='usage')).toEqual([{kind:'usage',totalCost:0,tokens:{input:20,output:7,cacheRead:10,cacheWrite:0}}]);
});

it('coalesces concurrent busy checks and rate limits real quota requests, including errors', async () => {
 vi.useFakeTimers();
 let settle!: (value:any) => void;
 const reader = vi.fn(() => new Promise<any>(resolve => {settle = resolve;}));
 const release = registerAntigravityQuotaReader('/busy-retries', reader);
 try {
  const book = new UsageBook('/busy-retries');
  const first = book.refresh(), same = book.refresh();
  expect(reader).toHaveBeenCalledTimes(1);
  settle({status:'unavailable',reason:'busy',source:'antigravity_acp'});
  await Promise.all([first,same]);
  const next = book.refresh();
  expect(reader).toHaveBeenCalledTimes(2);
  settle({status:'error',reason:'request_failed',source:'antigravity_acp'}); await next;
  await book.refresh();
  expect(reader).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60000);
  const retry = book.refresh();
  expect(reader).toHaveBeenCalledTimes(3);
  settle(view(.91)); await retry;
  await book.refresh(); expect(reader).toHaveBeenCalledTimes(3);
 } finally {release();}
});


it('serializes the original successful quota and timestamp through repeated busy results, then replaces it on success', async () => {
 vi.useFakeTimers();
 const original = view(.91, 123000);
 let value = original;
 const release = registerAntigravityQuotaReader('/retained-quota', async () => value);
 try {
  const book = new UsageBook('/retained-quota');
  await book.refresh();
  await vi.advanceTimersByTimeAsync(60000);
  value = {status:'unavailable',reason:'busy',source:'antigravity_acp'};
  await book.refresh(); await book.refresh();
  const decoded = AntigravityQuotaView.parse(JSON.parse(JSON.stringify(usageView(book.view()).antigravity)));
  expect(decoded).toMatchObject({status:'unavailable',reason:'busy',lastKnown:{seen:123000}});
  if (decoded.status === 'available' || original.status !== 'available') throw Error('wrong quota state');
  expect(decoded.lastKnown?.buckets).toEqual(original.buckets);
  value = view(.85, Date.now());
  await book.refresh();
  expect(book.antigravity).toEqual(value);
  expect(book.antigravity).not.toHaveProperty('lastKnown');
 } finally {release();}
});
