import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync,cpSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {launch,MAIN,post,chatFrame} from './launch';
import {desktop,tempDir,swiftLine} from '../helpers';
import {electronExecutable} from '../electron-runtime';
import {writeLibrary} from '../fixtures/components';

test('D8 component links cannot borrow guest bot replies or user notices',async()=>{
 const url='https://example.org/guest',file=join(tempDir('d8'),'secret.txt');writeFileSync(file,'synthetic');
 const run=await launch({chat:[swiftLine({id:randomUUID(),role:'bot',sourceID:'DEC0DE00-0000-4000-8000-00000000DEC0',text:`[guest](${url})`}),swiftLine({id:randomUUID(),role:'notice',text:`Called into another chat: [user file](file://${file})`})]});
 try{
  expect((await post(run.page,{v:10,id:'guest-open',cmd:{type:'link.open',source:'component',botId:MAIN,url}})).ok).toBe(false);
  expect((await post(run.page,{v:10,id:'echo-open',cmd:{type:'link.open',source:'component',botId:MAIN,url:'file://'+file}})).ok).toBe(false);
 }finally{await run.app.close();}
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
