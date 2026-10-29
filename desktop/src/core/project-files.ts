import { constants } from 'node:fs';
import { opendir, realpath, open, lstat } from 'node:fs/promises';
import { join, relative, isAbsolute, matchesGlob } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const excluded = new Set(['.git','.bot','.claude','.codex','node_modules','vendor','build','dist','out','.build','.cache','coverage','.ssh','.aws','.gnupg']);
const safeName = (path: string) => !path.split('/').some(p => excluded.has(p) || ['.env','.npmrc','.netrc','.git-credentials'].includes(p) || p.startsWith('.env.') || /\.(pem|key|p12)$/i.test(p));
export function fuzzyScore(path: string, query: string): number {
 const value = path.toLowerCase(); query = query.trim().toLowerCase();
 if (!query) return 10 / (1 + path.split('/').length);
 let at = -1, score = 0;
 for (const letter of query) { const next = value.indexOf(letter,at+1); if(next<0)return -1; score += next===at+1 ? 12 : 1; if(next===0 || '/._-'.includes(value[next-1]))score+=8; at=next; }
 const name=value.slice(value.lastIndexOf('/')+1); return score+(name.startsWith(query)?100:0)+(name.includes(query)?40:0)-value.length/1000;
}
export class ProjectFiles {
 private cache = new Map<string,{time:number;paths:string[];limited:boolean}>();
 private pending = new Map<string,Promise<{paths:string[];limited:boolean}>>();
 private async index(root: string): Promise<{paths:string[];limited:boolean}> {
  const cached=this.cache.get(root); if(cached && Date.now()-cached.time<5000)return cached;
  const pending=this.pending.get(root); if(pending)return pending;
  const job=this.scan(root).then(value=>{ if(this.cache.size>20)this.cache.clear(); this.cache.set(root,{...value,time:Date.now()}); return value; }).finally(()=>this.pending.delete(root));
  this.pending.set(root,job); return job;
 }
 private async scan(root: string): Promise<{paths:string[];limited:boolean}> {
  // Git applies nested ignore files and global excludes without a third-party picker dependency.
  try {
   const {stdout}=await exec('git',['-C',root,'ls-files','--cached','--others','--exclude-standard','--exclude-per-directory=.ignore','-z'],{timeout:1500,maxBuffer:2*1024*1024});
   const ignored = await exec('git',['-C',root,'ls-files','--cached','--ignored','--exclude-standard','-z'],{timeout:1500,maxBuffer:2*1024*1024});
   const ignoredPaths = new Set(ignored.stdout.split('\0'));
   const paths=[...new Set(stdout.split('\0').filter(p=>p && safeName(p) && !ignoredPaths.has(p)))].sort();
   return {paths:paths.slice(0,20000),limited:paths.length>20000};
  } catch (error) {
   // A failed/oversized Git listing must not bypass Git's ignore rules.
   const failure = error as {code?: string; stderr?: string};
   if(failure.code !== 'ENOENT' && !failure.stderr?.includes('not a git repository'))return {paths:[],limited:true};
  }
  const paths:string[]=[]; let visited=0, limited=false; const start=Date.now();
  type Rule={base:string;pattern:string;negated:boolean};
  async function walk(dir:string, rules:Rule[], depth:number):Promise<void> {
   if(depth>30 || visited>20000 || Date.now()-start>1500){limited=true;return;}
   for(const filename of ['.gitignore','.ignore']) {
    try { const handle=await open(join(root,dir,filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let text=''; try { const stat=await handle.stat(); if(stat.isFile() && stat.size<65536)text=await handle.readFile('utf8'); } finally {await handle.close();} if(text.length<65536)rules=[...rules,...text.split(/\r?\n/).filter(p=>p && !p.startsWith('#')).map(p=>({base:dir,pattern:p.replace(/^!/,''),negated:p.startsWith('!')}))]; }catch{}
   }
   const entries=[];
   try { const directory=await opendir(join(root,dir)); for await (const entry of directory) { entries.push(entry); if(entries.length+visited>=20000){limited=true;break;} } } catch {return;}

   entries.sort((a,b)=>a.name.localeCompare(b.name));
   for(const item of entries){
    if(++visited>20000 || Date.now()-start>1500){limited=true;break;}
    const path=dir ? `${dir}/${item.name}`:item.name; if(!safeName(path)||item.isSymbolicLink())continue;
    let ignored=false;
    for(const rule of rules){const local=rule.base?path.slice(rule.base.length+1):path; const pattern=rule.pattern.replace(/^\//,'').replace(/\/$/,''); if(matchesGlob(local,pattern)||(!pattern.includes('/')&&local.split('/').some(p=>matchesGlob(p,pattern))))ignored=!rule.negated;}
    if(ignored)continue;
    if(item.isDirectory())await walk(path,rules,depth+1); else if(item.isFile()&&!['.gitignore','.ignore'].includes(item.name))paths.push(path);
   }
  }
  await walk('',[],0);return {paths,limited};
 }
 async search(root:string,query:string){
  root=await realpath(root); const index=await this.index(root);
  const paths=index.paths.map(path=>({path,score:fuzzyScore(path,query)})).filter(f=>f.score>=0).sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path)).slice(0,40);
  const files=[];
  for(const {path} of paths){try{const resolved=await this.resolve(root,path); if(!(await lstat(resolved)).isFile())continue; files.push({path,url:pathToFileURL(resolved).href});}catch{}}
  return {files,limited:index.limited};
 }
 private async resolve(root:string,path:string){
  if(isAbsolute(path)||path.split(/[\\/]/).includes('..')||!safeName(path))throw Error('File outside project');
  const resolved=await realpath(join(root,path)); const rel=relative(root,resolved);
  if(rel.startsWith('..')||isAbsolute(rel)||!safeName(rel))throw Error('File outside project');
  // Do not follow aliases, even those pointing to private files within the project.
  if(resolved!==join(root,path))throw Error('Symbolic link unavailable');
  return resolved;
 }
 async preview(root:string,path:string):Promise<{text:string;status:'text'|'truncated'|'binary'|'unavailable'}>{
  root=await realpath(root);const index=await this.index(root);
  if(!index.paths.includes(path))throw Error('File not in project index');
  const resolved=await this.resolve(root,path);const handle=await open(resolved,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try{const stat=await handle.stat();if(!stat.isFile())throw Error('Not a regular file');
   const buffer=Buffer.alloc(32768);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);const bytes=buffer.subarray(0,bytesRead);
   if(bytes.includes(0))return {text:'',status:'binary'};
   let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes,{stream:stat.size>bytesRead});}catch{return {text:'',status:'binary'};}
   return {text,status:stat.size>bytesRead?'truncated':'text'};
  }finally{await handle.close();}
 }
}
