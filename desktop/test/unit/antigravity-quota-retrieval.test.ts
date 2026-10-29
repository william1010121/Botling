import { afterEach, expect, it, vi } from 'vitest';
import { AgyAcpProtocol } from '../../src/core/agent/agy-acp';
import { parseAntigravityUsage, registerAntigravityQuotaReader, refreshAntigravityQuota } from '../../src/core/antigravity-quota';
import { UsageBook, usageView } from '../../src/core/usage';
const report = '### Session Usage\n- **Session total:** 999 tokens\n\n### Quota Limits\n- **Gemini Models**\n  - **Weekly:** 91% remaining (resets Oct 02, 2026, 08:22 UTC)\n- **Claude and GPT models**\n  - **Daily:** 1,234 units remaining\n  - **Other:** Available\n  - **Restricted:** Disabled';
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
it('reads official usage on the existing session and never emits chat, token or tool permission events',async()=>{
 const h=await harness();const reading=h.c.readQuota();await tick();expect(h.frames.at(-1).params).toEqual({sessionId:'s',prompt:[{type:'text',text:'/usage'}]});const id=h.frames.at(-1).id;
 expect(h.c.fullPermissionActive).toBe(false);
 h.c.receive({jsonrpc:'2.0',id:100,method:'session/request_permission',params:{sessionId:'s',options:[{kind:'allow_once',optionId:'allow'},{kind:'reject_once',optionId:'deny'}]}});
 expect(h.frames.at(-1).result.outcome.outcome).toBe('cancelled');
 h.update(report.slice(0,90));h.update(report.slice(90));h.c.receive({jsonrpc:'2.0',id,result:{stopReason:'end_turn'}});
 expect((await reading).status).toBe('error');expect(h.items).toEqual([]);expect(h.fatal).not.toHaveBeenCalled();
 await expect(h.c.send('/usage','u')).rejects.toThrow('slash commands');await expect(h.c.send('/logout','u')).rejects.toThrow('slash commands');
});
it('maps quota groups, percentages, counts and UTC resets, without using session tokens',()=>{
 const q=parseAntigravityUsage(report,123);expect(q.status).toBe('available');if(q.status!=='available')return;
 expect(q.seen).toBe(123);expect(q.buckets).toEqual([
 {group:'Gemini Models',label:'Weekly',remainingFraction:.91,resetsAt:Date.parse('2026-10-02T08:22:00Z')},
 {group:'Claude and GPT models',label:'Daily',remainingAmount:'1234'},
 {group:'Claude and GPT models',label:'Other'},
 {group:'Claude and GPT models',label:'Restricted',disabled:true}]);
 expect(parseAntigravityUsage(report.replace('91%','0%')).status).toBe('available');
 for(const text of ['### Session Usage\n100 tokens','### Quota Limits\n- No quota limits reported.','### Quota Limits\n- data not available yet'])expect(parseAntigravityUsage(text).status).toBe('unavailable');
 expect(parseAntigravityUsage('### Quota Limits\n- Unable to retrieve quota status (secret)').status).toBe('error');
 expect(JSON.stringify(parseAntigravityUsage('### Quota Limits\n- Unable to retrieve quota status (secret)'))).not.toContain('secret');
 expect(parseAntigravityUsage(report.replace('91%','101%')).status).toBe('error');
});
it('refreshes UsageBook through a scoped connection, with no credential or task launch',async()=>{
 const release=registerAntigravityQuotaReader('/quota-test',async()=>parseAntigravityUsage(report));
 try{const book=new UsageBook('/quota-test');await book.refresh();expect(usageView(book.view()).antigravity?.status).toBe('available');expect((await refreshAntigravityQuota('/other')).status).toBe('unavailable');}finally{release();}
});
it('isolates successful reads and waits before starting a queued user prompt',async()=>{
 const h=await harness(),q=h.c.readQuota();await tick();const id=h.frames.at(-1).id;const task=h.c.send('hello','u');await tick();expect(h.frames.at(-1).id).toBe(id);
 h.update(report);h.reply({stopReason:'end_turn'});expect((await q).status).toBe('available');await tick();h.reply({configOptions:[{id:'mode',currentValue:'default'}]});await tick();
 expect(h.frames.at(-1).params.prompt[0].text).toBe('hello');h.update('hello back');h.reply({stopReason:'end_turn'});await task;expect(h.items.filter(i=>i.kind==='delta')).toEqual([{kind:'delta',text:'hello back'}]);
});
it('does not probe during a user turn and returns bounded timeout without leaking late quota text',async()=>{
 vi.useFakeTimers();const h=await harness();const q=h.c.readQuota();await tick();const id=h.frames.at(-1).id;await vi.advanceTimersByTimeAsync(15000);expect((await q).status).toBe('error');h.update(report);h.c.receive({jsonrpc:'2.0',id,result:{stopReason:'end_turn'}});await tick();expect(h.items).toEqual([]);
 const other=await harness();const task=other.c.send('task','u');await tick();expect(await other.c.readQuota()).toMatchObject({reason:'busy'});other.c.close();await task;
});

