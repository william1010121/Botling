// Small durable transaction records shared by startup, the helper handoff, and recovery UI.
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
export interface PendingUpdate {token:string;root:string;target:string;version:string;executable:string}
export interface RecoveryIssue {id:string;at:number;code:number;root:string;message:string;blocked:boolean;target:string;dataDir:string}
export function processAlive(pid:unknown):boolean {
 if(!Number.isSafeInteger(Number(pid))||Number(pid)<2)return false;
 try{process.kill(Number(pid),0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}
}
export function readSmallJSON(file:string):any {
 const stat=lstatSync(file);if(stat.isSymbolicLink()||stat.size>18000)throw new Error('Invalid update metadata');return JSON.parse(readFileSync(file,'utf8'));
}
export async function writeRecord(file:string,value:unknown):Promise<void>{
 await fs.mkdir(dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';
 try{await fs.writeFile(temp,JSON.stringify(value),{flag:'wx',mode:0o600});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}
}
export function validRoot(root:unknown,target:string):root is string {
 if(typeof root!=='string'||dirname(root)!==dirname(target)||!basename(root).startsWith('.botling-update-'))return false;
 try{return !lstatSync(root).isSymbolicLink()&&realpathSync(root)===root;}catch{return false;}
}
export function issueFor(dataDir:string,target:string,root:string,code:number,token?:string,at=Date.now()):RecoveryIssue{
 const blocked=[15,16,19,20,21,22].includes(code);
 const path=join(root,'data-before');
 const message=blocked?`Update recovery is required (failed:${code}). Normal startup is blocked. Recovery snapshot: ${path}. Current data: ${dataDir}. Prepared restore: ${dataDir}.update-restore-${token??'unknown'}.`:
 code===24?'A stale update transaction was cleared; prepare the update again.':code===18?'The update snapshot could not be completed (failed:18). The original app and data were kept.':`The update did not finish (failed:${code}). The available app was reopened.`;
 return{id:(token||createHash('sha256').update(root).digest('hex'))+':'+code,at,code,root,message,blocked,target,dataDir};
}
export async function recordIssue(issue:RecoveryIssue):Promise<void>{
 let previous:RecoveryIssue|null=null;try{previous=readSmallJSON(join(issue.dataDir,'update-recovery.json'));}catch{}
 if(!previous||previous.at<=issue.at)await writeRecord(join(issue.dataDir,'update-recovery.json'),issue);
}
export function currentRecovery(dataDir:string):RecoveryIssue|null{try{return readSmallJSON(join(dataDir,'update-recovery.json'));}catch{return null;}}
export function visibleRecovery(dataDir:string):{recoveryError:string|null;recoveryId:string|null}{
 const issue=currentRecovery(dataDir);let dismissed:string|undefined;try{dismissed=readSmallJSON(join(dataDir,'update-dismissed.json')).id;}catch{}
 return issue&&issue.id!==dismissed?{recoveryError:issue.message,recoveryId:issue.id}:{recoveryError:null,recoveryId:null};
}
export async function dismissRecovery(dataDir:string,id:string):Promise<void>{
 if(currentRecovery(dataDir)?.id!==id)throw new Error('The update recovery record changed.');await writeRecord(join(dataDir,'update-dismissed.json'),{id});
}
export function blockingRecovery(dataDir:string):RecoveryIssue|null{
 try{
  const p=readSmallJSON(join(dataDir,'update-pending.json')) as PendingUpdate;
  if(validRoot(p.root,p.target)){
   let result='';try{result=readFileSync(join(p.root,'result'),'utf8');}catch{}
   let code=Number(/^failed:(\d+)/.exec(result)?.[1]);
   if(!result){try{if(readFileSync(join(p.root,'decision'),'utf8').trim()==='rollback:'+p.token&&!processAlive(readFileSync(join(p.root,'helper.pid'),'utf8')))code=22;}catch{}}
   if([15,16,19,20,21,22].includes(code))return issueFor(dataDir,p.target,p.root,code,p.token);
  }
 }catch{}
 const issue=currentRecovery(dataDir);return issue?.blocked?issue:null;
}
export function recoveryHTML(issue:RecoveryIssue):string{
 const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
 return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Botling update recovery</title><style>body{background:#151517;color:#eee;font:17px system-ui;padding:48px;line-height:1.6}p{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Update recovery required</h1><p role="alert" aria-label="Update recovery">'+escape(issue.message)+'</p><p>Close the app before restoring the complete snapshot. The current data and recovery copies are preserved.</p>';
}
export async function commitUpdateReceipt(dataDir:string,target:string,version:string,argv:string[]):Promise<'waiting'|'committed'|'blocked'>{
 const token=argv.find(a=>a.startsWith('--botling-update-token='))?.slice('--botling-update-token='.length);if(!token)return'blocked';
 let pending:PendingUpdate;try{pending=readSmallJSON(join(dataDir,'update-pending.json'));}catch{return'blocked';}
 if(pending.token!==token||pending.target!==target||pending.version!==version||!validRoot(pending.root,target))return'blocked';
 const root=pending.root,read=(name:string)=>{try{return readFileSync(join(root,name),'utf8').trim();}catch{return'';}};
 if(read('boot.ok')!==token)return'waiting';
 const result=read('result'),decision=read('decision');
 if(result==='booted'&&(decision===''||decision==='commit:'+token))return'committed';
 if(result.startsWith('failed:')||decision==='rollback:'+token){
  if(!processAlive(read('helper.pid')))await recordIssue(issueFor(dataDir,target,root,Number(/^failed:(\d+)/.exec(result)?.[1]??22),token));
  return'blocked';
 }
 if(processAlive(read('helper.pid')))return'waiting';
 if(Number(read('new.pid'))!==process.pid)return'blocked';
 // A dead helper cannot make a later rollback decision. Atomic hard-link publication arbitrates
 // with a decision it made immediately before dying; a rollback decision always forbids activation.
 const temporary=join(root,'decision-candidate-'+randomUUID());
 try{
  await fs.writeFile(temporary,'commit:'+token+'\n',{flag:'wx',mode:0o600});
  try{await fs.link(temporary,join(root,'decision'));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 }finally{await fs.rm(temporary,{force:true});}
 if(read('decision')!=='commit:'+token)return'blocked';
 if(read('result').startsWith('failed:'))return'blocked';
 const file=join(root,'result-candidate-'+randomUUID());await fs.writeFile(file,'booted\n',{mode:0o600});await fs.rename(file,join(root,'result'));
 await writeRecord(join(dataDir,'update-orphan-commit.json'),{token,version,helper:Number(read('helper.pid')),candidate:process.pid});
 return'committed';
}
