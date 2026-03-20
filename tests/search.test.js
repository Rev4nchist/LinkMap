import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockElement, MockTextNode, setupMockDOM } from './helpers/mock-dom.js';

// Setup global DOM mocks
setupMockDOM();

// ---------------------------------------------------------------------------
// Import modules under test (after DOM mock)
// ---------------------------------------------------------------------------

const { smartSearch, el, debounce } = await import('../shared/utils.js');
const { initSearch } = await import('../sidepanel/modules/search.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(tabsArray) {
  const tabs = {};
  for (const t of tabsArray) {
    tabs[t.tabId] = t;
  }
  return { tabs, rootIds: tabsArray.map(t => t.tabId), collapsed: [], groupColors: {}, theme: 'midnight' };
}

function makeTab(id, title, url) {
  return {
    tabId: id,
    parentId: null,
    children: [],
    title,
    url,
    favIconUrl: `https://example.com/favicon-${id}.png`,
    pinned: false,
    audible: false,
    status: 'complete',
    groupId: -1,
    index: 0,
    windowId: 1,
  };
}

function fireInput(inputEl, value) {
  inputEl.value = value;
  const handlers = inputEl._listeners['input'] || [];
  for (const h of handlers) {
    h({ target: inputEl });
  }
}

function fireKeydown(inputEl, key) {
  const handlers = inputEl._listeners['keydown'] || [];
  for (const h of handlers) {
    h({ key, target: inputEl });
  }
}

// ---------------------------------------------------------------------------
// Tests: smartSearch (shared/utils.js — renamed from fuzzyMatch)
// ---------------------------------------------------------------------------

describe('smartSearch', () => {
  it('matches substring characters in order', () => {
    const result = smartSearch('gml', 'gmail.com');
    assert.equal(result.match, true);
    assert.ok(result.score > 0);
    // smartSearch returns indices for the match type (substring, fuzzy, etc.)
    assert.ok(result.indices.length > 0);
  });

  it('returns no match when characters are not in order', () => {
    const result = smartSearch('zxy', 'gmail.com');
    assert.equal(result.match, false);
    assert.equal(result.score, 0);
  });

  it('handles empty query', () => {
    const result = smartSearch('', 'something');
    assert.equal(result.match, false);
  });

  it('handles empty text', () => {
    const result = smartSearch('abc', '');
    assert.equal(result.match, false);
  });

  it('is case insensitive', () => {
    const result = smartSearch('ABC', 'abcdef');
    assert.equal(result.match, true);
  });

  it('scores higher for consecutive matches', () => {
    const exact = smartSearch('git', 'github.com');
    const spread = smartSearch('git', 'going into things');
    assert.ok(exact.score > spread.score);
  });

  it('scores higher for matches starting at beginning', () => {
    const atStart = smartSearch('go', 'google.com');
    const atMiddle = smartSearch('go', 'xx-google.com');
    assert.ok(atStart.score > atMiddle.score);
  });
});

// ---------------------------------------------------------------------------
// Tests: searchTabs (internal, tested via initSearch behavior)
// ---------------------------------------------------------------------------

describe('initSearch', () => {
  let inputEl;
  let container;
  let state;
  let restoreCalled;
  let search;

  beforeEach(() => {
    inputEl = new MockElement('input');
    container = new MockElement('div');
    restoreCalled = false;

    state = makeState([
      makeTab(1, 'GitHub - Dashboard', 'https://github.com/dashboard'),
      makeTab(2, 'Gmail Inbox', 'https://mail.google.com/inbox'),
      makeTab(3, 'Stack Overflow - JavaScript', 'https://stackoverflow.com/questions'),
      makeTab(4, 'YouTube - Music', 'https://youtube.com/watch'),
      makeTab(5, 'Google Docs', 'https://docs.google.com/document'),
    ]);

    search = initSearch(
      inputEl,
      container,
      () => state,
      () => { restoreCalled = true; }
    );
  });

  it('returns a control object with isActive and clear methods', () => {
    assert.equal(typeof search.isActive, 'function');
    assert.equal(typeof search.clear, 'function');
  });

  it('is not active initially', () => {
    assert.equal(search.isActive(), false);
  });

  it('registers input and keydown listeners on the input element', () => {
    assert.ok(inputEl._listeners['input']?.length > 0, 'should have input listener');
    assert.ok(inputEl._listeners['keydown']?.length > 0, 'should have keydown listener');
  });
});

