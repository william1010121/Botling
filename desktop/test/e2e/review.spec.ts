import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { desktop, tempDir, swiftLine } from '../helpers';
import { launch, post, chatFrame, say, MAIN } from './launch';
import { previewURL } from '../../src/core/preview-url';

const saved = (data: string) => {
  const p = join(data, 'core/settings.json');
  return existsSync(p) ? JSON.parse(readFileSync(p,'utf8')).messageColumnWidth : undefined;
};

test('B1 preview protocol serves real byte ranges, suffix ranges, HEAD and invalid 416', async () => {
  const folder = join(tempDir('review-media'), 'artifacts'); mkdirSync(folder);
  const file = join(folder,'movie.mp4'); writeFileSync(file,Buffer.from('0123456789abcdef'));
  const run = await launch();
  try {
    const fetchRange = (range: string, method = 'GET') => run.app.evaluate(async ({net}, args) => {
      const r = await net.fetch(args.url,{method:args.method,headers:{Range:args.range}});
      return {status:r.status,range:r.headers.get('content-range'),accept:r.headers.get('accept-ranges'),length:r.headers.get('content-length'),text:await r.text()};
    },{url:previewURL(file),range,method});
    expect(await fetchRange('bytes=2-5')).toMatchObject({status:206,range:'bytes 2-5/16',accept:'bytes',length:'4',text:'2345'});
    expect(await fetchRange('bytes=-4')).toMatchObject({status:206,range:'bytes 12-15/16',text:'cdef'});
    expect(await fetchRange('bytes=14-')).toMatchObject({status:206,text:'ef'});
    for(const range of ['bytes=99-','bytes=-0','bytes=5-2','bytes=0-1,4-5']) expect(await fetchRange(range)).toMatchObject({status:416,range:'bytes */16',text:''});
    expect(await fetchRange('bytes=2-5','HEAD')).toMatchObject({status:206,length:'4',text:''});
  } finally { await run.app.close(); }
});

test('B4 preview response itself enforces opaque origin without an iframe sandbox attribute', async () => {
  const folder=join(tempDir('review-csp'),'artifacts');mkdirSync(folder);
  const file=join(folder,'probe.html');writeFileSync(file,'<!doctype html><p>legitimate script</p><script>document.body.dataset.origin=self.origin;try{localStorage.test=1;document.body.dataset.storage="readable"}catch(e){document.body.dataset.storage=e.name}</script>');
  const run=await launch();
  try {
    const value=await run.app.evaluate(async ({BrowserWindow,net},url)=>{
      const r=await net.fetch(url);const csp=r.headers.get('content-security-policy');
      const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
      try {await w.loadURL(url);return {csp,probe:await w.webContents.executeJavaScript('({origin:document.body.dataset.origin,storage:document.body.dataset.storage,text:document.body.textContent})')};}finally{w.destroy();}
    },previewURL(file));
    expect(value.csp).toContain('sandbox allow-scripts');
    expect(value.probe).toMatchObject({origin:'null',storage:'SecurityError'});
    expect(value.probe.text).toContain('legitimate script');
  }finally{await run.app.close();}
});

test('B2 committed width survives stale streaming pushes and rapid keyboard nudges until echoed', async()=>{
  const run=await launch();try{
    await run.page.setViewportSize({width:1900,height:900});
    await run.app.context().addInitScript(()=>{if(location.origin==='botling-chat://chat')window.addEventListener('message',e=>{if(e.data?.botling==='state'){(window as any).__state=e.data;if((window as any).__holdWidth)e.data.messageColumnWidth=640;}},true);});
    await run.page.reload();await run.chat.locator('html[data-chat]').waitFor({state:'attached'});
    const f=await chatFrame(run.page);await f.evaluate(()=>{(window as any).__holdWidth=true;});
    await say(run.chat,'/slow');
    const h=run.chat.locator('.message-width-handle.right');await h.focus();
    await run.page.keyboard.press('ArrowRight');
    await expect.poll(()=>saved(run.dataDir)).toBe(660);
    // A store push with old settings can arrive between any two keyboard nudges.
    await run.page.evaluate(()=>{const f=document.getElementById('chat-frame') as HTMLIFrameElement;f.contentWindow!.postMessage({botling:'resync'},'botling-chat://chat');});
    await run.page.waitForTimeout(100);
    await expect.poll(()=>run.chat.locator('#messages').evaluate(el=>el.getBoundingClientRect().width)).toBe(660);
    await h.focus();for(let i=0;i<4;i++)await run.page.keyboard.press('ArrowRight');
    await expect.poll(()=>saved(run.dataDir)).toBe(740);
    await f.evaluate(()=>{(window as any).__holdWidth=false;});
    await post(run.page,{v:10,id:'echo-width',cmd:{type:'settings.set',change:{key:'messageColumnWidth',value:740}}});
    await expect.poll(()=>run.chat.locator('#messages').evaluate(el=>el.getBoundingClientRect().width)).toBe(740);
  }finally{await run.app.close();}
});

