// Development diagnostics only. No renderer-selected paths, runtime authority or production logs.
import {constants,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {open,type FileHandle} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {isTestTraceRecord} from '../test-trace';
export interface TraceGateOptions {packaged:boolean;dataDir:string;syntheticBase:string;env:Record<string,string|undefined>}
export interface SyntheticTraceContext {dataDir:string;runId:string;testId:string;focusEmulation:string;valid():boolean}
function identity(path:string):string {
 const stat=lstatSync(path);if(stat.isSymbolicLink())throw new Error('Trace metadata cannot be a symlink');
 return [stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
}
/** Explicit disposable directories below this checkout's synthetic test root only. Real/default,
 * imported, packaged or foreground data never receives the preload capability or a writer. */
export function syntheticTraceContext(options:TraceGateOptions):SyntheticTraceContext|null {
 const {packaged,dataDir,env}=options;
 const environment=()=>!packaged&&env.BOTLING_TEST_TRACE==='1'&&env.BOTLING_AGENT==='fake'&&env.BOTLING_HIDDEN==='1'&&
  !!env.BOTLING_DATA_DIR&&resolve(env.BOTLING_DATA_DIR)===dataDir&&!env.BOTLING_IMPORT_FROM&&!env.BOTLING_1X_DIR;
 if(!environment())return null;
 try{
  const base=realpathSync(options.syntheticBase);
  if(!base.startsWith('/Volumes/My-SSD/')||!dataDir.startsWith(base+sep)||realpathSync(dataDir)!==dataDir||!lstatSync(dataDir).isDirectory()||lstatSync(dataDir).isSymbolicLink())return null;
  const marker=join(dataDir,'.botling-synthetic-test.json'),stat=lstatSync(marker);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2048)return null;
  const value=JSON.parse(readFileSync(marker,'utf8')),id=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(s);
  if(value?.v!==1||value.fixture!=='composer-race'||!id(value.runId)||!id(value.testId)||!['requested-on','requested-off'].includes(value.focusEmulation))return null;
  // Only the directory inode is stable when Chromium creates profile files inside it.
  const directory=lstatSync(dataDir),directoryID=[directory.dev,directory.ino].join(':'),markerID=identity(marker);
  return{dataDir,runId:value.runId,testId:value.testId,focusEmulation:value.focusEmulation,valid:()=>{
   if(!environment())return false;
   try{const now=lstatSync(dataDir);return now.isDirectory()&&!now.isSymbolicLink()&&realpathSync(dataDir)===dataDir&&[now.dev,now.ino].join(':')===directoryID&&identity(marker)===markerID;}catch{return false;}
  }};
 }catch{return null;}
}
export interface TraceSender {owned:boolean;isMainFrame:boolean;url:string;contentsId:number;processId:number;routingId:number}
export function traceSenderAllowed(sender:TraceSender):boolean {
 if(!sender.owned||!sender.isMainFrame||!Number.isSafeInteger(sender.contentsId)||sender.contentsId<1||!Number.isSafeInteger(sender.processId)||sender.processId<1||!Number.isSafeInteger(sender.routingId)||sender.routingId<0)return false;
 try{const url=new URL(sender.url);return url.protocol==='app:'&&url.hostname==='botling'&&url.host==='botling'&&!url.username&&!url.password&&url.pathname==='/index.html'&&!url.search;}catch{return false;}
}
/** Electron may dispose a frame while dispatching IPC. Diagnostics must never throw into main. */
export function acceptTraceIPC(writer:InputTraceWriter|null,snapshot:()=>TraceSender|null,record:unknown):boolean {
 if(!writer)return false;
 try{const sender=snapshot();return sender?writer.accept(record,sender):false;}catch{return false;}
}
interface WriterLimits {maxFileBytes?:number;maxQueueBytes?:number}
/** One serialized, bounded sink. A reserved footer reports truncation/drops; close drains and
 * fsyncs before main reports shutdown. Existing files and symlinks are never overwritten. */
export class InputTraceWriter {
 private queue:Buffer[]=[];private queueBytes=0;private reserved=0;private written=0;private seq=0;
 private dropped=0;private invalid=0;private truncated=false;private closed=false;private error:unknown;
 private draining:Promise<void>|undefined;private closing:Promise<void>|undefined;
 private constructor(private context:SyntheticTraceContext,private file:FileHandle,private maxFileBytes:number,private maxQueueBytes:number){}
 static async open(context:SyntheticTraceContext,limits:WriterLimits={}):Promise<InputTraceWriter>{
  if(!context.valid())throw new Error('Synthetic trace authority is no longer valid');
  const maxFileBytes=Math.min(limits.maxFileBytes??16*1024*1024,16*1024*1024),maxQueueBytes=Math.min(limits.maxQueueBytes??1024*1024,1024*1024);
  if(maxFileBytes<1024||maxQueueBytes<256)throw new Error('Trace limits are too small');
  const file=await open(join(context.dataDir,'input-trace.jsonl'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  const writer=new InputTraceWriter(context,file,maxFileBytes,maxQueueBytes);
  try{await writer.writeDirect({kind:'header',runId:context.runId,testId:context.testId,focusEmulation:context.focusEmulation,protocol:1,synthetic:true});return writer;}
  catch(error){await file.close();throw error;}
 }
 private row(value:Record<string,unknown>):Buffer {return Buffer.from(JSON.stringify({...value,writerSeq:++this.seq,receivedAt:Date.now()})+'\n');}
 private async writeDirect(value:Record<string,unknown>):Promise<void>{const row=this.row(value);if(this.written+row.length>this.maxFileBytes)throw new Error('Trace footer exceeds reserved capacity');await this.file.writeFile(row);this.written+=row.length;}
 private enqueue(value:Record<string,unknown>):boolean {
  if(this.closed||this.error)return false;
  const row=this.row(value),footerReserve=512;
  if(this.written+this.reserved+row.length>this.maxFileBytes-footerReserve||this.queueBytes+row.length>this.maxQueueBytes){this.dropped++;this.truncated=true;return false;}
  this.queue.push(row);this.queueBytes+=row.length;this.reserved+=row.length;this.pump();return true;
 }
 private pump():void {
  if(this.draining)return;
  this.draining=(async()=>{try{while(this.queue.length){const row=this.queue.shift()!;await this.file.writeFile(row);this.written+=row.length;this.reserved-=row.length;this.queueBytes-=row.length;}}
   catch(error){this.error=error;this.dropped+=this.queue.length+1;this.queue=[];this.queueBytes=0;this.reserved=0;}
  })().finally(()=>{this.draining=undefined;if(this.queue.length&&!this.error)this.pump();});
 }
 accept(record:unknown,sender:TraceSender):boolean {
  if(this.closed)return false;
  if(!this.context.valid()||!traceSenderAllowed(sender)||!isTestTraceRecord(record)){this.invalid++;return false;}
  return this.enqueue({kind:'renderer',contentsId:sender.contentsId,processId:sender.processId,routingId:sender.routingId,record});
 }
 observe(event:string,data:Record<string,unknown>):boolean {
  if(!this.context.valid())return false;
  return this.enqueue({kind:'main',event,at:Date.now(),data});
 }
 close():Promise<void>{
  if(this.closing)return this.closing;
  this.closed=true;
  this.closing=(async()=>{try{
   while(this.draining)await this.draining;
   if(this.error)throw this.error;
   await this.writeDirect({kind:'end',dropped:this.dropped,invalid:this.invalid,truncated:this.truncated,bytesBeforeFooter:this.written});await this.file.sync();
  }finally{await this.file.close();}})();return this.closing;
 }
}
