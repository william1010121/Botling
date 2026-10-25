import {chromium,expect,test,type Browser} from '@playwright/test';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {createReadStream,existsSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createServer as tcpServer} from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {dirname,join} from 'node:path';
import {SWAP_SCRIPT,VerifiedInstaller,recoverUpdates} from '../../src/main/update-install';
import {payload} from '../../scripts/release-manifest.mjs';
import {desktop,tempDir,until} from '../helpers';

test.skip(process.platform!=='darwin','Real disposable macOS receipt handoff');
test('C7 candidate commits after receipt when helper is killed before its decision',async()=>{
 test.setTimeout(120000);
 const app=process.env.BOTLING_PACKAGED_APP??join(desktop,'.cache/dist/mac-arm64/Botling 2.app'),zip=join(dirname(dirname(app)),'Botling-2-2.0.0-dev.0-mac-arm64-unsigned-updates.zip');
 const base=tempDir('c7-orphan'),target=join(base,'Botling 2.app'),data=join(base,'data'),home=join(base,'home');mkdirSync(home);mkdirSync(join(data,'core'),{recursive:true});
 writeFileSync(join(data,'core/settings.json'),JSON.stringify({updateCheckEnabled:false}));
 execFileSync('/usr/bin/ditto',[join(desktop,'.cache/update-old/mac-arm64/Botling 2.app'),target]);
 const pair=generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({type:'spki',format:'pem'}).toString(),hash=createHash('sha256');let size=0;
 for await(const b of createReadStream(zip)){hash.update(b);size+=b.length;}
 const fields={version:'2.0.0-dev.0',sha256:hash.digest('hex'),size},manifest={...fields,signature:sign(null,payload(fields),pair.privateKey).toString('base64')};
 const server=createServer((req,res)=>{if(req.url?.endsWith('manifest.json'))res.end(JSON.stringify(manifest));else createReadStream(zip).pipe(res);}).listen(0,'127.0.0.1');await once(server,'listening');
 const installer=new VerifiedInstaller({current:'2.0.0-dev',appPath:target,dataDir:data,publicKey,platform:'darwin',arch:process.arch,fetch:url=>fetch(url),assetURL:()=>`http://127.0.0.1:${(server.address() as any).port}/release.zip`});
 let helper:ReturnType<typeof spawn>|undefined,browser:Browser|undefined,candidate=0;
 const pids=()=>execFileSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n').flatMap(line=>{const m=/^\s*(\d+)\s+(.*)$/.exec(line);return m?.[2]?.startsWith(target+'/Contents/')?[Number(m[1])]:[];});
 try{
  await installer.stage({version:fields.version,name:'C7',url:'https://github.com/william1010121/Botling/releases/tag/v'+fields.version,asset:`Botling-2-${fields.version}-mac-${process.arch}.zip`,publishedAt:null});
  const root=join(base,readdirSync(base).find(n=>n.startsWith('.botling-update-'))!),token=randomUUID(),gate=join(root,'test-helper-gate');
  const pending={root,target,token,version:fields.version,executable:'Botling 2'};writeFileSync(join(data,'update-pending.json'),JSON.stringify(pending));
  const script=SWAP_SCRIPT.replace('    # Commit marker precedes',()=>`    printf stopped > '${gate}'\n    kill -STOP "$$"\n    # Commit marker precedes`);
  expect(script).toContain('kill -STOP "$$"');const file=join(root,'test-swap.sh');writeFileSync(file,script);
  const reserve=tcpServer().listen(0,'127.0.0.1');await once(reserve,'listening');const port=(reserve.address() as any).port;await new Promise<void>(r=>reserve.close(()=>r()));
  const env={PATH:'/usr/bin:/bin',HOME:home,TMPDIR:base,BOTLING_DATA_DIR:data,BOTLING_IMPORT_FROM:'',BOTLING_1X_DIR:'',BOTLING_CLAUDE_PATH:'/usr/bin/false',BOTLING_CODEX_PATH:'/usr/bin/false'};
  helper=spawn('/bin/sh',[file,'99999999',target,join(root,'Botling 2.app'),join(root,'previous.app'),join(root,'boot.ok'),token,'Botling 2','0','0.1',data,'1200','50','--use-mock-keychain',`--remote-debugging-port=${port}`],{env,stdio:'ignore'});
  const exited=once(helper,'exit');await until(()=>existsSync(gate),{timeout:30000,what:'helper stopped after real main receipt'});
  expect(readFileSync(join(root,'boot.ok'),'utf8')).toBe(token);candidate=Number(readFileSync(join(root,'new.pid'),'utf8'));
  helper.kill('SIGKILL');await exited;
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);const page=await until(()=>browser!.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='app://botling/index.html'));
  const setting=()=>page.evaluate(()=>new Promise<any>(resolve=>{const bridge=(window as any).botling,id='c7-'+Math.random(),off=bridge.subscribe((m:any)=>{if(m.id===id){off();resolve(m);}});bridge.post({v:10,id,cmd:{type:'settings.set',change:{key:'messageColumnWidth',value:780}}});setTimeout(()=>{off();resolve(null);},1000);}));
  await expect.poll(async()=> (await setting())?.ok,{timeout:5000}).toBe(true);
  await until(()=>existsSync(join(data,'update-last-boot.json')));
  expect(JSON.parse(readFileSync(join(data,'update-last-boot.json'),'utf8'))).toMatchObject({token,activated:true,orphan:true});
  await recoverUpdates(data,target);
  expect(existsSync(join(root,'retained.json'))).toBe(true);expect(existsSync(join(root,'previous.app'))).toBe(true);expect(existsSync(join(root,'data-before'))).toBe(true);expect(existsSync(join(data,'update-pending.json'))).toBe(false);
  mkdirSync(join(desktop,'.cache/evidence/review-d'),{recursive:true});writeFileSync(join(desktop,'.cache/evidence/review-d/orphan-receipt.json'),JSON.stringify({helperKilledBeforeDecision:true,receipt:token,candidate,manifest,result:'booted',coreMutationAfterOrphan:true},null,2));
 }finally{
  await browser?.close().catch(()=>{});helper?.kill('SIGKILL');for(const pid of [...pids(),candidate])if(pid)try{process.kill(pid,'SIGTERM');}catch{}
  await until(()=>pids().length===0,{timeout:10000}).catch(()=>{for(const pid of pids())try{process.kill(pid,'SIGKILL');}catch{}});
  await installer.discard();await new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();});rmSync(base,{recursive:true,force:true});
 }
});
