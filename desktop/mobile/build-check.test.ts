// @vitest-environment jsdom
// A home-screen app iOS only suspended keeps the old web.js: when it comes back and the server has a new build, the page
// is told to reload; with the same build, an unknown answer, or a dev page without a build id, nothing happens.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageBuild, serverBuild, watchBuild } from './build-check';

const answer = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => { document.head.innerHTML = ''; });

describe('a new deploy reaching the home-screen app', () => {
  it('reads the build stamped in the page, and none from a page without one', () => {
    expect(pageBuild()).toBeNull();
    document.head.innerHTML = '<meta name="botling-build" content="53c33a0af330ad8d">';
    expect(pageBuild()).toBe('53c33a0af330ad8d');
    document.head.innerHTML = '<meta name="botling-build" content="__BOTLING_BUILD__">';
    expect(pageBuild()).toBeNull();
  });

  it('asks for version.json past every cache, and reads 410 as this page being gone', async () => {
    const fetcher = answer(200, { build: 'aaaaaaaa11111111' });
    expect(await serverBuild(fetcher)).toBe('aaaaaaaa11111111');
    expect(fetcher).toHaveBeenCalledWith('./version.json', expect.objectContaining({ cache: 'no-store', credentials: 'omit' }));
    expect(await serverBuild(answer(410))).toBe('gone');
    expect(await serverBuild(answer(404))).toBeNull();
    expect(await serverBuild(answer(200, { build: '<script>' }))).toBeNull();
    expect(await serverBuild(vi.fn(async () => { throw new TypeError('offline'); }))).toBeNull();
  });

  it('when the page comes back with a newer build on the server, asks once for a reload', async () => {
    let time = 100_000;
    const fetcher = answer(200, { build: 'bbbbbbbb22222222' }), reload = vi.fn();
    const stop = watchBuild(reload, { fetcher, build: 'aaaaaaaa11111111', now: () => time });
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    time += 60_000; window.dispatchEvent(new Event('pageshow')); await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it('the same build, an unknown answer or a page without a build id: no reload, and looks are spaced out', async () => {
    let time = 100_000;
    const same = answer(200, { build: 'aaaaaaaa11111111' }), reload = vi.fn();
    const stop = watchBuild(reload, { fetcher: same, build: 'aaaaaaaa11111111', now: () => time });
    window.dispatchEvent(new Event('pageshow')); window.dispatchEvent(new Event('online')); await settle();
    expect(same).toHaveBeenCalledTimes(1);
    time += 31_000; document.dispatchEvent(new Event('visibilitychange')); await settle();
    expect(same).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
    stop();
    const unknown = answer(503);
    const stop2 = watchBuild(reload, { fetcher: unknown, build: 'aaaaaaaa11111111', now: () => time });
    window.dispatchEvent(new Event('pageshow')); await settle();
    expect(reload).not.toHaveBeenCalled();
    stop2();
    const none = answer(200, { build: 'bbbbbbbb22222222' });
    const stop3 = watchBuild(reload, { fetcher: none });
    window.dispatchEvent(new Event('pageshow')); await settle();
    expect(none).not.toHaveBeenCalled();
    stop3();
  });

  it('the bridge answering 410 (its previous generation) asks for a reload too', async () => {
    const reload = vi.fn();
    const stop = watchBuild(reload, { fetcher: answer(410), build: 'aaaaaaaa11111111', now: () => 100_000 });
    window.dispatchEvent(new Event('pageshow')); await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });
});
