import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal DOM + Chrome mock (matching existing test patterns)
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
    this.innerHTML = '';
    this.hidden = false;
    this._listeners = {};
    this.style = {};
    this.title = '';
    this.parentNode = null;
  }

  setAttribute(key, value) {
    this.attributes[key] = String(value);
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

  removeEventListener(type, handler) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter(h => h !== handler);
  }

  closest(selector) {
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
    const search = (node) => {
      if (!node.children) return;
      for (const child of node.children) {
        if (!child || !child.tagName) continue;
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
            }
          }
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

  after() { /* no-op for inline prompt */ }
  focus() {}
  select() {}
}

class MockTextNode {
  constructor(text) {
    this.textContent = text;
    this.nodeType = 3;
    this.parentNode = null;
  }
}

// Setup global mocks before importing modules
globalThis.document = {
  createElement(tag) { return new MockElement(tag); },
  createTextNode(text) { return new MockTextNode(text); },
  getElementById() { return new MockElement('div'); },
  addEventListener() {},
  body: new MockElement('body'),
};

globalThis.window = { innerWidth: 1024, innerHeight: 768 };
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  writable: true,
  configurable: true,
});
globalThis.requestAnimationFrame = (fn) => fn();

const messageSent = [];
globalThis.chrome = {
  runtime: {
    sendMessage: async (msg) => { messageSent.push(msg); return {}; },
  },
  tabs: {
    remove: async () => {},
  },
};

// ---------------------------------------------------------------------------
// Import modules under test (after DOM mock)
// ---------------------------------------------------------------------------

const {
  getActiveWorkspaceId,
  getActiveWorkspaceTabIds,
  setWorkspaceState,
  buildWorkspaceMenuItems,
  initWorkspaceUI,
} = await import('../sidepanel/modules/workspace-ui.js');

// ---------------------------------------------------------------------------
// Tests: getActiveWorkspaceTabIds
// ---------------------------------------------------------------------------

