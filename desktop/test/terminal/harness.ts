// Isolated Electron smoke only: never launches the real app or reads its data/profile.
import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { join } from 'node:path';
import { BotTerminals } from '../../src/main/terminal';
import { installTerminalIPC } from '../../src/main/terminal-ipc';
import { sendTerminalEvent } from '../../src/main/terminal-transport';
import type { WebContents } from 'electron';
import { appMenuTemplate } from '../../src/main/app-menu';
// Fail test processes explicitly instead of Electron's modal uncaught-error dialog.
process.on('uncaughtException', error => { process.stderr.write(String(error.stack || error)); process.exit(1); });
process.on('unhandledRejection', error => { process.stderr.write(String(error)); process.exit(1); });
if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
app.setPath('userData', process.env.TERMINAL_SMOKE_HOME!);
let window: BrowserWindow;
let contents: WebContents | undefined;
const terminals = new BotTerminals((_owner, event) => sendTerminalEvent(contents, event));
installTerminalIPC(ipcMain, terminals, e => !!contents && !contents.isDestroyed() && e.sender === contents && e.senderFrame === contents.mainFrame,
  async id => ['A','B'].includes(id) ? process.env.TERMINAL_SMOKE_HOME! : null);
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 1100, height: 650, show: false, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true } });
  contents = window.webContents;
  const owner = contents.id;
  contents.once('destroyed', () => { terminals.closeOwner(owner); contents = undefined; });
  window.once('closed', () => terminals.closeOwner(owner));
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate()));
  await window.loadFile(join(__dirname, 'index.html'));
});
let closing = false;
app.on('before-quit', event => {
  if (closing) return; closing = true; event.preventDefault();
  void terminals.closeAll().then(() => app.exit(0));
});
