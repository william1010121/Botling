import {expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {VerifiedInstaller} from '../../src/main/update-install';
import {payload} from '../../scripts/release-manifest.mjs';
import {tempDir} from '../helpers';
vi.mock('node:child_process',async original=>({...await original<any>(),spawn:()=>{
 const child=new EventEmitter() as any;child.pid=777;child.unref=()=>{};
 queueMicrotask(()=>child.emit('error',Object.assign(new Error('injected spawn failure'),{code:'EAGAIN'})));return child;
}}));
it('C1 asynchronous helper spawn failure clears only its pending transaction and permits retry',async()=>{
 const base=tempDir('spawn-failure'),target=join(base,'Botling 2.app'),source=join(base,'source/Botling 2.app'),data=join(base,'data');
 const bundle=(path:string,version:string)=>{mkdirSync(join(path,'Contents/MacOS'),{recursive:true});writeFileSync(join(path,'Contents/MacOS/TestApp'),'#!/bin/sh\nexit 0\n',{mode:0o755});writeFileSync(join(path,'Contents/Info.plist'),`<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.github.william1010121.Botling2</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleExecutable</key><string>TestApp</string></dict></plist>`);};
 bundle(target,'2.0.0');bundle(source,'2.0.1');const zip=join(base,'source.zip');execFileSync('/usr/bin/ditto',['-c','-k','--keepParent',source,zip]);const bytes=readFileSync(zip),keys=generateKeyPairSync('ed25519');
 const fields={version:'2.0.1',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},manifest={...fields,signature:sign(null,payload(fields),keys.privateKey).toString('base64')};
 const installer=new VerifiedInstaller({current:'2.0.0',appPath:target,dataDir:data,publicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString(),platform:'darwin',arch:process.arch,assetURL:()=> 'https://synthetic.invalid/update.zip',fetch:async url=>new Response(url.endsWith('.json')?JSON.stringify(manifest):bytes)});
 try{
  await installer.stage({version:'2.0.1',name:'synthetic',asset:`Botling-2-2.0.1-mac-${process.arch}.zip`,url:'https://github.com/william1010121/Botling/releases/tag/v2.0.1',publishedAt:null});
  await expect(installer.restart(process.pid)).rejects.toThrow('Could not start update helper');
  expect(existsSync(join(data,'update-pending.json'))).toBe(false);expect(installer.ready).toBe('2.0.1');
 }finally{await installer.discard();rmSync(base,{recursive:true,force:true});}
});
