// Focused production-panel regression, private profile and hidden Electron window.
import { _electron as electron } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const out = resolve('out/terminal-harness');
const evidence = resolve(process.env.TERMINAL_LAYOUT_EVIDENCE || join(out, 'layout-evidence'));
mkdirSync(evidence, {recursive:true});
const home = mkdtempSync(join(out, 'layout-home-'));
writeFileSync(join(home, '.zshrc'), "export HISTFILE=/dev/null\nPROMPT='layout> '\n");
const env = {...process.env, HOME:home, ZDOTDIR:home, XDG_CONFIG_HOME:join(home,'.config'), TERMINAL_SMOKE_HOME:home};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({args:[join(out,'main.cjs')], env});
const checks = [], failures = [];
try {
 const page = await app.firstWindow(); page.setDefaultTimeout(10000);
 const toggle = page.getByRole('button', {name:'Terminal',exact:true});
 const measure = () => page.evaluate(() => {
  const content=document.querySelector('[data-testid=content]').getBoundingClientRect();
  const toolbar=document.querySelector('.terminal-panel:not([hidden]) .terminal-toolbar');
  const control=document.querySelector('.terminal-toggle');
  return {gap:innerHeight-content.bottom, inHeader:!!control.closest('header'), toggleHeight:control.getBoundingClientRect().height, toolbarHeight:toolbar?.getBoundingClientRect().height, overflow:document.documentElement.scrollWidth>innerWidth};
 });
 for (const width of [1100,480]) {
  await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,650),width);
  await page.waitForTimeout(100);
  const m=await measure();
  await page.screenshot({path:join(evidence,`collapsed-${width}.png`)});
  if(m.gap!==0 || !m.inHeader || m.toggleHeight>28 || m.overflow) failures.push({width,collapsed:m});
 }
 await toggle.click();
 await page.waitForSelector('.terminal-panel:not([hidden]) .xterm-helper-textarea');
 const type=async command=>{await page.locator('.terminal-tab:not([hidden]) .xterm-helper-textarea').focus();await page.keyboard.insertText(command);await page.keyboard.press('Enter');};
 const wait=async marker=>page.waitForFunction(marker=>[...document.querySelectorAll('.terminal-tab:not([hidden]) .xterm-screen')].some(e=>e.textContent.includes(marker)),marker);
 await type("export KEEP=alive; printf '\\033[32m中文 ready\\033[0m\\n'"); await wait('中文 ready');
 await page.getByRole('button',{name:'New terminal',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('[role=tab]').length===2);
 for(const width of [1100,480]) {
  await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,650),width);
  await page.waitForTimeout(150);
  const m=await measure();
  await page.screenshot({path:join(evidence,`expanded-${width}.png`)});
  if(m.toolbarHeight>38 || m.overflow) failures.push({width,expanded:m});
  const close=await page.getByRole('button',{name:'Hide terminal panel'}).boundingBox();
  assert(close && close.x>=0 && close.x+close.width<=width,'hide remains reachable');
 }
 assert.deepEqual(failures,[], 'collapsed content fills available height; controls live in header and compact toolbar');
 checks.push('normal/narrow collapsed zero height, header affordance and compact expanded toolbar');
 const divider=page.getByRole('separator',{name:'Resize terminal panel'});
 await divider.waitFor();
 const heights=[];
 for(const target of [150,260,400]) {
  const panel=page.locator('.terminal-panel:not([hidden])');
  const box=await panel.boundingBox(); const grip=await divider.boundingBox();
  await page.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2);
  await page.mouse.down(); await page.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2+box.height-target,{steps:8}); await page.mouse.up();
  await page.waitForTimeout(100);
  const actual=(await panel.boundingBox()).height; assert(Math.abs(actual-target)<2, `drag target ${target}, actual ${actual}`);
  await type(`stty size > rows-${target}.txt`);
  await page.waitForFunction(()=>document.querySelector('.terminal-tab:not([hidden]) .xterm-screen').textContent.includes('layout>'));
  await page.waitForTimeout(100);
  const rows=Number(readFileSync(join(home,`rows-${target}.txt`),'utf8').trim().split(/\s+/)[0]);
  heights.push({target,actual,rows});
  await page.screenshot({path:join(evidence,`drag-${target}.png`)});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,650));
  await page.waitForTimeout(100);
  await page.screenshot({path:join(evidence,`drag-${target}-wide.png`)});
  if(target===260) {
   await type('stty size > wide-size.txt'); await page.waitForTimeout(150);
   const narrowCols=Number(readFileSync(join(home,`rows-${target}.txt`),'utf8').trim().split(/\s+/)[1]);
   const wideCols=Number(readFileSync(join(home,'wide-size.txt'),'utf8').trim().split(/\s+/)[1]);
   assert(wideCols>narrowCols); checks.push({narrowCols,wideCols});
  }
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(480,650));
  await page.waitForTimeout(100);
 }
 assert(heights[0].rows < heights[1].rows && heights[1].rows < heights[2].rows,'PTY rows follow drag height');
 await page.getByRole('button',{name:'Hide terminal panel'}).click(); await toggle.click();
 assert.equal((await page.locator('.terminal-panel:not([hidden])').boundingBox()).height,400);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(480,400));
 await page.waitForTimeout(150);
 assert((await page.locator('.terminal-panel:not([hidden])').boundingBox()).height<=280);
 assert((await page.locator('[data-testid=content]').boundingBox()).height>0);
 await page.screenshot({path:join(evidence,'short-window.png')});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(480,650));
 await page.waitForTimeout(150);
 assert.equal((await page.locator('.terminal-panel:not([hidden])').boundingBox()).height,400);
 checks.push({dragHeights:heights,rememberedHeight:400,shortWindowClamp:280});
 await divider.focus(); await page.keyboard.press('Home');
 assert.equal((await page.locator('.terminal-panel:not([hidden])').boundingBox()).height,120);
 await page.keyboard.press('End');
 assert(Math.abs((await page.locator('.terminal-panel:not([hidden])').boundingBox()).height-await page.evaluate(()=>innerHeight*.7))<1);
 await page.keyboard.press('ArrowDown');
 await type("printf 'apple\\nbanana\\ncherry\\n' | /opt/homebrew/bin/fzf --no-mouse > picked.txt");
 await page.waitForTimeout(250); await page.keyboard.type('banana'); await page.waitForTimeout(150);
 await page.screenshot({path:join(evidence,'fullscreen.png')});
 await page.keyboard.press('Enter');
 await type('cat picked.txt'); await wait('banana');
 assert.equal(readFileSync(join(home,'picked.txt'),'utf8').trim(),'banana');
 checks.push('divider keyboard bounds and fullscreen fzf selection/restore');

 await page.getByRole('tab').first().click();
 await type("(sleep 0.3; printf 'HIDDEN_OUTPUT\\n') &");
 const menuToggle=()=>app.evaluate(({Menu,BrowserWindow})=>{
  const item=Menu.getApplicationMenu().items.find(i=>i.label==='View').submenu.items.find(i=>i.label==='Toggle Terminal');
  if(item.accelerator!=='CommandOrControl+J' && item.accelerator!=='CmdOrCtrl+J') throw new Error('Cmd+J accelerator missing: '+item.accelerator);
  item.click(null,BrowserWindow.getAllWindows()[0]);
 });
 await menuToggle();
 await page.waitForSelector('.terminal-panel[hidden]',{state:'attached'});
 assert.equal((await measure()).gap,0);
 await page.waitForTimeout(450);
 await menuToggle(); await wait('HIDDEN_OUTPUT');
 await type("printf 'KEEP=%s\\n' $KEEP"); await wait('KEEP=alive');
 assert.equal(await page.getByRole('tab').count(),2);
 checks.push('Cmd+J menu route preserves two tabs, shell state and output while hidden');
 await page.getByRole('button',{name:'Bot B',exact:true}).click(); await toggle.click();
 await page.waitForSelector('.terminal-panel:not([hidden]) .xterm-helper-textarea');
 await type("printf 'BOT_B=%s\\n' ${KEEP-unset}"); await wait('BOT_B=unset');
 await page.getByRole('button',{name:'Bot A',exact:true}).click(); await wait('KEEP=alive');
 await page.getByRole('button',{name:'Hide terminal panel'}).click();
 assert.equal((await measure()).gap,0); await toggle.click(); await wait('KEEP=alive');
 checks.push('per-bot tabs and hide button preserve shell state');
 console.log(JSON.stringify({checks,failures}));
 writeFileSync(join(evidence,'result.json'),JSON.stringify({checks,failures},null,2));
} catch(error) {
 writeFileSync(join(evidence,'result.json'),JSON.stringify({checks,failures,error:String(error)},null,2));
 throw error;
} finally {await app.close();rmSync(home,{recursive:true,force:true});}
