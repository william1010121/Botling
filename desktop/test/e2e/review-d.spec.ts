import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {launch,MAIN,post,chatFrame} from './launch';
import {desktop,tempDir,swiftLine} from '../helpers';
import {electronExecutable} from '../electron-runtime';
import {writeLibrary} from '../fixtures/components';

test('D3 recovery offers Open folder and explicit restored-data continuation; fresh launch is unblocked',async()=>{
 const target=dirname(dirname(dirname(electronExecutable()))),data=tempDir('d3-ui'),token=randomUUID(),root=join(dirname(target),'.botling-update-d3-'+token);
 mkdirSync(join(root,'data-before'),{recursive:true});mkdirSync(join(data,'core'));writeFileSync(join(data,'core/schema'),'restored synthetic data');
 writeFileSync(join(root,'owner.json'),JSON.stringify({target,dataDir:data,token,pid:99999999}));writeFileSync(join(root,'result'),'failed:19');writeFileSync(join(data,'update-pending.json'),JSON.stringify({target,root,token,version:'2.0.1',executable:'TestApp'}));
 let run:Awaited<ReturnType<typeof launch>>|undefined;
 try{
  run=await launch({dataDir:data,waitForState:false});await expect(run.page.getByRole('heading',{name:'Update recovery required'})).toBeVisible();
  await expect(run.page.getByRole('link',{name:'Open recovery folder'})).toBeVisible({timeout:3000});
  await run.app.evaluate(({app,shell})=>{(globalThis as any).__recoveryActions=[];shell.openPath=async path=>{(globalThis as any).__recoveryActions.push({open:path});return '';};app.relaunch=options=>{(globalThis as any).__recoveryActions.push({relaunch:options});};app.quit=()=>{(globalThis as any).__recoveryActions.push({quit:true});};});
  const open=await run.page.getByRole('link',{name:'Open recovery folder'}).boundingBox(),next=await run.page.getByRole('link',{name:'I restored my data — continue'}).boundingBox();
  await run.page.mouse.click(open!.x+open!.width/2,open!.y+open!.height/2);await expect.poll(()=>run!.app.evaluate(()=>(globalThis as any).__recoveryActions)).toContainEqual({open:join(root,'data-before')});
  await run.page.mouse.click(next!.x+next!.width/2,next!.y+next!.height/2);await expect.poll(()=>existsSync(join(data,'update-recovered.json'))).toBe(true);
  expect(existsSync(join(data,'update-pending.json'))).toBe(false);expect(readFileSync(join(data,'core/schema'),'utf8')).toBe('restored synthetic data');
  await expect.poll(()=>run!.app.evaluate(()=>(globalThis as any).__recoveryActions.some((x:any)=>x.relaunch))).toBe(true);
  const relaunch=await run.app.evaluate(()=>(globalThis as any).__recoveryActions.find((x:any)=>x.relaunch).relaunch);
  expect(relaunch.args).toContain('--botling-update-data='+data);expect(relaunch.args.some((a:string)=>a.startsWith('--botling-update-token='))).toBe(false);
  // Close the mocked restart instance, then actually launch the disposable app afresh.
  await run.app.evaluate(({app})=>app.exit(0));await run.app.close().catch(()=>{});run=await launch({dataDir:data});await expect(run.page.locator('.shell[data-ready="1"]')).toBeVisible();
  const counter=run.chat.frameLocator('iframe[src^="botling-card://card/"]').getByRole('button',{name:'Count: 0'});
  await expect(counter).toBeVisible();await counter.click();await expect(run.chat.frameLocator('iframe[src^="botling-card://card/"]').locator('#n')).toHaveText('1');
  await run.page.screenshot({path:join(desktop,'.cache/evidence/review-d/recovered-ui.png')});
 }finally{if(run){await run.app.evaluate(({app})=>app.exit(0)).catch(()=>{});await run.app.close().catch(()=>{});}rmSync(root,{recursive:true,force:true});}
});

test('D4 missing live data is discovered before any directory/profile is created',async()=>{
 const target=dirname(dirname(dirname(electronExecutable()))),base=tempDir('d4-ui'),data=join(base,'missing-data'),token=randomUUID(),root=join(dirname(target),'.botling-update-d4-'+token),after=data+'.update-after-'+token;
 mkdirSync(join(root,'data-before'),{recursive:true});mkdirSync(after);writeFileSync(join(after,'schema'),'current candidate data');
 writeFileSync(join(root,'owner.json'),JSON.stringify({target,dataDir:data,token,pid:99999999}));writeFileSync(join(root,'result'),'failed:21');
 let run:Awaited<ReturnType<typeof launch>>|undefined;
 try{
  run=await launch({dataDir:data,waitForState:false});await expect(run.page.getByRole('heading',{name:'Update recovery required'})).toBeVisible();
  expect(existsSync(data)).toBe(false);await expect(run.page.getByRole('alert',{name:'Update recovery'})).toContainText(after);expect(await run.app.evaluate(()=>(globalThis as any).__botlingCorePid())).toBeUndefined();
  await run.page.screenshot({path:join(desktop,'.cache/evidence/review-d/missing-data-recovery.png')});
 }finally{await run?.app.close().catch(()=>{});rmSync(root,{recursive:true,force:true});rmSync(base,{recursive:true,force:true});}
});

