import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sent } from '../src/bridge';
import { componentPage } from '../src/components';
import { setLanguage } from '../src/i18n';
import { messageElement } from '../src/messages';
import { staticSourcePage } from '../src/source-snapshot';
import { SummaryViewer } from '../src/summary-viewer';
import type { ChatState, MessageView } from '../src/types';

const option = (id:string,label:string) => ({id,label,detail:null,recommended:false});
const message = (id:string,extra:Partial<MessageView>):MessageView => ({id,role:'bot',text:'Design approval',stamp:null,avatar:null,choices:[option('yes','Implement'),option('no','Revise')],chosen:null,answer:null,open:true,attachments:null,replyTo:null,replyPreview:null,openable:false,...extra});
let viewer:SummaryViewer;
beforeEach(()=>{vi.useFakeTimers();setLanguage('en');document.body.innerHTML='';sent.length=0;viewer=new SummaryViewer();});
afterEach(()=>{viewer.close();vi.clearAllTimers();vi.useRealTimers();document.body.innerHTML='';});

it('preserves distinct live card identities and read-only original snapshots for one shared decision',()=>{
  const a=message('claude-view',{decisionID:'claude-view',chosen:0,answer:'Only reviewed scope',open:false,sourceEngine:'claude',sourceAuthor:'Garden'});
  const b=message('codex-view',{decisionID:'claude-view',choices:[option('no','Revise'),option('yes','Implement')],chosen:1,answer:'Only reviewed scope',open:false,sourceEngine:'codex',sourceAuthor:'Garden'});
  const c=message('independent-view',{});
  const state:ChatState={botID:'bot',botName:'Garden',messages:[a,b,c],working:false,avatar:'',placeholder:'',pendingFiles:[],replyingTo:null,components:{}};
  const original=structuredClone(state.messages);
  const live=new Map(state.messages.map(m=>{const row=messageElement(m,{});document.body.append(row);return [m.id,row]}));
  const revealed:string[]=[];
  viewer.open('owner',state,{key:'range',ids:[a.id,b.id,c.id],count:3,state:'ready',bullets:['Reviewed design'],model:'test'},id=>live.get(id)??null,id=>revealed.push(id));
  expect([...document.querySelectorAll<HTMLElement>('.source-message')].map(n=>n.dataset.sourceId)).toEqual([a.id,b.id,c.id]);
  expect([...document.querySelectorAll('.source-picked')].map(n=>n.textContent)).toEqual(['✓ Implement','✓ Implement']);
  expect([...document.querySelectorAll('.source-note')].filter(n=>n.textContent?.includes('Only reviewed scope'))).toHaveLength(2);
  expect(document.querySelectorAll('dialog .source-answer-in-chat')).toHaveLength(1);
  expect(document.querySelector('dialog .choice')).toBeNull();
  expect(state.messages).toEqual(original);
  for(const [id,row] of live) expect(document.querySelector(`.row[data-id="${id}"]`)).toBe(row);
  expect(sent).toEqual([]);
  document.querySelector<HTMLButtonElement>('dialog .source-answer-in-chat')!.click();
  expect(revealed).toEqual([c.id]);expect(sent).toEqual([]);
  live.get(c.id)!.querySelector<HTMLButtonElement>('.choice')!.click();
  expect(sent).toEqual([{type:'choose',messageID:c.id,index:0}]);
});

it('strips the new choice-plus-notes API from static modal snapshots',()=>{
  const live=componentPage('<button onclick="ccb.answer({index:0,text: &quot;Only reviewed scope&quot;})">Implement</button>','{}');
  const snapshot=new DOMParser().parseFromString(staticSourcePage(live),'text/html');
  expect(snapshot.querySelector('script')).toBeNull();
  expect(snapshot.querySelector('[onclick]')).toBeNull();
  expect(snapshot.querySelector('button')?.hasAttribute('disabled')).toBe(true);
  expect(sent).toEqual([]);
});
