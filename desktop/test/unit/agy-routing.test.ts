import {expect,it} from 'vitest';
import {makeHeads,headsFor,otherHead,Conductor,parseHeadTags} from '../../src/core/heads';
import {botPrompts} from '../../src/core/prompts';
import {mainProfile} from '../../src/core/store/workspace';
it('routes each supported mixed pair explicitly, never through an implicit Claude fallback',()=>{
 for(const engine of ['codex','claude'] as const){
  const h=makeHeads([engine,'agy']);expect(headsFor(h,'both')).toEqual([engine,'agy']);expect(otherHead('agy',h)).toBe(engine);expect(otherHead(engine,h)).toBe('agy');
  const conductor=new Conductor(h);conductor.userMessage('test');const tag=parseHeadTags(`<handoff to="${engine}" kind="review">check</handoff>`).handoff;
  expect(conductor.replied('agy','report',tag,false,null).some(a=>a.type==='ask'&&a.head===engine)).toBe(true);
  const prompt=botPrompts({profile:mainProfile('/tmp/unused-agy-routing'),engine:'agy',heads:h});expect(prompt.headsRule).toContain(`to="${engine}"`);
 }
});
