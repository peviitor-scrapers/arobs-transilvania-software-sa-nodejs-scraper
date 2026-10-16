import { jest } from '@jest/globals';
import { getHtml, renderHtml, BrowserUnavailable, MODE } from '../../scraper/browser.js';

// Fake Playwright: records calls, returns canned DOM.
function fakePlaywright({ html = '<html>rendered</html>', launchError, gotoError } = {}) {
  const calls = [];
  const page = {
    goto: async (url, opts) => { calls.push(['goto', url, opts]); if (gotoError) throw gotoError; },
    waitForSelector: async (sel, opts) => calls.push(['wait', sel, opts]),
    content: async () => html
  };
  const browser = {
    newContext: async (opts) => { calls.push(['context', opts]); return { newPage: async () => page }; },
    close: async () => calls.push(['close'])
  };
  const loadPlaywright = async () => ({
    chromium: { launch: async () => { if (launchError) throw launchError; return browser; } }
  });
  return { calls, loadPlaywright };
}

describe('renderHtml', () => {
  it('returns the DOM, waits for the selector and closes the browser', async () => {
    const { calls, loadPlaywright } = fakePlaywright();
    const html = await renderHtml('https://x.test/jobs', { waitSelector: '.job', timeoutMs: 1234, loadPlaywright });
    expect(html).toBe('<html>rendered</html>');
    expect(calls).toContainEqual(['goto', 'https://x.test/jobs', { waitUntil: 'networkidle', timeout: 1234 }]);
    expect(calls).toContainEqual(['wait', '.job', { timeout: 1234 }]);
    expect(calls[calls.length - 1]).toEqual(['close']);
  });

  it('closes the browser even when navigation fails', async () => {
    const { calls, loadPlaywright } = fakePlaywright({ gotoError: new Error('nav timeout') });
    await expect(renderHtml('https://x.test', { loadPlaywright })).rejects.toThrow('nav timeout');
    expect(calls).toContainEqual(['close']);
  });

  it('reports a missing playwright package as BrowserUnavailable', async () => {
    const loadPlaywright = async () => { throw new Error("Cannot find package 'playwright'"); };
    await expect(renderHtml('https://x.test', { loadPlaywright })).rejects.toBeInstanceOf(BrowserUnavailable);
  });

  it('reports missing browser binaries as BrowserUnavailable', async () => {
    const { loadPlaywright } = fakePlaywright({ launchError: new Error("browserType.launch: Executable doesn't exist at /x") });
    await expect(renderHtml('https://x.test', { loadPlaywright })).rejects.toBeInstanceOf(BrowserUnavailable);
  });
});

describe('getHtml', () => {
  const quiet = () => {};

  it('static mode never launches a browser', async () => {
    const render = jest.fn();
    const fetchHtml = jest.fn(async () => '<html>static</html>');
    expect(await getHtml('https://x.test', { mode: 'static', render, fetchHtml, log: quiet })).toBe('<html>static</html>');
    expect(render).not.toHaveBeenCalled();
  });

  it('browser mode skips the static fetch', async () => {
    const fetchHtml = jest.fn();
    expect(await getHtml('https://x.test', { mode: 'browser', render: async () => 'DOM', fetchHtml, log: quiet })).toBe('DOM');
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it('auto keeps the static HTML when it has jobs', async () => {
    const render = jest.fn();
    const out = await getHtml('https://x.test', { mode: 'auto', parseOk: () => true, render, fetchHtml: async () => 'S', log: quiet });
    expect(out).toBe('S');
    expect(render).not.toHaveBeenCalled();
  });

  it('auto renders when the static HTML has no jobs', async () => {
    const out = await getHtml('https://x.test', { mode: 'auto', parseOk: () => false, render: async () => 'DOM', fetchHtml: async () => 'S', log: quiet });
    expect(out).toBe('DOM');
  });

  it('auto falls back to the static HTML when no browser is available', async () => {
    const render = async () => { throw new BrowserUnavailable('no chromium'); };
    const out = await getHtml('https://x.test', { mode: 'auto', parseOk: () => false, render, fetchHtml: async () => 'S', log: quiet });
    expect(out).toBe('S');
  });

  it('auto does not swallow real rendering errors', async () => {
    const render = async () => { throw new Error('boom'); };
    await expect(getHtml('https://x.test', { mode: 'auto', parseOk: () => false, render, fetchHtml: async () => 'S', log: quiet })).rejects.toThrow('boom');
  });

  it('rejects an unknown mode', async () => {
    await expect(getHtml('https://x.test', { mode: 'turbo' })).rejects.toThrow(/rendering.mode/);
  });

  it('ships defaulting to static', () => {
    expect(MODE).toBe('static');
  });
});