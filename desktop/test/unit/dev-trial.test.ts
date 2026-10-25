import {expect,it} from 'vitest';
import {directoryDefaults,packagedDataName} from '../../src/main/main-environment';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

it('trial launch with unset import never discovers real 1.x data; lock detection stays enabled',()=>{
 const env:Record<string,string>={};directoryDefaults(env,'/synthetic-home',true,true);
 expect(env.BOTLING_IMPORT_FROM).toBeUndefined();expect(env.BOTLING_1X_DIR).toBe('/synthetic-home/.claudecodebot');
});
it('empty trial import remains disabled rather than falling back to 1.x',()=>{
 const env={BOTLING_IMPORT_FROM:''};directoryDefaults(env,'/synthetic-home',true,true);expect(env.BOTLING_IMPORT_FROM).toBe('');
});
it('explicit later import from a chosen copy and 1.x lock location are preserved',()=>{
 const env={BOTLING_IMPORT_FROM:'/chosen-copy',BOTLING_1X_DIR:'/lock-data'};directoryDefaults(env,'/synthetic-home',true,true);
 expect(env).toEqual({BOTLING_IMPORT_FROM:'/chosen-copy',BOTLING_1X_DIR:'/lock-data'});
});
it('trial default profile is separate from normal Botling 2',()=>{
 expect(packagedDataName(true)).toBe('Botling 2 Dev Trial');expect(packagedDataName(false)).toBe('Botling 2');
});
it('regular packaged imports and development behavior remain unchanged',()=>{
 const env:Record<string,string>={};directoryDefaults(env,'/synthetic-home',true);expect(env.BOTLING_IMPORT_FROM).toBe('/synthetic-home/.claudecodebot');
 const dev:Record<string,string>={};directoryDefaults(dev,'/synthetic-home',false,true);expect(dev).toEqual({});
});
it('manual trial shortcut isolates data, CLI state and temp without overriding 1.x project-lock lookup',()=>{
 const base=resolve('.cache/test-data');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'trial shortcut '));
 try{
  const app=join(root,'Botling 2.app');const bin=join(app,'Contents/MacOS/Botling 2');mkdirSync(join(app,'Contents/MacOS'),{recursive:true});
  writeFileSync(bin,`#!/bin/sh
/usr/bin/env > "$BOTLING_DATA_DIR/observed-env"
`);chmodSync(bin,0o700);
  const shortcut=join(root,'Launch Dev Trial.command');writeFileSync(shortcut,readFileSync('scripts/launch-dev-trial.command'));chmodSync(shortcut,0o700);
  const child=spawnSync('/bin/sh',[shortcut],{env:{PATH:'/usr/bin:/bin',BOTLING_IMPORT_FROM:'/must-not-import',BOTLING_1X_DIR:'/lock-data',CODEX_HOME:'/must-not-read',CLAUDE_CONFIG_DIR:'/must-not-read'},encoding:'utf8'});
  expect(child.status,child.stderr).toBe(0);const seen=readFileSync(join(root,'trial-data/observed-env'),'utf8');
  for(const [key,path] of Object.entries({BOTLING_DATA_DIR:join(root,'trial-data'),BOTLING_IMPORT_FROM:join(root,'trial-data/empty-import'),CODEX_HOME:join(root,'trial-data/codex'),CLAUDE_CONFIG_DIR:join(root,'trial-data/claude'),TMPDIR:join(root,'trial-data/tmp'),BOTLING_1X_DIR:'/lock-data'}))expect(seen).toContain(`${key}=${path}\n`);
 }finally{rmSync(root,{recursive:true,force:true});}
});
