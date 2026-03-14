import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal DOM + Chrome mock
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
    if (key === 'role') this.attributes.role = value;
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

  removeEventListener() {}

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
            if (attr === 'role') {
              if (val === undefined || child.attributes.role === val) results.push(child);
            } else if (attr.startsWith('data-')) {
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

  contains(el) {
    if (el === this) return true;
    for (const child of this.children) {
      if (child === el) return true;
      if (child.contains && child.contains(el)) return true;
    }
    return false;
  }

  after() {}
  focus() {}
  select() {}
  getBoundingClientRect() {
    return { top: 0, bottom: 100, left: 0, right: 200, width: 200, height: 100 };
  }
}

class MockTextNode {
  constructor(text) {
    this.textContent = text;
    this.nodeType = 3;
    this.parentNode = null;
  }
}

// The context-menu module calls document.getElementById('context-menu') at module level.
// We need a proper menuEl mock that gets returned.
const menuElMock = new MockElement('div');
menuElMock.hidden = true;

globalThis.document = {
  createElement(tag) { return new MockElement(tag); },
  createTextNode(text) { return new MockTextNode(text); },
  getElementById(id) {
    if (id === 'context-menu') return menuElMock;
    return new MockElement('div');
  },
  addEventListener() {},
  querySelector() { return null; },
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
    update: async () => ({}),
    create: async () => ({ id: 999 }),
    duplicate: async () => ({}),
    reload: async () => {},
    group: async () => 500,
    ungroup: async () => {},
    discard: async () => {},
  },
  tabGroups: {
    update: async () => ({}),
  },
};

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const {
  showContextMenu,
  hideContextMenu,
  setContextMenuState,
  showGroupContextMenu,
} = await import('../sidepanel/modules/context-menu.js');

// ---------------------------------------------------------------------------
// Tests: showContextMenu — DOM structure and ARIA roles
// ---------------------------------------------------------------------------

describe('showContextMenu', () => {
  beforeEach(() => {
    menuElMock.children = [];
    menuElMock.childNodes = [];
    menuElMock.hidden = true;
    messageSent.length = 0;
  });

  it('shows the menu element (sets hidden to false)', () => {
    setContextMenuState({
      tabs: {
        1: { tabId: 1, title: 'Test Tab', url: 'https://test.com', children: [], pinned: false, muted: false, groupId: -1 },
      },
      rootIds: [1],
      groups: {},
      duplicates: {},
    });
    showContextMenu(1, 100, 200);
    assert.equal(menuElMock.hidden, false);
  });

  it('populates menu items with role="menuitem"', () => {
    setContextMenuState({
      tabs: {
        1: { tabId: 1, title: 'Test Tab', url: 'https://test.com', children: [], pinned: false, muted: false, groupId: -1 },
      },
      rootIds: [1],
      groups: {},
      duplicates: {},
    });
    showContextMenu(1, 100, 200);

    const menuItems = menuElMock.querySelectorAll('[role="menuitem"]');
    assert.ok(menuItems.length > 0, 'should have menu items with role="menuitem"');

    // Verify each item has a class that includes 'context-menu-item'
    for (const item of menuItems) {
      assert.ok(
        item.className.includes('context-menu-item'),
        `item should have context-menu-item class, got: ${item.className}`
      );
    }
  });

  it('includes separators with role="separator"', () => {
    setContextMenuState({
      tabs: {
        1: { tabId: 1, title: 'Test Tab', url: 'https://test.com', children: [], pinned: false, muted: false, groupId: -1 },
      },
      rootIds: [1],
      groups: {},
      duplicates: {},
    });
    showContextMenu(1, 100, 200);

    const separators = menuElMock.querySelectorAll('[role="separator"]');
    assert.ok(separators.length > 0, 'should have at least one separator');
    for (const sep of separators) {
      assert.ok(
        sep.className.includes('context-menu-separator'),
        `separator should have context-menu-separator class, got: ${sep.className}`
      );
    }
  });

  it('does nothing when tab does not exist in state', () => {
    setContextMenuState({
      tabs: {},
      rootIds: [],
      groups: {},
    });
    showContextMenu(999, 100, 200);
    // Menu should remain hidden since tab not found
    assert.equal(menuElMock.hidden, true);
  });

  it('includes Close Branch when tab has children', () => {
    setContextMenuState({
      tabs: {
        1: { tabId: 1, title: 'Parent', url: 'https://test.com', children: [2], pinned: false, muted: false, groupId: -1 },
        2: { tabId: 2, title: 'Child', url: 'https://child.com', children: [], pinned: false, muted: false, groupId: -1, parentId: 1 },
      },
      rootIds: [1],
      groups: {},
      duplicates: {},
    });
    showContextMenu(1, 100, 200);

    const items = menuElMock.querySelectorAll('[role="menuitem"]');
    const labels = items.map(el => {
      // Text content of the element — childNodes[0] is the text node
      if (el.childNodes.length > 0 && el.childNodes[0].textContent) {
        return el.childNodes[0].textContent;
      }
      return el.textContent;
    });
    assert.ok(labels.includes('Close Branch'), `should include "Close Branch", got: ${labels.join(', ')}`);
  });

  it('shows Pin/Unpin based on current pin state', () => {
    // Tab is pinned — should show "Unpin"
    setContextMenuState({
      tabs: {
        1: { tabId: 1, title: 'Pinned Tab', url: 'https://test.com', children: [], pinned: true, muted: false, groupId: -1 },
      },
      rootIds: [1],
      groups: {},
      duplicates: {},
    });
    showContextMenu(1, 100, 200);

    const items = menuElMock.querySelectorAll('[role="menuitem"]');
    const labels = items.map(el => {
      if (el.childNodes.length > 0 && el.childNodes[0].textContent) {
        return el.childNodes[0].textContent;
      }
      return el.textContent;
    });
    assert.ok(labels.includes('Unpin'), `should show "Unpin" for pinned tab, got: ${labels.join(', ')}`);
    assert.ok(!labels.includes('Pin'), 'should not show "Pin" when already pinned');
  });
});

