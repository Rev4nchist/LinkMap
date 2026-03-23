import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTabEventHandlers } from '../background/tab-events.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal ShadowState-like mock for tab-events testing. */
function createMockState() {
  const tabs = new Map();
  const groups = new Map();
  return {
    tabs,
    groups,
    addTab(id, node) { tabs.set(id, { ...node, children: [] }); },
    removeTab(id) { tabs.delete(id); },
    updateTab(id, changes) {
      const existing = tabs.get(id);
      if (existing) tabs.set(id, { ...existing, ...changes });
    },
    replaceTabId(oldId, newId) {
      const node = tabs.get(oldId);
      if (node) {
        tabs.delete(oldId);
        tabs.set(newId, { ...node, tabId: newId });
      }
    },
    moveTab() {},
    addGroup(g) { groups.set(g.id, g); },
    updateGroup(id, updates) {
      const existing = groups.get(id);
      if (existing) groups.set(id, { ...existing, ...updates });
    },
    removeGroup(id) { groups.delete(id); },
  };
}

/** Creates a minimal context object compatible with createTabEventHandlers. */
function createMockContext(state) {
  const ctx = {
    initComplete: false,
    activeTabId: null,
    tabNotes: {},
    workspaces: [],
    DEBUG: false,
    suppressGroupCollapseCount: 0,
    suppressGroupTitleCount: 0,
    settings: {},
    currentWindowId: 1,
  };

  return {
    ctx,
    state,
    commitState() {},
    broadcastState() {},
    invalidateDuplicateMap() {},
    suppressGroupCollapseForBurst() {},
    suppressGroupTitleForBurst() {},
  };
}

function makeChromeTab(overrides = {}) {
  return {
    id: 1,
    title: 'Test Tab',
    url: 'https://example.com',
    favIconUrl: 'https://example.com/favicon.ico',
    pinned: false,
    audible: false,
    status: 'complete',
    groupId: -1,
    index: 0,
    windowId: 1,
    openerTabId: undefined,
    active: false,
    ...overrides,
  };
}

// Stubs needed to set up chrome global for constants import
globalThis.chrome = globalThis.chrome || {
  runtime: { sendMessage() {} },
  tabs: {},
  tabGroups: {},
  windows: {},
  storage: { local: { get() {}, set() {} } },
  alarms: {},
  commands: {},
  sidePanel: { setPanelBehavior() {} },
};

// ---------------------------------------------------------------------------
// Tests: Event buffering during init (BUG 5)
// ---------------------------------------------------------------------------

describe('tab-events event buffering (BUG 5)', () => {
  let state, context, handlers;

  beforeEach(() => {
    state = createMockState();
    context = createMockContext(state);
    handlers = createTabEventHandlers({
      context,
      applyAutoGroupRules: () => {},
      repositionTabToGroup: () => {},
      getPinnedBoundaryIndex: () => 0,
    });
  });

  it('buffers created events before initComplete', () => {
    // initComplete is false by default
    const tab = makeChromeTab({ id: 10, title: 'Buffered Tab' });
    handlers.onCreated(tab);

    // Tab should NOT be added to state (not yet processed)
    assert.equal(state.tabs.has(10), false, 'tab should not be in state yet');
  });

  it('buffers removed events before initComplete', () => {
    // Pre-populate state with a tab
    state.addTab(5, { tabId: 5, title: 'Existing', children: [] });

    handlers.onRemoved(5, { windowId: 1, isWindowClosing: false });

    // Tab should still be in state (event was buffered, not processed)
    assert.equal(state.tabs.has(5), true, 'tab should still be in state');
  });

  it('buffers updated events before initComplete', () => {
    state.addTab(5, { tabId: 5, title: 'Original', url: 'https://old.com', children: [] });

    handlers.onUpdated(5, { title: 'Updated' }, makeChromeTab({ id: 5, title: 'Updated' }));

    // Title should NOT have changed (event was buffered)
    assert.equal(state.tabs.get(5).title, 'Original', 'title should not have changed');
  });

  it('exposes drainPendingEvents function', () => {
    assert.equal(typeof handlers.drainPendingEvents, 'function',
      'drainPendingEvents should be exported on handlers object');
  });

  it('drainPendingEvents replays buffered created events', () => {
    const tab = makeChromeTab({ id: 20, title: 'Deferred Tab' });
    handlers.onCreated(tab);

    // Mark init complete so drain can process
    context.ctx.initComplete = true;

    handlers.drainPendingEvents();

    assert.equal(state.tabs.has(20), true, 'tab should be added after drain');
    assert.equal(state.tabs.get(20).title, 'Deferred Tab');
  });

  it('drainPendingEvents skips created events for tabs already in state', () => {
    // Buffer a created event
    const tab = makeChromeTab({ id: 30, title: 'Duplicate Tab' });
    handlers.onCreated(tab);

    // Simulate reconciliation already adding this tab
    state.addTab(30, { tabId: 30, title: 'Reconciled Tab', children: [] });

    context.ctx.initComplete = true;
    handlers.drainPendingEvents();

    // Title should remain 'Reconciled Tab' (reconciliation version kept)
    assert.equal(state.tabs.get(30).title, 'Reconciled Tab',
      'should not overwrite tab already added by reconciliation');
  });

  it('drainPendingEvents replays buffered removed events', () => {
    state.addTab(40, { tabId: 40, title: 'Will be removed', children: [] });

    handlers.onRemoved(40, { windowId: 1, isWindowClosing: false });

    context.ctx.initComplete = true;
    handlers.drainPendingEvents();

    assert.equal(state.tabs.has(40), false, 'tab should be removed after drain');
  });

  it('drainPendingEvents replays buffered updated events', () => {
    state.addTab(50, { tabId: 50, title: 'Before Update', url: 'https://old.com', children: [] });

    handlers.onUpdated(50, { title: 'After Update' }, makeChromeTab({ id: 50, title: 'After Update' }));

    context.ctx.initComplete = true;
    handlers.drainPendingEvents();

    assert.equal(state.tabs.get(50).title, 'After Update', 'title should be updated after drain');
  });

  it('drainPendingEvents skips updated events for tabs not in state', () => {
    // Buffer an update for a tab that doesn't exist in state
    handlers.onUpdated(999, { title: 'Ghost Tab' }, makeChromeTab({ id: 999, title: 'Ghost Tab' }));

    context.ctx.initComplete = true;

    // Should not throw
    handlers.drainPendingEvents();

    assert.equal(state.tabs.has(999), false, 'ghost tab should not appear in state');
  });

  it('pending buffer is empty after drain', () => {
    handlers.onCreated(makeChromeTab({ id: 60, title: 'Tab A' }));
    handlers.onCreated(makeChromeTab({ id: 61, title: 'Tab B' }));

    context.ctx.initComplete = true;
    handlers.drainPendingEvents();

    // Drain again -- should be no-op
    state.removeTab(60);
    state.removeTab(61);
    handlers.drainPendingEvents();

    assert.equal(state.tabs.size, 0, 'second drain should be a no-op');
  });

  it('preserves event order across types', () => {
    // Create tab 70, then update it, then remove it
    handlers.onCreated(makeChromeTab({ id: 70, title: 'Step 1' }));
    handlers.onUpdated(70, { title: 'Step 2' }, makeChromeTab({ id: 70, title: 'Step 2' }));
    handlers.onRemoved(70, { windowId: 1, isWindowClosing: false });

    context.ctx.initComplete = true;
    handlers.drainPendingEvents();

    // End result: tab was created, updated, then removed
    assert.equal(state.tabs.has(70), false, 'tab should be removed after full sequence');
  });
});
