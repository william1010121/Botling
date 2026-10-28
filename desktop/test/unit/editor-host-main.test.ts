import {afterEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {ipcMain} from 'electron';
import {prepareNativeEditorHost,nativeEditorNavigation,editorBounds,reloadNativeEditor,nativeEditorLayer} from '../../src/main/editor-host';
import {EDITOR_CHANNEL,EDITOR_URL} from '../../src/editor-host-wire';
vi.mock('electron',async()=>{
 const {EventEmitter}=await import('node:events');
 class Contents extends EventEmitter {id=2;mainFrame:any={url:EDITOR_URL,parent:null};dead=false;send=vi.fn();focus=vi.fn();isFocused=vi.fn(()=>false);capturePage=vi.fn(async()=>({isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,AA=='}));loadURL=vi.fn(async()=>{});setWindowOpenHandler=vi.fn();isDestroyed(){return this.dead;}close(){this.dead=true;this.emit('destroyed');}}
 class View {webContents=new Contents();setBounds=vi.fn();setVisible=vi.fn();constructor(readonly options:unknown){}}
 return{ipcMain:new EventEmitter(),WebContentsView:View};
});
const disposers:(()=>void)[]=[];afterEach(()=>{for(const dispose of disposers.splice(0))dispose();});
function fixture(ownerReady:Promise<void>=Promise.resolve()){
 const contents=Object.assign(new EventEmitter(),{id:1,mainFrame:{url:'app://botling/index.html',parent:null},isDestroyed:()=>false,send:vi.fn(),focus:vi.fn(),getZoomFactor:()=>1});
 const owner=Object.assign(new EventEmitter(),{webContents:contents,isVisible:():boolean=>false,isDestroyed:():boolean=>false,getContentBounds:()=>({x:0,y:0,width:1120,height:820}),contentView:{addChildView:vi.fn(),removeChildView:vi.fn()},focus:vi.fn(),show:vi.fn()});
 const result=prepareNativeEditorHost(owner as any,'/Volumes/My-SSD/synthetic/desktop',ownerReady);disposers.push(result.dispose);return{owner,...result};
}
it('creates only a sandboxed separate native root with narrow preload, no focus/reveal, and rejects navigation escapes',async()=>{
 const f=fixture(),contents=f.view.webContents,root=contents.mainFrame;
 expect((f.view as any).options.webPreferences).toMatchObject({preload:'/Volumes/My-SSD/synthetic/desktop/out/preload/editor-host.cjs',sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,nodeIntegrationInWorker:false,webSecurity:true,additionalArguments:['--botling-editor-host=1']});
 expect(nativeEditorNavigation(contents,{isMainFrame:true,url:EDITOR_URL})).toBe(true);await f.ready;
 expect(f.owner.show).not.toHaveBeenCalled();expect(f.owner.focus).not.toHaveBeenCalled();expect(nativeEditorNavigation(contents,{isMainFrame:true,url:EDITOR_URL})).toBe(false);
 expect(nativeEditorNavigation(contents,{isMainFrame:false,url:'botling-card://card/synthetic',frame:{parent:root} as any,initiator:root})).toBe(true);
 expect(nativeEditorNavigation(contents,{isMainFrame:false,url:'botling-card://preview/synthetic',frame:{parent:{parent:root,url:'botling-card://page/synthetic'}} as any})).toBe(true);
 for(const url of ['app://botling/index.html','https://example.invalid','file:///synthetic','botling-chat://chat/chat.html'])expect(nativeEditorNavigation(contents,{isMainFrame:false,url,frame:{parent:root} as any,initiator:root})).toBe(false);
});
it('main relay and layout authenticate the exact shell/editor roots; plugin messages cannot move or privilege the view',async()=>{
 const f=fixture(),stamp=await f.ready,contents=f.view.webContents,bounds={x:200,y:60,width:600,height:600},layout=(f.view as any).setBounds;layout.mockClear();
 ipcMain.emit(EDITOR_CHANNEL.layout,{sender:contents,senderFrame:contents.mainFrame},{stamp,bounds});expect(layout).not.toHaveBeenCalled();
 ipcMain.emit(EDITOR_CHANNEL.layout,{sender:f.owner.webContents,senderFrame:f.owner.webContents.mainFrame},{stamp,bounds});expect(layout).toHaveBeenCalledExactlyOnceWith(bounds);
 ipcMain.emit(EDITOR_CHANNEL.layout,{sender:f.owner.webContents,senderFrame:f.owner.webContents.mainFrame},{stamp,bounds:{x:0,y:0,width:5000,height:5000}});expect(layout).toHaveBeenCalledTimes(1);
 f.owner.webContents.send.mockClear();ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp,message:{botling:'request',id:1,cmd:{type:'accounts.list'}}});expect(f.owner.webContents.send).not.toHaveBeenCalled();
 ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp,message:{botling:'stop'}});expect(f.owner.webContents.send).toHaveBeenCalledExactlyOnceWith(EDITOR_CHANNEL.shell,{stamp,message:{botling:'stop'}});
});
it('shell document reload rotates authentication while retaining the native editor view and load',async()=>{
 const f=fixture(),first=await f.ready,contents=f.view.webContents;
 f.owner.isVisible=()=>true;
 (contents as any).isFocused.mockReturnValue(true);
 f.owner.webContents.emit('did-start-navigation',{isMainFrame:true});f.owner.webContents.mainFrame={url:'app://botling/index.html',parent:null};f.owner.webContents.emit('did-finish-load');
 expect(f.owner.webContents.focus).toHaveBeenCalledTimes(1);
 const bound=f.owner.webContents.send.mock.calls.filter(c=>c[0]===EDITOR_CHANNEL.bound).at(-1)![1];expect(bound.surfaceId).toBe(first.surfaceId);expect(bound.documentGeneration).not.toBe(first.documentGeneration);expect(f.owner.contentView.addChildView).toHaveBeenCalledTimes(1);expect(contents.loadURL).toHaveBeenCalledTimes(1);
 f.owner.webContents.send.mockClear();ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp:first,message:{botling:'stop'}});expect(f.owner.webContents.send).not.toHaveBeenCalled();
 ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp:bound,message:{botling:'stop'}});expect(f.owner.webContents.send).toHaveBeenCalledTimes(1);
 f.dispose();expect(f.owner.webContents.send).toHaveBeenLastCalledWith(EDITOR_CHANNEL.unbound,bound);expect(f.owner.contentView.removeChildView).toHaveBeenCalledTimes(1);expect(contents.isDestroyed()).toBe(true);expect(nativeEditorNavigation(contents,{isMainFrame:true,url:EDITOR_URL})).toBeNull();
});

