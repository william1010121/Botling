// Each worktree runs its own disposable Electron bundle. Dependencies may be symlinks to another
// checkout; recovery fixtures must never write stage siblings beside that shared runtime.
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {desktop} from './helpers';
export function electronExecutable():string {
 const source=require('electron') as string;
 if(process.platform!=='darwin')return source;
 const base=join(desktop,'.cache/electron-runtime'),bundle=join(base,'Electron.app');
 const version=JSON.parse(readFileSync(require.resolve('electron/package.json'),'utf8')).version;
 const stamp=join(base,'version'),executable=join(bundle,'Contents/MacOS/Electron');
 if(!existsSync(executable)||!existsSync(stamp)||readFileSync(stamp,'utf8')!==version){
  mkdirSync(base,{recursive:true});execFileSync('/usr/bin/ditto',[dirname(dirname(dirname(source))),bundle]);writeFileSync(stamp,version);
 }
 return executable;
}
