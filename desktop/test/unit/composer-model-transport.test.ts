// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
const wire=vi.hoisted(()=>({receive:[] as ((message:any)=>void)[],sent:[] as any[]}));
vi.mock('../../src/renderer/chat-frame/transport',()=>({toShell:(m:any)=>{wire.sent.push(m);return true;},fromShell:(f:any)=>wire.receive.push(f),onTransportDisconnect:()=>{}}));
import '../../src/renderer/chat-frame/composer-transport';
import {composerHost} from '../../../Web/src/composer-host';
import {editorMessageAllowed} from '../../src/editor-host-wire';
const settings={botId:'A',engines:['claude','codex','agy'],model:null,codexModel:null,agyModel:null,effort:null};
const respond=(value:any)=>wire.receive.forEach(f=>f(value));
it('routes model catalog and acknowledged per-engine saves through the native editor wire',async()=>{
 const read=composerHost!.modelSettings!('A');
 let action=wire.sent.at(-1).action;expect(action).toMatchObject({type:'composerModels',botID:'A',operation:'settings'});
 const packet={botling:'composerModelsResult',requestID:action.requestID,value:settings};expect(editorMessageAllowed('down',packet)).toBe(true);respond(packet);expect(await read).toEqual(settings);
 const discovery=composerHost!.modelCatalog!('A','codex');action=wire.sent.at(-1).action;expect(action).toMatchObject({operation:'catalog',value:'codex'});
 const catalog={status:'ready',message:'',models:[{id:'from-runtime',name:'Runtime display name',isDefault:true,efforts:['low','high']}]};
 const reply={...packet,requestID:action.requestID,value:catalog};expect(editorMessageAllowed('down',reply)).toBe(true);respond(reply);expect(await discovery).toEqual(catalog);
 const save=composerHost!.configureModels!('A',{codexModel:'from-runtime'});action=wire.sent.at(-1).action;
 expect(action).toMatchObject({operation:'save',value:{codexModel:'from-runtime'}});
 respond({...packet,requestID:action.requestID,value:{...settings,codexModel:'from-runtime'}});expect(await save).toMatchObject({codexModel:'from-runtime'});
});
it('rejects malformed native results and propagates save failures',async()=>{
 expect(editorMessageAllowed('down',{botling:'composerModelsResult',requestID:1,value:{...settings,engines:['invented']}})).toBe(false);
 expect(editorMessageAllowed('down',{botling:'composerModelsResult',requestID:1,value:{models:[{id:2}],status:'ready',message:''}})).toBe(false);
 const save=composerHost!.configureModels!('A',{effort:'high'});const requestID=wire.sent.at(-1).action.requestID;
 const failed=expect(save).rejects.toThrow('Save rejected');respond({botling:'composerModelsResult',requestID,error:'Save rejected'});await failed;
});
