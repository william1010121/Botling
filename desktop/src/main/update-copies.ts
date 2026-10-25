// Retained user data has no automatic expiry. The registry keeps old app locations discoverable
// after a move; every entry is re-authorized against its transaction owner before use.
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import {dirname,join,sep} from 'node:path';
import {blockingRecovery,persistentDataIdentity,readSmallJSON,validRoot,writeRecord,issueFor,recoveryCopies,processAlive,validateRestoredData} from './update-state';
import type {RecoveryIssue} from './update-state';
import type {RetainedUpdateCopy} from '../contract';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
const read=(file:string)=>fs.readFile(file,'utf8').then(value=>value.trim()).catch(()=>'');
const json=(file:string)=>{try{return readSmallJSON(file);}catch{return null;}};
export {rememberRetained} from './update-state';
export async function canRemovePrevious(issue:RecoveryIssue,running:string[]):Promise<boolean>{
 const owner=json(join(issue.root,'owner.json')),healthy=json(join(issue.dataDir,'update-last-boot.json'));
 const previous=join(issue.root,'previous.app');
 return Boolean(validRoot(issue.root,issue.target)&&owner?.dataDir===issue.dataDir&&owner.target===issue.target&&owner?.token&&await read(join(issue.root,'result'))==='booted'&&await read(join(issue.root,'activated.ok'))===owner.token&&
  healthy?.activated===true&&healthy.token===owner.token&&existsSync(issue.target)&&running.includes(issue.target)&&
  !running.some(path=>path===previous||path.startsWith(previous+sep)));
}
async function roots(dataDir:string,target:string):Promise<RecoveryIssue[]>{
 const candidates=new Map<string,string>();
 for(const name of ['update-pending.json','update-recovery.json','update-recovered.json']){const record=json(join(dataDir,name));if(typeof record?.root==='string'&&typeof record.target==='string')candidates.set(record.root,record.target);}
 for(const name of await fs.readdir(dirname(target)).catch(()=>[] as string[]))if(name.startsWith('.botling-update-'))candidates.set(join(dirname(target),name),target);
 for(const name of await fs.readdir(join(dataDir,'update-retained')).catch(()=>[] as string[])){
  if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const entry=json(join(dataDir,'update-retained',name));
  if(entry&&typeof entry.root==='string'&&typeof entry.target==='string')candidates.set(entry.root,entry.target);
 }
 const result:RecoveryIssue[]=[];
 for(const [root,app] of candidates){
  if(!validRoot(root,app))continue;const owner=json(join(root,'owner.json'));
  if(owner?.target!==app||owner.dataDir!==dataDir||typeof owner.token!=='string')continue;
  const status=await read(join(root,'result')),code=Number(/^failed:(\d+)/.exec(status)?.[1])||0;
  result.push(issueFor(dataDir,app,root,code,owner.token));
 }
 return result;
}
async function enumerate(dataDir:string,target:string,running:string[]){
 const all:{view:RetainedUpdateCopy;issue:RecoveryIssue}[]=[];
 for(const issue of await roots(dataDir,target)){
  const helper=processAlive(await read(join(issue.root,'helper.pid'))),candidate=Number(await read(join(issue.root,'new.pid')));
  for(const copy of await recoveryCopies(issue)){
   const active=helper||(candidate!==process.pid&&processAlive(candidate))||running.some(app=>app===copy.path||app.startsWith(copy.path+sep));
   const protectedApp=copy.kind==='app'&&(!existsSync(issue.target)||!running.includes(issue.target)||copy.role==='previous-app'&&!await canRemovePrevious(issue,running));
   all.push({issue,view:{...copy,id:createHash('sha256').update(issue.root+'\0'+copy.path).digest('hex'),deletable:!active&&!protectedApp,
    reason:active?'This transaction or app is still running.':protectedApp?'Kept until another running app has committed and activated successfully.':null}});
  }
 }
 return all;
}
export async function retainedUpdateCopies(dataDir:string,target:string,running:string[]):Promise<RetainedUpdateCopy[]>{
 return (await enumerate(dataDir,target,running)).map(item=>item.view);
}
/** Main has displayed this exact copy and received explicit native confirmation. Resolve the
 * opaque id again; a renderer cannot choose an arbitrary filesystem path. */
export async function deleteRetainedUpdateCopy(dataDir:string,target:string,id:string,running:string[]):Promise<void>{
 const item=(await enumerate(dataDir,target,running)).find(item=>item.view.id===id);
 if(!item)throw new Error('The recovery copy changed or no longer exists. Refresh the list.');
 if(!item.view.deletable)throw new Error(item.view.reason!);
 if(!persistentDataIdentity(dataDir))throw new Error('The live persistent data is unavailable. All recovery copies are kept.');
 const block=blockingRecovery(dataDir,target);
 if(block){const digest=await validateRestoredData(block);await writeRecord(join(block.root,'restored-validated.json'),{id:block.id,digest,at:Date.now()});}
 // Copies remain by default. Native deletion is limited to the owner-derived path selected above.
 await run('/bin/rm',['-rf',item.view.path],{timeout:120_000});
}
