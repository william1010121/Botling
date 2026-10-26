import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {EditorHostBoundary,type EditorContents} from '../../src/main/editor-host-boundary';
import {EDITOR_URL,EDITOR_ARGUMENT,EDITOR_CHANNEL,editorMessageAllowed,editorPreloadAllowed} from '../../src/editor-host-wire';
import {editorBridge} from '../../src/preload/editor-bridge';
const peer=(id:number,url:string):EditorContents=>({id,mainFrame:{url},isDestroyed:()=>false});
const shell=()=>peer(1,'app://botling/index.html'),editor=()=>peer(2,EDITOR_URL);
const message={botling:'request',id:1,cmd:{type:'card.save',botId:'6A0B0000-0000-4000-8000-000000000002',messageId:'0B07E11C-0000-4000-8000-00000000C0DE',cardId:'c-counter',data:'{"count":1}'}};
it('routes existing card saves and state only between the registered independent root documents',()=>{
 const boundary=new EditorHostBoundary(),a=shell(),b=editor(),stamp=boundary.bind(a,b);
 expect(boundary.route('up',{sender:b,senderFrame:b.mainFrame},{stamp,message})?.recipient).toBe(a);
 expect(boundary.route('down',{sender:a,senderFrame:a.mainFrame},{stamp,message:{botling:'state',state:{},extras:{}}})?.recipient).toBe(b);
});
it('a leaked stamp, same numeric id, copied URL or child frame cannot confer sender authority',()=>{
 const boundary=new EditorHostBoundary(),a=shell(),b=editor(),stamp=boundary.bind(a,b);
 for(const event of [{sender:peer(2,EDITOR_URL),senderFrame:b.mainFrame},{sender:b,senderFrame:{url:EDITOR_URL}},{sender:a,senderFrame:a.mainFrame},{sender:b,senderFrame:null}])expect(boundary.route('up',event,{stamp,message})).toBeNull();
 expect(boundary.route('up',{sender:b,senderFrame:b.mainFrame},{stamp:{...stamp,documentGeneration:'forged'},message})).toBeNull();
});
it('revokes on document identity, URL, owner lifetime or explicit close; old observations cannot revive it',()=>{
 const boundary=new EditorHostBoundary(),a=shell(),b=editor(),stamp=boundary.bind(a,b),event={sender:b,senderFrame:b.mainFrame};
 a.mainFrame={url:'app://botling/index.html'};expect(boundary.route('up',event,{stamp,message})).toBeNull();boundary.revoke(a);
 const fresh=boundary.bind(a,b,stamp.surfaceId);expect(fresh.surfaceId).toBe(stamp.surfaceId);expect(fresh.documentGeneration).not.toBe(stamp.documentGeneration);expect(boundary.route('up',event,{stamp,message})).toBeNull();
 b.mainFrame.url='https://example.invalid';expect(boundary.route('up',event,{stamp:fresh,message})).toBeNull();b.mainFrame.url=EDITOR_URL;a.isDestroyed=()=>true;expect(boundary.route('up',event,{stamp:fresh,message})).toBeNull();
});
it('does not bind a second editor, privileged/plugin shared document, wrong route or credentials',()=>{
 const boundary=new EditorHostBoundary(),a=shell(),b=editor();boundary.bind(a,b);expect(()=>boundary.bind(a,peer(3,EDITOR_URL))).toThrow(/already bound/);expect(()=>new EditorHostBoundary().bind(a,a)).toThrow();
 for(const url of ['app://botling/index.html','botling-chat://chat/chat.html','botling-chat://user@chat/chat.html?nativeHost=1','botling-chat://chat.evil/chat.html?nativeHost=1'])expect(()=>new EditorHostBoundary().bind(shell(),peer(4,url))).toThrow();
});
it.each(['settings.set','accounts.list','updates.restart','plugins.install'])('editor cannot inject core command %s',type=>{
 expect(editorMessageAllowed('up',{botling:'request',id:1,cmd:{type}})).toBe(false);expect(editorMessageAllowed('up',{v:10,id:'forged',cmd:{type}})).toBe(false);
});
it('contains no key/composition/recovery replay route, rejects malformed and oversized values',()=>{
 for(const botling of ['keydown','keyup','keypress','insertText','recoverFocus','focus','state','plugins'])expect(editorMessageAllowed('up',{botling})).toBe(false);
 for(const botling of ['recoverFocus','keydown','insertText'])expect(editorMessageAllowed('down',{botling})).toBe(false);
 expect(editorMessageAllowed('down',{botling:'focus'})).toBe(true);
 const cyclic:any={botling:'action',action:{type:'send'}};cyclic.self=cyclic;expect(editorMessageAllowed('up',cyclic)).toBe(false);expect(editorMessageAllowed('up',{botling:'page',id:1,html:'x'.repeat(1024*1024+1)})).toBe(false);
});
it('keeps existing action/link provenance as data for the unchanged shell/core authorization',()=>{
 const boundary=new EditorHostBoundary(),a=shell(),b=editor(),stamp=boundary.bind(a,b),action={botling:'action',linkSource:'component',linkMessageId:'own-reply',action:{type:'openExternal',url:'file:///synthetic/only'}};
 const result=boundary.route('up',{sender:b,senderFrame:b.mainFrame},{stamp,message:action});expect(result?.packet.message).toBe(action);expect(result?.recipient).toBe(a); // no openExternal/core call here
});
it('narrow bridge is inert before binding and sends no event object, arbitrary core IPC or trace sink',()=>{
 const callbacks=new Map<string,Function>(),send=vi.fn(),bridge=editorBridge({on:(channel,fn)=>callbacks.set(channel,fn),send},'editor'),stamp={surfaceId:'surface',documentGeneration:'document'};
 expect(bridge.post(message)).toBe(false);callbacks.get(EDITOR_CHANNEL.bound)!({secretEvent:'not forwarded'},stamp);
 const received=vi.fn();bridge.subscribe(received);expect(received.mock.calls[0][0]).toEqual({stamp,bound:true});expect(bridge.post(message)).toBe(true);expect(send).toHaveBeenCalledExactlyOnceWith(EDITOR_CHANNEL.up,{stamp,message});
 expect(bridge.layout({x:0,y:0,width:10,height:10})).toBe(false);expect(bridge.post({botling:'request',id:2,cmd:{type:'accounts.list'}})).toBe(false);expect(send).toHaveBeenCalledTimes(1);
 callbacks.get(EDITOR_CHANNEL.down)!({}, {stamp:{...stamp,documentGeneration:'old'},message:{botling:'state'}});expect(received).toHaveBeenCalledTimes(1);
 callbacks.get(EDITOR_CHANNEL.unbound)!({},stamp);expect(bridge.current()).toBeNull();expect(bridge.post(message)).toBe(false);expect(send).toHaveBeenCalledTimes(1);expect(received.mock.calls.at(-1)![0]).toEqual({stamp,unbound:true});
});
it('preload requires the exact native root, main frame and main-provided argument together',()=>{
 expect(editorPreloadAllowed(true,EDITOR_URL,[EDITOR_ARGUMENT])).toBe(true);
 for(const [main,url,args] of [[false,EDITOR_URL,[EDITOR_ARGUMENT]],[true,'app://botling/index.html',[EDITOR_ARGUMENT]],[true,EDITOR_URL,[]],[true,EDITOR_URL+'&extra=1',[EDITOR_ARGUMENT]]] as const)expect(editorPreloadAllowed(main,url,[...args])).toBe(false);
});
const mock=vi.hoisted(()=>({expose:vi.fn(),send:vi.fn(),on:vi.fn()}));
vi.mock('electron',()=>({contextBridge:{exposeInMainWorld:mock.expose},ipcRenderer:{send:mock.send,on:mock.on}}));
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();});afterEach(()=>vi.unstubAllGlobals());
it('actual native preload exposes only the narrow bridge, never window.botling or test trace',async()=>{
 vi.stubGlobal('process',{...process,isMainFrame:true,argv:[EDITOR_ARGUMENT,'--botling-test-trace=1']});vi.stubGlobal('location',{href:EDITOR_URL});await import('../../src/preload/editor-host');expect(mock.expose.mock.calls.map(call=>call[0])).toEqual(['botlingEditor']);
});
it('actual native preload exposes nothing if loaded into a card or foreign document',async()=>{
 vi.stubGlobal('process',{...process,isMainFrame:false,argv:[EDITOR_ARGUMENT]});vi.stubGlobal('location',{href:EDITOR_URL});await import('../../src/preload/editor-host');expect(mock.expose).not.toHaveBeenCalled();
});
