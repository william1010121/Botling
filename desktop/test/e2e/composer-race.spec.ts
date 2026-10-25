// What you type in the first second after the window opens stays in the input box and is sent, even
// when the page gets its first state (and switches the box to that chat's draft) after you started.
// No refill workaround here: the words are typed once, as a person would.
import { expect, test } from "@playwright/test";
import { launch, MAIN } from "./launch";

// Focus was also seen leaving the box as the window finished opening (a card's frame loading), about
// one start in fifteen: "right away" runs a few times.
for (const [name, env] of [
  ["right away", {}],
  ["right away, again", {}],
  ["right away, a third time", {}],
  // The first state held back 1.5 s, so the words are surely typed before it lands.
  ["before the first state", { BOTLING_TEST_FIRST_SNAPSHOT_MS: "1500" }],
] as const) {
  test(`words typed in the first second are kept (${name})`, async () => {
    const { app, page, chat } = await launch({ waitForState: false, env });
    try {
      const box = chat.getByRole("textbox", { name: "Message" });
      await box.waitFor();
      const typedBeforeState = await chat.locator("html[data-chat]").count() === 0;
      await box.click();
      await box.pressSequentially("early words stay", { delay: 15 });
      // The first state lands (the box switches to the main bot's chat).
      await chat.locator(`html[data-chat="${MAIN}"]`).waitFor({ state: "attached" });
      await page.waitForTimeout(300);
      await expect(box).toHaveText("early words stay");
      await box.press("Enter");
      await expect(chat.locator(".row.user").last()).toContainText("early words stay");
      if (name === "before the first state") expect(typedBeforeState).toBe(true);
    } finally {
      await app.close();
    }
  });
}

// Focus taken from the box by nothing you did (as when the window finishes opening): Return still sends.
test("Return sends even right after focus left the box by itself", async () => {
  const { app, page, chat } = await launch();
  try {
    const box = chat.getByRole("textbox", { name: "Message" });
    await box.click();
    await box.fill("still sent");
    await box.evaluate((element) => (element as HTMLElement).blur());
    await page.keyboard.press("Enter");
    await expect(chat.locator(".row.user").last()).toContainText("still sent");
  } finally {
    await app.close();
  }
});

// A shell-forwarded key may be delayed while later native keys are already arriving. Keep the
// focus handoff behind all forwarded edits (including Backspace and Return), so none overtake it.
test("keys forwarded during a focus handoff retain their order before typing resumes in the chat", async () => {
  const { app, page, chat } = await launch();
  try {
    // Install before the chat's listener: hold actual cross-origin delivery, not native input.
    await app.context().addInitScript(() => {
      if (location.origin !== "botling-chat://chat") return;
      const held: MessageEvent[] = [];
      let holding = false;
      window.addEventListener("message", event => {
        if (holding && event.source === parent && event.data?.botling === "key") {
          held.push(event); event.stopImmediatePropagation();
        }
      });
      (window as any).__holdKeys = () => {holding=true;};
      (window as any).__heldKeyCount = () => held.length;
      (window as any).__releaseKeys = () => {
        holding = false;
        for (const event of held) window.dispatchEvent(new MessageEvent("message", { data: event.data, source: parent, origin: event.origin }));
      };
    });
    await page.reload();
    await chat.locator("html[data-chat]").waitFor({ state: "attached" });
    const box = chat.getByRole("textbox", { name: "Message" });
    await box.click();
    await page.keyboard.type("Main");
    const frame = page.frames().find(frame => frame.url().endsWith("/chat.html"))!;
    await expect(box).toHaveText("Main");await frame.evaluate(()=>(window as any).__holdKeys());
    await page.evaluate(() => {
      // Recent shell keyboard activity suppresses its unrelated idle refocus timer.
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
      document.body.tabIndex = -1;
      window.focus(); document.body.focus();
      window.dispatchEvent(new Event("focus"));
    });
    await page.keyboard.type("tainerx");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await expect.poll(() => frame.evaluate(() => (window as any).__heldKeyCount())).toBeGreaterThan(0);
    // While delivery is held, later keys must stay on the same forwarding path.
    await expect(box).toHaveText("Main");
    await frame.evaluate(() => (window as any).__releaseKeys());
    await expect(chat.locator(".row.user .user-bubble").last()).toHaveText("Maintainer");
  } finally { await app.close(); }
});

