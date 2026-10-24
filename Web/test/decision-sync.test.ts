import { describe, expect, it } from 'vitest';
import { answerAction } from '../src/components';
import { messageElement } from '../src/messages';
import type { MessageView } from '../src/types';

describe('shared handoff decisions', () => {
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
