// A pasted or dropped picture is read by the chat page (in the native editor host) and handed to the
// shell as an `addFileData` action. A real screenshot is megabytes of base64, far over the editor
// wire's 1 MB cap for other messages, so that cap must not swallow it.
import {expect,it,vi} from 'vitest';
import {EditorHostBoundary,type EditorContents} from '../../src/main/editor-host-boundary';
import {EDITOR_URL,EDITOR_CHANNEL,editorMessageAllowed} from '../../src/editor-host-wire';
import {editorBridge} from '../../src/preload/editor-bridge';
import {FILE_DATA_LIMIT} from '../../src/contract';

const fileData=(bytes:number)=>({botling:'action',linkSource:'component',action:{type:'addFileData',name:'Pasted image.png',base64:'A'.repeat(bytes)}});
const peer=(id:number,url:string):EditorContents=>({id,mainFrame:{url},isDestroyed:()=>false});

it('lets a screenshot-sized pasted or dropped file through the editor wire',()=>{
 const screenshot=fileData(3*1024*1024);
 expect(editorMessageAllowed('up',screenshot)).toBe(true);
 const shell=peer(1,'app://botling/index.html'),editor=peer(2,EDITOR_URL),boundary=new EditorHostBoundary(),stamp=boundary.bind(shell,editor);
 expect(boundary.route('up',{sender:editor,senderFrame:editor.mainFrame},{stamp,message:screenshot})?.recipient).toBe(shell);
 const callbacks=new Map<string,Function>(),send=vi.fn(),bridge=editorBridge({on:(channel,fn)=>callbacks.set(channel,fn),send},'editor');
 callbacks.get(EDITOR_CHANNEL.bound)!({},stamp);
 expect(bridge.post(screenshot)).toBe(true);expect(send).toHaveBeenCalledExactlyOnceWith(EDITOR_CHANNEL.up,{stamp,message:screenshot});
 // The shell's side of the bridge accepts it too.
 const shellCallbacks=new Map<string,Function>(),shellBridge=editorBridge({on:(channel,fn)=>shellCallbacks.set(channel,fn),send:vi.fn()},'shell'),received=vi.fn();
 shellCallbacks.get(EDITOR_CHANNEL.bound)!({},stamp);shellBridge.subscribe(received);
 shellCallbacks.get(EDITOR_CHANNEL.shell)!({},{stamp,message:screenshot});
 expect(received.mock.calls.at(-1)![0]).toEqual({stamp,message:screenshot});
});

it('still bounds file data by the contract limit, and other actions by the 1 MB cap',()=>{
 expect(editorMessageAllowed('up',fileData(FILE_DATA_LIMIT))).toBe(true);
 expect(editorMessageAllowed('up',fileData(FILE_DATA_LIMIT+1))).toBe(false);
 expect(editorMessageAllowed('up',{botling:'action',action:{type:'addFileData',name:'a.png',base64:'A',extra:'x'.repeat(2*1024*1024)}})).toBe(false);
 expect(editorMessageAllowed('up',{botling:'action',action:{type:'send',text:'x'.repeat(2*1024*1024)}})).toBe(false);
});
