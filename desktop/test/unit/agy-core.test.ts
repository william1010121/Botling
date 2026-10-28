import { afterEach,expect,it } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { desktop,tempDir,until } from '../helpers';
import { CoreHarness,MAIN } from '../core-harness';
const cores:CoreHarness[]=[];
afterEach(async()=>{for(const c of cores.splice(0)) if(c.child.exitCode===null) await c.kill('SIGTERM');});
it('selects, configures, streams and persists agy; refuses mixed heads',async()=>{
 const dir=tempDir('agy-core'),log=join(dir,'agy.jsonl');
 const make=()=>{const c=new CoreHarness(dir,{BOTLING_FAKE_AGY:join(desktop,'test/fixtures/fake-agy.mjs'),FAKE_AGY_INPUT:log,BOTLING_QUIT_TIDY_MS:'0'});cores.push(c);return c;};
 const c=make();expect(await c.call({type:'heads.set',botId:MAIN,engines:['agy']})).toEqual({engines:['agy']});
 await expect(c.call({type:'heads.set',botId:MAIN,engines:['claude','agy']})).rejects.toThrow('only engine');
 expect(await c.call({type:'bot.configure',botId:MAIN,agyModel:'test-model',effort:'high'})).toMatchObject({agyModel:'test-model',engines:['agy']});
 const sent=await c.call({type:'chat.send',botId:MAIN,text:'hello'});await until(()=>c.of('turn.finished').some((e:any)=>e.event.turnId===sent.turnId));
 expect((await c.chat()).messages.findLast((m:any)=>m.role==='bot')).toMatchObject({engine:'agy',text:'AGY_REPLY',state:'done'});
 const entries=()=>readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));expect(entries()[0].args).toContain('test-model');expect(entries().some(e=>e.event==='user')).toBe(true);
 await c.kill('SIGTERM');const restarted=make();const next=await restarted.call({type:'chat.send',botId:MAIN,text:'again'});await until(()=>restarted.of('turn.finished').some((e:any)=>e.event.turnId===next.turnId));
 expect(entries().filter(e=>e.args).at(-1).args).toContain('--conversation');expect((await restarted.call({type:'bot.settings',botId:MAIN})).agyModel).toBe('test-model');
},30000);

it('marks refusal as failed, gates delegation, cancels and resumes without stale output',async()=>{
 const dir=tempDir('agy-core-lifecycle'),log=join(dir,'agy.jsonl');
 const c=new CoreHarness(dir,{BOTLING_FAKE_AGY:join(desktop,'test/fixtures/fake-agy.mjs'),FAKE_AGY_INPUT:log,BOTLING_QUIT_TIDY_MS:'0'});cores.push(c);
 await c.call({type:'heads.set',botId:MAIN,engines:['agy']});
 const say=async(text:string)=>{const sent=await c.call({type:'chat.send',botId:MAIN,text});await until(()=>c.of('turn.finished').some((e:any)=>e.event.turnId===sent.turnId));return c.of('turn.finished').find((e:any)=>e.event.turnId===sent.turnId)!.event;};
 expect(await say('AGY_DENIED')).toMatchObject({status:'failed',error:expect.stringContaining('approval')});
 await say('AGY_DELEGATE');expect((await c.chat()).messages.some((m:any)=>m.text.includes('nothing happened'))).toBe(true);
 const hang=await c.call({type:'chat.send',botId:MAIN,text:'AGY_HANG'});
 await until(()=>readFileSync(log,'utf8').includes('AGY_HANG'));
 expect(await c.call({type:'turn.stop',botId:MAIN,turnId:hang.turnId})).toMatchObject({stopped:true});
 expect(await say('after cancellation')).toMatchObject({status:'done',text:'AGY_REPLY'});
 const entries=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 expect(entries.filter(e=>e.args).at(-1).args).toContain('--conversation');
},30000);

it('does not replay a failed resumed agy turn into a new conversation',async()=>{
 const dir=tempDir('agy-silent'),log=join(dir,'agy.jsonl');mkdirSync(join(dir,'main'),{recursive:true});
 writeFileSync(join(dir,'main','bot.json'),JSON.stringify({engine:'agy',heads:{engines:['agy'],answerWith:'agy'},agyConversation:'11111111-2222-4333-8444-555555555555'}));
 const c=new CoreHarness(dir,{BOTLING_FAKE_AGY:join(desktop,'test/fixtures/fake-agy.mjs'),FAKE_AGY_INPUT:log,FAKE_AGY_SILENT:'1'});cores.push(c);
 const sent=await c.call({type:'chat.send',botId:MAIN,text:'do not duplicate this'});
 await until(()=>c.of('turn.finished').some((e:any)=>e.event.turnId===sent.turnId&&e.event.status==='failed'));
 expect(readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(e=>e.args)).toHaveLength(1);
});
