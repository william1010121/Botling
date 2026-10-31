import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,rmSync,writeFileSync,cpSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {launch,MAIN,post,chatFrame} from './launch';
import {tempDir,swiftLine,desktop} from '../helpers';
import {electronExecutable} from '../electron-runtime';
import {writeLibrary} from '../fixtures/components';

test('E2 trusted Markdown clicks allow guest and notice files; component notice opens stay denied',async()=>{
 const data=tempDir('e2-links'),file=join(data,'guest.txt'),notice=join(data,'notice.txt');writeFileSync(file,'guest');writeFileSync(notice,'notice');
 const run=await launch({dataDir:data,chat:[swiftLine({id:randomUUID(),role:'bot',sourceID:'DEC0DE00-0000-4000-8000-00000000DEC0',text:`[guest file](file://${file})`}),swiftLine({id:randomUUID(),role:'notice',text:`[notice file](file://${notice})`})]});
 try{const opened=()=>run.app.evaluate(()=>(globalThis as any).__botlingOpenedResults);await run.chat.locator('[data-url]').filter({hasText:'guest file'}).click();await expect.poll(opened).toContain('file://'+file);await run.chat.locator('[data-url]').filter({hasText:'notice file'}).click();await expect.poll(opened).toContain('file://'+notice);expect((await post(run.page,{v:10,id:randomUUID(),cmd:{type:'link.open',source:'component',botId:MAIN,url:'file://'+notice}})).ok).toBe(false);
 }finally{await run.app.close();}
});

test('E2 pinned guest component keeps trusted author context outside chat rows',async()=>{
 const data=tempDir('e2-pin'),guest='DEC0DE00-0000-4000-8000-00000000DEC0',id=randomUUID(),pin=randomUUID().toUpperCase(),own='https://example.org/pin-own',host='https://example.org/pin-host';writeLibrary(join(data,'core'));
 const run=await launch({dataDir:data,chat:[swiftLine({id:randomUUID(),role:'bot',text:`[host](${host})`}),swiftLine({id,role:'bot',sourceID:guest,text:`[guest](${own})`,displays:[{name:'todo',data:'{"items":["synthetic"]}'}]})]});
 try{await run.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.setSize(1800,1000));expect((await post(run.page,{v:10,id:randomUUID(),cmd:{type:'pin.add',botId:MAIN,id:pin,messageId:id,index:0,refresh:'manual',minutes:15}})).ok).toBe(true);
 await run.page.getByRole('button',{name:'Board',exact:true}).click();
 const card=run.chat.frameLocator('#board iframe.component-frame').locator('body');await expect(card.locator('#items')).toBeVisible();
 const opened=()=>run.app.evaluate(()=>(globalThis as any).__botlingOpenedResults);
 await card.evaluate((_el,url)=>parent.postMessage({ccb:'open',url},'*'),own);await expect.poll(opened).toContain(own);
 await card.evaluate((_el,url)=>parent.postMessage({ccb:'open',url,linkPinId:'forged'},'*'),host);await card.evaluate((_el,url)=>parent.postMessage({ccb:'open',url},'*'),own);await expect.poll(async()=>(await opened()).length).toBe(2);expect(await opened()).not.toContain(host);
 await run.page.getByRole('button',{name:'Board',exact:true}).click();await run.chat.locator('.pin-chip:not(.add)').first().click();
 const sheet=run.chat.frameLocator('.pin-sheet iframe.component-frame').locator('body');await expect(sheet.locator('#items')).toBeVisible();await sheet.evaluate((_el,url)=>parent.postMessage({ccb:'open',url},'*'),own);await expect.poll(async()=>(await opened()).length).toBe(3);
 expect((await post(run.page,{v:10,id:randomUUID(),cmd:{type:'pin.change',botId:MAIN,id:pin,change:{kind:'float',floating:true}}})).ok).toBe(true);
 const frame=await chatFrame(run.page);await expect.poll(()=>frame.evaluate(pin=>[...document.querySelectorAll('iframe.component-frame')].filter(f=>(f as any).ccbPin===pin).length,pin)).toBeGreaterThan(0);
 const floating=run.chat.frameLocator('.float-card iframe.component-frame').locator('body');await expect(floating.locator('#items')).toBeVisible();await floating.evaluate((_el,url)=>parent.postMessage({ccb:'open',url},'*'),own);await expect.poll(async()=>(await opened()).length).toBe(4);expect(await opened()).not.toContain(host);
 }finally{await run.app.close();}
});

