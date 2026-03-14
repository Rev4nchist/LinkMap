import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal DOM mock for Node.js testing (inline-prompt specific)
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
    this.type = '';
    this.value = '';
    this.placeholder = '';
    this.parentNode = null;
  }

  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key === 'type') this.type = value;
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

  after(newEl) {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      this.parentNode.children.splice(idx + 1, 0, newEl);
      this.parentNode.childNodes.splice(idx + 1, 0, newEl);
      newEl.parentNode = this.parentNode;
    }
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

  addEventListener(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }

  removeEventListener(event, fn) {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter(f => f !== fn);
    }
  }

  dispatchEvent(event) {
    const handlers = this._listeners[event.type] || [];
    for (const fn of handlers) fn(event);
  }

  focus() { this._focused = true; }
  select() { this._selected = true; }

  querySelector(sel) { return null; }
  closest(sel) { return null; }
}

// ---------------------------------------------------------------------------
// Mock document.createElement
// ---------------------------------------------------------------------------

globalThis.document = globalThis.document || {
  createElement(tag) {
    return new MockElement(tag);
  },
};

// ---------------------------------------------------------------------------
// Import the utility (after DOM mocks are in place)
// ---------------------------------------------------------------------------

const { inlinePrompt } = await import('../shared/utils.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('inlinePrompt', () => {
  let parent;
  let anchor;

  beforeEach(() => {
    parent = new MockElement('div');
    anchor = new MockElement('div');
    parent.appendChild(anchor);
  });

  it('should be exported as a function', () => {
    assert.equal(typeof inlinePrompt, 'function');
  });

  it('inserts an input element after the anchor', () => {
    // Start the prompt (don't await - it blocks until input resolves)
    const promise = inlinePrompt(anchor, 'Enter name', 'default');

    // Verify input was inserted after anchor
    assert.equal(parent.children.length, 2, 'parent should have 2 children');
    const input = parent.children[1];
    assert.equal(input.tagName, 'INPUT');
    assert.equal(input.type, 'text');
    assert.equal(input.className, 'inline-prompt-input');
    assert.equal(input.placeholder, 'Enter name');
    assert.equal(input.value, 'default');

    // Clean up by triggering blur
    input.dispatchEvent({ type: 'blur' });
  });

  it('resolves with trimmed value on Enter', async () => {
    const promise = inlinePrompt(anchor, '', '');
    const input = parent.children[1];
    input.value = '  hello world  ';

    // Simulate Enter key
    input.dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      preventDefault: () => {},
    });

    const result = await promise;
    assert.equal(result, 'hello world');
  });

  it('resolves with null on Enter with empty value', async () => {
    const promise = inlinePrompt(anchor, '', '');
    const input = parent.children[1];
    input.value = '   ';

    input.dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      preventDefault: () => {},
    });

    const result = await promise;
    assert.equal(result, null);
  });

  it('resolves with null on Escape', async () => {
    const promise = inlinePrompt(anchor, '', 'test');
    const input = parent.children[1];

    input.dispatchEvent({
      type: 'keydown',
      key: 'Escape',
      preventDefault: () => {},
    });

    const result = await promise;
    assert.equal(result, null);
  });

  it('resolves with null on blur', async () => {
    const promise = inlinePrompt(anchor, '', 'test');
    const input = parent.children[1];

    input.dispatchEvent({ type: 'blur' });

    const result = await promise;
    assert.equal(result, null);
  });

  it('removes the input element after resolving', async () => {
    const promise = inlinePrompt(anchor, '', '');
    const input = parent.children[1];
    input.value = 'test';

    input.dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      preventDefault: () => {},
    });

    await promise;
    // Input should be removed from parent
    assert.equal(parent.children.length, 1, 'input should be removed');
  });

  it('only resolves once (idempotent finish)', async () => {
    const promise = inlinePrompt(anchor, '', 'value');
    const input = parent.children[1];

    // Fire Enter then blur — should only resolve once
    input.dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      preventDefault: () => {},
    });
    input.dispatchEvent({ type: 'blur' });

    const result = await promise;
    assert.equal(result, 'value');
  });

  it('uses default values for optional parameters', () => {
    const promise = inlinePrompt(anchor);
    const input = parent.children[1];
    assert.equal(input.placeholder, '');
    assert.equal(input.value, '');

    // Clean up
    input.dispatchEvent({ type: 'blur' });
  });
});