describe('getActiveWorkspaceTabIds', () => {
  beforeEach(() => {
    messageSent.length = 0;
  });

  it('returns null when no state is set', () => {
    // Before any setWorkspaceState call, state is null
    // We need to reset module state — re-import won't help due to module cache.
    // Instead we set state with no activeWorkspaceId.
    setWorkspaceState({
      activeWorkspaceId: null,
      workspaces: [],
    });
    const result = getActiveWorkspaceTabIds();
    assert.equal(result, null);
  });

  it('returns null when activeWorkspaceId is falsy', () => {
    setWorkspaceState({
      activeWorkspaceId: '',
      workspaces: [{ id: 'ws-1', name: 'Work', tabIds: [1, 2, 3] }],
    });
    const result = getActiveWorkspaceTabIds();
    assert.equal(result, null);
  });

  it('returns correct Set when workspace is active', () => {
    setWorkspaceState({
      activeWorkspaceId: 'ws-1',
      workspaces: [
        { id: 'ws-1', name: 'Work', tabIds: [10, 20, 30] },
        { id: 'ws-2', name: 'Personal', tabIds: [40, 50] },
      ],
    });
    const result = getActiveWorkspaceTabIds();
    assert.ok(result instanceof Set, 'should return a Set');
    assert.equal(result.size, 3);
    assert.ok(result.has(10));
    assert.ok(result.has(20));
    assert.ok(result.has(30));
    assert.ok(!result.has(40), 'should not include tabs from other workspaces');
  });

  it('returns null for non-existent workspace ID', () => {
    setWorkspaceState({
      activeWorkspaceId: 'ws-nonexistent',
      workspaces: [
        { id: 'ws-1', name: 'Work', tabIds: [1, 2] },
      ],
    });
    const result = getActiveWorkspaceTabIds();
    assert.equal(result, null);
  });

  it('returns empty Set for workspace with no tabs', () => {
    setWorkspaceState({
      activeWorkspaceId: 'ws-empty',
      workspaces: [
        { id: 'ws-empty', name: 'Empty', tabIds: [] },
      ],
    });
    const result = getActiveWorkspaceTabIds();
    assert.ok(result instanceof Set, 'should return a Set');
    assert.equal(result.size, 0);
  });

  it('handles workspace with missing tabIds array', () => {
    setWorkspaceState({
      activeWorkspaceId: 'ws-no-tabs',
      workspaces: [
        { id: 'ws-no-tabs', name: 'No Tabs' },
      ],
    });
    const result = getActiveWorkspaceTabIds();
    assert.ok(result instanceof Set, 'should return a Set');
    assert.equal(result.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Tests: getActiveWorkspaceId
// ---------------------------------------------------------------------------

describe('getActiveWorkspaceId', () => {
  it('returns null when no workspace is active', () => {
    setWorkspaceState({
      activeWorkspaceId: null,
      workspaces: [],
    });
    assert.equal(getActiveWorkspaceId(), null);
  });

  it('returns the active workspace ID', () => {
    setWorkspaceState({
      activeWorkspaceId: 'ws-42',
      workspaces: [{ id: 'ws-42', name: 'Test' }],
    });
    assert.equal(getActiveWorkspaceId(), 'ws-42');
  });

  it('returns null when activeWorkspaceId is empty string', () => {
    setWorkspaceState({
      activeWorkspaceId: '',
      workspaces: [],
    });
    assert.equal(getActiveWorkspaceId(), null);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildWorkspaceMenuItems
// ---------------------------------------------------------------------------

describe('buildWorkspaceMenuItems', () => {
  const mockMenuItems = [];
  const menuItemFn = (label, onClick) => {
    const item = { label, onClick, type: 'menuItem' };
    mockMenuItems.push(item);
    return item;
  };
  const separatorFn = () => ({ type: 'separator' });

  beforeEach(() => {
    mockMenuItems.length = 0;
  });

  it('returns empty array when no workspaces exist', () => {
    setWorkspaceState({
      activeWorkspaceId: null,
      workspaces: [],
    });
    const items = buildWorkspaceMenuItems(1, menuItemFn, separatorFn);
    assert.equal(items.length, 0);
  });

  it('returns menu items for available workspaces', () => {
    setWorkspaceState({
      activeWorkspaceId: null,
      workspaces: [
        { id: 'ws-1', name: 'Work', tabIds: [10, 20] },
        { id: 'ws-2', name: 'Personal', tabIds: [30] },
      ],
    });
    const items = buildWorkspaceMenuItems(99, menuItemFn, separatorFn);
    // Should have: 1 separator + 2 menu items (one per workspace)
    assert.equal(items.length, 3);
    assert.equal(items[0].type, 'separator');
    assert.ok(items[1].label.includes('Work'));
    assert.ok(items[2].label.includes('Personal'));
  });

  it('skips workspace if tab is already in it', () => {
    setWorkspaceState({
      activeWorkspaceId: null,
      workspaces: [
        { id: 'ws-1', name: 'Work', tabIds: [10, 20] },
        { id: 'ws-2', name: 'Personal', tabIds: [30] },
      ],
    });
    // Tab 10 is already in ws-1, so ws-1 should be skipped
    const items = buildWorkspaceMenuItems(10, menuItemFn, separatorFn);
    assert.equal(items.length, 2); // separator + Personal only
    assert.equal(items[0].type, 'separator');
    assert.ok(items[1].label.includes('Personal'));
  });

  it('returns empty when tab is in all workspaces', () => {
    setWorkspaceState({
      activeWorkspaceId: null,
      workspaces: [
        { id: 'ws-1', name: 'Work', tabIds: [10] },
      ],
    });
    // Tab 10 is already in the only workspace
    const items = buildWorkspaceMenuItems(10, menuItemFn, separatorFn);
    // Just separator, no menu items — but separator is always added first
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'separator');
  });
});
