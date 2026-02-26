import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal DOM mock for Node.js testing
// ---------------------------------------------------------------------------

class MockElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.attributes = {};
    this.dataset = {};
    this.className = '';
    this.children = [];
    this.childNodes = [];
    this.textContent = '';
    this.hidden = false;
    this._listeners = {};
    this.style = {};
    this.title = '';
    this.alt = '';
    this.src = '';
    this.width = '';
    this.height = '';
    this.parentNode = null;
  }

  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key === 'src') this.src = value;
    if (key === 'width') this.width = value;
    if (key === 'height') this.height = value;
    if (key === 'alt') this.alt = value;
    if (key === 'title') this.title = value;
  }

  getAttribute(key) {
    return this.attributes[key] ?? null;
  }

  appendChild(child) {
    if (child) {
      this.children.push(child);
      this.childNodes.push(child);
      child.parentNode = this;
    }
    return child;
  }

  replaceChildren(...newChildren) {
    this.children = [];
    this.childNodes = [];
    for (const child of newChildren) {
      if (child) {
        this.children.push(child);
        this.childNodes.push(child);
        child.parentNode = this;
      }
    }
  }

  addEventListener(type, handler) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(handler);
  }

  closest(selector) {
    // Minimal: check class or tag
    let el = this;
    while (el) {
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        if (el.className && el.className.split(' ').includes(cls)) return el;
      }
      el = el.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) {
    const results = [];
    const search = (el) => {
      if (!el.children) return;
      for (const child of el.children) {
        if (!child || !child.tagName) continue; // skip text nodes
        if (selector.startsWith('.')) {
          const cls = selector.slice(1);
          if (child.className && child.className.split(' ').includes(cls)) results.push(child);
        } else if (selector.startsWith('[')) {
          const match = selector.match(/\[([^=]+)(?:="([^"]*)")?\]/);
          if (match) {
            const [, attr, val] = match;
            if (attr.startsWith('data-')) {
              const key = attr.replace('data-', '');
              if (val === undefined || child.dataset[key] === val) results.push(child);
            } else if (child.attributes[attr] !== undefined) {
              if (val === undefined || child.attributes[attr] === val) results.push(child);
            }
          }
        } else if (child.tagName === selector.toUpperCase()) {
          results.push(child);
        }
        search(child);
      }
    };
    search(this);
    return results;
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all[0] ?? null;
  }
}

class MockTextNode {
  constructor(text) {
    this.textContent = text;
    this.nodeType = 3;
    this.parentNode = null;
  }
}

// Setup global DOM mocks
globalThis.document = {
  createElement(tag) { return new MockElement(tag); },
  createTextNode(text) { return new MockTextNode(text); },
};

// ---------------------------------------------------------------------------
// Now import the modules under test (after DOM mock is set up)
// ---------------------------------------------------------------------------