it('keeps the opening window hidden until both the native editor state and its layout are ready', async () => {
 const f=fixture(),stamp=await f.ready,contents=f.view.webContents;
 const order:string[]=[];
 (contents as any).focus=vi.fn(()=>order.push('editor.focus'));
 f.owner.show.mockImplementation(()=>order.push('window.show'));
 const reveal=(f as any).revealWhenReady(false);
 await Promise.resolve();
 expect(order).toEqual([]);
 ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp,message:{botling:'hostObservation',chatId:'main',revision:1,intentEpoch:0}});
 await Promise.resolve();
 expect(order).toEqual([]);
 ipcMain.emit(EDITOR_CHANNEL.layout,{sender:f.owner.webContents,senderFrame:f.owner.webContents.mainFrame},{stamp,bounds:{x:200,y:60,width:600,height:600}});
 await reveal;
 expect(order).toEqual(['editor.focus','window.show','editor.focus']);
 ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp,message:{botling:'hostObservation',chatId:'main',revision:2,intentEpoch:0}});
 expect(order).toHaveLength(3);
});


it.each(['hidden','closed'])('never reveals or focuses an opening owner that is %s',async mode=>{
 const f=fixture(),stamp=await f.ready,contents=f.view.webContents;
 const reveal=f.revealWhenReady(mode==='hidden');
 if(mode==='closed'){f.owner.isDestroyed=()=>true;f.dispose();}
 else{
  ipcMain.emit(EDITOR_CHANNEL.layout,{sender:f.owner.webContents,senderFrame:f.owner.webContents.mainFrame},{stamp,bounds:{x:200,y:60,width:600,height:600}});
  ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp,message:{botling:'hostObservation',chatId:'main',revision:1,intentEpoch:0}});
 }
 await reveal;
 expect(f.owner.show).not.toHaveBeenCalled();expect((contents as any).focus).not.toHaveBeenCalled();
});

