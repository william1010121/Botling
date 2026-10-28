import {AgyAcpHead} from '../../../src/core/agent/agy-acp';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const root=resolve('.cache/agy-acp-dev'),evidence:any={};
async function run(crash:boolean){
 const dir=mkdtempSync(join(root,crash?'crash-smoke-':'image-smoke-')),cwd=join(dir,'workspace');mkdirSync(cwd);let resolveResult!:(x:any)=>void;
 const result=new Promise<any>(r=>resolveResult=r);const command='echo $$ > active.pid; sleep 60';let killed=false;
 const head=new AgyAcpHead({command:join(root,'server/agy_acp_server.par'),cwd,acpHome:join(dir,'profile'),sessionId:randomUUID(),resume:false,...(!crash?{model:'gemini-3.8-flash-high',effort:'medium'}:{})}, {
  onItem:i=>{
   if(i.kind==='permission'){const args=(i.input.arguments??i.input) as any;head.answer(i.requestId,crash&&args.command===command,i.input);}
   if(i.kind==='usage')evidence.usageReported=i.tokens;
   if(i.kind==='result'&&!crash)resolveResult(i);
  },onExit:e=>{if(crash||!e.expected)resolveResult(e);}
 });
 head.start();head.send(crash?'Use botling run_command to execute exactly `'+command+'`. Do not use other tools.':'Look at the attached image and name its dominant color in one word. Do not use tools.',randomUUID(),crash?[]:[join(root,'attachment-fixture.png')]);
 const interval=setInterval(()=>{if(crash&&!killed&&existsSync(join(cwd,'active.pid'))){killed=true;process.kill(head.pid,'SIGKILL');}},50);
 const timeout=setTimeout(()=>{resolveResult({error:'timed out'});void head.terminate();},90_000);
 const value=await result;clearTimeout(timeout);clearInterval(interval);await head.terminate();await head.exited;
 if(crash){const pid=Number(readFileSync(join(cwd,'active.pid'),'utf8'));let alive=true;try{process.kill(pid,0);}catch{alive=false;}if(!killed||alive)throw new Error('Crash cleanup failed');evidence.crashCleanup={serverKilled:true,commandStopped:true,exit:value};}
 else {if(!value.ok||!value.text.toLowerCase().includes('red'))throw new Error('Image/model smoke failed '+JSON.stringify(value));evidence.imageAndModel={model:'gemini-3.8-flash-high',effort:'medium',reply:value.text,ok:true};}
 writeFileSync(join(root,process.argv.includes('--crash-only')?'sandbox-crash-smoke-results.json':'extended-smoke-results.json'),JSON.stringify(evidence,null,2));
}
if(!process.argv.includes('--crash-only'))await run(false);await run(true);console.log(process.argv.includes('--crash-only')?'PASS ACP crash cleans sandboxed app-owned command':'PASS configured model/image and ACP crash cleans app-owned command');
