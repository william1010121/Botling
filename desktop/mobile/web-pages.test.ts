// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Client, RequestFailed } from '../src/renderer/client';
import { COMPONENT_CSP, PANEL_CSP } from '../src/main/card-page';
import { componentHostPage, showInHost } from '../src/renderer/web-pages';
import { WebBridge } from './web-bridge';

const page = '<!doctype html><html data-size="2x2"><head><meta charset="utf-8"><script>window.ok = 1</script></head><body><div id="ccb-root"></div></body></html>';

describe('component pages on the web (no botling-card:// scheme)', () => {
  it('a component page carries the desktop component CSP before any of its own content', () => {
    const html = componentHostPage(page);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${COMPONENT_CSP}">`);
    expect(html.indexOf(COMPONENT_CSP)).toBeLessThan(html.indexOf('<script>'));
    expect(componentHostPage(page, true)).toContain(`content="${PANEL_CSP}"`);
    expect(componentHostPage('<div>x</div>')).toMatch(/^<meta http-equiv="Content-Security-Policy"/);
    // A later, looser policy in the page can only narrow the app's (policies intersect).
    const hostile = componentHostPage('<head></head><meta http-equiv="Content-Security-Policy" content="script-src *">');
    expect(hostile.indexOf(COMPONENT_CSP)).toBeLessThan(hostile.indexOf('script-src *'));
  });
  it('showInHost loads the sandboxed frame host and hands it only the latest page, once loaded', () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const post = vi.fn();
    Object.defineProperty(frame, 'contentWindow', { value: { postMessage: post } });
    showInHost(frame, 'first', 'https://bridge.example/mobile/chat.html');
    showInHost(frame, 'second', 'https://bridge.example/mobile/chat.html');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe('https://bridge.example/mobile/frame-host.html');
    expect(post).not.toHaveBeenCalled();
    frame.dispatchEvent(new Event('load'));
    expect(post.mock.calls).toEqual([[{ botlingHost: 'page', html: 'second' }, '*']]);
  });
  it('the shell never asks the server for a page (card.page stays refused)', async () => {
    const transport = { request: vi.fn() };
    const client = new Client(new WebBridge({ transport }));
    await expect(client.request({ type: 'card.page', html: page })).rejects.toBeInstanceOf(RequestFailed);
    expect(transport.request).not.toHaveBeenCalled();
  });
});