it('does not accept forged readiness; hiding moves native focus to the shell without recreating the editor',async()=>{
 const f=fixture(),stamp=await f.ready,contents=f.view.webContents;
 const reveal=f.revealWhenReady(false);
 const shellEvent={sender:f.owner.webContents,senderFrame:f.owner.webContents.mainFrame};
 ipcMain.emit(EDITOR_CHANNEL.layout,shellEvent,{stamp,bounds:{x:200,y:60,width:600,height:600}});
 ipcMain.emit(EDITOR_CHANNEL.up,shellEvent,{stamp,message:{botling:'hostObservation',chatId:'main',revision:1,intentEpoch:0}});
 await Promise.resolve();expect(f.owner.show).not.toHaveBeenCalled();
 ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp,message:{botling:'hostObservation',chatId:'main',revision:1,intentEpoch:0}});
 await reveal;
 f.owner.isVisible=()=>true;
 (contents as any).isFocused.mockReturnValue(true);
 ipcMain.emit(EDITOR_CHANNEL.layout,shellEvent,{stamp,bounds:null});
 expect(f.owner.webContents.focus).toHaveBeenCalledTimes(1);
 expect((f.view as any).setBounds).toHaveBeenLastCalledWith({x:0,y:0,width:0,height:0});
 ipcMain.emit(EDITOR_CHANNEL.down,shellEvent,{stamp,message:{botling:'focus'}});
 expect((contents as any).focus).toHaveBeenCalledTimes(2); // Hidden view refuses explicit focus too.
 expect(contents.loadURL).toHaveBeenCalledTimes(1);
 f.owner.isVisible=()=>true;
 ipcMain.emit(EDITOR_CHANNEL.layout,shellEvent,{stamp,bounds:{x:200,y:60,width:600,height:600}});
 ipcMain.emit(EDITOR_CHANNEL.down,{sender:contents,senderFrame:contents.mainFrame},{stamp,message:{botling:'focus'}});
 expect((contents as any).focus).toHaveBeenCalledTimes(2);
 ipcMain.emit(EDITOR_CHANNEL.down,shellEvent,{stamp,message:{botling:'focus'}});
 expect((contents as any).focus).toHaveBeenCalledTimes(3);
 expect(contents.send).toHaveBeenLastCalledWith(EDITOR_CHANNEL.down,{stamp,message:{botling:'focus'}});
});


it.each(['snapshot','boot','disposed'])('reveals a usable shell within 3s when %s prevents native readiness',async mode=>{
 vi.useFakeTimers();
 try{
  const f=fixture(mode==='boot'?new Promise(()=>{}):Promise.resolve());
  const shown=f.revealWhenReady(false);
  if(mode==='disposed')f.dispose();
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.owner.show).toHaveBeenCalledTimes(1);
  expect(await shown).toBe(true);
  expect((f.view.webContents as any).focus).not.toHaveBeenCalled();
 }finally{vi.useRealTimers();}
});


it('keeps chat pixels underneath any registered overlay and rejects late or forged decoded-snapshot ACKs',async()=>{
 const f=fixture(),stamp=await f.ready,contents=f.view.webContents;
 const event={sender:f.owner.webContents,senderFrame:f.owner.webContents.mainFrame};
 const bounds={x:200,y:60,width:600,height:600};
 ipcMain.emit(EDITOR_CHANNEL.layout,event,{stamp,bounds});
 const visibility=(f.view as any).setVisible;visibility.mockClear();
 ipcMain.emit(EDITOR_CHANNEL.layout,event,{stamp,bounds,occluded:true});
 await Promise.resolve();
 expect((contents as any).capturePage).toHaveBeenCalledWith(undefined,{stayHidden:true,stayAwake:false});
 expect(visibility).not.toHaveBeenCalled();
 const captured=f.owner.webContents.send.mock.calls.filter(c=>c[0]===EDITOR_CHANNEL.snapshot).at(-1)![1];
 expect(captured.image).toBe('data:image/png;base64,AA==');
 ipcMain.emit(EDITOR_CHANNEL.layout,{sender:contents,senderFrame:contents.mainFrame},{stamp,snapshotReady:captured.revision});
 expect(visibility).not.toHaveBeenCalled();
 ipcMain.emit(EDITOR_CHANNEL.layout,event,{stamp,snapshotReady:captured.revision});
 expect(visibility).toHaveBeenLastCalledWith(false);
 ipcMain.emit(EDITOR_CHANNEL.layout,event,{stamp,bounds});
 expect(visibility).toHaveBeenLastCalledWith(true);
 const calls=visibility.mock.calls.length;
 ipcMain.emit(EDITOR_CHANNEL.layout,event,{stamp,snapshotReady:captured.revision});
 expect(visibility).toHaveBeenCalledTimes(calls);
 expect(contents.loadURL).toHaveBeenCalledTimes(1);
});

