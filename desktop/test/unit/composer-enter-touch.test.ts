// @vitest-environment jsdom
// Return in the chat box: on a phone's on-screen keyboard it is a new line and only the Send button sends; with a
// physical keyboard (a desktop, an iPad's keyboard) Return sends and Shift+Return is a new line. An input method's
// Return (choosing a Zhuyin / Pinyin candidate) never sends on either.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Composer } from '../../../Web/src/composer';
import { setComposerHost } from '../../../Web/src/composer-host';
import type { ChatState } from '../../../Web/src/types';

const state = (botID = 'A') => ({ botID, placeholder: 'Message', pendingFiles: [], replyingTo: null } as unknown as ChatState);
let composer: Composer | undefined;
let media: Record<string, boolean>;
beforeEach(() => {
  media = {};
  window.matchMedia = ((query: string) => ({ matches: media[query] ?? false, media: query, addEventListener() {}, removeEventListener() {} })) as any;
});
afterEach(() => { composer?.view.destroy(); composer = undefined; document.body.innerHTML = ''; setComposerHost(null); delete (window as any).matchMedia; });

/** A phone: touch only, no hover, no fine pointer anywhere. */
const phone = () => { media['(hover: none) and (pointer: coarse)'] = true; media['(any-pointer: fine)'] = false; };
function setup() {
  const send = vi.fn(async () => {});
  setComposerHost({ send });
  composer = new Composer(document.body); composer.update(state()); composer.setText('first line');
  return send;
}
const key = (fields: Partial<KeyboardEventInit> & { keyCode?: number }) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...fields });
  if (fields.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: fields.keyCode });
  composer!.view.contentDOM.dispatchEvent(event);
  return event;
};

it('on a phone, Return is a new line: nothing is sent and the Return key says "return"', () => {
  phone();
  const send = setup();
  key({ key: 'Enter', keyCode: 13 });
  expect(send).not.toHaveBeenCalled();
  expect(composer!.view.contentDOM.getAttribute('enterkeyhint')).toBe('enter');
  // The Send button still sends.
  document.querySelector<HTMLButtonElement>('.send')!.click();
  expect(send).toHaveBeenCalledTimes(1);
});

it('on a phone, an input method confirming a candidate with Return never sends', () => {
  phone();
  const send = setup();
  key({ key: 'Enter', keyCode: 229, isComposing: true });
  expect(send).not.toHaveBeenCalled();
});

it('on a desktop, Return sends and Shift+Return does not', () => {
  const send = setup();
  key({ key: 'Enter', shiftKey: true, code: 'Enter', keyCode: 13 });
  expect(send).not.toHaveBeenCalled();
  key({ key: 'Enter', code: 'Enter', keyCode: 13 });
  expect(send).toHaveBeenCalledTimes(1);
  expect(composer!.view.contentDOM.getAttribute('enterkeyhint')).toBe('send');
});

it('a touch device typing on a physical keyboard (an iPad keyboard) sends with Return once that keyboard is seen', () => {
  phone();
  const send = setup();
  // Letters from a physical keyboard name their key (`code`); an on-screen keyboard's do not.
  key({ key: 'a', code: 'KeyA', keyCode: 65 });
  key({ key: 'Enter', code: 'Enter', keyCode: 13 });
  expect(send).toHaveBeenCalledTimes(1);
});

it('an on-screen keyboard\'s letters (no key code) do not count as a physical keyboard', () => {
  phone();
  const send = setup();
  key({ key: 'a', code: '', keyCode: 65 });
  key({ key: 'Unidentified', code: '', keyCode: 229 });
  key({ key: 'Enter', code: '', keyCode: 13 });
  expect(send).not.toHaveBeenCalled();
});
