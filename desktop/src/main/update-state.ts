// Small durable transaction records shared by startup, helper handoff and recovery UI.
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,statSync,readFileSync,readdirSync,realpathSync,readlinkSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import {basename,dirname,join,relative,sep,resolve,isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
export interface PendingUpdate {token:string;root:string;target:string;version:string;executable:string}
export interface RecoveryIssue {id:string;at:number;code:number;root:string;message:string;blocked:boolean;target:string;dataDir:string;originalDataIdentity?:string;paths?:{label:string;path:string}[]}
export const UPDATE_RECORDS=['update-pending.json','update-recovery.json','update-dismissed.json','update-recovered.json','update-last-boot.json','update-orphan-commit.json','update-cleanup','update-diagnostics','update-retained'];
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
/** Persist a small owner-checked location record before clearing pending/recovery provenance. */
export async function rememberRetained(dataDir:string,root:string,target:string):Promise<void>{
 if(!existsSync(dataDir)||!validRoot(root,target))return;
 const owner=json(join(root,'owner.json'));if(owner?.dataDir!==dataDir||owner.target!==target)return;
 const file=join(dataDir,'update-retained',createHash('sha256').update(root).digest('hex')+'.json');
 if(!existsSync(file))await writeRecord(file,{root,target});
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
 const signature=(value:RecoveryIssue)=>JSON.stringify({...value,at:0});
 if(previous&&signature(previous)===signature(issue))return;
 if(!previous||previous.at<=issue.at)await writeRecord(join(issue.dataDir,'update-recovery.json'),issue);
}
export function currentRecovery(dataDir:string):RecoveryIssue|null {
 const issue=json(join(dataDir,'update-recovery.json')) as RecoveryIssue|null;
 if(!issue||recoveryAccepted(issue))return null;
 const token=issue.id.slice(0,issue.id.lastIndexOf(':'));
 return issue.blocked?{...issue,...issueFor(dataDir,issue.target,issue.root,issue.code,token,issue.at)}:issue;
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
   else if(!existsSync(dataDir)&&(['previous.app','snapshot.complete','new.pid'].some(name=>existsSync(join(root,name)))||owner.token&&['after','restore'].some(kind=>existsSync(`${dataDir}.update-${kind}-${owner.token}`))))code=helper?26:21;
   else if(!helper&&existsSync(join(root,'previous.app'))&&!existsSync(join(root,'Botling 2.app')))code=25;
  }
  if(code){const issue=issueFor(dataDir,owner.target,root,code,owner.token);if(issue.blocked&&!recoveryAccepted(issue))return issue;}
 }
 const issue=currentRecovery(dataDir);return issue?.blocked?issue:null;
}
/** Explicit user acknowledgment, never automatic recovery or deletion of user files. The next
 * launch uses the restored data; stale transaction records cannot restore the block. */