function snapshotFixture(){
 const pending=fixture();
 return pending.ready.then(stamp=>{
  const contents=pending.view.webContents;
  const event={sender:pending.owner.webContents,senderFrame:pending.owner.webContents.mainFrame};
  const bounds={x:200,y:60,width:600,height:600};
  const layout=(extra:object={})=>ipcMain.emit(EDITOR_CHANNEL.layout,event,{stamp,bounds,occluded:true,...extra});
  const observe=(revision:number)=>ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp,message:{botling:'hostObservation',chatId:'main',intentEpoch:0,revision}});
  return{...pending,stamp,event,bounds,layout,observe,capture:vi.mocked(contents.capturePage),
   snapshots:()=>pending.owner.webContents.send.mock.calls.filter(c=>c[0]===EDITOR_CHANNEL.snapshot&&c[1].image)};
 });
}

it('captures a static covered chat only once, ignoring duplicate layout and unauthenticated invalidations',async()=>{
 vi.useFakeTimers();
 try{
  const f=await snapshotFixture();f.layout();await vi.advanceTimersByTimeAsync(10_000);
  expect(f.capture).toHaveBeenCalledTimes(1);
  f.layout();
  ipcMain.emit(EDITOR_CHANNEL.up,f.event,{stamp:f.stamp,message:{botling:'hostObservation',chatId:'main',intentEpoch:0,revision:2}});
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.capture).toHaveBeenCalledTimes(1);expect(f.snapshots()).toHaveLength(1);
 }finally{vi.useRealTimers();}
});

it('coalesces applied chat state and changed layout at most once per second, including rapid covers',async()=>{
 vi.useFakeTimers();
 try{
  const f=await snapshotFixture();f.layout();await vi.advanceTimersByTimeAsync(100);
  for(let revision=1;revision<=20;revision++)f.observe(revision);
  const changed={...f.bounds,width:590};f.layout({bounds:changed});
  await vi.advanceTimersByTimeAsync(899);expect(f.capture).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);expect(f.capture).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(100);f.layout({bounds:changed,occluded:false});f.layout({bounds:changed});
  await vi.advanceTimersByTimeAsync(899);expect(f.capture).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);expect(f.capture).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(5000);expect(f.capture).toHaveBeenCalledTimes(3);
  f.layout({bounds:{...changed,x:210}});await vi.advanceTimersByTimeAsync(0);
  expect(f.capture).toHaveBeenCalledTimes(4);
 }finally{vi.useRealTimers();}
});

