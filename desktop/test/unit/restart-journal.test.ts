import {expect,it,vi} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {RestartJournal,RESTART_FILE,RESTART_MAX_AGE_MS,type RestartEntry} from '../../src/core/restart-continuation';
import {tempDir} from '../helpers';
const entry=(botId:string):RestartEntry=>({botId,engine:'claude',sessionId:'same-session',continue:true,queued:[]});
it('persists multiple original owners and claims each exactly once across boots',()=>{
 const dir=tempDir('restart-journal'),j=new RestartJournal(dir),send=vi.fn(),notice=vi.fn();
 j.prepare([entry('one'),{...entry('two'),engine:'codex',workers:[{id:'child',name:'Child',instructions:'Research only',run:7,thread:'original-child',wasActive:true,reportPending:false}]}]);j.ready();
 new RestartJournal(dir).recover(send,notice);new RestartJournal(dir).recover(send,notice);
 expect(send.mock.calls.map(([e])=>e.botId)).toEqual(['one','two']);
 expect(send.mock.calls[1][0].workers[0]).toMatchObject({id:'child',thread:'original-child',run:7,instructions:'Research only'});expect(notice).not.toHaveBeenCalled();
});
it('shutdown checkpoint removes completion-before-shutdown and cancellation',()=>{
 const dir=tempDir('restart-completed'),j=new RestartJournal(dir),send=vi.fn();
 j.prepare([entry('completed'),entry('cancelled'),entry('remaining')]);j.checkpoint([entry('remaining')]);j.ready();
 new RestartJournal(dir).recover(send,vi.fn());expect(send.mock.calls.map(([e])=>e.botId)).toEqual(['remaining']);
});
it('pending permission and incomplete shutdown are blocked without a prompt',()=>{
 const dir=tempDir('restart-permission'),j=new RestartJournal(dir),send=vi.fn(),notice=vi.fn();
 j.prepare([{...entry('permission'),blocked:'Permission pending'},entry('unfinished-shutdown')]);
 new RestartJournal(dir).recover(send,notice);expect(send).not.toHaveBeenCalled();expect(notice).toHaveBeenCalledTimes(2);
});
it('a crash after durable claim never retries delivery',()=>{
 const dir=tempDir('restart-claim'),j=new RestartJournal(dir);j.prepare([entry('one')]);j.ready();
 const file=join(dir,RESTART_FILE),v=JSON.parse(readFileSync(file,'utf8'));v.entries[0].state='claimed';writeFileSync(file,JSON.stringify(v));
 const send=vi.fn(),notice=vi.fn();new RestartJournal(dir).recover(send,notice);new RestartJournal(dir).recover(send,notice);
 expect(send).not.toHaveBeenCalled();expect(notice).toHaveBeenCalledOnce();expect(notice.mock.calls[0][1]).toContain('uncertain');
});
it('failed install cancels only its prepared intent',()=>{
 const j=new RestartJournal(tempDir('restart-cancel')),send=vi.fn();j.prepare([entry('one')]);j.cancel();j.recover(send,vi.fn());expect(send).not.toHaveBeenCalled();
});
it('preserves corrupt checkpoint data and refuses execution',()=>{
 const dir=tempDir('restart-corrupt'),file=join(dir,RESTART_FILE),raw=JSON.stringify({v:1,id:'restart',phase:'ready',entries:[{botId:'one',engine:'claude'}]});writeFileSync(file,raw);
 const send=vi.fn();expect(()=>new RestartJournal(dir).recover(send,vi.fn())).toThrow('unreadable');expect(send).not.toHaveBeenCalled();expect(readFileSync(file,'utf8')).toBe(raw);
});
it('a ready journal older than the max age is never resumed',()=>{
 const dir=tempDir('restart-stale'),j=new RestartJournal(dir);j.prepare([entry('one')]);j.ready();
 const file=join(dir,RESTART_FILE),v=JSON.parse(readFileSync(file,'utf8'));v.at=Date.now()-RESTART_MAX_AGE_MS-1000;writeFileSync(file,JSON.stringify(v));
 const send=vi.fn(),notice=vi.fn();new RestartJournal(dir).recover(send,notice);
 expect(send).not.toHaveBeenCalled();expect(notice).toHaveBeenCalledOnce();expect(notice.mock.calls[0][1]).toContain('too old');
});
it('a fresh ready journal is resumed',()=>{
 const dir=tempDir('restart-fresh'),j=new RestartJournal(dir);j.prepare([entry('one')]);j.ready();
 const send=vi.fn();new RestartJournal(dir).recover(send,vi.fn());expect(send).toHaveBeenCalledOnce();
});