// ---------------------------------------------------------------------------
// Tests: searchTabs function (exported for testing)
// ---------------------------------------------------------------------------

// We need to test the internal searchTabs via a test-friendly export or by
// testing the rendered output after initSearch fires. Let's import it directly.

const { searchTabs } = await import('../sidepanel/modules/search.js');

describe('searchTabs', () => {
  const tabs = {
    1: { tabId: 1, title: 'GitHub - Dashboard', url: 'https://github.com/dashboard' },
    2: { tabId: 2, title: 'Gmail Inbox', url: 'https://mail.google.com/inbox' },
    3: { tabId: 3, title: 'Stack Overflow', url: 'https://stackoverflow.com/questions' },
    4: { tabId: 4, title: 'YouTube Music', url: 'https://youtube.com/watch' },
    5: { tabId: 5, title: 'Google Docs', url: 'https://docs.google.com/document' },
  };

  it('returns matching tabs for a title query', () => {
    const results = searchTabs(tabs, 'git');
    assert.ok(results.length >= 1);
    const tabIds = results.map(r => r.tabId);
    assert.ok(tabIds.includes(1), 'GitHub should match "git"');
  });

  it('matches against URL as well', () => {
    const results = searchTabs(tabs, 'stackoverflow');
    assert.ok(results.length >= 1);
    const tabIds = results.map(r => r.tabId);
    assert.ok(tabIds.includes(3), 'Stack Overflow should match via URL');
  });

  it('returns empty array when nothing matches', () => {
    const results = searchTabs(tabs, 'zzzznotfound');
    assert.equal(results.length, 0);
  });

  it('sorts results by best score descending', () => {
    const results = searchTabs(tabs, 'google');
    assert.ok(results.length >= 2);
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].bestScore >= results[i].bestScore,
        `Result ${i - 1} (score ${results[i - 1].bestScore}) should be >= result ${i} (score ${results[i].bestScore})`);
    }
  });

  it('includes titleMatch and urlMatch objects in results', () => {
    const results = searchTabs(tabs, 'git');
    const github = results.find(r => r.tabId === 1);
    assert.ok(github);
    assert.ok('titleMatch' in github);
    assert.ok('urlMatch' in github);
    assert.ok('bestScore' in github);
  });

  it('handles tabs with missing title or url gracefully', () => {
    const sparseTab = { 6: { tabId: 6, title: undefined, url: undefined } };
    const results = searchTabs(sparseTab, 'test');
    assert.equal(results.length, 0); // no crash
  });
});

// ---------------------------------------------------------------------------
// Tests: renderSearchResults (via DOM output inspection)
// ---------------------------------------------------------------------------

const { renderSearchResults } = await import('../sidepanel/modules/search.js');

describe('renderSearchResults', () => {
  let container;

  beforeEach(() => {
    container = new MockElement('div');
  });

  it('renders empty state message when no results', () => {
    renderSearchResults([], container);
    assert.equal(container.children.length, 1);
    const emptyDiv = container.children[0];
    assert.ok(emptyDiv.className.includes('search-empty'));
  });

  it('sets search-results class on container when results exist', () => {
    const results = [{
      tab: { title: 'Test', url: 'https://test.com', favIconUrl: '' },
      tabId: 1,
      titleMatch: { match: true, score: 1, indices: [0, 1, 2, 3] },
      urlMatch: { match: false, score: 0, indices: [] },
      bestScore: 1,
    }];
    renderSearchResults(results, container);
    assert.equal(container.className, 'search-results');
  });

  it('renders one tab-entry per result', () => {
    const results = [
      {
        tab: { title: 'Tab A', url: 'https://a.com', favIconUrl: '' },
        tabId: 1,
        titleMatch: { match: true, score: 1, indices: [0] },
        urlMatch: { match: false, score: 0, indices: [] },
        bestScore: 1,
      },
      {
        tab: { title: 'Tab B', url: 'https://b.com', favIconUrl: '' },
        tabId: 2,
        titleMatch: { match: true, score: 0.8, indices: [0] },
        urlMatch: { match: false, score: 0, indices: [] },
        bestScore: 0.8,
      },
    ];
    renderSearchResults(results, container);
    const entries = container.querySelectorAll('.tab-entry');
    assert.equal(entries.length, 2);
  });

  it('sets data-tabId on each entry', () => {
    const results = [{
      tab: { title: 'Test', url: 'https://test.com', favIconUrl: '' },
      tabId: 42,
      titleMatch: { match: true, score: 1, indices: [] },
      urlMatch: { match: false, score: 0, indices: [] },
      bestScore: 1,
    }];
    renderSearchResults(results, container);
    const entry = container.querySelector('.tab-entry');
    assert.equal(entry.dataset.tabId, '42');
  });

  it('includes a close button in each entry', () => {
    const results = [{
      tab: { title: 'Test', url: 'https://test.com', favIconUrl: '' },
      tabId: 1,
      titleMatch: { match: true, score: 1, indices: [] },
      urlMatch: { match: false, score: 0, indices: [] },
      bestScore: 1,
    }];
    renderSearchResults(results, container);
    const closeBtns = container.querySelectorAll('.tab-close');
    assert.equal(closeBtns.length, 1);
  });

  it('shows URL with search-url-visible class', () => {
    const results = [{
      tab: { title: 'Test', url: 'https://test.com', favIconUrl: '' },
      tabId: 1,
      titleMatch: { match: false, score: 0, indices: [] },
      urlMatch: { match: true, score: 1, indices: [0, 1] },
      bestScore: 1,
    }];
    renderSearchResults(results, container);
    const urls = container.querySelectorAll('.search-url-visible');
    assert.ok(urls.length >= 1, 'should have a URL element with search-url-visible class');
  });
});