it('never overlaps captures and drops stale in-flight pixels before capturing the latest state',async()=>{
 vi.useFakeTimers();
 try{
  const f=await snapshotFixture();let finish!:(image:any)=>void;
  f.capture.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  f.layout();f.observe(1);f.layout({bounds:{...f.bounds,width:590}});
  f.layout({occluded:false});f.layout(); // A fresh cover must not accept the old capture.
  await vi.advanceTimersByTimeAsync(1500);expect(f.capture).toHaveBeenCalledTimes(1);
  finish({isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,stale'});
  await vi.advanceTimersByTimeAsync(0);
  expect(f.capture).toHaveBeenCalledTimes(2);
  expect(f.snapshots().map(c=>c[1].image)).toEqual(['data:image/png;base64,AA==']);
  await vi.advanceTimersByTimeAsync(5000);expect(f.capture).toHaveBeenCalledTimes(2);
 }finally{vi.useRealTimers();}
});

it.each(['restore','reload','dispose'])('cancels deferred snapshot work on %s',async mode=>{
 vi.useFakeTimers();
 try{
  const f=await snapshotFixture();f.layout();await vi.advanceTimersByTimeAsync(100);f.observe(1);
  if(mode==='restore')f.layout({occluded:false});
  if(mode==='reload')f.owner.webContents.emit('did-start-navigation',{isMainFrame:true});
  if(mode==='dispose')f.dispose();
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.capture).toHaveBeenCalledTimes(1);expect(f.snapshots()).toHaveLength(1);
 }finally{vi.useRealTimers();}
});

it('does not poll after capture failure, and retries only on a later state change',async()=>{
 vi.useFakeTimers();
 try{
  const f=await snapshotFixture();f.capture.mockRejectedValueOnce(new Error('capture unavailable'));
  f.layout();await vi.advanceTimersByTimeAsync(5000);
  expect(f.capture).toHaveBeenCalledTimes(1);expect(f.snapshots()).toHaveLength(0);
  f.observe(1);await vi.advanceTimersByTimeAsync(0);
  expect(f.capture).toHaveBeenCalledTimes(2);expect(f.snapshots()).toHaveLength(1);
 }finally{vi.useRealTimers();}
});


it('shows captured pixels during continuous state updates while scheduling the next bounded refresh',async()=>{
 vi.useFakeTimers();
 try{
  const f=await snapshotFixture();let finish!:(image:any)=>void;
  f.capture.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  f.layout();
  for(let revision=1;revision<=5;revision++){await vi.advanceTimersByTimeAsync(100);f.observe(revision);}
  finish({isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,stream'});
  await vi.advanceTimersByTimeAsync(0);
  const captured=f.snapshots()[0][1];
  expect(captured.image).toBe('data:image/png;base64,stream');
  f.observe(6);
  ipcMain.emit(EDITOR_CHANNEL.layout,f.event,{stamp:f.stamp,snapshotReady:captured.revision});
  expect(f.view.setVisible).toHaveBeenLastCalledWith(false);
  await vi.advanceTimersByTimeAsync(499);expect(f.capture).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);expect(f.capture).toHaveBeenCalledTimes(2);
 }finally{vi.useRealTimers();}
});
it('disposes without touching a destroyed owner window when it closes',async()=>{
 const f=fixture(),stamp=await f.ready,ownerContents=f.owner.webContents;
 f.owner.isDestroyed=()=>true;Object.defineProperty(f.owner,'webContents',{get(){throw new TypeError('Object has been destroyed');}});
 expect(()=>f.owner.emit('closed')).not.toThrow();expect(ownerContents.send).toHaveBeenLastCalledWith(EDITOR_CHANNEL.unbound,stamp);expect(ownerContents.listenerCount('did-start-navigation')).toBe(0);expect(f.view.webContents.isDestroyed()).toBe(true);
});
it('scales layout from a zoomed-out shell into window coordinates',async()=>{
 const f=fixture(),stamp=await f.ready,layout=(f.view as any).setBounds;layout.mockClear();
 (f.owner.webContents as any).getZoomFactor=()=>1450/1740;(f.owner as any).getContentBounds=()=>({x:10,y:37,width:1450,height:909});
 ipcMain.emit(EDITOR_CHANNEL.layout,{sender:f.owner.webContents,senderFrame:f.owner.webContents.mainFrame},{stamp,bounds:{x:248,y:85,width:1436,height:1005}});
 expect(layout).toHaveBeenCalledExactlyOnceWith({x:207,y:71,width:1197,height:838});
 expect(editorBounds({x:0,y:0,width:1740,height:1091},{width:1450,height:909},1450/1740)).toEqual({x:0,y:0,width:1450,height:909});
 expect(editorBounds({x:0,y:0,width:1740,height:1091},{width:1450,height:909})).toBeNull();
});

it('reloads only the chat page: same view and layout, fresh authenticated document, old stamp refused',async()=>{
 const f=fixture(),first=await f.ready,contents=f.view.webContents;
 const shellEvent={sender:f.owner.webContents,senderFrame:f.owner.webContents.mainFrame},bounds={x:200,y:60,width:600,height:600};
 ipcMain.emit(EDITOR_CHANNEL.layout,shellEvent,{stamp:first,bounds});
 const setBounds=(f.view as any).setBounds;setBounds.mockClear();f.owner.webContents.send.mockClear();
 const reloading=reloadNativeEditor(f.owner.webContents as any);
 // The shell learns at once that the old document is gone, so it stops posting to it.
 expect(f.owner.webContents.send).toHaveBeenCalledWith(EDITOR_CHANNEL.unbound,first);
 // The reload's own navigation is allowed and does not dispose the view.
 expect(nativeEditorNavigation(contents,{isMainFrame:true,url:EDITOR_URL})).toBe(true);
 expect(nativeEditorNavigation(contents,{isMainFrame:true,url:'https://example.invalid'})).toBe(false);
 contents.emit('did-start-navigation',{isMainFrame:true});
 expect(await reloading).toBe(true);
 expect(contents.loadURL).toHaveBeenCalledTimes(2);expect(contents.loadURL).toHaveBeenLastCalledWith(EDITOR_URL);
 expect(contents.isDestroyed()).toBe(false);expect(f.owner.contentView.removeChildView).not.toHaveBeenCalled();expect(f.owner.contentView.addChildView).toHaveBeenCalledTimes(1);
 expect(setBounds).not.toHaveBeenCalledWith({x:0,y:0,width:0,height:0});
 const bound=f.owner.webContents.send.mock.calls.filter(c=>c[0]===EDITOR_CHANNEL.bound).at(-1)![1];
 expect(bound.surfaceId).toBe(first.surfaceId);expect(bound.documentGeneration).not.toBe(first.documentGeneration);
 expect(contents.send).toHaveBeenLastCalledWith(EDITOR_CHANNEL.bound,bound);
 f.owner.webContents.send.mockClear();
 ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp:first,message:{botling:'stop'}});expect(f.owner.webContents.send).not.toHaveBeenCalled();
 ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp:bound,message:{botling:'stop'}});expect(f.owner.webContents.send).toHaveBeenCalledTimes(1);
 // After the reload, an unrequested navigation still disposes the editor as before.
 expect(nativeEditorNavigation(contents,{isMainFrame:true,url:EDITOR_URL})).toBe(false);
});

