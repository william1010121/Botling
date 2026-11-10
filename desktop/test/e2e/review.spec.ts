import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { desktop, tempDir, swiftLine } from '../helpers';
import { launch, post, chatFrame, say, MAIN } from './launch';
import { previewURL } from '../../src/core/preview-url';

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

test('B6 ordinary user and Web-viewer web links open without result authorization',async()=>{
  const run=await launch({chat:[swiftLine({id:'ABCD0000-0000-4000-8000-000000000077',role:'user',text:'[Ordinary](https://example.org/ordinary)'})]});try{
    // A trusted click in the viewer/chat chip DOM, independent of result authorization.
    const frame=await chatFrame(run.page);await frame.evaluate(()=>{const a=document.createElement('a');a.href='#';a.dataset.url='https://example.org/ordinary';a.textContent='Ordinary';document.querySelector('.user-body')!.append(a);});
    await run.chat.getByRole('link',{name:'Ordinary',exact:true}).click();
    await expect.poll(()=>run.app.evaluate(()=>(globalThis as any).__botlingOpenedResults)).toContain('https://example.org/ordinary');
    const denied=await post(run.page,{v:10,id:'unshown-local',cmd:{type:'result.open',botId:MAIN,url:'file:///unshown/private.html'}});expect(denied.ok).toBe(false);
  }finally{await run.app.close();}
});

test('B5 reload ignores stale key/ack messages without changing the draft or stealing chosen shell focus',async()=>{
 const run=await launch();try{
  await run.page.reload();await run.chat.locator('html[data-chat]').waitFor({state:'attached'});
  const box=run.chat.getByRole('textbox',{name:'Message'});await box.fill('kept draft');
  const search=run.page.getByRole('searchbox',{name:'Search bots'});await search.click();await search.fill('Main');
  const frame=await chatFrame(run.page);
  await frame.evaluate(()=>{for(const key of ['x','Enter'])parent.postMessage({botling:'handoffKey',key,code:key==='Enter'?'Enter':'KeyX',shiftKey:false,altKey:false},'app://botling');parent.postMessage({botling:'keyHandled',id:1},'app://botling');});
  await run.page.evaluate(()=>{const frame=document.getElementById('chat-frame') as HTMLIFrameElement;for(const key of ['x','Enter'])frame.contentWindow!.postMessage({botling:'key',id:7,key,code:key==='Enter'?'Enter':'KeyX',shiftKey:false,altKey:false},'botling-chat://chat');});
  // Exceeds the removed 2s acknowledgement + 500ms idle watchdog; chosen focus must survive.
  await run.page.waitForTimeout(2600);
  await expect(search).toBeFocused();await expect(search).toHaveValue('Main');await expect(box).toHaveText('kept draft');await expect(run.chat.locator('.row.user')).toHaveCount(0);
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
