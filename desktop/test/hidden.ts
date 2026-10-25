import type {ElectronApplication,Page} from '@playwright/test';
export function requireFocusOptIn(env:Record<string,string|undefined>):void {
 if(env.BOTLING_HIDDEN==='0'&&env.BOTLING_TEST_ALLOW_FOCUS!=='1')throw new Error('Foreground tests require explicit BOTLING_TEST_ALLOW_FOCUS=1 authorization');
}
/** CDP focus is renderer emulation only: never show/focus a native window. */
export async function backgroundPages(app:ElectronApplication,page:Page):Promise<void>{
 const pending=new WeakMap<Page,Promise<void>>();
 const prepare=(page:Page)=>{
  let task=pending.get(page);if(!task){task=(async()=>{const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});})();pending.set(page,task);}return task;
 };
 app.context().on('page',page=>{void prepare(page).catch(error=>{process.stderr.write('Background focus emulation failed: '+String(error)+'\n');void app.close();});});
 await Promise.all(app.context().pages().map(prepare));await prepare(page);
}
