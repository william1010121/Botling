// Math, 2026-11-06: the user wrote "*web search 一下" while the Antigravity head was at work and the line sat "Queued"
// until the turn ended. ACP has no way to put words into a running prompt (no steer method; a second session/prompt
// breaks the first), but every tool the head calls is Botling's own MCP bridge: the words ride on the next tool result
// of that turn, exactly once. A turn that ends without another tool call leaves them for the normal queue.
// Offline: no engine process may start.
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const fixture=vi.hoisted(()=>({workers:[] as any[]}));
vi.mock('../../src/core/agent/agy-capabilities',()=>({agyWorkerRuntimeEnabled:()=>true}));
vi.mock('../../src/core/process/tree',async original=>({...await original<any>(),processTreeAdapter:()=>({spawn(){throw Error('Real process spawning forbidden');}})}));
vi.mock('../../src/core/agent/agy-worker-router',()=>({createAgyWorkerHead:(config:any,handlers:any)=>{
 const worker={config,handlers,start(){},send(){},answer(){},async terminate(){return {killed:[],forced:false};}};fixture.workers.push(worker);return worker;
}}));
import {AgyAcpHead,agyInsertTiming} from '../../src/core/agent/agy-acp';
const heads:AgyAcpHead[]=[];
afterEach(async()=>{await Promise.all(heads.splice(0).map(h=>h.terminate()));fixture.workers.length=0;Object.assign(agyInsertTiming,saved);});
const saved={...agyInsertTiming};
const wait=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const settle=()=>new Promise<void>(r=>setImmediate(r));
async function setup(worker=false){
 const dir=mkdtempSync(join(tmpdir(),'agy-insert-')),cwd=join(dir,'workspace'),home=join(dir,'profile');mkdirSync(cwd);mkdirSync(home);
 const items:any[]=[],prompts:string[]=[];
 const head=new AgyAcpHead({command:'/never-spawned',cwd,acpHome:home,sessionId:'owner',resume:false,worker,canStartReport:()=>true},{onItem(item:any){items.push(item);},onExit(){}});heads.push(head);
 await (head as any).connectTools(cwd,home);
 const bridge=(head as any).bridge;
 let cancels=0,pending:((ok:boolean)=>void)|undefined;
 // As AgyAcpProtocol: its items go through the head's protocolItem; session/cancel ends the prompt as cancelled.
 const end=(how:'normal'|'cancelled')=>{const r=pending;pending=undefined;if(!r)return;
  (head as any).protocolItem({kind:'result',ok:how==='normal',how,text:'',error:'',subtype:how==='normal'?'end_turn':'cancelled'});r(how==='normal');};
 (head as any).protocol={send:(text:string)=>{prompts.push(text);return new Promise<boolean>(r=>{pending=r;});},interrupt(){cancels++;end('cancelled');},close(){}};
 // A tool call of the turn under way, as Antigravity makes it (MCP tools/call on the bridge).
 const tool=async()=>(await bridge.rpc('tools/call',{name:'app_handoff',arguments:{name:'probe',instructions:'offline fixture only'}})).content.map((c:any)=>c.text).join('\n');
 return {head,items,prompts,tool,bridge,cancels:()=>cancels,end:async()=>{end('normal');await settle();}};
}

it('a message offered mid-turn rides on the next tool result, marked as the user\'s, exactly once',async()=>{
 const h=await setup();
 h.head.send('first','u1');await settle();
 expect(h.head.offerInsert('u2','web search 一下')).toBe(true);
 const result=await h.tool();
 expect(result).toContain('web search 一下');
 expect(result).toMatch(/user sent this message while you work/i);
 expect(h.items.filter(i=>i.kind==='inserted')).toEqual([{kind:'inserted',id:'u2'}]);
 const again=await h.tool();
 expect(again).not.toContain('web search 一下');
 expect(h.items.filter(i=>i.kind==='inserted')).toHaveLength(1);
});

it('a turn that ends without another tool call delivers nothing: the message stays for the queue',async()=>{
 const h=await setup();
 expect(h.head.offerInsert('u0','too early')).toBe(false);
 h.head.send('first','u1');await settle();
 expect(h.head.offerInsert('u2','web search 一下')).toBe(true);
 await h.end();
 expect(h.items.some(i=>i.kind==='inserted')).toBe(false);
 h.head.send('next turn','u3');await settle();
 expect(await h.tool()).not.toContain('web search 一下');
 expect(h.items.some(i=>i.kind==='inserted')).toBe(false);
});

