import {expect,it} from 'vitest';
import {makeHeads,headsFor,readHeads} from '../../src/core/heads';
it('preserves mixed configurations and routes legacy Both to the saved primary only',()=>{
 for(const engine of ['codex','claude'] as const){
  const heads=readHeads({engines:[engine,'agy'],answerWith:'both'},engine);
  expect(heads.engines).toContain(engine);expect(heads.engines).toContain('agy');
  expect(headsFor(heads,'both')).toEqual([engine]);
 }
 expect(makeHeads(['claude','codex','agy']).engines).toEqual(['claude','codex','agy']);
});
