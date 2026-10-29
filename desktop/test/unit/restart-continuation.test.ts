import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreHarness, MAIN } from '../core-harness';
import { tempDir, until } from '../helpers';
const all: CoreHarness[] = [];
const core = (dir: string) => { const c = new CoreHarness(dir, { FAKE_CLAUDE_LOG: join(dir,'starts.log'), FAKE_CLAUDE_INPUT: join(dir,'input.log'), BOTLING_ROUTINE_TICK_MS:'0', BOTLING_UPDATE_PENDING:'0', BOTLING_IMPORT_FROM:'', BOTLING_QUIT_TIDY_MS:'0' }); all.push(c); return c; };
const lines = (dir:string, name:string):any[] => existsSync(join(dir,name)) ? readFileSync(join(dir,name),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)) : [];
afterEach(async()=>{for(const c of all.splice(0))if(c.child.exitCode===null&&c.child.signalCode===null)await c.kill('SIGKILL');});
it('explicit restart resumes the original session once; a second boot does not replay the continuation',async()=>{
 const dir=tempDir('restart-continuation'),a=core(dir);
 await a.call({type:'chat.send',botId:MAIN,text:'/slow'});
 await until(()=>a.of('turn.delta').length,{what:'slow reply'});
 a.post({botling:'prepareRestart',id:900});
 const prepared=await until(()=>a.responses.get(900 as unknown as string),{timeout:3000,what:'durable restart checkpoint'});
 expect(prepared).toMatchObject({ok:true});
 const session=lines(dir,'starts.log')[0].session;
 await a.kill('SIGTERM');
 const b=core(dir);
 await until(()=>lines(dir,'input.log').find(x=>x.text.includes('explicitly approved restarting')),{what:'automatic continuation'});
 expect(lines(dir,'starts.log').at(-1)).toMatchObject({session,resume:true});
 await until(()=>b.of('turn.finished').length,{what:'resumed result'});
 await b.kill('SIGTERM');
 const c=core(dir);await c.chat();
 expect(lines(dir,'input.log').filter(x=>x.text.includes('explicitly approved restarting'))).toHaveLength(1);
});

async function prepare(c:CoreHarness){c.post({botling:'prepareRestart',id:901});expect(await until(()=>c.responses.get(901 as unknown as string),{what:'restart checkpoint'})).toMatchObject({ok:true});}
it('completion between confirmation and shutdown is not replayed',async()=>{
 const dir=tempDir('restart-complete-race'),a=core(dir);
 const {turnId}=await a.call({type:'chat.send',botId:MAIN,text:'/linger complete-me'});
 await until(()=>a.of('turn.delta').length,{what:'reply began'});await prepare(a);
 await until(()=>a.of('turn.finished').some(e=>(e.event as any).turnId===turnId),{what:'completion'});
 await a.kill('SIGTERM');const b=core(dir);await b.chat();
 expect(lines(dir,'input.log').some(x=>x.text.includes('explicitly approved restarting'))).toBe(false);
});
it('explicit stop after restart confirmation wins',async()=>{
 const dir=tempDir('restart-stop'),a=core(dir);
 const {turnId}=await a.call({type:'chat.send',botId:MAIN,text:'/slow'});
 await until(()=>a.of('turn.delta').length,{what:'reply began'});await prepare(a);
 await a.call({type:'turn.stop',botId:MAIN,turnId});await a.kill('SIGTERM');
 const b=core(dir);await b.chat();expect(lines(dir,'input.log').some(x=>x.text.includes('explicitly approved restarting'))).toBe(false);
});
it('pending approval remains blocked and identifies the original request',async()=>{
 const dir=tempDir('restart-approval'),a=core(dir);
 await a.call({type:'chat.send',botId:MAIN,text:'/tool echo needs-approval'});
 await until(async()=>JSON.stringify(await a.chat()).includes('Allow once'),{what:'permission request'});await prepare(a);await a.kill('SIGTERM');
 const b=core(dir);const chat=await b.chat();
 expect(lines(dir,'input.log').some(x=>x.text.includes('explicitly approved restarting'))).toBe(false);
 expect(JSON.stringify(chat)).toContain('permission decision was pending');
 expect(JSON.stringify(chat)).toContain('echo needs-approval');
 expect(JSON.parse(readFileSync(join(dir,'main','head.json'),'utf8')).sessionId).toBe(lines(dir,'starts.log')[0].session);
});
it('two original conversations resume independently in their original sessions',async()=>{
 const dir=tempDir('restart-multi'),a=core(dir),other='DEC0DE00-0000-4000-8000-00000000DEC0';
 await a.call({type:'chat.send',botId:MAIN,text:'/slow'});await a.call({type:'chat.send',botId:other,text:'/slow'});
 await until(()=>new Set(a.of('turn.delta').map(e=>(e.event as any).botId)).size===2,{what:'both conversations running'});
 const originals=lines(dir,'starts.log').map(x=>x.session).sort();await prepare(a);await a.kill('SIGTERM');
 const b=core(dir);await until(()=>lines(dir,'input.log').filter(x=>x.text.includes('explicitly approved restarting')).length===2,{what:'both original conversations resumed'});
 expect(lines(dir,'starts.log').filter(x=>x.resume).map(x=>x.session).sort()).toEqual(originals);await b.chat();
});
it('a message accepted during restart preparation is delivered once after boot',async()=>{
 const dir=tempDir('restart-queued'),a=core(dir);await a.call({type:'chat.send',botId:MAIN,text:'first'});
 await until(()=>a.of('turn.finished').length,{what:'first result'});await prepare(a);
 const queued=await a.call({type:'chat.send',botId:MAIN,text:'queued-original-work'});await a.kill('SIGTERM');
 const b=core(dir);await until(()=>b.of('turn.finished').some(e=>(e.event as any).turnId===queued.turnId),{what:'queued original turn'});
 expect(lines(dir,'input.log').filter(x=>x.text.includes('queued-original-work'))).toHaveLength(1);
});
