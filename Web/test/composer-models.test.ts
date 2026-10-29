import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {Composer} from '../src/composer';
import {setComposerHost} from '../src/composer-host';
import {sent} from '../src/bridge';
import type {ChatState} from '../src/types';
let composer: Composer;
let settings: any;
let catalog: any;
const configure = vi.fn(async (_bot: string, change: any) => (settings = {...settings, ...change}));
const state = (botID = 'A') => ({botID, botName:botID, messages:[],working:true,avatar:'',placeholder:'Message',replyingTo:null,pendingFiles:[],components:{},answerWith:{chosen:'claude',options:[{id:'claude',label:'Claude'},{id:'codex',label:'Codex'},{id:'agy',label:'Antigravity'}]}} as ChatState);
const settle = async () => {for(let i=0;i<12;i++) await Promise.resolve();};
const button = (label: string) => [...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label || b.textContent===label)!;
async function open(engine='Codex') {button(`${engine} model and effort`).click(); await settle();}
beforeEach(()=>{
 document.body.replaceChildren(); sent.length=0; configure.mockClear();
 settings={botId:'A',engines:['claude','codex','agy'],model:null,codexModel:'old',agyModel:null,effort:'medium'};
 catalog={status:'ready',source:'test runtime',message:'',models:[{id:'runtime',name:'Runtime choice',isDefault:true,efforts:['low','medium','high','xhigh']}]};
 setComposerHost({send:vi.fn(),modelSettings:async()=>settings,modelCatalog:async()=>catalog,configureModels:configure} as any);
 composer=new Composer(document.body); composer.update(state());
});
afterEach(()=>{composer.view.destroy();setComposerHost(null);document.body.replaceChildren();});
it('opens each engine without selecting a recipient, preserving the draft and saved unlisted ID',async()=>{
 composer.setText('Keep my draft'); await open();
 expect(sent.filter(a=>a.type==='setAnswerWith')).toEqual([]);
 expect(document.querySelector('.model-popover')?.textContent).toContain('old');
 button('Runtime choice').click(); await settle();
 expect(configure).toHaveBeenCalledWith('A',{codexModel:'runtime'});
 expect(composer.text).toBe('Keep my draft');
 expect(button('Runtime choice').getAttribute('aria-pressed')).toBe('true');
 document.querySelector<HTMLButtonElement>('.answer-chip[data-head="agy"]')!.click();
 expect(sent).toContainEqual(expect.objectContaining({type:'setAnswerWith',to:'agy'}));
});
it('uses a real discrete range, limits shared effort with Antigravity, and saves only on commit',async()=>{
 settings.codexModel=null; await open();
 const slider=document.querySelector<HTMLInputElement>('input[type=range]')!;
 expect(slider).not.toBeNull(); expect(slider.max).toBe('3');
 slider.value='3'; slider.dispatchEvent(new Event('input',{bubbles:true}));
 expect(configure).not.toHaveBeenCalled();
 slider.dispatchEvent(new Event('change',{bubbles:true})); await settle();
 expect(configure).toHaveBeenCalledWith('A',{effort:'high'});
 const current=document.querySelector<HTMLInputElement>('input[type=range]')!;
 current.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true})); await settle();
 expect(configure).toHaveBeenLastCalledWith('A',{effort:null});
});
it('keeps unsupported saved effort visible and does not invent capabilities',async()=>{
 settings.effort='max'; catalog.models[0].efforts=null; await open('Claude');
 expect(document.querySelector('.model-popover')?.textContent).toContain('Max');
 expect(document.querySelector('.model-popover')?.textContent).toContain('unsupported');
 expect(document.querySelector<HTMLInputElement>('input[type=range]')!.max).toBe('0');
 expect(configure).not.toHaveBeenCalled();
});
it('discards a late catalog after changing bots',async()=>{
 let resolve!: (value:any)=>void;
 setComposerHost({send:vi.fn(),modelSettings:async()=>settings,modelCatalog:()=>new Promise(r=>resolve=r),configureModels:configure} as any);
 button('Codex model and effort').click(); await settle(); composer.update(state('B'));
 resolve(catalog); await settle(); expect(document.querySelector('.model-popover')).toBeNull();
});
it('keeps confirmed selection on save failure and blocks a send while saving',async()=>{
 await open(); let reject!: (error:Error)=>void;
 configure.mockImplementationOnce(()=>new Promise((_r,j)=>reject=j));
 button('Runtime choice').click();composer.setText('next'); expect(composer.submit()).toBe(false);
 reject(new Error('Could not save'));await settle();
 expect(document.querySelector('.model-popover')?.textContent).toContain('Could not save');
 expect(settings.codexModel).toBe('old');
});
it('shows a catalog failure without losing default and saved selections, then retries',async()=>{
 catalog={status:'unavailable',models:[],message:'Engine is unavailable'};await open();
 expect(button('Default')).toBeDefined();expect(document.querySelector('.model-popover')?.textContent).toContain('old');
 expect(document.querySelector('.model-popover')?.textContent).toContain('Engine is unavailable');
 catalog={status:'ready',message:'',models:[{id:'recovered',name:'Recovered runtime model',isDefault:true,efforts:['low','high']}]};
 button('Retry').click();await settle();expect(button('Recovered runtime model')).toBeDefined();expect(configure).not.toHaveBeenCalled();
});
it('preserves expanded state across streaming updates and restores focus after Escape',async()=>{
 await open();composer.update(state());expect(button('Codex model and effort').getAttribute('aria-expanded')).toBe('true');
 document.querySelector('.model-popover')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 expect(document.querySelector('.model-popover')).toBeNull();expect(document.activeElement).toBe(button('Codex model and effort'));
});
it('lets an unsupported saved effort reset to default even when capabilities are unavailable',async()=>{
 settings.effort='max';catalog={status:'error',models:[],message:'Offline'};await open();button('Use default').click();await settle();
 expect(configure).toHaveBeenCalledWith('A',{effort:null});
});
it('keeps only model rows and compact effort controls in the normal menu',async()=>{
 settings.codexModel=null;await open();
 const panel=document.querySelector('.model-popover')!;
 expect(button('Default')).toBeDefined();
 expect(panel.querySelector('.model-heading')).toBeNull();
 expect(panel.querySelector('.model-footer')).toBeNull();
 expect(panel.querySelector('.effort-caption')?.textContent).toBe('Effort');
 expect(panel.querySelector('.effort-value')?.textContent).toBe('Medium');
 const refresh=button('Refresh models');expect(refresh).toBeDefined();expect(refresh.textContent).toBe('');
 expect(refresh.querySelector('svg')).not.toBeNull();
 button('Runtime choice').click();await settle();
 expect(button('Runtime choice').getAttribute('aria-pressed')).toBe('true');
 expect(panel.querySelector('.model-footer')).toBeNull();
});
it('reveals shared effort scope on keyboard focus without adding a permanent explanation',async()=>{
 settings.codexModel=null;await open();
 const caption=button('Effort');const tooltip=document.querySelector<HTMLElement>('[role=tooltip]')!;
 expect(tooltip).not.toBeNull();expect(tooltip.hidden).toBe(true);
 expect(caption.getAttribute('aria-describedby')).toBe(tooltip.id);
 caption.focus();expect(tooltip.hidden).toBe(false);expect(tooltip.textContent).toBe('Shared by this bot');
 button('Default').focus();expect(tooltip.hidden).toBe(true);
});
it('renders every runtime model name, including a name that looks like fixture copy',async()=>{
 catalog.models.push({id:'unusual-runtime-name',name:'Runtime catalog fixture',isDefault:false,efforts:null});await open();
 expect(button('Runtime catalog fixture')).toBeDefined();button('Runtime catalog fixture').click();await settle();
 expect(configure).toHaveBeenCalledWith('A',{codexModel:'unusual-runtime-name'});
});
it('shows Claude\'s "default" alias once, as Default, and saves no model for it',async()=>{
 settings.model='default';
 catalog.models=[{id:'default',name:'Default (recommended)',isDefault:true,efforts:['low']},{id:'opus',name:'Opus 5.5',isDefault:false,efforts:['low']}];
 await open('Claude');
 const names=[...document.querySelectorAll('.model-choice .model-name')].map(n=>n.textContent);
 expect(names).toEqual(['Default','Opus 5.5']);
 expect(document.querySelector('.model-choice')!.getAttribute('aria-pressed')).toBe('true');
 expect(document.querySelector('.model-choice small')!.textContent).toBe('Recommended');
 button('Opus 5.5').click(); await settle();
 button('Default').click(); await settle();
 expect(configure).toHaveBeenLastCalledWith('A',{model:null});
});
