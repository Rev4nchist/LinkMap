import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Stub chrome with a getURL that mimics the extension's local favicon route.
globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://abc123${p}` },
  tabs: {}, tabGroups: {}, windows: {},
  storage: { local: {} }, alarms: {}, commands: {}, sidePanel: {},
};

const { getFaviconUrl } = await import('../shared/constants.js');

describe('getFaviconUrl — local favicons, no third-party egress (SM-1)', () => {
  it('returns the native favIconUrl when present', () => {
    assert.equal(
      getFaviconUrl({ favIconUrl: 'https://site.com/fav.ico', url: 'https://site.com' }),
      'https://site.com/fav.ico'
    );
  });

  it('falls back to the on-device _favicon route, never google.com', () => {
    const result = getFaviconUrl({ favIconUrl: '', url: 'https://example.com/page' });
    assert.ok(!result.includes('google.com'), 'must not call out to google.com');
    assert.ok(result.includes('/_favicon/'), 'uses the local _favicon route');
    assert.ok(
      result.includes(encodeURIComponent('https://example.com/page')),
      'passes the page URL to the local resolver'
    );
  });

  it('returns a non-network default for non-http tabs', () => {
    const result = getFaviconUrl({ favIconUrl: '', url: 'chrome://newtab/' });
    assert.ok(!result.includes('google.com'), 'no third-party request for chrome:// tabs');
  });
});
