import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockElement, MockTextNode, setupMockDOM } from './helpers/mock-dom.js';

// Setup global DOM mocks before any imports
const doc = setupMockDOM();
doc.getElementById = () => new MockElement('div');

globalThis.chrome = {
  runtime: {
    sendMessage: () => Promise.resolve(),
    onMessage: { addListener() {} },
  },
  storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
};

Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: () => Promise.resolve() } },
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Import modules under test (top-level await)
// ---------------------------------------------------------------------------

const { renderTree, patchElement } = await import('../sidepanel/modules/tree-renderer.js');
const { initKeyboardNav } = await import('../sidepanel/modules/keyboard-nav.js');
const { initSearch } = await import('../sidepanel/modules/search.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides = {}) {
  return {
    tabs: {},
    rootIds: [],
    collapsed: [],
    groupColors: {},
    theme: 'midnight',
    activeTabId: null,
    ...overrides,
  };
}

function makeTabNode(id, overrides = {}) {
  return {
    tabId: id,
    parentId: null,
    children: [],
    title: `Tab ${id}`,
    url: `https://example.com/${id}`,
    favIconUrl: `https://example.com/favicon-${id}.png`,
    pinned: false,
    audible: false,
    status: 'complete',
    groupId: -1,
    index: 0,
    windowId: 1,
    ...overrides,
  };
}

function makeContainers() {
  const container = new MockElement('main');
  const pinnedList = new MockElement('div');
  return { container, pinnedList };
}

function findAll(container, className) {
  return container.querySelectorAll(`.${className}`);
}

// ---------------------------------------------------------------------------
// A1: ARIA tree roles
// ---------------------------------------------------------------------------

describe('A1: ARIA tree roles', () => {

  it('tab entries have role="treeitem"', () => {
    const state = makeState({
      tabs: { 1: makeTabNode(1), 2: makeTabNode(2) },
      rootIds: [1, 2],
    });
    const { container, pinnedList } = makeContainers();
    renderTree(state, null, container, pinnedList);

    const entries = findAll(container, 'tab-entry');
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.equal(entry.getAttribute('role'), 'treeitem',
        'tab-entry should have role="treeitem"');
    }
  });

  it('tab entries have tabindex="-1"', () => {
    const state = makeState({
      tabs: { 1: makeTabNode(1) },
      rootIds: [1],
    });
    const { container, pinnedList } = makeContainers();
    renderTree(state, null, container, pinnedList);

    const entry = findAll(container, 'tab-entry')[0];
    assert.equal(entry.getAttribute('tabindex'), '-1',
      'tab-entry should have tabindex="-1"');
  });

  it('chevron has aria-expanded="false" when collapsed', () => {
    const state = makeState({
      tabs: {
        1: makeTabNode(1, { children: [2] }),
        2: makeTabNode(2, { parentId: 1 }),
      },
      rootIds: [1],
      collapsed: [1],
    });
    const { container, pinnedList } = makeContainers();
    renderTree(state, null, container, pinnedList);

    const chevron = container.querySelector('.tab-chevron');
    assert.ok(chevron, 'should find a .tab-chevron element');
    assert.equal(chevron.getAttribute('aria-expanded'), 'false',
      'collapsed chevron should have aria-expanded="false"');
  });

  it('chevron has aria-expanded="true" when expanded', () => {
    const state = makeState({
      tabs: {
        1: makeTabNode(1, { children: [2] }),
        2: makeTabNode(2, { parentId: 1 }),
      },
      rootIds: [1],
      collapsed: [],
    });
    const { container, pinnedList } = makeContainers();
    renderTree(state, null, container, pinnedList);

    const chevron = container.querySelector('.tab-chevron');
    assert.ok(chevron, 'should find a .tab-chevron element');
    assert.equal(chevron.getAttribute('aria-expanded'), 'true',
      'expanded chevron should have aria-expanded="true"');
  });

  it('active tab has aria-current="page"', () => {
    const state = makeState({
      tabs: { 1: makeTabNode(1), 2: makeTabNode(2) },
      rootIds: [1, 2],
    });
    const { container, pinnedList } = makeContainers();
    renderTree(state, 1, container, pinnedList);

    const entries = findAll(container, 'tab-entry');
    const activeEntry = entries.find(e => e.dataset.tabId === '1');
    const inactiveEntry = entries.find(e => e.dataset.tabId === '2');

    assert.equal(activeEntry.getAttribute('aria-current'), 'page',
      'active tab should have aria-current="page"');
    assert.equal(inactiveEntry.getAttribute('aria-current'), null,
      'inactive tab should NOT have aria-current');
  });

  it('patchElement syncs aria-expanded on chevron', () => {
    const stateCollapsed = makeState({
      tabs: {
        1: makeTabNode(1, { children: [2] }),
        2: makeTabNode(2, { parentId: 1 }),
      },
      rootIds: [1],
      collapsed: [1],
    });
    const stateExpanded = makeState({
      tabs: {
        1: makeTabNode(1, { children: [2] }),
        2: makeTabNode(2, { parentId: 1 }),
      },
      rootIds: [1],
      collapsed: [],
    });

    const { container: c1, pinnedList: p1 } = makeContainers();
    const { container: c2, pinnedList: p2 } = makeContainers();

    renderTree(stateCollapsed, null, c1, p1);
    renderTree(stateExpanded, null, c2, p2);

    const existingEntry = findAll(c1, 'tab-entry')[0];
    const incomingEntry = findAll(c2, 'tab-entry')[0];

    const chevronBefore = existingEntry.querySelector('.tab-chevron');
    assert.equal(chevronBefore.getAttribute('aria-expanded'), 'false');

    patchElement(existingEntry, incomingEntry);

    const chevronAfter = existingEntry.querySelector('.tab-chevron');
    assert.equal(chevronAfter.getAttribute('aria-expanded'), 'true',
      'patchElement should sync aria-expanded attribute on chevron');
  });

  it('patchElement syncs aria-current on tab entry', () => {
    const state1 = makeState({
      tabs: { 1: makeTabNode(1) },
      rootIds: [1],
    });
    const state2 = makeState({
      tabs: { 1: makeTabNode(1) },
      rootIds: [1],
    });

    const { container: c1, pinnedList: p1 } = makeContainers();
    const { container: c2, pinnedList: p2 } = makeContainers();

    renderTree(state1, null, c1, p1);
    renderTree(state2, 1, c2, p2);

    const existing = findAll(c1, 'tab-entry')[0];
    const incoming = findAll(c2, 'tab-entry')[0];

    assert.equal(existing.getAttribute('aria-current'), null, 'pre-patch: no aria-current');

    patchElement(existing, incoming);

    assert.equal(existing.getAttribute('aria-current'), 'page',
      'patchElement should sync aria-current="page" to active tab');
  });
});

