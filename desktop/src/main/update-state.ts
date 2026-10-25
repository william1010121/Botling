// Small durable transaction records shared by startup, helper handoff and recovery UI.
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
export interface PendingUpdate {token:string;root:string;target:string;version:string;executable:string}
export interface RecoveryIssue {id:string;at:number;code:number;root:string;message:string;blocked:boolean;target:string;dataDir:string;paths?:{label:string;path:string}[]}
export const UPDATE_RECORDS=['update-pending.json','update-recovery.json','update-dismissed.json','update-recovered.json','update-last-boot.json','update-orphan-commit.json','update-cleanup','update-diagnostics'];
export function processAlive(pid:unknown):boolean {
 if(!Number.isSafeInteger(Number(pid))||Number(pid)<2)return false;
 try{process.kill(Number(pid),0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}
}
export function readSmallJSON(file:string):any {
 const stat=lstatSync(file);if(stat.isSymbolicLink()||stat.size>18000)throw new Error('Invalid update metadata');return JSON.parse(readFileSync(file,'utf8'));
}
function text(file:string):string {try{return readFileSync(file,'utf8').trim();}catch{return '';}}
function json(file:string):any {try{return readSmallJSON(file);}catch{return null;}}
export async function writeRecord(file:string,value:unknown):Promise<void>{
 await fs.mkdir(dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';
 try{await fs.writeFile(temp,JSON.stringify(value),{flag:'wx',mode:0o600});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}
}
export function validRoot(root:unknown,target:string):root is string {
 if(typeof root!=='string'||dirname(root)!==dirname(target)||!basename(root).startsWith('.botling-update-'))return false;
 try{return lstatSync(root).isDirectory()&&!lstatSync(root).isSymbolicLink()&&realpathSync(root)===root;}catch{return false;}
}
/** Old helpers reused 16 before any swap and after a failed restore. A partial unmarked snapshot
 * alone proves neither a completed snapshot nor a restore attempt. Preserve real restore evidence. */
export function recoveryCode(dataDir:string,target:string,root:string,code:number,token?:string):number {
 if(code!==16)return code;
 const paths=['previous.app','failed.app','new.pid','snapshot.complete','data-restored'];
 const restore=token&&[`${dataDir}.update-restore-${token}`,`${dataDir}.update-after-${token}`].some(existsSync);
 return existsSync(dataDir)&&existsSync(target)&&!restore&&!paths.some(p=>existsSync(join(root,p)))?18:16;
}
export function issueFor(dataDir:string,target:string,root:string,code:number,token?:string,at=Date.now()):RecoveryIssue{
 code=recoveryCode(dataDir,target,root,code,token);
 const blocked=[15,16,19,20,21,22,25,26].includes(code);
 const owned=validRoot(root,target);
 const candidates=[...(owned?[{label:'Recovery snapshot',path:join(root,'data-before')}]:[]),{label:'Current data',path:dataDir},
  ...(token?[{label:'Previous data',path:`${dataDir}.update-after-${token}`},{label:'Prepared restore',path:`${dataDir}.update-restore-${token}`}]:[]),
  {label:owned?'Transaction folder':'Available app folder',path:root}];
 const paths=candidates.filter(p=>existsSync(p.path));
 const message=blocked?`Update recovery is required (failed:${code}). Normal startup is blocked.\n${paths.map(p=>p.label+': '+p.path).join('\n')}`:
 code===24?'A stale update transaction was cleared; prepare the update again.':code===18?'The update snapshot could not be completed (failed:18). The original app and data were kept.':`The update did not finish (failed:${code}). The available app was reopened.`;
 return{id:(token||createHash('sha256').update(root).digest('hex'))+':'+code,at,code,root,message,blocked,target,dataDir,paths};
}
export function recoveryAccepted(issue:RecoveryIssue):boolean {
 return [json(join(issue.root,'recovery-accepted.json')),json(join(issue.dataDir,'update-recovered.json'))].some(record=>record?.id===issue.id);
}
export async function recordIssue(issue:RecoveryIssue):Promise<void>{
 const previous=json(join(issue.dataDir,'update-recovery.json')) as RecoveryIssue|null;
 if(!previous||previous.at<=issue.at)await writeRecord(join(issue.dataDir,'update-recovery.json'),issue);
}
export function currentRecovery(dataDir:string):RecoveryIssue|null {
 const issue=json(join(dataDir,'update-recovery.json')) as RecoveryIssue|null;
 if(!issue||recoveryAccepted(issue))return null;
 const token=issue.id.slice(0,issue.id.lastIndexOf(':'));
 return issue.blocked?issueFor(dataDir,issue.target,issue.root,issue.code,token,issue.at):issue;
}
export function visibleRecovery(dataDir:string):{recoveryError:string|null;recoveryId:string|null}{
 const issue=currentRecovery(dataDir),dismissed=json(join(dataDir,'update-dismissed.json'))?.id;
 return issue&&issue.id!==dismissed?{recoveryError:issue.message,recoveryId:issue.id}:{recoveryError:null,recoveryId:null};
}
export async function dismissRecovery(dataDir:string,id:string):Promise<void>{
 if(currentRecovery(dataDir)?.id!==id)throw new Error('The update recovery record changed.');await writeRecord(join(dataDir,'update-dismissed.json'),{id});
}
/** This is read-only and runs before mkdir/profile/core startup. Recovery metadata outside the live
 * directory remains discoverable even if both data renames and compensation failed (failed:21). */
export function blockingRecovery(dataDir:string,target?:string):RecoveryIssue|null {
 const pending=json(join(dataDir,'update-pending.json')) as PendingUpdate|null;
 const roots=new Map<string,{target:string;token?:string}>();
 if(pending&&validRoot(pending.root,pending.target))roots.set(pending.root,{target:pending.target,token:pending.token});
 if(target){
  let names:string[]=[];try{names=readdirSync(dirname(target));}catch{}
  for(const name of names){
   if(!name.startsWith('.botling-update-')||name.startsWith('.botling-update-gc-'))continue;
   const root=join(dirname(target),name);if(!validRoot(root,target))continue;
   const owner=json(join(root,'owner.json'));
   if(owner?.dataDir===dataDir&&owner.target===target)roots.set(root,{target,token:owner.token});
  }
 }
 for(const [root,owner] of roots){
  const result=text(join(root,'result')),helper=processAlive(text(join(root,'helper.pid')));
  let code=Number(/^failed:(\d+)/.exec(result)?.[1]);
  if(!result){
   if(text(join(root,'decision'))==='rollback:'+owner.token&&!helper)code=22;
   else if(!existsSync(dataDir))code=helper?26:21;
   else if(!helper&&existsSync(join(root,'previous.app'))&&!existsSync(join(root,'Botling 2.app')))code=25;
  }
  if(code){const issue=issueFor(dataDir,owner.target,root,code,owner.token);if(issue.blocked&&!recoveryAccepted(issue))return issue;}
 }
 const issue=currentRecovery(dataDir);return issue?.blocked?issue:null;
}
/** Explicit user acknowledgment, never automatic recovery or deletion of user files. The next
 * launch uses the restored data; stale transaction records cannot restore the block. */
export async function completeRecovery(dataDir:string,target:string,id:string):Promise<void>{
 const issue=blockingRecovery(dataDir,target);if(!issue||issue.id!==id)throw new Error('The recovery record changed; review the current recovery paths.');
 if(processAlive(text(join(issue.root,'helper.pid'))))throw new Error('Recovery is still running. Wait for the helper to finish.');
 const candidate=Number(text(join(issue.root,'new.pid')));
 if(candidate!==process.pid&&processAlive(candidate))throw new Error('The candidate app is still running. Close it before continuing.');
 if(!existsSync(dataDir)||!lstatSync(dataDir).isDirectory())throw new Error('Restore the complete data directory before continuing.');
 const accepted={id:issue.id,root:issue.root,at:Date.now()};
 if(validRoot(issue.root,issue.target))await writeRecord(join(issue.root,'recovery-accepted.json'),accepted);
 await writeRecord(join(dataDir,'update-recovered.json'),accepted);
 const pending=json(join(dataDir,'update-pending.json'));
 if(pending?.root===issue.root)await fs.rm(join(dataDir,'update-pending.json'),{force:true});
 if(json(join(dataDir,'update-recovery.json'))?.id===id)await fs.rm(join(dataDir,'update-recovery.json'),{force:true});
 if(json(join(dataDir,'update-dismissed.json'))?.id===id)await fs.rm(join(dataDir,'update-dismissed.json'),{force:true});
}
export function recoveryHTML(issue:RecoveryIssue,error?:string):string {
 const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
 const action=(name:string)=>'botling-recovery://action/'+name+'?id='+encodeURIComponent(issue.id);
 return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Botling update recovery</title><style>body{background:#151517;color:#eee;font:17px system-ui;padding:48px;line-height:1.6}p{white-space:pre-wrap;overflow-wrap:anywhere}a{display:inline-block;color:#fff;background:#345c9b;padding:8px 16px;margin:8px 12px 0 0;border-radius:6px}</style><h1>Update recovery required</h1><p role="alert" aria-label="Update recovery">'+escape(issue.message)+'</p>'+(error?'<p role="alert">'+escape(error)+'</p>':'')+'<p>Restore the complete snapshot with all app windows closed. Restore destination: '+escape(issue.dataDir)+'. Continue only after the complete data is restored there. Continuing restarts the available app and allows cleanup of this transaction’s recovery copies.</p><a href="'+escape(action('open'))+'">Open recovery folder</a><a href="'+escape(action('continue'))+'">I restored my data — continue</a>';
}
export async function commitUpdateReceipt(dataDir:string,target:string,version:string,argv:string[]):Promise<'waiting'|'committed'|'blocked'>{
 const token=argv.find(a=>a.startsWith('--botling-update-token='))?.slice('--botling-update-token='.length);
 const pending=json(join(dataDir,'update-pending.json')) as PendingUpdate|null;
 const block=async(root:string,code=25,expected=token)=>{await recordIssue(issueFor(dataDir,target,root,code,expected));return 'blocked' as const;};
 if(!token||!pending||pending.token!==token||pending.target!==target||pending.version!==version||!validRoot(pending.root,target))return block(pending&&validRoot(pending.root,target)?pending.root:dirname(target));
 const root=pending.root,read=(name:string)=>text(join(root,name));
 if(read('boot.ok')!==token)return'waiting';
 const result=read('result'),decision=read('decision');
 if(result==='booted'&&(decision===''||decision==='commit:'+token))return'committed';
 if(result.startsWith('failed:')||decision==='rollback:'+token){
  if(!processAlive(read('helper.pid')))await block(root,Number(/^failed:(\d+)/.exec(result)?.[1]??22));
  return'blocked';
 }
 if(processAlive(read('helper.pid')))return'waiting';
 if(Number(read('new.pid'))!==process.pid)return block(root);
 // Atomic publication arbitrates with a rollback decision the helper made immediately before dying.
 const temporary=join(root,'decision-candidate-'+randomUUID());
 try{
  await fs.writeFile(temporary,'commit:'+token+'\n',{flag:'wx',mode:0o600});
  try{await fs.link(temporary,join(root,'decision'));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 }finally{await fs.rm(temporary,{force:true});}
 if(read('decision')!=='commit:'+token||read('result').startsWith('failed:'))return block(root,22);
 const file=join(root,'result-candidate-'+randomUUID());await fs.writeFile(file,'booted\n',{mode:0o600});await fs.rename(file,join(root,'result'));
 await writeRecord(join(dataDir,'update-orphan-commit.json'),{token,version,helper:Number(read('helper.pid')),candidate:process.pid});return'committed';
}
