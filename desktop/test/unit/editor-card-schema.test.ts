import {expect,it} from 'vitest';
import {Command,CARD_SAVE_LIMIT} from '../../src/contract';
import {editorMessageAllowed} from '../../src/editor-host-wire';
const save={type:'card.save',botId:'B',messageId:'m',cardId:'c',data:''};
const action={type:'card.action',botId:'B',messageId:'m',cardId:'c',name:'doThing.v2',value:''};
function check(cmd:unknown,accepted:boolean){
 expect(Command.safeParse(cmd).success).toBe(accepted);
 expect(editorMessageAllowed('up',{botling:'request',id:0,cmd})).toBe(accepted);
}
it('preserves card validation at ID, payload, action name and strict object boundaries',()=>{
 for(const valid of [save,action,{...save,data:'x'.repeat(CARD_SAVE_LIMIT)},{...action,value:'x'.repeat(4000)},{...action,name:'a'.repeat(64)}])check(valid,true);
 for(const base of [save,action]){
  for(const key of ['botId','messageId','cardId']){
   for(const value of ['',null,7,'../file','a/b','a b','a'.repeat(65)])check({...base,[key]:value},false);
   check({...base,[key]:'A_.:-9'},true);
   check({...base,[key]:'a'.repeat(64)},true);
   const missing:Record<string,unknown>={...base};delete missing[key];check(missing,false);
  }
  check({...base,extra:true},false);
 }
 for(const data of [null,{},1,'x'.repeat(CARD_SAVE_LIMIT+1)])check({...save,data},false);
 for(const name of ['', 'Upper','a-b','a_b','../x','a'.repeat(65),null])check({...action,name},false);
 for(const value of [null,{},1,'x'.repeat(4001)])check({...action,value},false);
 for(const cmd of [null,[],{},'card.save',{...save,type:'card.unknown'}])check(cmd,false);
});
it('keeps envelope restrictions and rejects valid unrelated commands',()=>{
 for(const id of [-1,0.5,Number.MAX_SAFE_INTEGER+1,'1',null])expect(editorMessageAllowed('up',{botling:'request',id,cmd:save})).toBe(false);
 for(const cmd of [{type:'accounts.list'},{type:'card.html',botId:'B',messageId:'m',cardId:'c'}]){
  expect(Command.safeParse(cmd).success).toBe(true);
  expect(editorMessageAllowed('up',{botling:'request',id:1,cmd})).toBe(false);
 }
 expect(editorMessageAllowed('up',{botling:'request',id:1,cmd:save,padding:'x'.repeat(1024*1024)})).toBe(false);
});
