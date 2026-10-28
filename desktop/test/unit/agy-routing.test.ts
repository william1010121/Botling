import {expect,it} from 'vitest';
import {makeHeads,headsFor,readHeads} from '../../src/core/heads';
it('gates mixed agy routing including saved configurations without launching another engine',()=>{
 for(const engine of ['codex','claude'] as const){
  expect(headsFor(makeHeads([engine,'agy']),'both')).toEqual(['agy']);
  expect(readHeads({engines:[engine,'agy'],answerWith:'both'},engine).engines).toEqual(['agy']);
 }
 expect(makeHeads(['claude','codex']).engines).toEqual(['claude','codex']);
});
