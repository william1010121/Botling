import {expect,it} from 'vitest';
import {Bot} from '../../src/core/bot';
const peer=(engine:string)=>({engine,readOnly:false,head:null,turn:{open:true,origin:'user',id:engine+'-turn',userId:engine+'-user',reply:{text:'Working'},steps:[]},queue:[],approvals:new Map(),subagents:{running:[]},session:{started:true,sessionId:engine+'-original'}});
it('restart checkpoint includes every engine peer with shared owner and distinct session/task correlation',()=>{
 const claude=peer('claude'),codex=peer('codex'),agy=peer('agy');
 const owner={...claude,owner:{id:'original-chat'},partner:codex,peers:[codex,agy]};
 const entries=Bot.prototype.restartEntries.call(owner as unknown as Bot);
 expect(entries.map(e=>[e.botId,e.engine,e.sessionId,e.turnId])).toEqual([
  ['original-chat','claude','claude-original','claude-turn'],['original-chat','codex','codex-original','codex-turn'],['original-chat','agy','agy-original','agy-turn']]);
});
