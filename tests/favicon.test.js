import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Stub chrome with a getURL that mimics the extension's local favicon route.
globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://abc123${p}` },
  tabs: {}, tabGroups: {}, windows: {},
  storage: { local: {} }, alarms: {}, commands: {}, sidePanel: {},
};

const { DEFAULT_FAVICON, getFaviconUrl } = await import('../shared/constants.js');

describe('getFaviconUrl — local favicons, no third-party egress (SM-1)', () => {
  it('returns the native favIconUrl when present', () => {
    assert.equal(
      getFaviconUrl({ favIconUrl: 'https://site.com/fav.ico', url: 'https://site.com' }),
      'https://site.com/fav.ico'
    );
  });

  for (const url of [
    'http://example.com/page',
    'https://example.com/page',
    'file:///C:/Favicons/space%20and-%E2%9C%93.html',
  ]) {
    it(`routes ${new URL(url).protocol} through the on-device _favicon route`, () => {
      const result = getFaviconUrl({ favIconUrl: '', url });
      assert.ok(!result.includes('google.com'), 'must not call out to google.com');
      assert.ok(result.includes('/_favicon/'), 'uses the local _favicon route');
      assert.ok(result.includes(encodeURIComponent(url)), 'passes the page URL to the local resolver');
    });
  }

  for (const url of [
    'data:text/html,hello',
    'blob:https://example.com/id',
    'view-source:https://example.com/',
    'javascript:void(0)',
    'chrome://newtab/',
    'chrome-extension://abc123/page.html',
    'about:blank',
    'edge://newtab/',
    'devtools://devtools/bundled/inspector.html',
  ]) {
    it(`uses the default for ${url.split(':')[0]} URLs`, () => {
      assert.equal(getFaviconUrl({ favIconUrl: '', url }), DEFAULT_FAVICON);
    });
  }
});
