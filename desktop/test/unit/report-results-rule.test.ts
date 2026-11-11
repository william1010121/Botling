// Math, 2026-11-06 10:32: asked for a report, the Antigravity head handed off "Generate professional HTML report page
// ... Follow results rule: starts with <!doctype html><meta charset="utf-8">, styles inline", and only used ReportSpec
// once the user insisted. Its results rule said reports go into a hand-written single-file page, ahead of the report
// page rule that says never hand-written HTML: the head followed the first. With the report rule told, the results
// rule must send report pages its way, for the head and for the workers it briefs.
import {expect,it} from 'vitest';
import {botPrompts,desktopPrompts} from '../../src/core/prompts';
import {reportSections} from '../report-section';

const docs='/Users/x/Library/Application Support/Botling 2/core/plugin-guides/botling.report/skills/report/report-blocks.md';
const HAND_WRITTEN='go into one HTML page: a single file with its styles inline';

for(const engine of ['agy','codex','claude'] as const) it(`${engine}: the results rule sends report pages to ReportSpec, for the head and its workers`,()=>{
 const profile={name:'Math',role:'bot' as const,folder:'/Users/x/docs/Math',memoryPath:'.bot/memory.md',job:null};
 const prompts=desktopPrompts(botPrompts({profile,engine}),profile,engine,true,reportSections({command:"'/Applications/Botling 2.app/Contents/MacOS/Botling 2' --render-report",docs}));
 for(const text of [prompts.system,prompts.codexWorkerSystem]){
  const results=text.split('\n').find(line=>line.includes('Results meant for the user'))!;
  expect(results).toBeTruthy();
  expect(results).not.toContain(HAND_WRITTEN);
  expect(results).toContain('a report page as the report page rule says, never written by hand');
  expect(text).toContain(`read '${docs}'`);
 }
});

it('without the report plugin the results rule keeps the hand-written page wording (but still no .md results)',()=>{
 const profile={name:'Math',role:'bot' as const,folder:'/Users/x/docs/Math',memoryPath:'.bot/memory.md',job:null};
 const base=botPrompts({profile,engine:'agy'});
 expect(desktopPrompts(base,profile,'agy',true,reportSections(null)).system).toContain('Results meant for the user');
 expect(desktopPrompts(base,profile,'agy',true,reportSections(null)).system).not.toContain('a report page as the report page rule says');
});
