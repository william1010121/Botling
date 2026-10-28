// Explicit opt-in; uses existing authentication only, in a private disposable folder.
import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyHead } from '../../src/core/agent/agy';
import type { StreamItem } from '../../src/core/agent/stream';
import { until } from '../helpers';
const live=process.env.BOTLING_LIVE_AGY==='1';
it.skipIf(!live)('real agy: two turns, explicit resume, tool/refusal, cancellation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'botling-agy-live-'));const heads:AgyHead[]=[];
 const start=(resume=false,sessionId='')=>{
  const items:StreamItem[]=[];
  const head=new AgyHead({command:process.env.BOTLING_AGY_PATH??'agy',cwd:dir,sessionId,resume,model:'gemini-3.8-flash-medium'}, {onItem:i=>items.push(i),onExit:()=>{}});
  heads.push(head);head.start();return {head,items};
 };
 const turn=async(h:ReturnType<typeof start>,prompt:string)=>{
  const n=h.items.filter(i=>i.kind==='result').length;
  h.head.send(prompt,`turn-${n}`);
  await until(()=>h.items.filter(i=>i.kind==='result').length>n,{timeout:35000,what:'real agy result'});
  return h.items.filter((i):i is Extract<StreamItem,{kind:'result'}>=>i.kind==='result').at(-1)!;
 };
 try {
  const first=start();expect((await turn(first,'Without using any tools, reply exactly AGY_SESSION_42.')).text).toContain('AGY_SESSION_42');
  expect((await turn(first,'Without using tools, repeat the exact token I requested in my previous message.')).text).toContain('AGY_SESSION_42');
  const init=first.items.find((i):i is Extract<StreamItem,{kind:'init'}>=>i.kind==='init');expect(init).toBeTruthy();
  first.head.finish();await first.head.exited;
  const resumed=start(true,init!.sessionId);
  expect((await turn(resumed,'Without using tools, repeat the original AGY token from this conversation.')).text).toContain('AGY_SESSION_42');
  writeFileSync(join(dir,'sentinel.txt'),'AGY_READ_42');
  const result=await turn(resumed,'Read sentinel.txt in the current directory using a file tool. Then try run_command with exactly: printf AGY_COMMAND_42 . Do not use any other tools or paths. If refused, stop and report the refusal; do not retry, bypass or change permissions.');
  expect(resumed.items.some(i=>i.kind==='toolUse'&&i.tool==='read_file')).toBe(true);
  expect(result.ok).toBe(false);expect(result.error).toContain('approval');
  console.log('AGY_LIVE: model selected; two turns and process resume remembered token; file tool observed; command refused; refusal surfaced as failed result.');
  resumed.head.send('Without any tools, write a numbered list of 500 ordinary English words.','cancel');
  await until(()=>resumed.head.running,{timeout:2000});
  const count=resumed.items.length;resumed.head.interrupt();await resumed.head.exited;
  expect(resumed.head.running).toBe(false);expect(resumed.items.length).toBe(count);
  console.log('AGY_LIVE: cancellation exited the process; no late stream events.');
 } finally { for(const h of heads) await h.terminate(500);rmSync(dir,{recursive:true,force:true}); }
},150000);