const { el } = await import('../shared/utils.js');
const { renderTree } = await import('../sidepanel/modules/tree-renderer.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal state payload matching getStatePayload() format. */
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

/** Create a tab node object for the state. */
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

/** Creates container and pinnedList mock elements. */
function makeContainers() {
  const container = new MockElement('main');
  const pinnedList = new MockElement('div');
  return { container, pinnedList };
}

/** Count elements matching a class in a container's children tree. */
function findAll(container, className) {
  return container.querySelectorAll(`.${className}`);
}

// ---------------------------------------------------------------------------
// Tests: renderTree
// ---------------------------------------------------------------------------

describe('renderTree', () => {

  describe('empty state', () => {
    it('renders nothing into container when no tabs exist', () => {
      const state = makeState();
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      assert.equal(container.children.length, 0);
      assert.equal(pinnedList.children.length, 0);
    });
  });

  describe('flat list of tabs (no nesting)', () => {
    it('renders each root tab as a .tab-entry', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1),
          2: makeTabNode(2),
          3: makeTabNode(3),
        },
        rootIds: [1, 2, 3],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entries = findAll(container, 'tab-entry');
      assert.equal(entries.length, 3);
    });

    it('sets data-tab-id attribute on each entry', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entry = findAll(container, 'tab-entry')[0];
      assert.equal(entry.dataset.tabId, '1');
    });

    it('sets data-depth="0" for root tabs', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entry = findAll(container, 'tab-entry')[0];
      assert.equal(entry.dataset.depth, '0');
    });

    it('renders tab title text', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1, { title: 'My Page' }) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const titleEl = findAll(container, 'tab-title')[0];
      assert.ok(titleEl, 'should have .tab-title element');
      // Title should contain the text
      const hasText = titleEl.childNodes.some(
        n => n.textContent === 'My Page'
      );
      assert.ok(hasText, 'title element should contain "My Page"');
    });

    it('renders favicon img with src', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1, { favIconUrl: 'https://example.com/icon.png' }) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const favicon = findAll(container, 'tab-favicon')[0];
      assert.ok(favicon, 'should have .tab-favicon element');
      assert.equal(favicon.tagName, 'IMG');
      assert.equal(favicon.attributes.src, 'https://example.com/icon.png');
    });

    it('renders close button', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const closeBtn = findAll(container, 'tab-close')[0];
      assert.ok(closeBtn, 'should have .tab-close element');
      assert.equal(closeBtn.tagName, 'BUTTON');
    });

    it('renders spacer instead of chevron for tabs without children', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const chevrons = findAll(container, 'tab-chevron');
      assert.equal(chevrons.length, 0, 'should have no chevron for leaf tabs');

      // Should have a spacer div instead
      const spacers = findAll(container, 'tab-chevron-spacer');
      assert.equal(spacers.length, 1, 'should have a spacer for leaf tabs');
    });
  });

  describe('active tab highlighting', () => {
    it('sets data-active="true" on the active tab', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1),
          2: makeTabNode(2),
        },
        rootIds: [1, 2],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, 2, container, pinnedList);

      const entries = findAll(container, 'tab-entry');
      const activeEntry = entries.find(e => e.dataset.tabId === '2');
      assert.equal(activeEntry.dataset.active, 'true');

      const inactiveEntry = entries.find(e => e.dataset.tabId === '1');
      assert.equal(inactiveEntry.dataset.active, 'false');
    });
  });

  describe('nested tree structure', () => {
    it('renders children with increasing depth', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { children: [2] }),
          2: makeTabNode(2, { parentId: 1, children: [3] }),
          3: makeTabNode(3, { parentId: 2 }),
        },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entries = findAll(container, 'tab-entry');
      assert.equal(entries.length, 3, 'should render all 3 tabs');

      const depths = entries.map(e => e.dataset.depth);
      assert.deepEqual(depths, ['0', '1', '2']);
    });

    it('shows chevron on parent tabs with children', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { children: [2] }),
          2: makeTabNode(2, { parentId: 1 }),
        },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const chevrons = findAll(container, 'tab-chevron');
      assert.equal(chevrons.length, 1, 'parent should have a chevron');
    });

    it('sets data-collapsed on chevron based on collapsed state', () => {
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

      const chevron = findAll(container, 'tab-chevron')[0];
      assert.equal(chevron.dataset.collapsed, 'true');
    });
  });

  describe('collapsed nodes', () => {
    it('does not render children of collapsed tabs', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { children: [2, 3] }),
          2: makeTabNode(2, { parentId: 1 }),
          3: makeTabNode(3, { parentId: 1 }),
        },
        rootIds: [1],
        collapsed: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entries = findAll(container, 'tab-entry');
      assert.equal(entries.length, 1, 'only the collapsed parent should render');
      assert.equal(entries[0].dataset.tabId, '1');
    });

    it('renders children of non-collapsed parent normally', () => {
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

      const entries = findAll(container, 'tab-entry');
      assert.equal(entries.length, 2);
    });
  });

  describe('pinned tabs', () => {
    it('renders pinned tabs into pinnedList, not tree container', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { pinned: true }),
          2: makeTabNode(2, { pinned: false }),
        },
        rootIds: [1, 2],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      // Pinned list should have 1 pinned tab
      const pinnedTabs = findAll(pinnedList, 'pinned-tab');
      assert.equal(pinnedTabs.length, 1);

      // Tree container should only have the non-pinned tab
      const entries = findAll(container, 'tab-entry');
      assert.equal(entries.length, 1);
      assert.equal(entries[0].dataset.tabId, '2');
    });

    it('renders pinned tab as compact tile with favicon', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { pinned: true, favIconUrl: 'https://pin.com/icon.png' }),
        },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const pinned = findAll(pinnedList, 'pinned-tab')[0];
      assert.ok(pinned, 'should have .pinned-tab element');
      assert.equal(pinned.dataset.tabId, '1');

      // Should contain a favicon img
      const imgs = pinned.querySelectorAll('img');
      assert.equal(imgs.length, 1);
    });

    it('renders empty pinnedList when no pinned tabs', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      assert.equal(pinnedList.children.length, 0);
    });
  });

  describe('tab status indicators', () => {
    it('adds tab-loading class for loading tabs', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1, { status: 'loading' }) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const favicon = findAll(container, 'tab-favicon')[0];
      assert.ok(
        favicon.className.includes('tab-loading'),
        'favicon should have tab-loading class'
      );
    });

    it('adds tab-audible class for audible tabs', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1, { audible: true }) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entry = findAll(container, 'tab-entry')[0];
      assert.ok(
        entry.className.includes('tab-audible'),
        'entry should have tab-audible class'
      );
    });

    it('does not add tab-audible for non-audible tabs', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1, { audible: false }) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entry = findAll(container, 'tab-entry')[0];
      assert.ok(
        !entry.className.includes('tab-audible'),
        'entry should not have tab-audible class'
      );
    });
  });

  describe('favicon fallback', () => {
    it('uses fallback when favIconUrl is empty', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1, { favIconUrl: '' }) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const favicon = findAll(container, 'tab-favicon')[0];
      // Should still render an element (either img with fallback or a div)
      assert.ok(favicon, 'should render a favicon element even without URL');
    });
  });

  describe('replaceChildren behavior', () => {
    it('clears previous content on re-render', () => {
      const state1 = makeState({
        tabs: { 1: makeTabNode(1), 2: makeTabNode(2) },
        rootIds: [1, 2],
      });
      const state2 = makeState({
        tabs: { 3: makeTabNode(3) },
        rootIds: [3],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state1, null, container, pinnedList);
      assert.equal(findAll(container, 'tab-entry').length, 2);

      renderTree(state2, null, container, pinnedList);
      assert.equal(findAll(container, 'tab-entry').length, 1);
      assert.equal(findAll(container, 'tab-entry')[0].dataset.tabId, '3');
    });
  });

  describe('deeply nested tree', () => {
    it('handles 5 levels of nesting', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { children: [2] }),
          2: makeTabNode(2, { parentId: 1, children: [3] }),
          3: makeTabNode(3, { parentId: 2, children: [4] }),
          4: makeTabNode(4, { parentId: 3, children: [5] }),
          5: makeTabNode(5, { parentId: 4 }),
        },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entries = findAll(container, 'tab-entry');
      assert.equal(entries.length, 5);

      const depths = entries.map(e => e.dataset.depth);
      assert.deepEqual(depths, ['0', '1', '2', '3', '4']);
    });
  });

  describe('mixed pinned and nested tabs', () => {
    it('excludes pinned tabs from tree even if they are parents', () => {
      // Pinned tab with a child — child should still render (promoted to root)
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { pinned: true, children: [2] }),
          2: makeTabNode(2, { parentId: 1 }),
        },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      // Pinned tab goes to pinned list
      const pinnedTabs = findAll(pinnedList, 'pinned-tab');
      assert.equal(pinnedTabs.length, 1);

      // Non-pinned child should render in tree
      const entries = findAll(container, 'tab-entry');
      assert.ok(entries.length >= 1, 'child of pinned parent should render in tree');
    });
  });

  describe('order preservation', () => {
    it('renders tabs in rootIds order', () => {
      const state = makeState({
        tabs: {
          3: makeTabNode(3),
          1: makeTabNode(1),
          2: makeTabNode(2),
        },
        rootIds: [3, 1, 2],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entries = findAll(container, 'tab-entry');
      const ids = entries.map(e => e.dataset.tabId);
      assert.deepEqual(ids, ['3', '1', '2']);
    });

    it('renders children in their array order', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { children: [3, 2] }),
          2: makeTabNode(2, { parentId: 1 }),
          3: makeTabNode(3, { parentId: 1 }),
        },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entries = findAll(container, 'tab-entry');
      const ids = entries.map(e => e.dataset.tabId);
      // Parent 1, then children in order: 3, 2
      assert.deepEqual(ids, ['1', '3', '2']);
    });
  });
});
