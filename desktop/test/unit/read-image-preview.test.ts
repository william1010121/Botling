import { expect, it } from 'vitest';
import { Bot, stepView } from '../../src/core/bot';
import { StepView } from '../../src/contract';
import { parseLine } from '../../src/core/agent/stream';
import type { StepRecord } from '../../src/core/store/records';

const read: StepRecord = { id: 'read-image', kind: 'tool', tool: 'Read', title: 'Read diagram.png', detail: '/work/diagram.png', done: true, failed: false, output: '' };
it('restores an image-only Claude Read after its path-only record is reopened', () => {
  const items = parseLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: read.id, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' } }] }] } }));
  expect(items[0]).toMatchObject({ kind: 'toolResult', output: '', failed: false });
  const live = StepView.parse(stepView(read));
  expect(live).toMatchObject({ images: [{ url: 'file:///work/diagram.png', name: 'diagram.png' }] });
  expect(StepView.parse(stepView(JSON.parse(JSON.stringify(read))))).toEqual(live);
});
it('keeps text reads, failed reads and unfinished reads unchanged', () => {
  for (const extra of [{ output: 'source text' }, { failed: true }, { done: false }, { detail: '/work/notes.txt' }, { tool: 'Write' }]) {
    expect(stepView({ ...read, ...extra })).not.toHaveProperty('images');
  }
});

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CoreHarness, MAIN } from '../core-harness';
import { tempDir, until } from '../helpers';
import { chatState } from '../../src/renderer/payload';
import { readImagePaths } from '../../src/core/read-images';

it('serves only recorded image Reads live and after core restart, preserving the renderer payload', async () => {
  const dir = tempDir('read-image-core');
  const image = join(dir, '圖 space.png');
  writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC', 'base64'));
  const cli = join(dir, 'read-cli.mjs');
  writeFileSync(cli, `import {createInterface} from 'node:readline';
const out = x => process.stdout.write(JSON.stringify(x)+'\\n');
 out({type:'system',subtype:'init',session_id:'image-session',tools:[],model:'fake'});
createInterface({input:process.stdin}).on('line', line => {
 const x=JSON.parse(line);
 if(x.type==='control_request' && x.request?.subtype==='initialize') out({type:'control_response',response:{subtype:'success',request_id:x.request_id,response:{}}});
 if(x.type!=='user')return;
 out({type:'assistant',message:{content:[{type:'tool_use',id:'image-read',name:'Read',input:{file_path:${JSON.stringify(image)}}}]}});
 out({type:'user',message:{content:[{type:'tool_result',tool_use_id:'image-read',content:[{type:'image',source:{type:'base64',media_type:'image/jpeg',data:'/9j/'}}]}]}});
 setTimeout(()=>out({type:'result',subtype:'success',is_error:false,result:'Read complete',session_id:'image-session',total_cost_usd:0}),150);
});`);
  let core = new CoreHarness(dir, { BOTLING_FAKE_CLI: cli, BOTLING_UPDATE_PENDING: '', BOTLING_IMPORT_FROM: '' });
  const url = pathToFileURL(image).href;
  try {
    await core.call({ type: 'chat.send', botId: MAIN, text: 'Read the image' });
    const event = await until(() => core.of('turn.steps').find(e => e.event.type === 'turn.steps' && e.event.steps.some(s => s.images?.length))).catch(error => { throw new Error(error.message + '\n' + JSON.stringify(core.events.map(e => e.event.type)) + '\n' + core.stderr); });
    expect(event.event).toMatchObject({ steps: [{ images: [{ url }] }] });
    expect(await core.call({ type: 'attachment.file', botId: MAIN, ref: url })).toEqual({ path: image, type: 'image/png' });
    await until(() => core.of('turn.finished').length);
    await core.kill();
    core = new CoreHarness(dir, { BOTLING_UPDATE_PENDING: '', BOTLING_IMPORT_FROM: '' });
    const chat = await core.chat();
    expect(chat.messages.flatMap((m: any) => m.steps ?? []).find((s: any) => s.id === 'image-read').images).toEqual([{ url, name: '圖 space.png' }]);
    const bot = { id: MAIN, name: 'Main', role: 'main', folder: dir, phase: 'asleep', heads: ['claude'] } as any;
    expect(chatState(bot, chat).state.messages.flatMap(m => m.steps ?? []).find(s => s.id === 'image-read')?.images).toEqual([{ url, name: '圖 space.png' }]);
    expect(await core.call({ type: 'attachment.file', botId: MAIN, ref: url })).toEqual({ path: image, type: 'image/png' });
    await expect(core.call({ type: 'attachment.file', botId: MAIN, ref: pathToFileURL(join(dir, 'unnamed.png')).href })).rejects.toThrow('not_found');
    await expect(core.call({ type: 'attachment.file', botId: MAIN, ref: 'file:///etc/passwd' })).rejects.toThrow('not_found');
  } finally { await core.kill('SIGKILL'); }
});

it('uses kept images and falls back to the recorded source when kept files are gone', () => {
  const dir = tempDir('kept-read');
  const kept = join(dir, 'kept.jpg'); writeFileSync(kept, 'fixture');
  expect(readImagePaths({ ...read, images: [kept] })).toEqual([kept]);
  expect(readImagePaths({ ...read, images: [join(dir, 'gone.jpg')] })).toEqual([read.detail]);
  expect(readImagePaths({ ...read, detail: 'relative.png' })).toEqual([]);
});


it('allows live Read images from every peer and its subagents, without allowing unnamed paths', () => {
  const owner = Object.create(Bot.prototype);
  const first = Object.create(Bot.prototype);
  const second = Object.create(Bot.prototype);
  for (const member of [owner, first, second]) {
    member.options = {};
    member.records = [];
    member.subagents = { list: [] };
    Object.defineProperty(member, 'shownTurn', { value: null, writable: true });
  }
  owner.partners = new Map([['codex', first], ['agy', second]]);
  for (const member of [first, second]) {
    member.shownTurn = { steps: [read] };
    expect(owner.attachmentPath('file:///work/diagram.png')).toBe('/work/diagram.png');
    member.shownTurn = null;
    member.subagents.list = [{ steps: [read] }];
    expect(owner.attachmentPath('file:///work/diagram.png')).toBe('/work/diagram.png');
    member.subagents.list = [];
    expect(owner.attachmentPath('file:///work/diagram.png')).toBeNull();
  }
});