it('registers the real protocol only in its core scope and removes it on disconnect', async()=>{
 const h=await harness('/registry-core/agy-acp/profile');
 const q=refreshAntigravityQuota('/registry-core');await tick();h.update(report);h.reply({stopReason:'end_turn'});
 expect((await q).status).toBe('available');h.c.close();
 expect(await refreshAntigravityQuota('/registry-core')).toMatchObject({status:'unavailable',reason:'no_connection'});
});
it('deduplicates reads, handles sanitized RPC errors, and permits the next read', async()=>{
 const h=await harness();const a=h.c.readQuota(),b=h.c.readQuota();expect(a).toBe(b);const id=h.frames.at(-1).id;
 h.c.receive({jsonrpc:'2.0',id,error:{code:-32000,message:'secret credential'}});
 expect(await a).toMatchObject({status:'error',reason:'request_failed'});expect(JSON.stringify(await a)).not.toContain('secret');
 const retry=h.c.readQuota();h.update(report);h.reply({stopReason:'end_turn'});expect((await retry).status).toBe('available');expect(h.fatal).not.toHaveBeenCalled();
});
it('never exposes partial readings after disconnect or provider cancellation',async()=>{
 const h=await harness();const q=h.c.readQuota();h.update(report);h.c.close();expect((await q).status).toBe('error');expect(h.items).toEqual([]);
 const other=await harness();const cancelled=other.c.readQuota();other.update(report);other.reply({stopReason:'cancelled'});expect((await cancelled).status).toBe('error');
});
it('keeps large unit counts exact and rejects malformed readings',()=>{
 const large=parseAntigravityUsage(report.replace('1,234','9,007,199,254,740,993'));if(large.status!=='available')throw Error('missing');
 expect(large.buckets[1].remainingAmount).toBe('9007199254740993');
 for(const bad of ['-1% remaining','NaN% remaining','1,23 units remaining'])expect(parseAntigravityUsage(report.replace('91% remaining',bad)).status).toBe('error');
 expect(parseAntigravityUsage(report.replace('Oct 02, 2026, 08:22 UTC','unknown date')).status).toBe('error');
});

it('cancelling while a user message waits for quota never submits that message',async()=>{
 const h=await harness(),q=h.c.readQuota();const task=h.c.send('cancelled task','u');h.c.interrupt();h.update(report);h.reply({stopReason:'end_turn'});
 expect((await q).status).toBe('error');expect(await task).toBe(false);
 expect(h.frames.filter(f=>f.method==='session/prompt')).toHaveLength(1);expect(h.items).toEqual([]);
});


it('refreshes immediately after an active turn ends without repeating other provider requests', async () => {
 vi.useFakeTimers();
 const h = await harness('/busy-core/agy-acp/profile');
 const retrieve = vi.fn(async () => { throw Error('offline'); });
 const book = new UsageBook('/busy-core', undefined, undefined, retrieve);
 const task = h.c.send('task', 'busy-turn'); await tick();
 h.reply({configOptions:[{id:'mode',currentValue:'default'}]}); await tick();
 const prompts = () => h.frames.filter(f => f.method === 'session/prompt');
 await book.refresh();
 expect(book.antigravity).toMatchObject({reason:'busy'});
 expect(prompts()).toHaveLength(1);
 h.reply({stopReason:'end_turn'}); await task;
 const refresh = book.refresh(); await tick();
 expect(prompts()).toHaveLength(2);
 expect(prompts().at(-1).params.prompt[0].text).toBe('/usage');
 h.update(report); h.reply({stopReason:'end_turn'}); await refresh;
 expect(book.antigravity.status).toBe('available');
 await book.refresh(); expect(prompts()).toHaveLength(2);
 expect(retrieve).toHaveBeenCalledTimes(2);
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
  settle(parseAntigravityUsage(report)); await retry;
  await book.refresh(); expect(reader).toHaveBeenCalledTimes(3);
 } finally {release();}
});