// Chromium can refocus the composer while a shell key is still crossing origins. Native input
// must then join the same queue, rather than overtaking an earlier forwarded character.
test('native keys after unexpected composer refocus cannot overtake a delayed shell key',async()=>{
 const {app,page,chat}=await launch();
 try{
  await app.context().addInitScript(()=>{
   if(location.origin!=='botling-chat://chat')return;
   const held:MessageEvent[]=[];let holding=false;
   window.addEventListener('message',event=>{if(holding&&event.source===parent&&event.data?.botling==='key'){held.push(event);event.stopImmediatePropagation();}});
   (window as any).__hold=()=>{holding=true;};(window as any).__held=()=>held.length;(window as any).__release=()=>{holding=false;for(const event of held)window.dispatchEvent(new MessageEvent('message',{data:event.data,source:parent,origin:event.origin}));};
  });
  await page.reload();await chat.locator('html[data-chat]').waitFor({state:'attached'});
  const box=chat.getByRole('textbox',{name:'Message'}),frame=page.frames().find(f=>f.url().endsWith('/chat.html'))!;
  await box.click();await page.keyboard.type('Prefix ');await expect(box).toHaveText('Prefix ');await frame.evaluate(()=>(window as any).__hold());
  await box.evaluate(element=>(element as HTMLElement).blur());
  await page.evaluate(()=>{document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',bubbles:true}));document.body.tabIndex=-1;window.focus();document.body.focus();window.dispatchEvent(new Event('focus'));});
  await page.keyboard.type('n');await expect.poll(()=>frame.evaluate(()=>(window as any).__held())).toBe(1);
  // A browser/card focus event can do this independently of the shell's acknowledgement checks.
  await box.evaluate(element=>(element as HTMLElement).focus());await page.keyboard.type('ame');
  await expect(box).toHaveText('Prefix ');
  await frame.evaluate(()=>(window as any).__release());await expect(box).toHaveText('Prefix name');
  await page.keyboard.press('Enter');await expect(chat.locator('.row.user .user-bubble').last()).toHaveText('Prefix name');
 }finally{await app.close();}
});

// A normal app switch must never turn CodeMirror into a partial synthetic keyboard.
test('app-switch blur preserves native caret order and editing', async () => {
  const {app,page,chat}=await launch();
  try {
    const box=chat.getByRole('textbox',{name:'Message'});
    await box.click();await page.waitForTimeout(350);
    await box.evaluate(()=>window.dispatchEvent(new Event('blur')));
    await page.keyboard.type('ab');await page.keyboard.press('ArrowLeft');await page.keyboard.type('X');
    await expect(box).toHaveText('aXb');
    await page.keyboard.press('Delete');await expect(box).toHaveText('aX');
    await page.keyboard.press('Meta+z');await expect(box).toHaveText('aXb');
  } finally {await app.close();}
});

// Composition events model the macOS unflagged candidate key. CDP supplies trusted keys with
// isComposing=false (unlike a synthetic KeyboardEvent, which the old handoff skipped entirely).
for (const mode of ['state','229','ended'] as const) test(`IME candidate Space/Enter stays native (${mode})`,async()=>{
  const {app,page,chat}=await launch();
  try {
    const box=chat.getByRole('textbox',{name:'Message'});
    await box.click();await box.fill('中文');await page.waitForTimeout(350);
    await box.evaluate((element,mode)=>{
      window.dispatchEvent(new Event('blur'));
      element.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中文'}));
      if(mode!=='state')element.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));
      (window as any).__candidateKeys=[];
      window.addEventListener('keydown',event=>(window as any).__candidateKeys.push({trusted:event.isTrusted,composing:event.isComposing,code:event.keyCode}),true);
    },mode);
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:mode==='229'?229:32});
    await page.waitForTimeout(100);
    expect(await box.textContent()).toBe('中文');
    expect(await box.evaluate(()=> (window as any).__candidateKeys[0])).toMatchObject({trusted:true,composing:false,code:mode==='229'?229:32});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:229});
    await page.waitForTimeout(100);
    await expect(chat.locator('.row.user')).toHaveCount(0);
    expect(await box.textContent()).toBe('中文');
    await box.evaluate(element=>element.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'})));
    await cdp.detach();
  }finally{await app.close();}
});

// Feedback has an ordinary textarea inside the chat, outside the composer.
test('handoff never hijacks a feedback textarea',async()=>{
 const {app,page,chat}=await launch();
 try{
  const box=chat.getByRole('textbox',{name:'Message'});await box.click();await page.waitForTimeout(350);
  await box.evaluate(()=>{window.dispatchEvent(new Event('blur'));const feedback=document.createElement('textarea');feedback.ariaLabel='Feedback regression';document.body.append(feedback);feedback.focus();});
  const feedback=chat.getByRole('textbox',{name:'Feedback regression'});await page.keyboard.type('feedback');
  await expect(feedback).toHaveValue('feedback');await expect(box).toHaveText('');
 }finally{await app.close();}
});

// Once Tab leaves the composer, a former handoff's idle acknowledgement must not steal it back.
test('Tab focus survives the former 500ms handoff recovery timer',async()=>{
 const {app,page,chat}=await launch();try{
  const box=chat.getByRole('textbox',{name:'Message'});await box.click();
  await page.evaluate(()=>{document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',bubbles:true}));document.body.tabIndex=-1;window.focus();document.body.focus();window.dispatchEvent(new Event('focus'));});
  await page.keyboard.type('n');await expect(box).toHaveText('n');
  await box.evaluate(element=>(element as HTMLElement).focus());await page.keyboard.press('Tab');
  const frame=page.frames().find(f=>f.url().endsWith('/chat.html'))!;
  const active=await frame.evaluate(()=>{(window as any).__tabTarget=document.activeElement;return document.activeElement?.className;});
  expect(active).not.toContain('cm-content');await page.waitForTimeout(750);
  expect(await frame.evaluate(()=>document.activeElement===(window as any).__tabTarget)).toBe(true);
 }finally{await app.close();}
});
