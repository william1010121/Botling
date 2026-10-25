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

test('E4 Dock activation after recovery cleared must restart with normal profile and core',async()=>{
 const target=dirname(dirname(dirname(electronExecutable()))),data=tempDir('e4-activate'),token=randomUUID(),root=join(dirname(target),'.botling-update-e4-'+token);mkdirSync(root);writeFileSync(join(root,'owner.json'),JSON.stringify({target,dataDir:data,token}));writeFileSync(join(root,'result'),'failed:19');
 let run:Awaited<ReturnType<typeof launch>>|undefined;
 try{run=await launch({dataDir:data,waitForState:false,env:{BOTLING_QUIT_ON_CLOSE:'0'}});await expect(run.page.getByRole('heading',{name:'Update recovery required'})).toBeVisible();await run.app.evaluate(({app})=>{(globalThis as any).__restart=[];app.relaunch=options=>(globalThis as any).__restart.push(options);app.quit=()=>{};});await run.page.close();rmSync(root,{recursive:true,force:true});await run!.app.evaluate(({app})=>app.emit('activate'));await expect.poll(()=>run!.app.evaluate(()=>(globalThis as any).__restart.length)).toBe(1);await run.app.evaluate(({app})=>app.exit(0));await run.app.close().catch(()=>{});run=await launch({dataDir:data});expect(await run.app.evaluate(({app})=>app.getPath('userData'))).toBe(join(data,'electron'));expect(await run.app.evaluate(()=>(globalThis as any).__botlingCorePid())).toBeGreaterThan(0);
 }finally{await run?.app.evaluate(({app})=>app.exit(0)).catch(()=>{});await run?.app.close().catch(()=>{});rmSync(root,{recursive:true,force:true});}
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

test('E1 recovery copy sizes, safe native delete confirmation, and verified Continue',async()=>{
 const target=dirname(dirname(dirname(electronExecutable()))),data=tempDir('e1-copy-ui'),token=randomUUID(),root=join(dirname(target),'.botling-update-e1-'+token);mkdirSync(join(data,'core'),{recursive:true});writeFileSync(join(data,'core/settings.json'),'{}');cpSync(data,join(root,'data-before'),{recursive:true});writeFileSync(join(root,'snapshot.complete'),'complete');mkdirSync(join(root,'previous.app'));writeFileSync(join(root,'owner.json'),JSON.stringify({target,dataDir:data,token,pid:99999999}));writeFileSync(join(root,'result'),'failed:21');
 let run:Awaited<ReturnType<typeof launch>>|undefined;
 try{run=await launch({dataDir:data,waitForState:false});await expect(run.page.getByRole('link',{name:'Delete recovery copies…'})).toBeVisible();await expect(run.page.locator('body')).toContainText('bytes');await run.page.screenshot({path:join(desktop,'.cache/evidence/review-e/retained-copy-sizes.png'),fullPage:true});await run.app.evaluate(({dialog,app})=>{(globalThis as any).__confirmations=[];(globalThis as any).__answer=0;(dialog as any).showMessageBox=async (_window:any,options:any)=>{(globalThis as any).__confirmations.push(options);return{response:(globalThis as any).__answer,checkboxChecked:false};};app.relaunch=()=>{};app.quit=()=>{};});
 const windowIds=await run.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(window=>window.id));
 const deleteClick=async()=>{const rect=await run!.page.getByRole('link',{name:'Delete recovery copies…'}).boundingBox();expect(rect).not.toBeNull();await run!.page.mouse.click(rect!.x+rect!.width/2,rect!.y+rect!.height/2);};
 await deleteClick();await expect.poll(()=>run!.app.evaluate(()=>(globalThis as any).__confirmations.length)).toBe(1);expect(existsSync(join(root,'data-before'))).toBe(true);await expect(run.page.getByRole('link',{name:'Delete recovery copies…'})).toBeVisible();expect(run.page.isClosed()).toBe(false);expect(await run.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(window=>window.id))).toEqual(windowIds);
 await run.app.evaluate(()=>(globalThis as any).__answer=1);await deleteClick();await expect.poll(()=>existsSync(join(root,'data-before'))).toBe(false);expect(existsSync(join(root,'previous.app'))).toBe(true);expect(run.page.isClosed()).toBe(false);expect(await run.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(window=>window.id))).toEqual(windowIds);
 await expect(run.page.getByRole('link',{name:'I restored my data — continue'})).toBeVisible();await run.page.screenshot({path:join(desktop,'.cache/evidence/review-e/recovery-copies.png'),fullPage:true});const next=await run.page.getByRole('link',{name:'I restored my data — continue'}).boundingBox();await run.page.mouse.click(next!.x+next!.width/2,next!.y+next!.height/2);await expect.poll(()=>existsSync(join(data,'update-recovered.json'))).toBe(true);
 const options=await run.app.evaluate(()=>(globalThis as any).__confirmations[0]);expect(options.defaultId).toBe(0);expect(options.cancelId).toBe(0);expect(options.detail).toContain(join(root,'data-before'));
 }finally{await run?.app.evaluate(({app})=>app.exit(0)).catch(()=>{});await run?.app.close().catch(()=>{});rmSync(root,{recursive:true,force:true});}
});

test('E5 an abandoned download does not block normal startup with a fresh data directory',async()=>{
 const target=dirname(dirname(dirname(electronExecutable()))),base=tempDir('e5-download'),data=join(base,'absent-data'),token=randomUUID(),root=join(dirname(target),'.botling-update-e5-'+token);mkdirSync(root);writeFileSync(join(root,'owner.json'),JSON.stringify({target,dataDir:data,token,pid:99999999}));writeFileSync(join(root,'download.zip'),'synthetic download');let run:Awaited<ReturnType<typeof launch>>|undefined;
 try{run=await launch({dataDir:data});await expect(run.page.locator('.shell[data-ready="1"]')).toBeVisible();await expect.poll(()=>existsSync(root)).toBe(false);expect(await run.app.evaluate(()=>(globalThis as any).__botlingCorePid())).toBeGreaterThan(0);}
 finally{await run?.app.close().catch(()=>{});rmSync(root,{recursive:true,force:true});rmSync(base,{recursive:true,force:true});}
});

test('E5 missing external volume shows a storage error without data creation or core startup',async()=>{
 const data='/Volumes/definitely-not-mounted-botling-test/data';expect(existsSync(dirname(data))).toBe(false);const run=await launch({dataDir:data,waitForState:false});
 try{await expect(run.page.getByRole('heading',{name:'Data volume unavailable'})).toBeVisible();expect(existsSync(dirname(data))).toBe(false);expect(await run.app.evaluate(()=>(globalThis as any).__botlingCorePid())).toBeUndefined();await expect(run.page.getByRole('link',{name:'I restored my data — continue'})).toHaveCount(0);}
 finally{await run.app.close();}
});
