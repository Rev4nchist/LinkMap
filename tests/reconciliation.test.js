import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Enhanced DOM mock that supports reconciliation operations
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
    this.style = { cssText: '' };
    this.title = '';
    this.alt = '';
    this.src = '';
    this.width = '';
    this.height = '';
    this.parentNode = null;
    this.draggable = '';
  }

  get firstElementChild() {
    return this.children[0] ?? null;
  }

  get lastElementChild() {
    return this.children[this.children.length - 1] ?? null;
  }

  get nextElementSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    const idx = siblings.indexOf(this);
    return idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;
  }

  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key === 'src') this.src = value;
    if (key === 'width') this.width = value;
    if (key === 'height') this.height = value;
    if (key === 'alt') this.alt = value;
    if (key === 'title') this.title = value;
    if (key === 'draggable') this.draggable = value;
  }

  getAttribute(key) {
    return this.attributes[key] ?? null;
  }

  appendChild(child) {
    if (child) {
      // Remove from previous parent
      if (child.parentNode) {
        child.parentNode._removeChild(child);
      }
      this.children.push(child);
      this.childNodes.push(child);
      child.parentNode = this;
    }
    return child;
  }

  insertBefore(newNode, referenceNode) {
    if (!referenceNode) {
      return this.appendChild(newNode);
    }
    // Remove from previous parent
    if (newNode.parentNode) {
      newNode.parentNode._removeChild(newNode);
    }
    const idx = this.children.indexOf(referenceNode);
    if (idx === -1) {
      return this.appendChild(newNode);
    }
    this.children.splice(idx, 0, newNode);
    this.childNodes.splice(idx, 0, newNode);
    newNode.parentNode = this;
    return newNode;
  }

  _removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
  }

  remove() {
    if (this.parentNode) {
      this.parentNode._removeChild(this);
    }
  }

  replaceChildren(...newChildren) {
    // Clear all
    for (const child of [...this.children]) {
      child.parentNode = null;
    }
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

  cloneNode(deep) {
    const clone = new MockElement(this.tagName.toLowerCase());
    clone.className = this.className;
    clone.textContent = this.textContent;
    clone.style = { ...this.style };
    clone.draggable = this.draggable;
    Object.assign(clone.dataset, this.dataset);
    Object.assign(clone.attributes, this.attributes);
    clone.src = this.src;
    clone.width = this.width;
    clone.height = this.height;
    clone.alt = this.alt;
    clone.title = this.title;
    if (deep) {
      for (const child of this.children) {
        if (child.cloneNode) {
          clone.appendChild(child.cloneNode(true));
        } else {
          clone.appendChild(new MockTextNode(child.textContent));
        }
      }
    }
    return clone;
  }

  addEventListener(type, handler) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(handler);
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
    const search = (el) => {
      if (!el.children) return;
      for (const child of el.children) {
        if (!child || !child.tagName) continue;
        if (selector.startsWith('.')) {
          const cls = selector.slice(1);
          if (child.className && child.className.split(' ').includes(cls)) results.push(child);
        } else if (selector.startsWith('[')) {
          const match = selector.match(/\[([^=\]]+)(?:="([^"]*)")?\]/);
          if (match) {
            const [, attr, val] = match;
            if (attr.startsWith('data-')) {
              const key = attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
              if (val === undefined) {
                if (key in child.dataset) results.push(child);
              } else if (child.dataset[key] === val) {
                results.push(child);
              }
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
// Import modules under test (after DOM mock)
// ---------------------------------------------------------------------------

const { reconcileChildren, getElementKey, patchElement } = await import(
  '../sidepanel/modules/tree-renderer.js'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTabEl(tabId, title = `Tab ${tabId}`, opts = {}) {
  const entry = new MockElement('div');
  entry.className = opts.className || 'tab-entry';
  entry.dataset.tabId = String(tabId);
  entry.dataset.depth = String(opts.depth || 0);
  entry.dataset.active = String(opts.active || false);
  entry.dataset.groupId = String(opts.groupId || -1);
  entry.dataset.windowId = String(opts.windowId || 1);

  // Inner content structure matching buildTabEntry
  const titleEl = new MockElement('span');
  titleEl.className = 'tab-title';
  titleEl.appendChild({ textContent: title, nodeType: 3, parentNode: null });
  titleEl.textContent = title;

  const favEl = new MockElement('img');
  favEl.className = 'tab-favicon';
  favEl.src = opts.favicon || `https://example.com/fav-${tabId}.png`;
  favEl.setAttribute('src', favEl.src);

  const closeBtn = new MockElement('button');
  closeBtn.className = 'tab-close';

  const row = new MockElement('div');
  row.className = 'tab-row';
  row.appendChild(favEl);
  row.appendChild(titleEl);
  row.appendChild(closeBtn);

  entry.appendChild(row);
  return entry;
}

function makeGroupEl(groupId, title = 'Group', count = 1) {
  const header = new MockElement('div');
  header.className = 'group-header';
  header.dataset.groupId = String(groupId);

  const titleEl = new MockElement('span');
  titleEl.className = 'group-title';
  titleEl.textContent = title;

  const countEl = new MockElement('span');
  countEl.className = 'group-count';
  countEl.textContent = String(count);

  header.appendChild(titleEl);
  header.appendChild(countEl);
  header.style.borderLeft = '3px solid #ff0000';
  header.style.cssText = 'border-left: 3px solid #ff0000';
  return header;
}

function makeWindowSep(windowId) {
  const sep = new MockElement('div');
  sep.className = 'window-separator';
  sep.dataset.windowId = String(windowId);
  return sep;
}

// ---------------------------------------------------------------------------
// Tests: getElementKey
// ---------------------------------------------------------------------------

describe('getElementKey', () => {
  it('returns tab key for tab-entry elements', () => {
    const el = makeTabEl(42);
    assert.equal(getElementKey(el), 'tab-42');
  });

  it('returns group key for group-header elements', () => {
    const el = makeGroupEl(5);
    assert.equal(getElementKey(el), 'group-5');
  });

  it('returns window key for window-separator elements', () => {
    const el = makeWindowSep(3);
    assert.equal(getElementKey(el), 'window-3');
  });

  it('returns null for elements without data attributes', () => {
    const el = new MockElement('div');
    assert.equal(getElementKey(el), null);
  });
});

// ---------------------------------------------------------------------------
// Tests: reconcileChildren
// ---------------------------------------------------------------------------

describe('reconcileChildren', () => {
  let container;

  beforeEach(() => {
    container = new MockElement('div');
  });

  describe('empty to populated', () => {
    it('inserts all new elements into empty container', () => {
      const newEls = [makeTabEl(1), makeTabEl(2), makeTabEl(3)];
      reconcileChildren(container, newEls);

      assert.equal(container.children.length, 3);
      assert.equal(container.children[0].dataset.tabId, '1');
      assert.equal(container.children[1].dataset.tabId, '2');
      assert.equal(container.children[2].dataset.tabId, '3');
    });
  });

  describe('populated to empty', () => {
    it('removes all elements when new list is empty', () => {
      container.replaceChildren(makeTabEl(1), makeTabEl(2));
      reconcileChildren(container, []);
      assert.equal(container.children.length, 0);
    });
  });

  describe('same elements same order', () => {
    it('reuses existing DOM nodes (referential identity)', () => {
      const el1 = makeTabEl(1);
      const el2 = makeTabEl(2);
      container.replaceChildren(el1, el2);

      // Build new elements with same keys
      const newEl1 = makeTabEl(1);
      const newEl2 = makeTabEl(2);
      reconcileChildren(container, [newEl1, newEl2]);

      // Container should still have el1 and el2, not newEl1/newEl2
      assert.equal(container.children.length, 2);
      assert.strictEqual(container.children[0], el1, 'should reuse first element');
      assert.strictEqual(container.children[1], el2, 'should reuse second element');
    });
  });

  describe('element removal', () => {
    it('removes elements no longer in the new list', () => {
      container.replaceChildren(makeTabEl(1), makeTabEl(2), makeTabEl(3));
      reconcileChildren(container, [makeTabEl(1), makeTabEl(3)]);

      assert.equal(container.children.length, 2);
      assert.equal(container.children[0].dataset.tabId, '1');
      assert.equal(container.children[1].dataset.tabId, '3');
    });
  });

  describe('element insertion', () => {
    it('inserts new elements at correct positions', () => {
      container.replaceChildren(makeTabEl(1), makeTabEl(3));
      reconcileChildren(container, [makeTabEl(1), makeTabEl(2), makeTabEl(3)]);

      assert.equal(container.children.length, 3);
      assert.equal(container.children[0].dataset.tabId, '1');
      assert.equal(container.children[1].dataset.tabId, '2');
      assert.equal(container.children[2].dataset.tabId, '3');
    });
  });

  describe('reordering', () => {
    it('reorders elements without recreation', () => {
      const el1 = makeTabEl(1);
      const el2 = makeTabEl(2);
      const el3 = makeTabEl(3);
      container.replaceChildren(el1, el2, el3);

      reconcileChildren(container, [makeTabEl(3), makeTabEl(1), makeTabEl(2)]);

      assert.equal(container.children.length, 3);
      // Should reuse existing elements in new order
      assert.strictEqual(container.children[0], el3);
      assert.strictEqual(container.children[1], el1);
      assert.strictEqual(container.children[2], el2);
    });
  });

  describe('mixed element types', () => {
    it('handles tabs, groups, and window separators together', () => {
      const sep = makeWindowSep(1);
      const group = makeGroupEl(10, 'Dev');
      const tab1 = makeTabEl(1);
      container.replaceChildren(sep, group, tab1);

      // Add a new tab, keep existing
      reconcileChildren(container, [
        makeWindowSep(1),
        makeGroupEl(10, 'Dev'),
        makeTabEl(1),
        makeTabEl(2),
      ]);

      assert.equal(container.children.length, 4);
      assert.strictEqual(container.children[0], sep, 'window sep reused');
      assert.strictEqual(container.children[1], group, 'group header reused');
      assert.strictEqual(container.children[2], tab1, 'tab reused');
      assert.equal(container.children[3].dataset.tabId, '2', 'new tab inserted');
    });
  });

  describe('patching existing elements', () => {
    it('updates tab title when it changes', () => {
      const el1 = makeTabEl(1, 'Old Title');
      container.replaceChildren(el1);

      reconcileChildren(container, [makeTabEl(1, 'New Title')]);

      const titleEl = container.children[0].querySelector('.tab-title');
      assert.equal(titleEl.textContent, 'New Title');
    });

    it('updates className when it changes', () => {
      const el1 = makeTabEl(1);
      el1.className = 'tab-entry';
      container.replaceChildren(el1);

      const newEl = makeTabEl(1);
      newEl.className = 'tab-entry tab-audible';
      reconcileChildren(container, [newEl]);

      assert.equal(container.children[0].className, 'tab-entry tab-audible');
    });

    it('updates group header title', () => {
      const group = makeGroupEl(5, 'Old Name');
      container.replaceChildren(group);

      reconcileChildren(container, [makeGroupEl(5, 'New Name')]);

      const titleEl = container.children[0].querySelector('.group-title');
      assert.equal(titleEl.textContent, 'New Name');
    });

    it('updates group member count', () => {
      const group = makeGroupEl(5, 'Group', 3);
      container.replaceChildren(group);

      reconcileChildren(container, [makeGroupEl(5, 'Group', 7)]);

      const countEl = container.children[0].querySelector('.group-count');
      assert.equal(countEl.textContent, '7');
    });
  });

  describe('complex scenario', () => {
    it('handles simultaneous add, remove, reorder, and update', () => {
      // Start: [tab1, tab2, tab3, tab4]
      const tab1 = makeTabEl(1, 'One');
      const tab2 = makeTabEl(2, 'Two');
      const tab3 = makeTabEl(3, 'Three');
      const tab4 = makeTabEl(4, 'Four');
      container.replaceChildren(tab1, tab2, tab3, tab4);

      // New: [tab3, tab5(new), tab1(updated title), tab4]
      // Removed: tab2
      // Reordered: tab3 moved to front, tab1 moved after tab5
      // Updated: tab1 title changed
      const newTab3 = makeTabEl(3, 'Three');
      const newTab5 = makeTabEl(5, 'Five');
      const newTab1 = makeTabEl(1, 'One Updated');
      const newTab4 = makeTabEl(4, 'Four');

      reconcileChildren(container, [newTab3, newTab5, newTab1, newTab4]);

      assert.equal(container.children.length, 4);
      assert.strictEqual(container.children[0], tab3, 'tab3 reused');
      assert.equal(container.children[1].dataset.tabId, '5', 'tab5 new');
      assert.strictEqual(container.children[2], tab1, 'tab1 reused');
      assert.strictEqual(container.children[3], tab4, 'tab4 reused');

      // tab1 title should be updated
      const tab1Title = tab1.querySelector('.tab-title');
      assert.equal(tab1Title.textContent, 'One Updated');
    });
  });

  describe('idempotency', () => {
    it('calling reconcile twice with same data produces same result', () => {
      container.replaceChildren(makeTabEl(1), makeTabEl(2));

      const newEls1 = [makeTabEl(1, 'A'), makeTabEl(3, 'C')];
      reconcileChildren(container, newEls1);
      assert.equal(container.children.length, 2);
      const child0 = container.children[0];

      const newEls2 = [makeTabEl(1, 'A'), makeTabEl(3, 'C')];
      reconcileChildren(container, newEls2);
      assert.equal(container.children.length, 2);
      // Same element reused
      assert.strictEqual(container.children[0], child0);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: patchElement
// ---------------------------------------------------------------------------

describe('patchElement', () => {
  it('updates className only when different', () => {
    const existing = makeTabEl(1);
    existing.className = 'tab-entry';
    const incoming = makeTabEl(1);
    incoming.className = 'tab-entry tab-audible';

    patchElement(existing, incoming);
    assert.equal(existing.className, 'tab-entry tab-audible');
  });

  it('does not modify className when same', () => {
    const existing = makeTabEl(1);
    existing.className = 'tab-entry';
    const incoming = makeTabEl(1);
    incoming.className = 'tab-entry';

    patchElement(existing, incoming);
    assert.equal(existing.className, 'tab-entry');
  });

  it('updates dataset attributes', () => {
    const existing = makeTabEl(1);
    existing.dataset.active = 'false';
    const incoming = makeTabEl(1);
    incoming.dataset.active = 'true';

    patchElement(existing, incoming);
    assert.equal(existing.dataset.active, 'true');
  });

  it('updates tab favicon src', () => {
    const existing = makeTabEl(1, 'Tab', { favicon: 'old.png' });
    const incoming = makeTabEl(1, 'Tab', { favicon: 'new.png' });

    patchElement(existing, incoming);

    const fav = existing.querySelector('.tab-favicon');
    assert.equal(fav.src, 'new.png');
  });

  it('updates tab title text', () => {
    const existing = makeTabEl(1, 'Old');
    const incoming = makeTabEl(1, 'New');

    patchElement(existing, incoming);

    const titleEl = existing.querySelector('.tab-title');
    assert.equal(titleEl.textContent, 'New');
  });

  it('updates group count', () => {
    const existing = makeGroupEl(5, 'Dev', 3);
    const incoming = makeGroupEl(5, 'Dev', 8);

    patchElement(existing, incoming);

    const countEl = existing.querySelector('.group-count');
    assert.equal(countEl.textContent, '8');
  });

  it('updates group title', () => {
    const existing = makeGroupEl(5, 'Old');
    const incoming = makeGroupEl(5, 'New');

    patchElement(existing, incoming);

    const titleEl = existing.querySelector('.group-title');
    assert.equal(titleEl.textContent, 'New');
  });
});