test('D8 component links cannot borrow guest bot replies or user notices',async()=>{
 const url='https://example.org/guest',file=join(tempDir('d8'),'secret.txt');writeFileSync(file,'synthetic');
 const run=await launch({chat:[swiftLine({id:randomUUID(),role:'bot',sourceID:'DEC0DE00-0000-4000-8000-00000000DEC0',text:`[guest](${url})`}),swiftLine({id:randomUUID(),role:'notice',text:`Called into another chat: [user file](file://${file})`})]});
 try{
  expect((await post(run.page,{v:10,id:'guest-open',cmd:{type:'link.open',source:'component',botId:MAIN,url}})).ok).toBe(false);
  expect((await post(run.page,{v:10,id:'echo-open',cmd:{type:'link.open',source:'component',botId:MAIN,url:'file://'+file}})).ok).toBe(false);
 }finally{await run.app.close();}
});


test('D6 a helper dying before new.pid replaces the gated normal window with actionable recovery',async()=>{
 const target=dirname(dirname(dirname(electronExecutable()))),data=tempDir('d6-ui'),token=randomUUID(),root=join(dirname(target),'.botling-update-d6-'+token);
 mkdirSync(root);writeFileSync(join(root,'owner.json'),JSON.stringify({target,dataDir:data,token,pid:99999999}));writeFileSync(join(root,'helper.pid'),String(process.pid));
 writeFileSync(join(data,'update-pending.json'),JSON.stringify({target,root,token,version:'2.0.0-dev.0',executable:'Electron'}));
 let run:Awaited<ReturnType<typeof launch>>|undefined;
 try{
  run=await launch({dataDir:data,args:['--botling-update-token='+token,'--botling-update-data='+data]});
  await expect.poll(()=>existsSync(join(root,'boot.ok'))).toBe(true);expect(existsSync(join(root,'new.pid'))).toBe(false);
  const recovery=run.app.waitForEvent('window');writeFileSync(join(root,'helper.pid'),'99999999');const page=await recovery;
  await expect(page.getByRole('heading',{name:'Update recovery required'})).toBeVisible();await expect(page.getByRole('alert',{name:'Update recovery'})).toContainText('failed:25');
  await expect.poll(()=>run!.app.evaluate(()=>{const pid=(globalThis as any).__botlingCorePid();try{process.kill(pid,0);return true;}catch{return false;}})).toBe(false);expect(JSON.parse(readFileSync(join(data,'update-recovery.json'),'utf8')).code).toBe(25);
  await page.screenshot({path:join(desktop,'.cache/evidence/review-d/helper-before-pid-recovery.png')});
 }finally{await run?.app.close().catch(()=>{});rmSync(root,{recursive:true,force:true});}
});


test('D8 real component message provenance follows its guest author, excluding host links and notice echoes',async()=>{
 const data=tempDir('d8-component'),guest='DEC0DE00-0000-4000-8000-00000000DEC0',id=randomUUID(),own='https://example.org/guest-own',host='https://example.org/host-only';
 writeLibrary(join(data,'core'));const run=await launch({dataDir:data,chat:[swiftLine({id:randomUUID(),role:'bot',text:`[host](${host})`}),swiftLine({id,role:'bot',sourceID:guest,text:`[guest](${own})`,displays:[{name:'todo',data:'{"items":["synthetic"]}'}]})]});
 try{
  const card=run.page.frames().find(f=>f.url().startsWith('botling-card://page/'))||await new Promise<import('@playwright/test').Frame>(resolve=>{run.page.on('framenavigated',f=>{if(f.url().startsWith('botling-card://page/'))resolve(f);});});
  const opened=()=>run.app.evaluate(()=>(globalThis as any).__botlingOpenedResults);
  await card.evaluate(url=>parent.postMessage({ccb:'open',url,linkMessageId:'forged-host-context'},'*'),own);await expect.poll(opened).toContain(own);
  await card.evaluate(url=>parent.postMessage({ccb:'open',url},'*'),host);
  // Join a subsequent allowed request to establish all earlier messages crossed the same bridge.
  await card.evaluate(url=>parent.postMessage({ccb:'open',url},'*'),own);await expect.poll(async()=>(await opened()).length).toBe(2);expect(await opened()).not.toContain(host);
  // A detached/legacy pin has no reply author. It must fail closed rather than inherit the host.
  const frame=await chatFrame(run.page);await frame.evaluate(()=>document.querySelector('iframe.component-frame')!.closest('.row')!.removeAttribute('data-id'));
  await run.page.evaluate(()=>{(window as any).__linkFailures=[];(window as any).botling.subscribe((m:any)=>{if(m.ok===false)(window as any).__linkFailures.push(m.error);});});
  await card.evaluate(url=>parent.postMessage({ccb:'open',url},'*'),host);
  await expect.poll(()=>run.page.evaluate(()=>(window as any).__linkFailures)).toContainEqual(expect.objectContaining({code:'not_found'}));expect(await opened()).not.toContain(host);
  await run.page.screenshot({path:join(desktop,'.cache/evidence/review-d/guest-component-links.png')});
 }finally{await run.app.close();}
});
