import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SummaryViewer, sourceAuthor } from "../src/summary-viewer";
import type { CatchUpView, ChatState, MessageView } from "../src/types";
import { sent } from "../src/bridge";
import { setLanguage } from "../src/i18n";
const message=(id:string,extra:Partial<MessageView>={}):MessageView=>({id,role:"bot",text:`Original ${id}: First sentence.`,stamp:null,avatar:null,choices:null,chosen:null,answer:null,open:false,attachments:null,replyTo:null,replyPreview:null,openable:false,...extra});
const a=message("a",{sourceAuthor:"Garden",sourceEngine:"claude",sourceTime:"10:21 PM",choices:[{label:"Stable",detail:"after review",recommended:true},{label:"Canary",detail:null,recommended:false}],chosen:0,answer:"Keep tests. Wait for signing."});
const b=message("b",{sourceAuthor:"Garden",sourceEngine:"codex",choices:[{label:"Continue",detail:null,recommended:false}],open:true});
const view:CatchUpView={key:"range",ids:["a","b"],count:2,state:"ready",bullets:["Decision [[source:a/answer|Wait for signing.]] [[source:b]]"],model:"persisted-model",requestedBy:"user"};
let viewer:SummaryViewer;
const state=():ChatState=>({botID:"bot",botName:"Garden",messages:[a,b,message("outside")],working:false,avatar:"",placeholder:"",pendingFiles:[],replyingTo:null,components:{}});
beforeEach(()=>{setLanguage("en");document.body.innerHTML='<main id="background"><button id="restore">Sources</button></main>';viewer=new SummaryViewer();});
afterEach(()=>viewer.close());
it("keeps original authors/time, selected option and notes, without emitting answers or actions",()=>{
 const before=sent.length;viewer.open("owner",state(),view,()=>null,()=>{},0);
 expect(document.querySelectorAll(".source-message")).toHaveLength(2);
 expect(document.querySelector('[data-source-id="a"] .source-who')?.textContent).toContain("Garden · Claude10:21 PM");
 expect(document.querySelector(".source-picked")?.textContent).toContain("Stable");
 expect(document.querySelector(".source-faded")?.textContent).toContain("Canary");
 expect(document.querySelector(".source-note")?.textContent).toContain("Picked by YouKeep tests. Wait for signing.");
 expect(document.querySelector("mark")?.textContent).toBe("Wait for signing.");
 expect(document.querySelector(".source-header")?.textContent).toContain("persisted-model");
 expect(document.querySelector(".source-header")?.textContent).toContain("asked by You");
 expect(sent.length).toBe(before);
 expect(sourceAuthor(message("unknown"))).toBe("Original conversation");
});
it("reuses the window, navigates exact references and returns to all originals",()=>{
 viewer.open("owner",state(),view,()=>null,()=>{},0,0);const dialog=document.querySelector("dialog");
 document.querySelector<HTMLButtonElement>('[data-source-next]')!.click();
 expect(document.querySelector('[data-source-id="b"]')?.classList.contains("cited")).toBe(true);
 viewer.open("owner",state(),view,()=>null,()=>{},0,0);
 expect(document.querySelectorAll("dialog")).toHaveLength(1);expect(document.querySelector("dialog")).toBe(dialog);
 document.querySelector<HTMLButtonElement>('[data-source-all]')!.click();
 expect(document.querySelector(".source-nav")).toBeNull();
 expect(document.querySelectorAll(".source-message")).toHaveLength(2);
});
it("offers only Answer in chat on an unanswered card, closes then locates its actual live message",()=>{
 const reveal=vi.fn();viewer.open("owner",state(),view,()=>null,reveal);
 const original=structuredClone(b);
 expect(document.querySelector('[data-source-id="b"]')?.textContent).toContain("Not answered yet");
 document.querySelector<HTMLButtonElement>('.source-answer-in-chat')!.click();
 expect(document.querySelector("dialog")).toBeNull();expect(reveal).toHaveBeenCalledWith("b");expect(b).toEqual(original);
});
it("handles Escape, keeps background inert and restores keyboard focus",()=>{
 const restore=document.querySelector<HTMLButtonElement>("#restore")!;restore.focus();
 viewer.open("owner",state(),view,()=>null,()=>{});
 expect(document.querySelector<HTMLElement>("#background")!.inert).toBe(true);
 document.querySelector("dialog")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
 expect(document.querySelector("dialog")).toBeNull();expect(document.querySelector<HTMLElement>("#background")!.inert).toBeFalsy();expect(document.activeElement).toBe(restore);
});