it('a chat page reload of an unknown, closed or mid-reload owner is refused or shared, never a second view',async()=>{
 const stranger=new EventEmitter() as any;expect(await reloadNativeEditor(stranger)).toBe(false);
 const f=fixture();await f.ready;
 const one=reloadNativeEditor(f.owner.webContents as any),two=reloadNativeEditor(f.owner.webContents as any);
 expect(await one).toBe(true);expect(await two).toBe(true);expect(f.view.webContents.loadURL).toHaveBeenCalledTimes(2);
 f.dispose();expect(await reloadNativeEditor(f.owner.webContents as any)).toBe(false);
});

it('a failed chat page load disposes the editor instead of leaving a dead view bound',async()=>{
 const f=fixture();await f.ready;const contents=f.view.webContents as any;
 contents.loadURL.mockRejectedValueOnce(new Error('ERR_FILE_NOT_FOUND'));
 expect(await reloadNativeEditor(f.owner.webContents as any)).toBe(false);
 expect(contents.isDestroyed()).toBe(true);expect(f.owner.contentView.removeChildView).toHaveBeenCalledTimes(1);
});

it('loads the editor preload from a chosen developer preload directory',async()=>{
 const contents=Object.assign(new EventEmitter(),{id:1,mainFrame:{url:'app://botling/index.html',parent:null},isDestroyed:()=>false,send:vi.fn(),focus:vi.fn(),getZoomFactor:()=>1});
 const owner=Object.assign(new EventEmitter(),{webContents:contents,isVisible:()=>false,isDestroyed:()=>false,getContentBounds:()=>({x:0,y:0,width:1120,height:820}),contentView:{addChildView:vi.fn(),removeChildView:vi.fn()},focus:vi.fn(),show:vi.fn()});
 const result=prepareNativeEditorHost(owner as any,'/Volumes/My-SSD/synthetic/desktop',Promise.resolve(),'/Volumes/My-SSD/synthetic/dev-preload');disposers.push(result.dispose);
 expect((result.view as any).options.webPreferences.preload).toBe('/Volumes/My-SSD/synthetic/dev-preload/editor-host.cjs');
 await result.ready;
});
it('offers the chat view to a window picture only while it is laid out and uncovered',async()=>{
 const f=fixture(),stamp=await f.ready,contents=f.view.webContents,owner=f.owner.webContents,event={sender:owner,senderFrame:owner.mainFrame},bounds={x:248,y:86,width:600,height:600};
 expect(nativeEditorLayer(owner as any)).toBeNull();
 ipcMain.emit(EDITOR_CHANNEL.layout,event,{stamp,bounds});
 const layer=nativeEditorLayer(owner as any)!;expect(layer.bounds).toEqual(bounds);
 await layer.capture();expect((contents as any).capturePage).toHaveBeenLastCalledWith(undefined,{stayHidden:true,stayAwake:false});
 ipcMain.emit(EDITOR_CHANNEL.layout,event,{stamp,bounds,occluded:true});expect(nativeEditorLayer(owner as any)).toBeNull();
 ipcMain.emit(EDITOR_CHANNEL.layout,event,{stamp,bounds});expect(nativeEditorLayer(owner as any)).not.toBeNull();
 ipcMain.emit(EDITOR_CHANNEL.layout,event,{stamp,bounds:null});expect(nativeEditorLayer(owner as any)).toBeNull();
 ipcMain.emit(EDITOR_CHANNEL.layout,event,{stamp,bounds});f.dispose();expect(nativeEditorLayer(owner as any)).toBeNull();
});