export async function completeRecovery(dataDir:string,target:string,id:string,progress?:(message:string)=>void):Promise<void>{
 const issue=blockingRecovery(dataDir,target);if(!issue||issue.id!==id)throw new Error('The recovery record changed; review the current recovery paths.');
 if(processAlive(text(join(issue.root,'helper.pid'))))throw new Error('Recovery is still running. Wait for the helper to finish.');
 const candidate=Number(text(join(issue.root,'new.pid')));
 if(candidate!==process.pid&&processAlive(candidate))throw new Error('The candidate app is still running. Close it before continuing.');
 await validateRestoredData(issue,progress);
 await rememberRetained(dataDir,issue.root,issue.target);
 const accepted={id:issue.id,root:issue.root,target:issue.target,at:Date.now()};
 if(validRoot(issue.root,issue.target))await writeRecord(join(issue.root,'recovery-accepted.json'),accepted);
 await writeRecord(join(dataDir,'update-recovered.json'),accepted);
 const pending=json(join(dataDir,'update-pending.json'));
 if(pending?.root===issue.root)await fs.rm(join(dataDir,'update-pending.json'),{force:true});
 if(json(join(dataDir,'update-recovery.json'))?.id===id)await fs.rm(join(dataDir,'update-recovery.json'),{force:true});
 if(json(join(dataDir,'update-dismissed.json'))?.id===id)await fs.rm(join(dataDir,'update-dismissed.json'),{force:true});
}
export function recoveryHTML(issue:RecoveryIssue,error?:string,copies:RecoveryCopy[]=[],busy?:string):string {
 const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
 const action=(name:string)=>'botling-recovery://action/'+name+'?id='+encodeURIComponent(issue.id);
 if(issue.code===27)return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Data volume unavailable</title><style>body{font:18px system-ui;padding:48px;line-height:1.6}p{overflow-wrap:anywhere}</style><h1>Data volume unavailable</h1><p role="alert">'+escape(issue.message)+'</p><a href="'+escape(action('retry'))+'">I mounted the volume — reopen</a>';
 return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Botling update recovery</title><style>body{background:#151517;color:#eee;font:17px system-ui;padding:48px;line-height:1.6}p{white-space:pre-wrap;overflow-wrap:anywhere}a{display:inline-block;color:#fff;background:#345c9b;padding:8px 16px;margin:8px 12px 0 0;border-radius:6px}</style><h1>Update recovery required</h1><p role="alert" aria-label="Update recovery">'+escape(issue.message)+'</p>'+(error?'<p role="alert">'+escape(error)+'</p>':'')+'<p>Recovery copies retained: '+escape(copies.map(copy=>(copy.role==='newer'?'NEWER candidate data: ':copy.role+': ')+copy.path+' ('+copy.bytes.toLocaleString()+' bytes)').join('\n')||'No retained copies found.')+'</p>'+(busy?'<p role="status">'+escape(busy)+'</p>':'')+'<p>Restore your data with all app windows closed. Validation compares the persistent core tree; Chromium profiles and Finder metadata are excluded. Restore destination: '+escape(issue.dataDir)+'. Continue only after the complete data is restored there. Continuing restarts the available app and keeps all recovery copies until you explicitly delete them.</p>'+(busy?'':('<a href="'+escape(action('open'))+'">Open recovery folder</a><a href="'+escape(action('continue'))+'">I restored my data — continue</a><a href="'+escape(action('delete'))+'">Delete recovery copies…</a>'));
}
export async function commitUpdateReceipt(dataDir:string,target:string,version:string,argv:string[],originalDataIdentity?:string):Promise<'waiting'|'committed'|'blocked'>{
 const token=argv.find(a=>a.startsWith('--botling-update-token='))?.slice('--botling-update-token='.length);
 const pending=json(join(dataDir,'update-pending.json')) as PendingUpdate|null;
 const block=async(root:string,code=25,expected=token)=>{await recordIssue({...issueFor(dataDir,target,root,code,expected),...(originalDataIdentity?{originalDataIdentity}:{})});return 'blocked' as const;};
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

/** Never create an absent external-volume mount point as an ordinary directory. */
export function dataVolumeError(dataDir:string):string|null {
 // Resolve existing path components with lstat, including dangling links that realpath cannot
 // resolve. A local symlink must not hide a missing external volume from the startup guard.
 let path=resolve(dataDir);
 for(let hops=0;hops<40;hops++){
  const match=/^\/Volumes\/([^/]+)(?:\/|$)/i.exec(path);
  if(match){const volume=join('/Volumes',match[1]!);let mounted=false;
   try{const stat=statSync(volume);mounted=stat.isDirectory()&&(stat.dev!==statSync('/Volumes').dev||realpathSync(volume)==='/');}catch{}
   if(!mounted)return `Data volume is unavailable: ${volume}. Mount the original volume before opening Botling. No data directory has been created.`;
  }
  const parts=path.split(sep).filter(Boolean);let prefix:string=sep,changed=false;
  for(let i=0;i<parts.length;i++){prefix=join(prefix,parts[i]!);try{
   if(lstatSync(prefix).isSymbolicLink()){const link=readlinkSync(prefix);path=resolve(isAbsolute(link)?link:join(dirname(prefix),link),...parts.slice(i+1));changed=true;break;}
  }catch{break;}}
  if(!changed)return null;
 }
 return 'Data volume is unavailable: the data path contains an unresolved symlink loop. No data directory has been created.';
}
/** Startup provenance must predate profile/core creation, not merely an existing empty folder. */
export function persistentDataIdentity(path:string):string|undefined {
 const read=(name:string)=>{const file=join(path,name),stat=lstatSync(file);if(!stat.isFile()||stat.size>32*1024*1024)throw new Error('Invalid core metadata');return JSON.parse(readFileSync(file,'utf8'));};
 try{const value=read('core/settings.json');if(value&&typeof value==='object'&&!Array.isArray(value))return dataIdentity(path);}catch{}
 try{if(Array.isArray(read('core/main/chat.json')))return dataIdentity(path);}catch{}
 return undefined;
}
export function dataIdentity(path:string):string|undefined {
 try{const stat=lstatSync(path);return stat.isDirectory()&&!stat.isSymbolicLink()?`${stat.dev}:${stat.ino}`:undefined;}catch{return undefined;}
}
export interface RecoveryCopy {path:string;bytes:number;kind:'data'|'app';role:'snapshot'|'newer'|'restore'|'previous-app'|'failed-app'}
export function recoveryCopyPaths(issue:RecoveryIssue):{path:string;kind:'data'|'app';role:'snapshot'|'newer'|'restore'|'previous-app'|'failed-app'}[]{
 if(!validRoot(issue.root,issue.target))return[];
 const token=json(join(issue.root,'owner.json'))?.token;
 const paths:{path:string;kind:'data'|'app';role:'snapshot'|'newer'|'restore'|'previous-app'|'failed-app'}[]=[{path:join(issue.root,'data-before'),kind:'data',role:'snapshot'},{path:join(issue.root,'previous.app'),kind:'app',role:'previous-app'},{path:join(issue.root,'failed.app'),kind:'app',role:'failed-app'}];
 if(typeof token==='string'&&/^[a-zA-Z0-9-]+$/.test(token))for(const kind of ['after','restore'])paths.push({path:`${issue.dataDir}.update-${kind}-${token}`,kind:'data',role:kind==='after'?'newer':'restore'});
 return paths.filter(p=>existsSync(p.path));
}
async function bytesAt(path:string):Promise<number>{
 const stat=await fs.lstat(path);if(!stat.isDirectory())return stat.size;
 let size=0;for(const name of await fs.readdir(path))size+=await bytesAt(join(path,name));return size;
}
export async function recoveryCopies(issue:RecoveryIssue):Promise<RecoveryCopy[]>{
 return Promise.all(recoveryCopyPaths(issue).map(async copy=>({...copy,bytes:await bytesAt(copy.path)})));
}
type Progress=(message:string)=>void;
const finder=(name:string)=>name==='.DS_Store'||name.startsWith('._')||name==='Icon\r';
// Recovery certifies the complete persistent core tree. Chromium profiles and Finder metadata
// are deliberately outside that contract. Metadata fingerprints cache byte comparisons without
// rereading gigabytes on every acknowledgment; ctime/ino also detect same-size replacements.
async function inventory(folder:string,progress:Progress=()=>{}):Promise<Map<string,string>>{
 const entries=new Map<string,string>();let count=0;
 async function visit(path:string):Promise<void>{
  const key=relative(folder,path),stat=await fs.lstat(path);
  if(stat.isSymbolicLink()){entries.set(key,'link:'+await fs.readlink(path));return;}
  if(stat.isDirectory()){entries.set(key,'dir');for(const name of (await fs.readdir(path)).sort())if(!finder(name))await visit(join(path,name));return;}
  if(!stat.isFile())throw new Error('Unsupported restored core entry: '+path);
  entries.set(key,JSON.stringify([stat.size,stat.dev,stat.ino,stat.mtimeMs,stat.ctimeMs]));
  if(++count%50===0)progress(`Inspecting core data: ${count} files`);
 }
 progress('Inspecting persistent core data…');await visit(join(folder,'core'));return entries;
}
async function sameCore(left:string,right:string,a:Map<string,string>,b:Map<string,string>,progress:Progress):Promise<boolean>{
 if(a.size!==b.size)return false;
 for(const [key,value] of a){const other=b.get(key);if(other===undefined)return false;
  if(value==='dir'||value.startsWith('link:')){if(value!==other)return false;continue;}
  if(JSON.parse(value)[0]!==JSON.parse(other)[0])return false;
  progress('Comparing core data: '+key);
  const x=await fs.open(join(left,key),'r');let y:fs.FileHandle|undefined;
  try{y=await fs.open(join(right,key),'r');const xb=Buffer.alloc(64*1024),yb=Buffer.alloc(64*1024);let bytes=0;
   while(true){const [xr,yr]=await Promise.all([x.read(xb),y.read(yb)]);if(xr.bytesRead!==yr.bytesRead||!xb.subarray(0,xr.bytesRead).equals(yb.subarray(0,yr.bytesRead)))return false;if(!xr.bytesRead)break;bytes+=xr.bytesRead;if(bytes%(4*1024*1024)===0)progress(`Comparing ${key}: ${bytes.toLocaleString()} bytes`);}
  }finally{await x.close();await y?.close();}
 }
 return true;
}
async function recognizableData(folder:string):Promise<boolean>{
 async function read(file:string){const stat=await fs.lstat(file);if(!stat.isFile()||stat.size>32*1024*1024)throw new Error('Invalid core metadata');return JSON.parse(await fs.readFile(file,'utf8'));}
 try{const settings=await read(join(folder,'core/settings.json'));if(settings&&typeof settings==='object'&&!Array.isArray(settings))return true;}catch{}
 try{return Array.isArray(await read(join(folder,'core/main/chat.json')));}catch{return false;}
}
/** No arbitrary directory acknowledgment: match complete core bytes, or the exact original
 * directory identity captured before any candidate/data move. Partial snapshots are not proof. */
export async function validateRestoredData(issue:RecoveryIssue,progress:Progress=()=>{}):Promise<string>{
 const fail=()=>new Error('Restore the complete core data before continuing. It must match a complete retained snapshot or previous-data copy, or be the proven untouched original directory; all recovery copies are preserved.');
 if(!await recognizableData(issue.dataDir))throw fail();
 const paths=recoveryCopyPaths(issue),copies=paths.filter(copy=>copy.kind==='data'&&(copy.role==='newer'||copy.role==='snapshot'&&existsSync(join(issue.root,'snapshot.complete'))));
 const live=await inventory(issue.dataDir,progress),digest=inventoryDigest(live);
 const verified=validRoot(issue.root,issue.target)?json(join(issue.root,'restored-validated.json')):null;
 if(verified?.id===issue.id&&verified.digest===digest)return digest;
 for(const copy of copies){
  if(!await recognizableData(copy.path))continue;const saved=await inventory(copy.path,progress);
  if(await sameCore(issue.dataDir,copy.path,live,saved,progress)){
   // Reject a live tree changed while the asynchronous comparison was in flight.
   if(digest!==inventoryDigest(await inventory(issue.dataDir)))throw fail();return digest;
  }
 }
 const owned=validRoot(issue.root,issue.target),moved=paths.some(copy=>copy.role==='newer'||copy.role==='restore')||owned&&existsSync(join(issue.root,'data-restored'));
 const original=issue.originalDataIdentity||(owned?text(join(issue.root,'original-data.identity')):undefined);
 if(!copies.length&&!moved&&original&&original===dataIdentity(issue.dataDir))return digest;
 // Legacy pre-candidate helpers have no inode receipt. Their complete path metadata plus no
 // launched process, completed snapshot or moved copies proves they never reached a data move.
 const legacy=owned?json(join(issue.root,'recovery.json')):null;
 if(!copies.length&&!moved&&legacy?.dataDir===issue.dataDir&&legacy.before===join(issue.root,'data-before')&&
    !existsSync(join(issue.root,'new.pid'))&&!existsSync(join(issue.root,'snapshot.complete'))&&
    !existsSync(join(issue.root,'previous.app'))&&!existsSync(join(issue.root,'failed.app')))return digest;
 throw fail();
}
/** Only an explicit native confirmation may call this. Retention is the default, even after
 * Continue or a successful update. A running/sole available app is never eligible. */
function inventoryDigest(entries:Map<string,string>):string{return createHash('sha256').update(JSON.stringify([...entries].sort(([a],[b])=>a.localeCompare(b)))).digest('hex');}
export async function deleteRecoveryCopies(issue:RecoveryIssue,runningBundles:string[],includeNewer=false,progress:Progress=()=>{}):Promise<void>{
 if(processAlive(text(join(issue.root,'helper.pid'))))throw new Error('Recovery is still running.');
 const validatedDigest=await validateRestoredData(issue,progress);
 const candidate=Number(text(join(issue.root,'new.pid')));
 if(candidate!==process.pid&&processAlive(candidate))throw new Error('The candidate app is still running.');
 if(validRoot(issue.root,issue.target))await writeRecord(join(issue.root,'restored-validated.json'),{id:issue.id,digest:validatedDigest,at:Date.now()});
 const copies=recoveryCopyPaths(issue),owner=json(join(issue.root,'owner.json')),healthy=json(join(issue.dataDir,'update-last-boot.json'));
 for(const copy of copies){
  if(copy.role==='newer'&&!includeNewer)continue;
  if(copy.kind==='app'){
   const knownGood=healthy?.activated===true&&healthy.token===owner?.token&&existsSync(issue.target)&&runningBundles.includes(issue.target);
   if(!existsSync(issue.target)||!runningBundles.includes(issue.target)||copy.role==='previous-app'&&!knownGood||runningBundles.some(path=>path===copy.path||path.startsWith(copy.path+sep)))continue;
  }
  // Native ASAR-unaware deletion, awaited; only after the explicit native confirmation.
  await promisify(execFile)('/bin/rm',['-rf',copy.path],{timeout:120_000});
 }
}
