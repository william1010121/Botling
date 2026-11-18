import {expect,it} from 'vitest';
import {makeHeads,readHeads,headsFor,targets} from '../../src/core/heads';
import {headsParts} from '../../src/renderer/payload';
it('offers only explicit primary recipients, without Both',()=>{
 const heads=makeHeads(['claude','codex'],'codex');
 expect(targets(heads)).toEqual(['claude','codex']);
 expect(headsParts({...heads,rounds:null,handoffs:[]} as any).answerWith?.options.map(x=>x.id)).toEqual(['claude','codex']);
});
it('migrates legacy Both to saved engine, keeping explicit choices and settings',()=>{
 const raw={engines:['claude','codex'],answerWith:'both',handoffs:false,codexModel:'saved'};
 const migrated=readHeads(raw,'codex');
 expect(migrated.answerWith).toBe('codex');expect(migrated.handoffs).toBe(false);expect(migrated.codexModel).toBe('saved');
 expect(readHeads({...raw,answerWith:'claude'},'codex').answerWith).toBe('claude');
 expect(headsFor(migrated,'both')).toEqual(['codex']);
});
it('a one-head bot (no HeadsView) still offers its engine, so the composer shows the model menu',()=>{
 expect(headsParts(null,['codex']).answerWith).toEqual({options:[{id:'codex',label:'Codex'}],chosen:'codex'});
 expect(headsParts(undefined,['claude'])).toEqual({answerWith:{options:[{id:'claude',label:'Claude'}],chosen:'claude'}});
 expect(headsParts(null,[])).toEqual({});
 // Two engines without a HeadsView (nothing to switch between yet): no one-head chip, never a guess at the first.
 expect(headsParts(null,['claude','codex'])).toEqual({});
 expect(headsParts(null)).toEqual({});
});