// ---------------------------------------------------------------------------
// A3: Keyboard focus -- screen reader support
// ---------------------------------------------------------------------------

describe('A3: Keyboard focus calls element.focus()', () => {

  it('updateFocusRing calls focus() on the focused element', () => {
    const treeContainer = new MockElement('main');
    const entry1 = new MockElement('div');
    entry1.className = 'tab-entry';
    entry1.dataset.tabId = '1';
    entry1.setAttribute('tabindex', '-1');
    const entry2 = new MockElement('div');
    entry2.className = 'tab-entry';
    entry2.dataset.tabId = '2';
    entry2.setAttribute('tabindex', '-1');
    treeContainer.appendChild(entry1);
    treeContainer.appendChild(entry2);

    const searchInput = new MockElement('input');
    let focusedId = 1;

    const { updateFocusRing } = initKeyboardNav({
      treeContainer,
      searchInput,
      getFocusedTabId: () => focusedId,
      setFocusedTabId: (id) => { focusedId = id; },
      getCurrentState: () => ({ tabs: {}, collapsed: [] }),
    });

    updateFocusRing();

    assert.equal(entry1._focused, true,
      'updateFocusRing should call .focus() on the focused element');
    assert.equal(entry2._focused, false,
      'non-focused element should not have focus');
  });
});

// ---------------------------------------------------------------------------
// A4: Search result announcements
// ---------------------------------------------------------------------------

describe('A4: Search result announcements', () => {

  it('initSearch creates an aria-live region', () => {
    const inputEl = new MockElement('input');
    const parent = new MockElement('div');
    parent.appendChild(inputEl);
    const treeContainer = new MockElement('main');

    initSearch(inputEl, treeContainer, () => null, () => {});

    // Check that an aria-live element was appended to the input's parent
    const liveRegion = parent.children.find(
      c => c.getAttribute && c.getAttribute('aria-live') === 'polite'
    );
    assert.ok(liveRegion, 'should create an aria-live="polite" region');
    assert.equal(liveRegion.getAttribute('aria-atomic'), 'true',
      'live region should have aria-atomic="true"');
    assert.ok(liveRegion.className.includes('sr-only'),
      'live region should have sr-only class');
  });
});
