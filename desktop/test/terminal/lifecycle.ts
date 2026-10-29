import { app, BrowserWindow } from 'electron';
import { spawn } from 'node-pty';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { BotTerminals } from '../../src/main/terminal';
import { sendTerminalEvent } from '../../src/main/terminal-transport';
process.on('uncaughtException', e => { console.error(e); process.exit(1); });
process.on('unhandledRejection', e => { console.error(e); process.exit(1); });
const home = mkdtempSync(join(__dirname, 'lifecycle-home-'));
process.env.HOME = home; process.env.ZDOTDIR = home;
if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
app.setPath('userData', home);
app.on('window-all-closed', () => {});
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const pids: number[] = [];
let listeners = 0, data = 0, sent = 0;
app.whenReady().then(async () => {
  for (let cycle = 0; cycle < 20; cycle++) {
    const window = new BrowserWindow({show:false,webPreferences:{sandbox:true}});
    const contents = window.webContents, owner = contents.id;
    let manager: BotTerminals;
    manager = new BotTerminals((_owner, event) => {
      if (event.type === 'data') { data++; manager.ack(owner, event.botId, event.sessionId, event.offset); }
      if (sendTerminalEvent(contents, event)) sent++;
    }, (shell, args, options) => {
      const pty = spawn(shell, args, options);pids.push(pty.pid);
      for (const key of ['onData','onExit'] as const) {
        const original = pty[key];
        Object.defineProperty(pty, key, {value:(callback: any) => {
          listeners++; const disposable = original(callback); let disposed=false;
          return {dispose() { if(!disposed){disposed=true;listeners--;disposable.dispose();} }};
        }});
      }
      return pty;
    });
    contents.once('destroyed', () => manager.closeOwner(owner));
    const first = manager.open(owner, 'A', home, '/bin/sh');
    manager.input(owner,'A',first.sessionId,"while :; do printf 'stream中文'; sleep 0.01; done\r");
    await delay(50);manager.close(owner,'A',first.sessionId);
    const second = manager.open(owner,'A',home,'/bin/sh');
    manager.input(owner,'A',second.sessionId,(cycle === 19 ? "trap '' HUP; " : "") + "while :; do printf stream; sleep 0.01; done\r");
    await delay(50);
    if (cycle % 2) await manager.closeAll();
    window.destroy();await delay(50);
    assert.equal(listeners,0);assert.equal(manager.list(owner,'A').length,0);
  }
  await delay(400);
  const alive = pids.filter(pid => {try{process.kill(pid,0);return true;}catch{return false;}});
  assert.equal(data>0,true);assert.deepEqual(alive,[]);assert.equal(listeners,0);
  const result={cycles:20,ptys:pids.length,listeners,alive,data,sent,uncaughtExceptions:0,electron:process.versions.electron,modules:process.versions.modules,napi:process.versions.napi};
  writeFileSync(join(__dirname,'evidence/lifecycle.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  rmSync(home,{recursive:true,force:true});app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
