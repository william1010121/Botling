import { AgyAcpHead } from '../../../src/core/agent/agy-acp';
import { mkdtempSync,mkdirSync,existsSync,writeFileSync,readFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { randomUUID } from 'node:crypto';
const root=resolve('.cache/agy-acp-dev');const dir=mkdtempSync(join(root,'head-smoke-'));const cwd=join(dir,'workspace');mkdirSync(cwd);
const marker=join(cwd,'denied.txt');const evidence:any={turns:[],permissions:[],exits:[]};let sessionId=randomUUID();
async function turn(resume:boolean,text:string,allow=false){
 let finish!:(value:any)=>void;const result=new Promise<any>(r=>finish=r);
 const h=new AgyAcpHead({command:join(root,'server/agy_acp_server.par'),cwd,acpHome:join(dir,'profile'),sessionId,resume}, {onItem:i=>{
  if(i.kind==='init')sessionId=i.sessionId;
  if(i.kind==='permission'){evidence.permissions.push({summary:i.summary,markerAbsent:!existsSync(marker)});const args=(i.input.arguments??i.input) as any;const permitted=allow&&((args.path==='approved.txt'&&args.content==='APPROVED')||args.command==="echo $$ > active.pid; sleep 60");h.answer(i.requestId,permitted,i.input);}
  if(i.kind==='result')finish(i);
 },onExit:e=>{evidence.exits.push(e);if(!e.expected)finish({error:e.stderr});}});
 h.start();h.send(text,randomUUID());
 const watcher=setInterval(()=>{if(allow&&existsSync(join(cwd,'active.pid')))h.interrupt();},100);
 const timer=setTimeout(()=>{finish({error:'smoke timeout'});void h.terminate();},90_000);
 const r=await result;clearTimeout(timer);clearInterval(watcher);await h.terminate();await h.exited;evidence.turns.push(r);writeFileSync(join(root,'head-smoke-results.json'),JSON.stringify(evidence,null,2));return r;
}
await turn(false,'Use the botling write_file tool to create denied.txt containing hello. If permission is denied, stop without trying anything else.');
if(!evidence.permissions.length||existsSync(marker)||evidence.turns[0].error)throw new Error('Deny smoke failed: '+JSON.stringify(evidence));
await turn(true,'Reply exactly ACP_RESUMED without using any tool.');
if(evidence.turns[1].error||!evidence.turns[1].text.includes('ACP_RESUMED'))throw new Error('Resume smoke failed: '+JSON.stringify(evidence));
await turn(true,'Use botling write_file once to create approved.txt containing exactly APPROVED. Do not use other tools.',true);
if(readFileSync(join(cwd,'approved.txt'),'utf8')!=='APPROVED')throw new Error('Approved tool failed');
await turn(true,'Use botling run_command to run exactly: echo $$ > active.pid; sleep 60 . Wait for completion; do not use any other tool.',true);
const pid=Number(readFileSync(join(cwd,'active.pid'),'utf8'));let alive=true;try{process.kill(pid,0);}catch{alive=false;}if(alive)throw new Error('Command survived cancellation');
evidence.activeToolStopped=true;evidence.sessionId=sessionId;evidence.markerAbsent=!existsSync(marker);writeFileSync(join(root,'head-smoke-results.json'),JSON.stringify(evidence,null,2));console.log('PASS ACP head denial and process-restart continuation');
