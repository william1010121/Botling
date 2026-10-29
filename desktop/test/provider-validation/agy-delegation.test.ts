// Opt-in product integration probe, outside normal unit/live discovery.
// Only this test module enables the staged transport. Production gates stay false.
import {expect,it,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
vi.mock('../../src/core/agent/agy-capabilities',()=>({agyWorkerRuntimeEnabled:()=>true,agyMixedRuntimeEnabled:()=>false,agyPairAllowed:()=>false}));
vi.mock('../../src/core/process/tree',async original=>{const actual=await original<typeof import('../../src/core/process/tree')>();const adapter=actual.processTreeAdapter();return {...actual,processTreeAdapter:()=>adapter};});
import {AgyAcpHead,verifyAcpRuntime} from '../../src/core/agent/agy-acp';
import {verifyAgyFileHelper} from '../../src/core/agent/agy-mcp';
import {AgyWorkers} from '../../src/core/agent/agy-workers';
import {createAgyWorkerHead} from '../../src/core/agent/agy-worker-router';
import {processTreeAdapter} from '../../src/core/process/tree';

it('validates real isolated agy denial, report identity and same-session continuation',async()=>{
 if(process.env.BOTLING_VALIDATE_AGY_DELEGATION!=='1')throw Error('Explicit live validation opt-in required.');
 const command=process.env.BOTLING_AGY_ACP_PATH;if(!command)throw Error('Verified runtime path required.');
 verifyAcpRuntime(command);
 // Metadata only. Missing cache must not initiate login or a model prompt.
 execFileSync('/usr/bin/security',['find-generic-password','-s','gemini','-a','antigravity-acp'],{stdio:'ignore'});
 const parent=resolve('.cache/agy-parity-live');mkdirSync(parent,{recursive:true});
 const root=mkdtempSync(join(parent,'run-')),cwd=join(root,'workspace'),home=join(root,'profile');mkdirSync(cwd);mkdirSync(home);
 verifyAgyFileHelper(join(dirname(command),'botling-agy-file-helper'),cwd);
 const evidence:any={runtimeVerified:true,authMetadataPresent:true,permissions:[],reports:[],sessions:[],processes:[],markerAbsent:true,liveCoordinator:false};
 let authAttempt=false,manager:AgyWorkers;
 const adapter=processTreeAdapter(),spawn=adapter.spawn.bind(adapter);
 const spy=vi.spyOn(adapter,'spawn').mockImplementation((exe,args,options)=>{
  if(exe!==command)throw Error('Unexpected top-level process; no action approved.');
  const p=spawn(exe,args,options);evidence.processes.push(p.pid);
  p.child.stderr?.on('data',(chunk:Buffer)=>{if(/https:\/\/accounts\.google|oauth.*(?:consent|browser)/i.test(String(chunk))){authAttempt=true;void p.terminate({graceMs:500});}});
  return p;
 });
 const wait=async(check:()=>boolean)=>{const end=Date.now()+90_000;while(!check()){if(authAttempt)throw Error('ACP emitted authentication-related output; stopped without login. Confirm existing ACP authentication before repeating.');if(Date.now()>end)throw Error('Provider validation exceeded 90 seconds.');await new Promise(r=>setTimeout(r,100));}};
 manager=new AgyWorkers({command,cwd,acpHome:home,sessionId:randomUUID(),resume:false,bypassPermissions:false,
  workerInstructions:'This is an isolated product integration fixture. Execute only the supplied private scratch task. Do not delegate, inspect credentials, access external paths, or change settings. Stop after any denial.'},item=>{
   if(item.kind==='permission'){evidence.permissions.push({workerId:item.workerId,tool:item.tool,denied:true});manager.answer(item.requestId,false,item.input);}
  },(id,text,run)=>evidence.reports.push({id,run,text}),(config,handlers)=>createAgyWorkerHead(config,handlers,(c,h)=>{
   const session:any={taskProfile:c.acpHome,sessionId:c.sessionId,resume:c.resume};evidence.sessions.push(session);
   return new AgyAcpHead(c,{...h,onItem:item=>{if(item.kind==='init')session.actualSessionId=item.sessionId;if(item.kind==='init'||item.kind==='usage'||item.kind==='result'||item.kind==='permission'||item.kind==='permissionCancelled'||item.kind==='delta'||item.kind==='toolUse'||item.kind==='toolResult')h.onItem(item);}});
  }));
 try{
  const denied=await manager.tool('app_handoff',{instructions:'Use botling write_file exactly once to create deny-marker.txt containing DENIED. If denied, stop immediately and report the denial. Do not use any other tool.'});
  const plain=await manager.tool('app_handoff',{instructions:'Reply exactly AGY_ISOLATED_READY. Do not use tools.'});
  expect(denied.task_id).not.toBe(plain.task_id);
  await wait(()=>evidence.reports.length===2);
  expect(authAttempt).toBe(false);expect(existsSync(join(cwd,'deny-marker.txt'))).toBe(false);
  expect(evidence.permissions.some((p:any)=>p.workerId===denied.task_id)).toBe(true);
  expect(evidence.reports.find((r:any)=>r.id===denied.task_id).text).toContain('status="failed"');
  expect(evidence.reports.find((r:any)=>r.id===plain.task_id).text).toContain('AGY_ISOLATED_READY');
  for(const task of [denied,plain]){expect(manager.beginReport(task.task_id,1)).toBe(true);await manager.tool('app_task_checkpoint',{task_id:task.task_id,run:1,outcome:task===denied?'blocked':'complete',evidence:task===denied?'Exact denial observed; marker absent':'Expected isolated reply received'});}
  const saved=evidence.sessions.find((s:any)=>s.taskProfile.endsWith(plain.task_id));
  await manager.tool('app_send_message',{task_id:plain.task_id,run:1,message:'Same integration task: reply exactly AGY_RESUMED_READY without tools.'});
  await wait(()=>evidence.reports.length===3);
  expect(evidence.sessions.at(-1).resume).toBe(true);expect(evidence.sessions.at(-1).sessionId).toBe(saved.actualSessionId);
  expect(evidence.reports.at(-1).text).toContain('AGY_RESUMED_READY');
  evidence.result='passed';
 }catch(error){evidence.result='failed';evidence.error=(error as Error).message;throw error;}
 finally{
  await manager.close();spy.mockRestore();
  evidence.authAttempt=authAttempt;evidence.markerAbsent=!existsSync(join(cwd,'deny-marker.txt'));
  evidence.processGroupsGone=evidence.processes.every((pid:number)=>{try{process.kill(-pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}});
  writeFileSync(join(root,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({evidencePath:join(root,'evidence.json'),result:evidence.result,processGroupsGone:evidence.processGroupsGone}));
  expect(evidence.processes.length).toBeGreaterThanOrEqual(2);expect(evidence.processGroupsGone).toBe(true);
 }
},290_000);
