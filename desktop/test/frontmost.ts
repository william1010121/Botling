import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {desktop} from './helpers';
const run=promisify(execFile);
export interface FrontmostResult {code:number;stdout:string;stderr:string;signal?:string|null}
export function parseFrontmostResult(result:FrontmostResult):string {
 const unavailable=(reason:string)=>new Error('Frontmost verification unavailable: '+reason+'. No GUI launch is allowed.');
 // Historical helper printed OSStatus while returning process exit 0. Do not mistake either for
 // a frontmost sample or permission denial: -600 is procNotFound, not a permission result.
 if(result.stdout.trim()==='-600')throw unavailable('procNotFound (-600): automation target not running, not a permission result');
 if(result.code!==0||result.signal)throw unavailable(`metadata tool exit ${result.code}${result.signal?' signal '+result.signal:''}; stderr=${result.stderr.slice(0,2000)}`);
 let value:any;try{value=JSON.parse(result.stdout);}catch{throw unavailable('missing or malformed frontmost metadata');}
 if(!value||!Number.isSafeInteger(value.pid)||value.pid<=0||value.active!==true||typeof value.bundleId!=='string'||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(value.bundleId))throw unavailable('frontmost application metadata missing/inactive');
 return `${value.pid}\t${value.bundleId}`;
}
export async function readFrontmost(read:()=>Promise<FrontmostResult>):Promise<string>{return parseFrontmostResult(await read());}
let binary:Promise<string>|undefined;
/** NSWorkspace's readonly metadata getter needs no already-running automation target. A query
 * failure stays closed; there is deliberately no osascript, UI scripting or activation fallback. */
export async function frontmost():Promise<string>{
 binary??=(async()=>{const folder=join(desktop,'.cache/f0');await mkdir(folder,{recursive:true});
  const file=join(folder,'frontmost-metadata');
  await run('/usr/bin/clang',[join(desktop,'test/fixtures/frontmost-metadata.m'),'-framework','AppKit','-fobjc-arc','-o',file],{timeout:10000,maxBuffer:65536,env:{...process.env,CLANG_MODULE_CACHE_PATH:join(desktop,'.cache/clang-modules')}});return file;})();
 return readFrontmost(async()=>{
  try{const result=await run(await binary!,[],{timeout:3000,maxBuffer:65536});return{code:0,stdout:result.stdout,stderr:result.stderr};}
  catch(error){const e=error as {code?:number;stdout?:string;stderr?:string;signal?:string};return{code:typeof e.code==='number'?e.code:1,stdout:e.stdout??'',stderr:e.stderr??String(error),signal:e.signal};}
 });
}
