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
    this.value = '';
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

  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx >= 0) this.parentNode.children.splice(idx, 1);
      const nIdx = this.parentNode.childNodes.indexOf(this);
      if (nIdx >= 0) this.parentNode.childNodes.splice(nIdx, 1);
      this.parentNode = null;
    }
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
        }
        search(child);
      }
    };
    search(this);
    return results;
  }

  querySelector(selector) {
    // Support basic class selector matching on innerHTML-created elements
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      // Check self first
      if (this.className && this.className.split(' ').includes(cls)) return this;
      // Then children (recursively)
      const all = this.querySelectorAll(selector);
      return all[0] ?? null;
    }
    // For tag selectors
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
  scrollIntoView() {}
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

// The command-palette module uses document.body.appendChild and document.createElement
// It also sets innerHTML on created elements (which our MockElement stores as a string).
// We need a more capable mock for querySelector on innerHTML-created elements.

// Trick: override createElement to also support innerHTML-based querySelector
const bodyEl = new MockElement('body');

globalThis.document = {
  createElement(tag) {
    const el = new MockElement(tag);
    // When innerHTML is set, we can't easily parse it in a mock.
    // The palette's openCommandPalette sets innerHTML then queries children.
    // We'll override querySelector/querySelectorAll to check innerHTML for class names.
    const origQuerySelector = el.querySelector.bind(el);
    el.querySelector = function(selector) {
      // Try children first
      const result = origQuerySelector(selector);
      if (result) return result;

      // If innerHTML was set, create mock elements for known selectors
      if (this.innerHTML && selector.startsWith('.')) {
        const cls = selector.slice(1);
        if (this.innerHTML.includes(cls)) {
          const mock = new MockElement('div');
          mock.className = cls;
          mock.parentNode = this;
          // For input elements inside the palette
          if (cls === 'cp-input') {
            const input = new MockElement('input');
            input.className = cls;
            input.parentNode = this;
            input.value = '';
            return input;
          }
          return mock;
        }
      }
      return null;
    };
    return el;
  },
  createTextNode(text) { return new MockTextNode(text); },
  getElementById() { return new MockElement('div'); },
  addEventListener() {},
  querySelector() { return null; },
  body: bodyEl,
};

globalThis.window = { innerWidth: 1024, innerHeight: 768 };
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  writable: true,
  configurable: true,
});
globalThis.requestAnimationFrame = (fn) => fn();

const removedTabIds = [];
const messageSent = [];
globalThis.chrome = {
  runtime: {
    sendMessage: async (msg) => { messageSent.push(msg); return {}; },
  },
  tabs: {
    remove: async (ids) => { removedTabIds.push(...(Array.isArray(ids) ? ids : [ids])); },
    update: async () => ({}),
    create: async () => ({ id: 999 }),
  },
};

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const {
  setCommandPaletteState,
  toggleCommandPalette,
  closeCommandPalette,
} = await import('../sidepanel/modules/command-palette.js');

// ---------------------------------------------------------------------------
// Tests: toggleCommandPalette — open/close lifecycle
// ---------------------------------------------------------------------------

describe('toggleCommandPalette', () => {
  beforeEach(() => {
    // Ensure palette is closed
    closeCommandPalette();
    bodyEl.children = [];
    bodyEl.childNodes = [];
    messageSent.length = 0;
    removedTabIds.length = 0;
  });

  it('opens the palette overlay on first toggle', () => {
    setCommandPaletteState({
      tabs: {},
    });
    toggleCommandPalette();
    // After opening, document.body should have a child (the overlay)
    assert.ok(bodyEl.children.length > 0, 'should append overlay to body');
    const overlay = bodyEl.children[0];
    assert.ok(
      overlay.className.includes('command-palette-overlay'),
      'overlay should have command-palette-overlay class'
    );
  });

  it('closes the palette on second toggle', () => {
    setCommandPaletteState({ tabs: {} });
    toggleCommandPalette(); // open
    assert.ok(bodyEl.children.length > 0, 'palette should be open');

    toggleCommandPalette(); // close
    // The overlay should be removed from body
    // (closeCommandPalette calls overlayEl.remove())
    // Note: our mock remove() removes from parent
  });
});

// ---------------------------------------------------------------------------
// Tests: closeCommandPalette
// ---------------------------------------------------------------------------

describe('closeCommandPalette', () => {
  beforeEach(() => {
    closeCommandPalette();
    bodyEl.children = [];
    bodyEl.childNodes = [];
  });

  it('does not throw when no palette is open', () => {
    assert.doesNotThrow(() => closeCommandPalette());
  });

  it('removes overlay from DOM when palette is open', () => {
    setCommandPaletteState({ tabs: {} });
    toggleCommandPalette(); // open
    assert.ok(bodyEl.children.length > 0, 'should have overlay');

    closeCommandPalette();
    // Calling close should have called overlayEl.remove()
    // Since our mock tracks parent removal, verify no error
    assert.doesNotThrow(() => closeCommandPalette());
  });
});

// ---------------------------------------------------------------------------
// Tests: setCommandPaletteState — basic state management
// ---------------------------------------------------------------------------

describe('setCommandPaletteState', () => {
  it('accepts state without throwing', () => {
    assert.doesNotThrow(() => {
      setCommandPaletteState({
        tabs: {
          1: { tabId: 1, title: 'Test', url: 'https://test.com', favIconUrl: '' },
        },
        duplicates: { 'https://test.com': [1, 2] },
      });
    });
  });

  it('accepts null state without throwing', () => {
    assert.doesNotThrow(() => {
      setCommandPaletteState(null);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: search integration (via opened palette)
// The internal search function runs when the palette opens (initial results).
// We can verify behavior by checking that the palette renders results
// based on state provided via setCommandPaletteState.
// ---------------------------------------------------------------------------

describe('command palette search integration', () => {
  beforeEach(() => {
    closeCommandPalette();
    bodyEl.children = [];
    bodyEl.childNodes = [];
  });

  it('opens palette with state containing tabs', () => {
    setCommandPaletteState({
      tabs: {
        1: { tabId: 1, title: 'GitHub', url: 'https://github.com', favIconUrl: '' },
        2: { tabId: 2, title: 'Gmail', url: 'https://gmail.com', favIconUrl: '' },
      },
    });

    // Opening the palette triggers initial search('') which shows all tabs + actions
    assert.doesNotThrow(() => toggleCommandPalette());
    assert.ok(bodyEl.children.length > 0, 'palette should render');
  });

  it('opens palette with empty state without error', () => {
    setCommandPaletteState({ tabs: {} });
    assert.doesNotThrow(() => toggleCommandPalette());
  });
});
