// Built-in, loopback-only tool transport. No external plugin installation or credentials.
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, readFileSync, statSync } from 'node:fs';
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
  { name:'write_file', description:'Write exact UTF-8 contents to a workspace file. Requires single-action user approval.', inputSchema:schema({path:text,content:text},['path','content']) },
  { name:'run_command', description:'Run a shell command in this workspace, waiting for completion (maximum 120 seconds). Requires single-action user approval. Stop cancels its process group.', inputSchema:schema({command:text},['command']) },
];
export const AGY_WORKER_TOOLS: AgyTool[] = [
  { name:'app_handoff', description:'Assign an authorized task to an app-managed Antigravity worker. Returns task_id immediately. A correlated app_task_result arrives later. Does not grant tool permissions.', inputSchema:schema({instructions:text,name:text},['instructions']) },
  { name:'app_send_message', description:'Continue an existing idle worker task using task_id. Busy workers reject steering; wait for their report. Does not authorize a new deliverable.', inputSchema:schema({task_id:text,message:text},['task_id','message']) },
  { name:'app_cancel_task', description:'Stop one app-managed worker and its active tools.', inputSchema:schema({task_id:text},['task_id']) },
];
const canonical = (v: any): string => v && typeof v === 'object' ? Array.isArray(v) ? '['+v.map(canonical).join(',')+']' : '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}' : JSON.stringify(v);

export class AgyMcpBridge {
  private server?: Server;
  private token = randomUUID();
  private grants = new Map<string, number[]>();
  private fileProcesses = new Set<ChildProcess>();
  private commands = new Set<ManagedProcess>();
  private stopped = false;
  private epoch = 0;
  private scratch: string | undefined;
  readonly tools: AgyTool[];
  private base: string;
  private rootIdentity: string[];
  private protectedIdentity: string[];
  constructor(private cwd: string, private protectedPath: string, private delegate?: (name: string, args: Args) => Promise<unknown>, private processStarted?: (pid:number)=>void, private helperPath?: string) {
    // Worker transport is deliberately unavailable until live isolation/recovery validation.
    this.tools = [...AGY_LOCAL_TOOLS];
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
      const actual = nested as Args;
      if (Object.keys(actual).some(key => key in args && canonical(args[key]) !== canonical(actual[key]))) return;
      args = actual;
    }
    const key = name+':'+canonical(args), list = this.grants.get(key) ?? [];
    list.push(Date.now()+60_000); this.grants.set(key,list);
  }
  revoke() { this.grants.clear(); this.epoch++; }
  async start() {
    if (this.stopped) throw new Error('Tool bridge closed.');
    this.server=createServer(async(req,res)=>{
      if (req.url!==`/${this.token}` || req.method!=='POST' || req.headers.origin) { res.writeHead(403).end(); return; }
      let body='';
      for await(const chunk of req) { body+=chunk; if(body.length>4*1024*1024){res.writeHead(413).end();return;} }
      let request:any;try{request=JSON.parse(body);}catch{res.writeHead(400).end();return;}
      res.setHeader('Content-Type','application/json');
      if(request.id===undefined){res.writeHead(202).end();return;}
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
    try { const result=await this.invoke(name,args);return {isError:name==='run_command'&&(result as {exitCode:number|null}).exitCode!==0,content:[{type:'text',text:typeof result==='string'?result:JSON.stringify(result)}]}; }
    catch(error){return {isError:true,content:[{type:'text',text:(error as Error).message}]};}
  }
  /** Independent enforcement: even a direct MCP call cannot act without the exact user's grant. */
  async invoke(name:string,args:Args):Promise<unknown> {
    if(this.stopped)throw new Error('Tool bridge closed.');
    const tool=this.tools.find(t=>t.name===name);if(!tool)throw new Error('Unsupported tool.');
    const key=name+':'+canonical(args),grants=(this.grants.get(key)??[]).filter(deadline=>deadline>Date.now());
    if(!grants.length)throw new Error('No matching single-action user approval. Nothing executed.');
    grants.shift();this.grants.set(key,grants);
    const epoch=this.epoch;
    if(name==='run_command') {
      if(typeof args.command!=='string'||!args.command.trim())throw new Error('Command required.');
      return this.command(args.command);
    }
    if(name==='read_file'||name==='write_file') {
      if(typeof args.path!=='string')throw new Error('Path required.');
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
    if(!this.delegate)throw new Error('Workers unavailable.');
    return this.delegate(name,args);
  }
  private command(command:string):Promise<{exitCode:number|null;output:string}> {
    const env:NodeJS.ProcessEnv={};for(const key of ['HOME','PATH','USER','TMPDIR','LANG'])if(process.env[key])env[key]=process.env[key];
    if(process.platform!=='darwin')return Promise.reject(new Error('Verified macOS command containment is required.'));
    this.scratch??=realpathSync(mkdtempSync(join(tmpdir(),'botling-agy-command-')));
    env.TMPDIR=this.scratch;
    // Every command still requires its exact approval. No unsandboxed fallback or escalation.
    const quoted=(path:string)=>JSON.stringify(path);
    const cwd=realpathSync(this.cwd),profile=realpathSync(this.protectedPath);
    const sandbox=`(version 1) (allow default)
      (deny file-write*)
      (allow file-write* (subpath ${quoted(cwd)}) (subpath ${quoted(this.scratch)}) (literal "/dev/null") (literal "/dev/tty"))
      (deny file-read* (subpath ${quoted(realpathSync(homedir()))}))
      (allow file-read* (subpath ${quoted(cwd)}) (subpath ${quoted(this.scratch)}))
      (deny file-read* file-write* (subpath ${quoted(profile)}))`;
    const child=processTreeAdapter().spawn('/usr/bin/sandbox-exec',['-p',sandbox,'/bin/sh','-c',command],{cwd,env});this.commands.add(child);
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