test('B3 slider previews locally, commits once on release, Escape cancels and external changes win',async()=>{
  const run=await launch();try{
    await run.page.setViewportSize({width:1900,height:900});await run.page.getByRole('button',{name:'Settings',exact:true}).click();
    const sheet=run.page.getByRole('dialog',{name:'Settings'});await sheet.getByRole('button',{name:'Appearance',exact:true}).click();
    const slider=sheet.getByRole('slider',{name:'Message column width'});
    const draft=async(value:number)=>slider.evaluate((el,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(el,String(value));el.dispatchEvent(new Event('input',{bubbles:true}));},value);
    await slider.dispatchEvent('pointerdown',{button:0,isPrimary:true});for(const value of [700,720,740,760])await draft(value);
    await expect.poll(()=>run.chat.locator('#messages').evaluate(el=>el.getBoundingClientRect().width)).toBe(760);
    expect(saved(run.dataDir)).toBeUndefined();
    mkdirSync(join(desktop,'.cache/evidence/review'),{recursive:true});
    await run.page.screenshot({path:join(desktop,'.cache/evidence/review/integrated-width-draft.png')});
    await slider.dispatchEvent('pointerup',{button:0});await expect.poll(()=>saved(run.dataDir)).toBe(760);
    await draft(900);await slider.press('Escape');expect(saved(run.dataDir)).toBe(760);await expect(slider).toHaveValue('760');
    await draft(1000);await post(run.page,{v:10,id:'external-width',cmd:{type:'settings.set',change:{key:'messageColumnWidth',value:820}}});
    await expect(slider).toHaveValue('820');await slider.dispatchEvent('pointerup');expect(saved(run.dataDir)).toBe(820);
  }finally{await run.app.close();}
});

test('B6 ordinary user and Web-viewer web links open without result authorization',async()=>{
  const run=await launch({chat:[swiftLine({id:'ABCD0000-0000-4000-8000-000000000077',role:'user',text:'[Ordinary](https://example.org/ordinary)'})]});try{
    // A trusted click in the viewer/chat chip DOM, independent of result authorization.
    const frame=await chatFrame(run.page);await frame.evaluate(()=>{const a=document.createElement('a');a.href='#';a.dataset.url='https://example.org/ordinary';a.textContent='Ordinary';document.querySelector('.user-body')!.append(a);});
    await run.chat.getByRole('link',{name:'Ordinary',exact:true}).click();
    await expect.poll(()=>run.app.evaluate(()=>(globalThis as any).__botlingOpenedResults)).toContain('https://example.org/ordinary');
    const denied=await post(run.page,{v:10,id:'unshown-local',cmd:{type:'result.open',botId:MAIN,url:'file:///unshown/private.html'}});expect(denied.ok).toBe(false);
  }finally{await run.app.close();}
});

test('B5 a chat reload and an ack timeout recover focus without reordering or replaying lost keys',async()=>{
 const run=await launch();try{
  await run.app.context().addInitScript(()=>{if(location.origin==='app://botling'){(window as any).__dropAcks=true;window.addEventListener('message',event=>{if((window as any).__dropAcks&&event.data?.botling==='keyHandled')event.stopImmediatePropagation();});}});
  await run.page.reload();await run.chat.locator('html[data-chat]').waitFor({state:'attached'});
  const forward=async()=>{
   await run.chat.getByRole('textbox',{name:'Message'}).click();
   await run.page.evaluate(()=>{document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',bubbles:true}));document.body.tabIndex=-1;window.focus();document.body.focus();window.dispatchEvent(new Event('focus'));});
   await run.page.keyboard.type('k');
  };
  await forward();await expect.poll(()=>run.page.evaluate(()=>document.activeElement?.id),{timeout:3500}).toBe('chat-frame');
  // Repeat the lost acknowledgement, but navigate the iframe before its watchdog fires.
  await forward();await run.page.evaluate(()=>{const f=document.getElementById('chat-frame') as HTMLIFrameElement;f.src=f.src;(window as any).__dropAcks=false;});
  await run.chat.locator('html[data-chat]').waitFor({state:'attached'});await forward();
  await expect.poll(()=>run.page.evaluate(()=>document.activeElement?.id)).toBe('chat-frame');
 }finally{await run.app.close();}
});

test('B1 Chromium decodes and seeks a small streamed WAV preview', async()=>{
 const folder=join(tempDir('review-seek'),'artifacts');mkdirSync(folder);
 const bytes=Buffer.alloc(44+64000);bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(16000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(64000,40);
 const media=join(folder,'seek.wav');writeFileSync(media,bytes);
 const page=join(folder,'player.html');writeFileSync(page,`<!doctype html><audio controls preload="auto" src="${previewURL(media)}"></audio>`);
 const run=await launch();try{
  const result=await run.app.evaluate(async({BrowserWindow},url)=>{
   const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
   try{await w.loadURL(url);return await w.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const a=document.querySelector('audio'); const timer=setTimeout(()=>reject(new Error('media timeout')),8000);a.onerror=()=>reject(new Error('media '+a.error?.message));function seek(){a.addEventListener('seeked',()=>{clearTimeout(timer);resolve({duration:a.duration,time:a.currentTime,seekable:a.seekable.length,ready:a.readyState})},{once:true});a.currentTime=2.5;}if(a.readyState>=1)seek();else a.onloadedmetadata=seek;})`);}finally{w.destroy();}
  },previewURL(page));
  expect(result).toMatchObject({duration:4,time:2.5,seekable:1});
 }finally{await run.app.close();}
});