it('reveals Quick settings immediately despite a pending capture and restores chat on close',async()=>{
 vi.useFakeTimers();
 try{
  const f=await snapshotFixture();let finish!:(image:any)=>void;
  f.layout({occluded:false});
  f.capture.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const visibility=vi.mocked(f.view.setVisible);visibility.mockClear();
  const started=Date.now();
  f.layout({revealImmediately:true});
  expect(visibility).toHaveBeenLastCalledWith(false);
  expect(Date.now()-started).toBe(0);
  await vi.advanceTimersByTimeAsync(500);
  f.layout({occluded:false});
  expect(visibility).toHaveBeenLastCalledWith(true);
  finish({isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,AA=='});
  await vi.advanceTimersByTimeAsync(0);
  expect(f.snapshots()).toHaveLength(0);
  visibility.mockClear();
  f.layout({revealImmediately:true});
  expect(visibility).toHaveBeenLastCalledWith(false);
  expect(f.capture).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(f.capture).toHaveBeenCalledTimes(2);
  expect(f.snapshots()).toHaveLength(1);
 }finally{vi.useRealTimers();}
});

it.each([false,true])('measures cover handoff with a 500ms capture and 50ms decode (immediate=%s)',async revealImmediately=>{
 vi.useFakeTimers();
 try{
  const f=await snapshotFixture();
  f.layout({occluded:false});
  f.capture.mockImplementation(()=>new Promise(resolve=>setTimeout(()=>resolve({isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,AA=='} as any),500)));
  const started=Date.now();let revealedAt:number|undefined;
  vi.mocked(f.view.setVisible).mockImplementation(visible=>{if(!visible&&revealedAt===undefined)revealedAt=Date.now()-started;});
  f.layout({revealImmediately});
  await vi.advanceTimersByTimeAsync(500);
  const captured=f.snapshots()[0][1];
  await vi.advanceTimersByTimeAsync(50);
  ipcMain.emit(EDITOR_CHANNEL.layout,f.event,{stamp:f.stamp,snapshotReady:captured.revision});
  expect(revealedAt).toBe(revealImmediately?0:550);
 }finally{vi.useRealTimers();}
});

it('keeps Quick settings revealed after capture failure and rejects forged immediate reveal',async()=>{
 const f=await snapshotFixture();f.layout({occluded:false});
 const visibility=vi.mocked(f.view.setVisible);visibility.mockClear();
 ipcMain.emit(EDITOR_CHANNEL.layout,{sender:f.view.webContents,senderFrame:f.view.webContents.mainFrame},{stamp:f.stamp,bounds:f.bounds,occluded:true,revealImmediately:true});
 expect(visibility).not.toHaveBeenCalled();
 f.capture.mockRejectedValueOnce(new Error('capture unavailable'));
 f.owner.isVisible=()=>true;
 vi.mocked(f.view.webContents.isFocused).mockReturnValue(true);
 f.layout({revealImmediately:true});await Promise.resolve();
 expect(visibility).toHaveBeenLastCalledWith(false);
 expect(f.owner.webContents.focus).toHaveBeenCalledOnce();
 expect(f.snapshots()).toHaveLength(0);
 f.layout({occluded:false});
 expect(visibility).toHaveBeenLastCalledWith(true);
});