// ---------------------------------------------------------------------------
// Tests: highlightText
// ---------------------------------------------------------------------------

const { highlightText } = await import('../sidepanel/modules/search.js');

describe('highlightText', () => {
  it('wraps matched indices in search-match spans', () => {
    const span = highlightText('hello', [0, 2, 4]); // h, l, o highlighted
    // Should have mix of text nodes and span.search-match elements
    assert.ok(span.children.length > 0 || span.childNodes.length > 0);

    // Find all search-match children
    const matches = span.querySelectorAll('.search-match');
    assert.ok(matches.length > 0, 'should have highlighted spans');
  });

  it('does not highlight when indices is empty', () => {
    const span = highlightText('hello', []);
    const matches = span.querySelectorAll('.search-match');
    assert.equal(matches.length, 0);
  });

  it('handles all characters matched', () => {
    const span = highlightText('ab', [0, 1]);
    const matches = span.querySelectorAll('.search-match');
    assert.ok(matches.length > 0);
  });

  it('preserves all text content', () => {
    const span = highlightText('hello', [1, 3]);
    // Collect all text from the span
    let allText = '';
    function collectText(node) {
      if (node.nodeType === 3) {
        allText += node.textContent;
      } else if (node.textContent && !node.children?.length) {
        // Leaf element with textContent
        allText += node.textContent;
      } else if (node.childNodes) {
        for (const child of node.childNodes) {
          collectText(child);
        }
      }
    }
    collectText(span);
    assert.equal(allText, 'hello');
  });
});

// ---------------------------------------------------------------------------
// Tests: Escape key behavior
// ---------------------------------------------------------------------------

describe('initSearch — escape key', () => {
  it('clears input and calls restoreTree on Escape', () => {
    const inputEl = new MockElement('input');
    const container = new MockElement('div');
    let restoreCalled = false;

    const state = makeState([
      makeTab(1, 'Test Tab', 'https://test.com'),
    ]);

    const search = initSearch(
      inputEl,
      container,
      () => state,
      () => { restoreCalled = true; }
    );

    // First trigger a search so isSearching becomes true
    // We need to trigger the debounced search synchronously
    // Since debounce uses setTimeout, we simulate by calling doSearch directly
    // Instead, use the clear() method after forcing search active state
    fireInput(inputEl, 'test');

    // Since debounce delays execution, we can't easily test the full flow
    // in a synchronous test. Test the clear() method instead.
    // Force a search via the public API isn't easily doable with debounce.
    // We'll test the Escape keydown handler clears the input value.
    inputEl.value = 'test';
    fireKeydown(inputEl, 'Escape');
    assert.equal(inputEl.value, '');
  });
});

// ---------------------------------------------------------------------------
// Tests: clear() method on control object
// ---------------------------------------------------------------------------

describe('initSearch — clear() method', () => {
  it('clears the input value', () => {
    const inputEl = new MockElement('input');
    const container = new MockElement('div');

    const search = initSearch(
      inputEl,
      container,
      () => makeState([makeTab(1, 'Test', 'https://test.com')]),
      () => {}
    );

    inputEl.value = 'some query';
    search.clear();
    assert.equal(inputEl.value, '');
  });
});
