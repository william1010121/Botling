import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {desktop} from './helpers';
const run=promisify(execFile);
/** Never ask TCC for permission or launch System Events just to obtain it. */
export async function frontmost():Promise<string>{
 const folder=join(desktop,'.cache/f0');await mkdir(folder,{recursive:true});
 const binary=join(folder,'permission');
 await run('/usr/bin/clang',[join(desktop,'test/fixtures/frontmost-permission.c'),'-framework','ApplicationServices','-o',binary],{timeout:10000});
 const permission=(await run(binary,[],{timeout:3000})).stdout.trim();
 if(permission!=='0')throw new Error('Frontmost verification unavailable without prompting/starting an automation target (permission preflight '+permission+'). No GUI launch is allowed.');
 const script='tell application "System Events" to tell first application process whose frontmost is true to return (unix id as text) & tab & (bundle identifier as text)';
 return (await run('/usr/bin/osascript',['-e',script],{timeout:3000})).stdout.trim();
}
