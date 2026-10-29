import {composerHost, type ModelEngine, type ModelPreferences, type ModelCatalog, type ModelChange} from './composer-host';
const fields = {claude:'model',codex:'codexModel',agy:'agyModel'} as const;
const labels: Record<string,string> = {default:'Default',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Max'};
const order = ['low','medium','high','xhigh','max'];
/** Effort is shared: offer the intersection, never guess absent model capabilities. */
export function supportedEfforts(settings: ModelPreferences, catalogs: Partial<Record<ModelEngine,ModelCatalog>>): (string|null)[] {
 const supported = settings.engines.map(engine=>{
  if(engine==='agy') return ['low','medium','high'];
  const catalog=catalogs[engine];
  const model=catalog?.status==='ready' ? catalog.models.find(m=>settings[fields[engine]] ? m.id===settings[fields[engine]] : m.isDefault) : undefined;
  const levels=model?.efforts ?? [];
  return engine==='codex' && levels.includes('xhigh') ? [...levels,'max'] : levels;
 });
 return [null,...order.filter(level=>supported.length>0 && supported.every(levels=>levels.includes(level)))];
}
export class ComposerModels {
 private panel: HTMLElement|null=null;
 private lifetime: AbortController|null=null;
 private generation=0;
 private bot='';
 private engine: ModelEngine='claude';
 private settings: ModelPreferences|null=null;
 private catalogs: Partial<Record<ModelEngine,ModelCatalog>>={};
 private loading=false;
 private error='';
 private pending=new Set<string>();
 constructor(private root:HTMLElement, private changed:()=>void) {}
 isOpen(bot:string,engine:string):boolean {return !!this.panel && this.bot===bot && this.engine===engine;}
 blocked(bot:string):boolean {return this.pending.has(bot);}
 update(bot:string,engines:string[]):void {if(this.panel && (bot!==this.bot || !engines.includes(this.engine))) this.close(false);}
 close(focus=true):void {
  ++this.generation; this.lifetime?.abort();this.lifetime=null;this.panel?.remove();this.panel=null;
  this.root.querySelectorAll('.answer-menu').forEach(el=>el.setAttribute('aria-expanded','false'));
  if(focus) this.root.querySelector<HTMLButtonElement>(`.answer-menu[data-engine="${this.engine}"]`)?.focus();
 }
 async open(bot:string,engine:ModelEngine,label:string):Promise<void> {
  if(this.panel && bot===this.bot && engine===this.engine){this.close();return;}
  this.close(false);this.bot=bot;this.engine=engine;
  this.settings=null;this.catalogs={};this.error='';
  this.panel=document.createElement('div');this.panel.className='model-popover';
  this.panel.setAttribute('role','dialog');this.panel.setAttribute('aria-label',`${label} model and effort`);
  this.panel.tabIndex=-1; this.root.append(this.panel);
  const anchor=this.root.querySelector(`.answer-menu[data-engine="${engine}"]`)?.getBoundingClientRect();
  if(anchor){const root=this.root.getBoundingClientRect();this.panel.style.left=`${Math.max(8,Math.min(anchor.left-root.left,root.width-268))}px`;this.panel.style.bottom=`${root.bottom-anchor.top+8}px`;}
  this.root.querySelector(`.answer-menu[data-engine="${engine}"]`)?.setAttribute('aria-expanded','true');
  this.lifetime=new AbortController();
  document.addEventListener('pointerdown',event=>{if(!this.panel?.contains(event.target as Node) && !(event.target as Element).closest?.('.answer-menu'))this.close(false);},{signal:this.lifetime.signal});
  this.panel.addEventListener('keydown',event=>{
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.close();}
   if(['ArrowDown','ArrowUp','Home','End'].includes(event.key) && (event.target as Element).closest('.model-choice')){
    const choices=[...this.panel!.querySelectorAll<HTMLButtonElement>('.model-choice:not(:disabled)')];
    const at=choices.indexOf(event.target as HTMLButtonElement);
    const next=event.key==='Home'?0:event.key==='End'?choices.length-1:(at+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length;
    event.preventDefault();choices[next]?.focus();
   }
   if(event.key==='Tab') {
    const controls=[...this.panel!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')];
    if(controls.length && ((event.shiftKey && document.activeElement===controls[0]) || (!event.shiftKey && document.activeElement===controls.at(-1)))){event.preventDefault();(event.shiftKey?controls.at(-1):controls[0])!.focus();}
   }
  });
  const loading=this.load(),epoch=this.generation; await loading;
  if(this.panel && epoch===this.generation) this.panel.querySelector<HTMLButtonElement>('button')?.focus();
 }
 private async load():Promise<void> {
  const epoch=++this.generation,bot=this.bot;
  this.loading=true;this.error='';this.draw();
  try {
   const settings=await composerHost!.modelSettings!(bot);
   if(epoch!==this.generation)return;
   this.settings=settings;this.draw();
   const results=await Promise.all(settings.engines.map(async engine=>[engine,await composerHost!.modelCatalog!(bot,engine).catch(()=>({status:'error',message:'Could not load models. Retry.',models:[]}))] as const));
   if(epoch!==this.generation)return;
   this.catalogs=Object.fromEntries(results);
  } catch(error){if(epoch===this.generation)this.error=String(error instanceof Error?error.message:error);}
  finally{if(epoch===this.generation){this.loading=false;this.draw();}}
 }
 private async save(change:ModelChange):Promise<void> {
  const bot=this.bot,epoch=this.generation;
  const focus=(document.activeElement as HTMLElement)?.dataset.focus;
  if(this.pending.has(bot))return;
  this.pending.add(bot);this.error='';this.changed();this.draw();
  try {
   const settings=await composerHost!.configureModels!(bot,change);
   if(epoch===this.generation){this.settings=settings;}
  }catch(error){if(epoch===this.generation)this.error=error instanceof Error?error.message:String(error);}
  finally{
   this.pending.delete(bot);this.changed();
   if(epoch===this.generation){this.draw();if(focus)[...this.panel?.querySelectorAll<HTMLElement>('[data-focus]')??[]].find(el=>el.dataset.focus===focus)?.focus();}
   else if(this.panel && this.bot===bot) void this.load();
  }
 }
 private draw():void {
  const panel=this.panel;if(!panel)return;
  const focused=(document.activeElement as HTMLElement)?.dataset.focus;
  panel.replaceChildren();
  const busy=this.pending.has(this.bot);
  const button=(label:string,run:()=>void,focus:string)=>{const el=document.createElement('button');el.type='button';el.textContent=label;el.setAttribute('aria-label',label);el.dataset.focus=focus;el.disabled=busy;el.onclick=run;return el;};
  const settings=this.settings;
  if(settings){
   const value=settings[fields[this.engine]];
   const catalog=this.catalogs[this.engine];
   const models=catalog?.status==='ready'?catalog.models:[];
   const rows=document.createElement('div');rows.className='model-choices';rows.setAttribute('role','group');rows.setAttribute('aria-label','Model');panel.append(rows);
   const choice=(id:string|null,name:string,missing=false)=>{
    const row=button(name,()=>void this.save({[fields[this.engine]]:id}),`model:${id ?? ''}`);row.className='model-choice';row.title=id??name;
    row.setAttribute('aria-pressed',String(id===value));
    const mark=document.createElement('span');mark.className='model-check';mark.textContent=id===value?'✓':'';mark.setAttribute('aria-hidden','true');row.prepend(mark);
    if(missing){const note=document.createElement('small');note.textContent=this.loading?'Saved':'Saved · not in current list';row.append(note);}
    rows.append(row);
   };
   choice(null,'Default');
   if(value && !models.some(m=>m.id===value))choice(value,value,true);
   models.forEach(m=>choice(m.id,m.name));
   const levels=supportedEfforts(settings,this.catalogs);
   const selected=levels.indexOf(settings.effort);
   const section=document.createElement('div');section.className='model-effort';
   const heading=document.createElement('div');heading.className='effort-heading';
   const caption=button('Effort',()=>{},'effort-scope');caption.className='effort-caption';
   const scope=document.createElement('span');scope.id='composer-effort-scope';scope.className='effort-tooltip';scope.setAttribute('role','tooltip');scope.textContent='Shared by this bot';scope.hidden=true;
   caption.setAttribute('aria-describedby',scope.id);
   caption.onfocus=caption.onmouseenter=()=>{scope.hidden=false;};
   caption.onblur=()=>{scope.hidden=!caption.matches(':hover');};
   caption.onmouseleave=()=>{scope.hidden=document.activeElement!==caption;};
   const separator=document.createElement('span');separator.className='effort-separator';separator.textContent='·';separator.setAttribute('aria-hidden','true');
   const output=document.createElement('span');output.className='effort-value';
   const current=labels[settings.effort??'default']??settings.effort;
   const unavailable=settings.engines.includes('agy') && ['xhigh','max'].includes(settings.effort??'') ? 'unsupported' : 'not reported';
   output.textContent=selected<0?`${current} · ${unavailable}`:current;
   const track=document.createElement('div');track.className='effort-track';
   const slider=document.createElement('input');slider.id='composer-effort';slider.type='range';slider.min='0';slider.max=String(levels.length-1);slider.step='1';slider.value=String(Math.max(0,selected));slider.dataset.focus='effort';
   slider.disabled=busy||this.loading||levels.length<2;slider.setAttribute('aria-label','Reasoning effort, shared by this bot');
   const reflect=()=>{const index=Math.max(0,Math.min(levels.length-1,Math.round(Number(slider.value))));slider.value=String(index);const label=labels[levels[index]??'default'];output.textContent=label;slider.setAttribute('aria-valuetext',label);track.style.setProperty('--progress',`${levels.length>1?index/(levels.length-1)*100:0}%`);};
   reflect();if(selected<0){output.textContent=this.loading?current:`${current} · ${unavailable}`;slider.setAttribute('aria-valuetext',output.textContent);}
   slider.oninput=reflect;
   slider.onchange=()=>{reflect();void this.save({effort:levels[Number(slider.value)]});};
   slider.onkeydown=event=>{
    const next=event.key==='Home'?0:event.key==='End'?levels.length-1:['ArrowRight','ArrowUp'].includes(event.key)?Number(slider.value)+1:['ArrowLeft','ArrowDown'].includes(event.key)?Number(slider.value)-1:null;
    if(next===null || slider.disabled)return;event.preventDefault();slider.value=String(Math.max(0,Math.min(levels.length-1,next)));reflect();void this.save({effort:levels[Number(slider.value)]});
   };
   const dots=document.createElement('div');dots.className='effort-dots';dots.setAttribute('aria-hidden','true');levels.forEach(()=>dots.append(document.createElement('i')));
   heading.append(caption,separator,output,scope);
   track.append(slider,dots);section.append(heading,track);
   if(selected<0 && !this.loading) section.append(button('Use default',()=>void this.save({effort:null}),'default-effort'));
   panel.append(section);
  }
  const catalog=this.catalogs[this.engine];
  const message=busy?'Saving…':this.error|| (this.loading?'Loading…':catalog?.status!=='ready'?catalog?.message??'':catalog.models.length?'':'No models returned');
  const retry=!!this.error || !!(catalog && catalog.status!=='ready');
  const refresh=button(retry?'Retry':'Refresh models',()=>void this.load(),'refresh');refresh.disabled=busy||this.loading;
  if(!retry){
   refresh.className='model-refresh';refresh.title='Refresh models';
   refresh.innerHTML='<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 6a5 5 0 1 0 .2 3M13 2v4H9"/></svg>';
  }
  if(message){
   const footer=document.createElement('div');footer.className='model-footer';
   const status=document.createElement('span');status.setAttribute('role','status');status.textContent=message;
   footer.append(status,refresh);panel.append(footer);
  } else panel.querySelector('.effort-heading')?.append(refresh);
  if(focused) [...panel.querySelectorAll<HTMLElement>('[data-focus]')].find(el=>el.dataset.focus===focused)?.focus();
 }
}