it('a message taken back before the next tool call is not delivered',async()=>{
 const h=await setup();
 h.head.send('first','u1');await settle();
 h.head.offerInsert('u2','never mind');
 expect(h.head.withdrawInsert('u2')).toBe(true);
 expect(await h.tool()).not.toContain('never mind');
 expect(h.items.some(i=>i.kind==='inserted')).toBe(false);
});

it('Stop drops a message not yet delivered',async()=>{
 const h=await setup();
 h.head.send('first','u1');await settle();
 h.head.offerInsert('u2','after stop');
 h.head.interrupt();
 expect(await h.tool().catch(()=>'')).not.toContain('after stop');
});

it('a worker head marks the words as its task owner\'s, not the user\'s',async()=>{
 const h=await setup(true);
 h.head.send('task','t1');await settle();
 expect(h.head.offerInsert('m1','also check the README')).toBe(true);
 const result=await h.tool().catch(()=>'');
 // A worker has no app tools; the bridge refuses the call, and the words still ride on that result.
 expect(result).toContain('also check the README');
 expect(result).not.toMatch(/user sent/i);
});

// When no tool call comes to carry the words (the model is writing its answer, or thinking), the turn is cancelled
// (session/cancel) after agyInsertTiming.waitMs and sent again with the words: one continuous turn to the app, the
// cancelled attempt's result never shown. Never both: words resent are not on a later tool result too.
it('no tool call within the wait: the turn is cancelled and resent with the original words and the new ones, once',async()=>{
 agyInsertTiming.waitMs=30;agyInsertTiming.recheckMs=10;
 const h=await setup();
 h.head.send('first question','u1');await settle();
 h.head.offerInsert('u2','web search 一下');
 await wait(80);await settle();
 expect(h.cancels()).toBe(1);
 expect(h.items.filter(i=>i.kind==='inserted')).toEqual([{kind:'inserted',id:'u2'}]);
 // The cancelled attempt's end is not the turn's end.
 expect(h.items.some(i=>i.kind==='result')).toBe(false);
 expect(h.prompts).toHaveLength(2);
 expect(h.prompts[1]).toContain('first question');expect(h.prompts[1]).toContain('web search 一下');
 expect(await h.tool()).not.toContain('web search 一下');
 await h.end();
 expect(h.items.filter(i=>i.kind==='result')).toHaveLength(1);
 expect(h.cancels()).toBe(1);expect(h.prompts).toHaveLength(2);
});

it('a tool still at work when the wait runs out carries the words when it returns: no cancel',async()=>{
 agyInsertTiming.waitMs=30;agyInsertTiming.recheckMs=10;
 const h=await setup();
 h.head.send('first','u1');await settle();
 let release!:()=>void;const slow=new Promise<void>(r=>release=r);
 (h.bridge as any).delegate=async()=>{await slow;return {accepted:true};};
 const call=h.tool();
 h.head.offerInsert('u2','web search 一下');
 await wait(80);
 expect(h.cancels()).toBe(0);
 release();
 expect(await call).toContain('web search 一下');
 await wait(60);
 expect(h.cancels()).toBe(0);expect(h.prompts).toHaveLength(1);
});

it('words delivered on a tool result before the wait never cause a cancel',async()=>{
 agyInsertTiming.waitMs=30;agyInsertTiming.recheckMs=10;
 const h=await setup();
 h.head.send('first','u1');await settle();
 h.head.offerInsert('u2','web search 一下');
 expect(await h.tool()).toContain('web search 一下');
 await wait(80);
 expect(h.cancels()).toBe(0);expect(h.prompts).toHaveLength(1);
});

it('a worker run is resent the same way, as its own task owner\'s words',async()=>{
 agyInsertTiming.waitMs=30;agyInsertTiming.recheckMs=10;
 const h=await setup(true);
 h.head.send('the task','t1');await settle();
 h.head.offerInsert('m1','also check the README');
 await wait(80);await settle();
 expect(h.cancels()).toBe(1);
 expect(h.prompts[1]).toContain('the task');expect(h.prompts[1]).toContain('also check the README');
 expect(h.prompts[1]).not.toMatch(/user sent/i);
});
