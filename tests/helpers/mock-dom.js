/**
 * Shared DOM mock for Node.js testing.
 *
 * This is the superset of all MockElement implementations across the test suite.
 * Every method/property that any test file relied on is included here.
 */

// ---------------------------------------------------------------------------
// MockTextNode
// ---------------------------------------------------------------------------

export class MockTextNode {
  constructor(text) {
    this.textContent = text;
    this.nodeType = 3;
    this.parentNode = null;
  }
}

// ---------------------------------------------------------------------------
// MockElement
// ---------------------------------------------------------------------------

export class MockElement {
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
    this.id = '';
    this._listeners = {};
    this.style = { cssText: '' };
    this.title = '';
    this.alt = '';
    this.src = '';
    this.width = '';
    this.height = '';
    this.parentNode = null;
    this.draggable = '';
    this.value = '';
    this.type = '';
    this.placeholder = '';
    this._focused = false;
    this._selected = false;
  }

  // --- Getters for sibling / child traversal ---

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

  get parentElement() {
    return this.parentNode;
  }

  // --- Attribute methods ---

  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key === 'src') this.src = value;
    if (key === 'width') this.width = value;
    if (key === 'height') this.height = value;
    if (key === 'alt') this.alt = value;
    if (key === 'title') this.title = value;
    if (key === 'draggable') this.draggable = value;
    if (key === 'type') this.type = value;
    if (key === 'role') this.attributes.role = value;
  }

  getAttribute(key) {
    return this.attributes[key] ?? null;
  }

  removeAttribute(key) {
    delete this.attributes[key];
  }

  // --- Child manipulation ---

  appendChild(child) {
    if (child) {
      if (child.parentNode) child.parentNode._removeChild(child);
      this.children.push(child);
      this.childNodes.push(child);
      child.parentNode = this;
    }
    return child;
  }

  insertBefore(newNode, referenceNode) {
    if (!referenceNode) return this.appendChild(newNode);
    if (newNode.parentNode) newNode.parentNode._removeChild(newNode);
    const idx = this.children.indexOf(referenceNode);
    if (idx === -1) return this.appendChild(newNode);
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
    if (this.parentNode) this.parentNode._removeChild(this);
  }

  replaceChildren(...newChildren) {
    for (const child of [...this.children]) child.parentNode = null;
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

  // --- Insertion helpers (before / after) ---

  before(newEl) {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      newEl.parentNode = this.parentNode;
      this.parentNode.children.splice(idx, 0, newEl);
      this.parentNode.childNodes.splice(idx, 0, newEl);
    }
  }

  after(newEl) {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      this.parentNode.children.splice(idx + 1, 0, newEl);
      this.parentNode.childNodes.splice(idx + 1, 0, newEl);
      newEl.parentNode = this.parentNode;
    }
  }

  // --- Event methods ---

  addEventListener(type, handler) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(handler);
  }

  removeEventListener(type, handler) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter(h => h !== handler);
  }

  dispatchEvent(event) {
    const handlers = this._listeners[event.type] || [];
    for (const fn of handlers) fn(event);
  }

  // --- Focus / selection / scroll ---

  focus() { this._focused = true; }
  blur() { /* no-op */ }
  select() { this._selected = true; }
  scrollIntoView() { /* no-op */ }

  // --- Geometry ---

  getBoundingClientRect() {
    return { top: 0, bottom: 100, left: 0, right: 200, width: 200, height: 100 };
  }

  // --- Containment ---

  contains(el) {
    if (el === this) return true;
    for (const child of this.children) {
      if (child === el) return true;
      if (child.contains && child.contains(el)) return true;
    }
    return false;
  }

  // --- Traversal: closest ---

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

  // --- Query: querySelectorAll / querySelector ---
  //
  // Unified implementation that handles:
  //   - Class selectors:        .foo
  //   - Tag selectors:          div
  //   - Attribute selectors:    [role="menuitem"], [data-tab-id="1"]
  //   - data-* with camelCase:  [data-tab-id] -> dataset.tabId
  //   - Compound selectors:     .tab-entry[data-tab-id="1"]
  //   - ID selectors:           #foo
  //   - [data-focused], [data-selected] (presence checks)

  querySelectorAll(selector) {
    const results = [];
    const search = (el) => {
      if (!el.children) return;
      for (const child of el.children) {
        if (!child || !child.tagName) continue;
        if (_matchesSelector(child, selector)) results.push(child);
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

// ---------------------------------------------------------------------------
// Unified selector matching (private helper)
// ---------------------------------------------------------------------------

function _matchesSelector(el, selector) {
  // ID selector: #foo
  if (selector.startsWith('#')) {
    return el.id === selector.slice(1);
  }

  // Compound selector: .class[attr] or .class[attr="val"]
  const compoundMatch = selector.match(/^\.([a-zA-Z0-9_-]+)\[([^\]]+)\]$/);
  if (compoundMatch) {
    const [, cls, attrPart] = compoundMatch;
    if (!el.className || !el.className.split(' ').includes(cls)) return false;
    return _matchAttr(el, `[${attrPart}]`);
  }

  // Class selector: .foo
  if (selector.startsWith('.')) {
    const cls = selector.slice(1);
    return el.className && el.className.split(' ').includes(cls);
  }

  // Attribute selector: [attr], [attr="val"]
  if (selector.startsWith('[')) {
    return _matchAttr(el, selector);
  }

  // Tag selector: div, span, etc.
  return el.tagName === selector.toUpperCase();
}

function _matchAttr(el, selector) {
  const match = selector.match(/\[([^=\]]+)(?:="([^"]*)")?\]/);
  if (!match) return false;
  const [, attr, val] = match;

  // data-* attributes -> dataset with camelCase conversion
  if (attr.startsWith('data-')) {
    const key = attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (val === undefined) {
      return key in el.dataset;
    }
    return el.dataset[key] === val;
  }

  // role and other regular attributes
  if (el.attributes[attr] !== undefined) {
    if (val === undefined) return true;
    return el.attributes[attr] === val;
  }

  return false;
}

// ---------------------------------------------------------------------------
// setupMockDOM / teardownMockDOM
// ---------------------------------------------------------------------------

let _savedDocument;
let _savedChrome;
let _savedNavigator;
let _savedWindow;
let _savedRAF;

/**
 * Sets up globalThis.document with all factory methods needed by the test suite.
 * Returns the mock document object for further customisation by individual tests.
 */
export function setupMockDOM() {
  _savedDocument = globalThis.document;

  const doc = {
    createElement(tag) { return new MockElement(tag); },
    createTextNode(text) { return new MockTextNode(text); },
    getElementById() { return null; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    activeElement: null,
    body: new MockElement('body'),
  };

  globalThis.document = doc;
  return doc;
}

/**
 * Tears down the mock DOM, restoring the previous globalThis.document.
 */
export function teardownMockDOM() {
  if (_savedDocument !== undefined) {
    globalThis.document = _savedDocument;
    _savedDocument = undefined;
  }
}
