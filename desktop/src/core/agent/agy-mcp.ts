// Built-in, loopback-only tool transport. No external plugin installation or credentials.
import type { StreamItem } from './stream';
import { executableEnvironment } from '../process/executable';
import { agyWorkerRuntimeEnabled, agyMixedRuntimeEnabled } from './agy-capabilities';
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { processTreeAdapter, type ManagedProcess } from '../process/tree';

export const AGY_FILE_HELPER_SHA = '1e6feb57e33dfa1e5ffed2a7a359e6cd15c0df3272293e2ed63ec7af2ffc3403';
export function verifyAgyFileHelper(path: string | undefined, workspace: string) {
  if(!path || !isAbsolute(path) || realpathSync(path)!==resolve(path))throw new Error('Canonical verified file helper path required.');
  const rel=relative(realpathSync(workspace),path);
  if(rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel))throw new Error('ACP runtime and file helper must be provisioned outside the agent workspace.');
  if(createHash('sha256').update(readFileSync(path)).digest('hex')!==AGY_FILE_HELPER_SHA)throw new Error('File helper hash mismatch; nothing executed.');
}
type Args = Record<string, unknown>;
export interface AgyTool { name: string; description: string; inputSchema: Args }
const schema = (properties: Args, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string' };
export const AGY_LOCAL_TOOLS: AgyTool[] = [
  { name:'read_file', description:'Read a UTF-8 file inside this workspace.', inputSchema:schema({path:text},['path']) },
  { name:'write_file', description:'Write exact UTF-8 contents to a workspace file. Requires approval unless Full permission is active.', inputSchema:schema({path:text,content:text},['path','content']) },
  { name:'run_command', description:'Run a shell command in this workspace, waiting for completion (maximum 120 seconds). Requires approval unless Full permission is active. Stop cancels its process group.', inputSchema:schema({command:text},['command']) },
];
export const AGY_WORKER_TOOLS: AgyTool[] = [
  { name:'app_task_checkpoint', description:'Resolve this task/run report with concrete acceptance evidence or a specific blocker. Does not grant authorization.', inputSchema:schema({task_id:text,run:{type:'integer',minimum:1},outcome:{type:'string',enum:['complete','waiting_user','waiting_dependency','blocked']},evidence:text,dependency_task_id:text},['task_id','run','outcome','evidence']) },
  { name:'app_reconcile_report', description:'Needs no user approval card. Acknowledge an uncertain report as received, or retry only its delivery. Never replays the worker task.', inputSchema:schema({task_id:text,run:{type:'integer',minimum:1},action:{type:'string',enum:['acknowledge','retry']}},['task_id','run','action']) },
  { name:'app_handoff', description:'Assign an authorized task to an app-managed agy or Codex worker; engine identity cannot change on resume. Returns task_id immediately. A correlated app_task_result arrives later. Does not grant tool permissions.', inputSchema:schema({instructions:text,name:text,engine:{type:'string',enum:['agy','codex']}},['instructions']) },
  { name:'app_send_message', description:'Continue an existing idle worker task using task_id. Busy workers reject steering; wait for their report. Does not authorize a new deliverable.', inputSchema:schema({task_id:text,run:{type:'integer',minimum:1},message:text},['task_id','run','message']) },
  { name:'app_cancel_task', description:'Stop one app-managed worker and its active tools.', inputSchema:schema({task_id:text,run:{type:'integer',minimum:1}},['task_id','run']) },
];
export const AGY_AUTO_ALLOWED_TOOLS = new Set(['app_handoff','app_send_message','app_task_checkpoint','app_cancel_task','app_reconcile_report']);
const canonical = (v: any): string => v && typeof v === 'object' ? Array.isArray(v) ? '['+v.map(canonical).join(',')+']' : '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}' : JSON.stringify(v);

// ACP 1.4.3 can supply filePath even though tools/list advertises path.
// Normalize the explicit alias identically for approval and execution; never
// choose between conflicting paths or infer a destination from file contents.
function normalizeFileArgs(name: string, args: Args): Args {
  if (name !== 'read_file' && name !== 'write_file') return args;
  if (!Object.prototype.hasOwnProperty.call(args, 'filePath')) return args;
  if (typeof args.filePath !== 'string' || !args.filePath.trim()) throw new Error('Path required.');
  if (Object.prototype.hasOwnProperty.call(args, 'path') && args.path !== args.filePath) throw new Error('Conflicting path and filePath. Nothing executed.');
  const {filePath, ...rest} = args;
  return {...rest, path:filePath};
}

export class AgyMcpBridge {
  private server?: Server;
  private token = randomUUID();
  private grants = new Map<string, number[]>();
  private fileProcesses = new Set<ChildProcess>();
  private commands = new Set<ManagedProcess>();
  private stopped = false;
  private epoch = 0;
  private pendingApprovals = new Map<string, (allow: boolean) => void>();
  private fullTurn = false;
  private scratch: string | undefined;
  readonly tools: AgyTool[];
  private base: string;
  private rootIdentity: string[];
  private protectedIdentity: string[];
  constructor(private cwd: string, private protectedPath: string, private delegate?: (name: string, args: Args) => Promise<unknown>, private processStarted?: (pid:number)=>void, private helperPath?: string, private fullPermissionActive: () => boolean = () => false, private onToolEvent?: (item: StreamItem) => void) {
    // Worker transport is deliberately unavailable until live isolation/recovery validation.
    this.tools = delegate && agyWorkerRuntimeEnabled()
      ? AGY_WORKER_TOOLS.map(tool => tool.name === 'app_handoff' && !agyMixedRuntimeEnabled()
        ? {...tool, inputSchema:schema({instructions:text,name:text,engine:{type:'string',enum:['agy']}},['instructions'])} : tool)
      : [...AGY_LOCAL_TOOLS];
    this.base = realpathSync(cwd);
    const root = statSync(this.base, {bigint:true}), profile = statSync(protectedPath, {bigint:true});
    this.rootIdentity = [String(root.dev), String(root.ino)];
    this.protectedIdentity = [String(profile.dev), String(profile.ino)];
  }
  /** Called only from an explicit allow-once answer to ACP's matching tool card. */
  grant(title: string, args: Args) {
    if (this.stopped) return;
    const name = title.startsWith('botling_') ? title.slice('botling_'.length) : '';
    if (!this.tools.some(t=>t.name===name)) return;
    const nested = args.arguments;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      let actual: Args;
      try { actual = normalizeFileArgs(name, nested as Args); args = normalizeFileArgs(name, args); } catch { return; }
      if (Object.keys(actual).some(key => key in args && canonical(args[key]) !== canonical(actual[key]))) return;
      args = actual;
    }
    try { args = normalizeFileArgs(name, args); } catch { return; }
    const key = name+':'+canonical(args), list = this.grants.get(key) ?? [];
    list.push(Date.now()+60_000); this.grants.set(key,list);
  }
  answer(requestId: string, allow: boolean) {
    const resolve = this.pendingApprovals.get(requestId);
    if (!resolve) return false;
    this.pendingApprovals.delete(requestId);
    resolve(allow && !this.stopped);
    return true;
  }
  private requestApproval(name: string, args: Args): Promise<boolean> {
    if (!this.onToolEvent) return Promise.resolve(false);
    const requestId = `agy-mcp:${randomUUID()}`;
    return new Promise(resolve => {
      this.pendingApprovals.set(requestId, resolve);
      this.onToolEvent!({kind:'permission',requestId,tool:name,summary:`botling_${name}\n${JSON.stringify(args)}`,input:args});
    });
  }
  beginTurn() { this.revoke(); if (!this.stopped) this.fullTurn = true; }
  revoke() {
    this.fullTurn = false; this.grants.clear(); this.epoch++;
    for (const [requestId, resolve] of this.pendingApprovals) {
      this.pendingApprovals.delete(requestId);
      this.onToolEvent?.({kind:'permissionCancelled',requestId});
      resolve(false);
    }
  }
  async start() {
    if (this.stopped) throw new Error('Tool bridge closed.');
    this.server=createServer(async(req,res)=>{
      if (req.url!==`/${this.token}` || req.method!=='POST' || req.headers.origin) { res.writeHead(403).end(); return; }
      const requestEpoch = this.epoch;
      let body='';
      for await(const chunk of req) { body+=chunk; if(body.length>4*1024*1024){res.writeHead(413).end();return;} }
      let request:any;try{request=JSON.parse(body);}catch{res.writeHead(400).end();return;}
      res.setHeader('Content-Type','application/json');
      if(request.id===undefined){res.writeHead(202).end();return;}
      if (this.stopped || requestEpoch !== this.epoch) { res.writeHead(409).end(); return; }
      try { const result=await this.rpc(request.method,request.params??{});res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,result})); }
      catch(error){res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32602,message:(error as Error).message}}));}
    });
    await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(0,'127.0.0.1',resolve);});
    const address=this.server.address();if(!address||typeof address==='string')throw new Error('Tool bridge unavailable.');
    return {type:'http',name:'botling',url:`http://127.0.0.1:${address.port}/${this.token}`,headers:[]};
  }
  private async rpc(method:string,params:Args) {
    if(method==='initialize')return {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'botling',version:'1'}};
    if(method==='ping')return {};
    if(method==='tools/list')return {tools:this.tools};
    if(method!=='tools/call')throw new Error('Unsupported MCP method.');
    const name=String(params.name),args=(params.arguments??{}) as Args;
    // These cards describe the operation this bridge actually executes. ACP's
    // mirrored tool updates can attribute a previous tool's error to this call.
    const id = `botling-mcp:${randomUUID()}`;
    const observed = this.onToolEvent && AGY_LOCAL_TOOLS.some(tool => tool.name === name);
    if (observed) {
      this.onToolEvent!({kind:'textBlock'});
      this.onToolEvent!({kind:'toolUse',id,tool:'other',title:`botling_${name}`,detail:JSON.stringify(args),input:args,parent:null});
    }
    let output: string, failed: boolean;
    try { const result=await this.invoke(name,args);failed=name==='run_command'&&(result as {exitCode:number|null}).exitCode!==0;output=typeof result==='string'?result:JSON.stringify(result); }
    catch(error){failed=true;output=(error as Error).message;}
    if (observed) this.onToolEvent!({kind:'toolResult',id,output,failed,parent:null,launch:null});
    return {isError:failed,content:[{type:'text',text:output}]};
  }
  /** Exact grants by default; local tools alone may use this head's negotiated active-turn capability. */
  async invoke(name:string,args:Args):Promise<unknown> {
    if(this.stopped)throw new Error('Tool bridge closed.');
    const tool=this.tools.find(t=>t.name===name);if(!tool)throw new Error('Unsupported tool.');
    args = normalizeFileArgs(name, args);
    const key=name+':'+canonical(args),grants=(this.grants.get(key)??[]).filter(deadline=>deadline>Date.now());
    const full = AGY_LOCAL_TOOLS.some(t=>t.name===name) && this.fullTurn && this.fullPermissionActive();
    // Coordination tools only dispatch/steer/cancel app-managed workers and never grant file or command
    // permission (workers' own tool calls keep their normal approval flow), so they need no user card.
    if (AGY_AUTO_ALLOWED_TOOLS.has(name)) {
      if(!agyWorkerRuntimeEnabled() || !this.delegate)throw new Error('Workers unavailable.');
      if(name==='app_handoff' && args.engine!==undefined && args.engine!=='agy' && !agyMixedRuntimeEnabled())throw new Error('Cross-engine workers unavailable.');
      return this.delegate(name,args);
    }
    if (!full && !grants.length && AGY_WORKER_TOOLS.some(tool=>tool.name===name)) {
      const approved = await this.requestApproval(name,args);
      if (!approved || this.stopped) throw new Error('The user did not approve this app action. Nothing executed.');
      this.grant(`botling_${name}`,args);
      return this.invoke(name,args);
    }
    if(!full && !grants.length)throw new Error('No matching single-action user approval. Nothing executed.');
    grants.shift();this.grants.set(key,grants);
    const epoch=this.epoch;
    if(name==='run_command') {
      if(typeof args.command!=='string'||!args.command.trim())throw new Error('Command required.');
      return this.command(args.command, full);
    }
    if(name==='read_file'||name==='write_file') {
      if(typeof args.path!=='string'||!args.path.trim())throw new Error('Path required.');
      if(full) {
        // Explicit full permission: ordinary OS paths (including symlinks/outside workspace).
        // Synchronous bounded operations cannot outlive revocation between event-loop turns.
        const path = resolve(this.base, args.path);
        if(name==='write_file') {
          if(typeof args.content!=='string'||Buffer.byteLength(args.content,'utf8')>2_000_000)throw new Error('File content required (maximum 2 MB).');
          try { if(!statSync(path).isFile())throw new Error('Regular file required.'); } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
          writeFileSync(path,args.content,'utf8'); return 'File written.';
        }
        const stat=statSync(path); if(!stat.isFile()||stat.size>2_000_000)throw new Error('Regular file required (maximum 2 MB).');
        const output=readFileSync(path,'utf8');return output.slice(0,200_000)+(output.length>200_000?'\n[Truncated at 200000 characters]':'');
      }
      const rel=relative(this.base,resolve(this.base,args.path));
      if(!rel||rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw new Error('Path is outside the workspace.');
      const protectedRel=relative(this.base,resolve(this.protectedPath));
      if(rel===protectedRel||rel.startsWith(protectedRel+'/'))throw new Error('Protected ACP state.');
      if(this.stopped||epoch!==this.epoch)throw new Error('Tool cancelled.');
      if(name==='write_file'&&(typeof args.content!=='string'||Buffer.byteLength(args.content,'utf8')>2_000_000))throw new Error('File content required (maximum 2 MB).');
      verifyAgyFileHelper(this.helperPath, this.base);
      // openat walks anchored directory FDs, rejects every symlink and never truncates before fstat.
      const output = await new Promise<string>((resolve,reject)=>{
        const child=execFile(this.helperPath!,[name==='read_file'?'read':'write',this.base,...this.rootIdentity,...this.protectedIdentity,rel],{timeout:10_000,maxBuffer:2_100_000},(error,stdout)=>{this.fileProcesses.delete(child);error?reject(new Error('Workspace file access refused.')):resolve(stdout);});
        this.fileProcesses.add(child);
        child.stdin?.on("error",()=>{});
        child.stdin?.end(name==='write_file'?args.content as string:undefined);
      });
      return name==='write_file'?'File written.':output.slice(0,200_000)+(output.length>200_000?'\n[Truncated at 200000 characters]':'');
    }
    if(!agyWorkerRuntimeEnabled() || !this.delegate)throw new Error('Workers unavailable.');
    if(name==='app_handoff' && args.engine!==undefined && args.engine!=='agy' && !agyMixedRuntimeEnabled())throw new Error('Cross-engine workers unavailable.');
    return this.delegate(name,args);
  }
  private command(command:string, full = false):Promise<{exitCode:number|null;output:string}> {
    const inherited:Record<string,string>={};for(const key of ['HOME','PATH','USER','TMPDIR','LANG'])if(process.env[key])inherited[key]=process.env[key]!;
    const env = executableEnvironment(inherited);
    if(process.platform!=='darwin')return Promise.reject(new Error('Verified macOS command containment is required.'));
    this.scratch??=realpathSync(mkdtempSync(join(tmpdir(),'botling-agy-command-')));
    env.TMPDIR=this.scratch;
    // Default keeps exact approval and containment. Only explicit negotiated Full permission removes this sandbox.
    const quoted=(path:string)=>JSON.stringify(path);
    const cwd=realpathSync(this.cwd),profile=realpathSync(this.protectedPath);
    const sandbox=`(version 1) (allow default)
      (deny file-write*)
      (allow file-write* (subpath ${quoted(cwd)}) (subpath ${quoted(this.scratch)}) (literal "/dev/null") (literal "/dev/tty"))
      (deny file-read* (subpath ${quoted(realpathSync(homedir()))}))
      (allow file-read* (subpath ${quoted(cwd)}) (subpath ${quoted(this.scratch)}))
      (deny file-read* file-write* (subpath ${quoted(profile)}))`;
    const child=processTreeAdapter().spawn(full ? '/bin/sh' : '/usr/bin/sandbox-exec',full ? ['-c',command] : ['-p',sandbox,'/bin/sh','-c',command],{cwd,env});this.commands.add(child);
    try{if(child.pid>0)this.processStarted?.(child.pid);}catch(error){void child.terminate({graceMs:500});return Promise.reject(error);}
    return new Promise(resolve=>{
      let output='',ended=false;
      const capture=(chunk:Buffer)=>{output=(output+chunk.toString()).slice(-100_000);};
      child.child.stdout.on('data',capture);child.child.stderr.on('data',capture);
      const timer=setTimeout(()=>{output+='\nCommand timed out.';void child.terminate({graceMs:500});},120_000);
      const finish=(code:number|null)=>{if(ended)return;ended=true;clearTimeout(timer);void child.terminate({graceMs:500}).finally(()=>{this.commands.delete(child);resolve({exitCode:code,output});});};
      child.child.once('error',()=>finish(null));child.child.once('close',finish);
    });
  }
  async cancel() { this.revoke();await Promise.all([...this.fileProcesses].map(child=>new Promise<void>(resolve=>{child.once("close",()=>resolve());child.kill("SIGKILL");})));await Promise.all([...this.commands].map(c=>c.terminate({graceMs:500}))); }
  async close() { this.stopped=true;await this.cancel();this.server?.closeAllConnections();await new Promise<void>(resolve=>{if(!this.server)return resolve();this.server.close(()=>resolve());});if(this.scratch){rmSync(this.scratch,{recursive:true,force:true});this.scratch=undefined;} }
}