it("highlights the persisted note rather than identical author or metadata text",()=>{
 const repeated={...a,sourceAuthor:"You",answer:"You"};
 viewer.open("owner",{...state(),messages:[repeated,b]}, {...view,bullets:["Answer [[source:a/answer|You]]"]},()=>null,()=>{},0);
 expect(document.querySelector(".source-who mark")).toBeNull();
 expect(document.querySelector(".source-note>div:last-child mark")?.textContent).toBe("You");
});

it("keeps original image preview inside the top-layer source dialog",async()=>{
 const {openLightbox,closeLightbox}=await import("../src/lightbox");
 viewer.open("owner",state(),view,()=>null,()=>{});
 openLightbox("data:image/png;base64,aGVsbG8=","Original image");
 expect(document.querySelector("dialog .lightbox")).not.toBeNull();
 closeLightbox();expect(document.querySelector("dialog")).not.toBeNull();
});

it("does not instantiate unloaded generic templates or commands, and offers return to the live card",()=>{
 const generic=message("a",{open:true,displays:[{name:"custom",data:'{"question":"Original question"}',command:"touch /tmp/must-not-run",every:1}]});
 const before=sent.length,reveal=vi.fn();
 viewer.open("owner",{...state(),messages:[generic]}, {...view,ids:["a"]},()=>null,reveal);
 expect(document.querySelector(".source-card pre")?.textContent).toContain("Original question");
 expect(document.querySelector("iframe")).toBeNull();expect(sent.length).toBe(before);
 document.querySelector<HTMLButtonElement>(".source-answer-in-chat")!.click();expect(reveal).toHaveBeenCalledWith("a");
});

it("keeps an open source viewer stable when only messages outside its range stream",()=>{
 viewer.open("owner",state(),view,()=>null,()=>{});
 const body=document.querySelector(".source-body"),source=document.querySelector("[data-source-id=a]");
 viewer.sync("owner",{...state(),messages:[a,b,message("outside",{text:"New streamed text"})]},view);
 expect(document.querySelector(".source-body")).toBe(body);expect(document.querySelector("[data-source-id=a]")).toBe(source);
});


it("disposes image preview listeners on in-range sync and subsequent summary close", async () => {
 const { openLightbox, closeLightbox } = await import("../src/lightbox");
 const restore=document.querySelector<HTMLButtonElement>("#restore")!;restore.focus();
 const original={...state(),messages:[message("a",{text:"![Photo](file:///tmp/a.png)"}),b]};
 viewer.open("owner",original,view,()=>null,()=>{});
 const image=document.querySelector<HTMLElement>("dialog img.media")!;image.focus();
 openLightbox("file:///tmp/a.png","Photo");
 try {
  viewer.sync("owner",{...original,messages:[{...original.messages[0],text:"Updated photo description"},b]},view);
  expect(document.querySelector(".lightbox")).toBeNull();
  expect(document.activeElement).toBe(document.querySelector('[data-source-close]'));
  const tab=new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true});
  document.activeElement!.dispatchEvent(tab);expect(tab.defaultPrevented).toBe(false);
  viewer.close();expect(document.querySelector("dialog")).toBeNull();
  const after=new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true});
  restore.dispatchEvent(after);expect(after.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(restore);
 } finally {closeLightbox();}
});
