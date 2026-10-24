import { describe, expect, it } from 'vitest';
import { sent } from '../src/bridge';
import { answerAction, componentPage } from '../src/components';
import { messageElement } from '../src/messages';
import type { MessageView } from '../src/types';

describe('shared handoff decisions', () => {
  it('retains notes from the actual sandboxed component message', () => {
    document.body.innerHTML = '';
    sent.length = 0;
    const row = messageElement({id:'component-notes',role:'bot',text:'Decision',choices:[{label:'Implement',detail:null,recommended:true}],chosen:null,answer:null,open:true,avatar:null,stamp:null,attachments:null,replyTo:null,replyPreview:null,openable:false}, {choices:{template:'<button>Implement</button>',version:0,working:false,updated:false,hasPrevious:false}});
    document.body.append(row);
    const frame = row.querySelector('iframe')!;
    window.dispatchEvent(new MessageEvent('message',{data:{ccb:'answer',index:0,text:'Only reviewed scope'},source:frame.contentWindow}));
    expect(sent).toEqual([{type:'choose',messageID:'component-notes',index:0,text:'Only reviewed scope'}]);
    document.body.innerHTML = '';
  });
  it('preserves option identity inside the injected component API', async () => {
    const page = componentPage('<div></div>', '{}');
    const script = page.slice(page.indexOf('<script>') + 8, page.indexOf('</script>'));
    const posted: unknown[] = [];
    const frame = {addEventListener() {}} as unknown as {ccb: {answer: (value: unknown) => Promise<void>}};
    new Function('window','parent',script)(frame,{postMessage:(value: unknown)=>posted.push(value)});
    await frame.ccb.answer({index:1,text:'Only reviewed scope'});
    expect(posted).toContainEqual({ccb:'answer',index:1,text:'Only reviewed scope',images:[]});
  });
  it('preserves a selected option together with its notes', () => {
    expect(answerAction('view-two', { index: 1, text: 'Only the reviewed design' })).toEqual({ type: 'choose', messageID: 'view-two', index: 1, text: 'Only the reviewed design' });
  });
  it.each(['Only the reviewed design', '(Skipped)', 'My own answer'])('folds both resolved views while unrelated control stays open: %s', answer => {
    const base = {role:'bot',text:'Design approval',choices:[{label:'Implement',detail:null,recommended:true}],chosen:null,answer:null,open:true,avatar:null,stamp:null,attachments:null,replyTo:null,replyPreview:null,openable:false} as MessageView;
    const cards = [messageElement({...base,id:'claude',answer,open:false},{}),messageElement({...base,id:'codex',answer,open:false},{}),messageElement({...base,id:'unrelated'}, {})];
    expect(cards.map(c => !!c.querySelector('.folded-choice'))).toEqual([true,true,false]);
    expect(cards[0].querySelector('.folded-choice')?.textContent).toBe(cards[1].querySelector('.folded-choice')?.textContent);
  });
});