// ---------------------------------------------------------------------------
// Tests: hideContextMenu
// ---------------------------------------------------------------------------

describe('hideContextMenu', () => {
  it('hides the menu element', () => {
    menuElMock.hidden = false;
    hideContextMenu();
    assert.equal(menuElMock.hidden, true);
  });
});

// ---------------------------------------------------------------------------
// Tests: showGroupContextMenu — rename guard logic
// ---------------------------------------------------------------------------

describe('showGroupContextMenu', () => {
  beforeEach(() => {
    menuElMock.children = [];
    menuElMock.childNodes = [];
    menuElMock.hidden = true;
    messageSent.length = 0;
  });

  it('shows menu for a valid group', () => {
    setContextMenuState({
      tabs: {
        1: { tabId: 1, title: 'Tab', url: 'https://test.com', children: [], groupId: 100 },
      },
      rootIds: [1],
      groups: { 100: { id: 100, title: 'My Group', color: 'blue' } },
      groupColors: {},
      theme: 'midnight',
    });
    showGroupContextMenu(100, 50, 50);
    assert.equal(menuElMock.hidden, false);
  });

  it('does nothing when group does not exist', () => {
    setContextMenuState({
      tabs: {},
      rootIds: [],
      groups: {},
    });
    showGroupContextMenu(999, 50, 50);
    assert.equal(menuElMock.hidden, true);
  });

  it('includes a rename input in the menu', () => {
    setContextMenuState({
      tabs: {},
      rootIds: [],
      groups: { 100: { id: 100, title: 'My Group', color: 'blue' } },
      groupColors: {},
      theme: 'midnight',
    });
    showGroupContextMenu(100, 50, 50);

    // The rename wrapper should be the first child
    const renameWrapper = menuElMock.children[0];
    assert.ok(renameWrapper, 'should have at least one child');
    assert.ok(
      renameWrapper.className.includes('context-menu-rename'),
      'first item should be rename wrapper'
    );
  });

  it('includes Delete Group as a danger item', () => {
    setContextMenuState({
      tabs: {
        1: { tabId: 1, title: 'Tab', url: 'https://test.com', children: [], groupId: 100 },
      },
      rootIds: [1],
      groups: { 100: { id: 100, title: 'My Group', color: 'blue' } },
      groupColors: {},
      theme: 'midnight',
    });
    showGroupContextMenu(100, 50, 50);

    const items = menuElMock.querySelectorAll('[role="menuitem"]');
    const dangerItems = items.filter(el => el.className.includes('danger'));
    assert.ok(dangerItems.length > 0, 'should have at least one danger menu item');

    // The danger item should be Delete Group
    const deleteLabel = dangerItems[0].childNodes[0]?.textContent || dangerItems[0].textContent;
    assert.equal(deleteLabel, 'Delete Group');
  });
});
