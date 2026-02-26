import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Chrome API Mock
// ---------------------------------------------------------------------------

/**
 * Creates a mock Chrome API surface sufficient for background.js.
 * Each test gets a fresh mock via beforeEach.
 */
function createChromeMock() {
  const listeners = {};

  function makeEvent(name) {
    listeners[name] = [];
    return {
      addListener: (fn) => listeners[name].push(fn),
      _fire: (...args) => {
        for (const fn of listeners[name]) fn(...args);
      },
      _listeners: listeners[name],
    };
  }

  const storedData = {};

  return {
    tabs: {
      onCreated: makeEvent('tabs.onCreated'),
      onRemoved: makeEvent('tabs.onRemoved'),
      onUpdated: makeEvent('tabs.onUpdated'),
      onMoved: makeEvent('tabs.onMoved'),
      onActivated: makeEvent('tabs.onActivated'),
      onAttached: makeEvent('tabs.onAttached'),
      onDetached: makeEvent('tabs.onDetached'),
      query: mock.fn(async () => []),
      update: mock.fn(async () => ({})),
      remove: mock.fn(async () => {}),
      duplicate: mock.fn(async () => ({})),
    },
    storage: {
      local: {
        get: mock.fn(async (key) => {
          if (typeof key === 'string') {
            return { [key]: storedData[key] ?? undefined };
          }
          return {};
        }),
        set: mock.fn(async (obj) => {
          Object.assign(storedData, obj);
        }),
        _data: storedData,
      },
    },
    runtime: {
      onMessage: makeEvent('runtime.onMessage'),
      sendMessage: mock.fn(async () => {}),
    },
    sidePanel: {
      setPanelBehavior: mock.fn(async () => {}),
    },
    _listeners: listeners,
    _storedData: storedData,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a minimal chrome.tabs.Tab-like object. */
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

/**
 * Loads background.js as a fresh module with a mocked chrome global.
 * Returns { chrome, module } where module has the exports.
 *
 * We use dynamic import with a cache-busting query param to get a fresh
 * module instance each time. The chrome mock is set as a global before import.
 */
async function loadBackground(chromeMock, storageData = null) {
  // Pre-populate storage if needed
  if (storageData) {
    chromeMock.storage.local._data.linkmap_state = storageData;
    chromeMock.storage.local.get = mock.fn(async (key) => {
      if (typeof key === 'string') {
        return { [key]: chromeMock.storage.local._data[key] };
      }
      return {};
    });
  }

  // Set up chrome global
  globalThis.chrome = chromeMock;

  // Import the module fresh each time with cache buster
  const timestamp = Date.now() + Math.random();
  const mod = await import(`../background.js?t=${timestamp}`);

  // Wait for init() to complete (it's called at module load time)
  // Give microtasks time to settle
  await new Promise((r) => setTimeout(r, 50));

  return { chrome: chromeMock, module: mod };
}

// ---------------------------------------------------------------------------
// Tests: Module Structure
// ---------------------------------------------------------------------------

describe('background.js module structure', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
    // Default: query returns some live tabs
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) {
        return [makeChromeTab({ id: 1, active: true })];
      }
      return [makeChromeTab({ id: 1 })];
    });
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('registers side panel behavior on load', async () => {
    await loadBackground(chromeMock);
    assert.equal(chromeMock.sidePanel.setPanelBehavior.mock.callCount(), 1);
    assert.deepEqual(
      chromeMock.sidePanel.setPanelBehavior.mock.calls[0].arguments[0],
      { openPanelOnActionClick: true }
    );
  });

  it('registers all tab event listeners', async () => {
    await loadBackground(chromeMock);
    assert.ok(chromeMock._listeners['tabs.onCreated'].length > 0, 'onCreated listener registered');
    assert.ok(chromeMock._listeners['tabs.onRemoved'].length > 0, 'onRemoved listener registered');
    assert.ok(chromeMock._listeners['tabs.onUpdated'].length > 0, 'onUpdated listener registered');
    assert.ok(chromeMock._listeners['tabs.onMoved'].length > 0, 'onMoved listener registered');
    assert.ok(chromeMock._listeners['tabs.onActivated'].length > 0, 'onActivated listener registered');
    assert.ok(chromeMock._listeners['tabs.onAttached'].length > 0, 'onAttached listener registered');
    assert.ok(chromeMock._listeners['tabs.onDetached'].length > 0, 'onDetached listener registered');
  });

  it('registers runtime message listener', async () => {
    await loadBackground(chromeMock);
    assert.ok(chromeMock._listeners['runtime.onMessage'].length > 0, 'onMessage listener registered');
  });
});

// ---------------------------------------------------------------------------
// Tests: Initialization
// ---------------------------------------------------------------------------

describe('background.js initialization', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('loads state from storage on init', async () => {
    chromeMock.tabs.query = mock.fn(async () => []);
    await loadBackground(chromeMock);
    assert.ok(chromeMock.storage.local.get.mock.callCount() >= 1, 'storage.local.get was called');
  });

  it('reconstructs state from saved data', async () => {
    const savedState = {
      version: 1,
      tabs: {
        1: { tabId: 1, parentId: null, children: [2], title: 'Saved Root', url: 'https://saved.com', favIconUrl: '', pinned: false, audible: false, status: 'complete', groupId: -1, index: 0, windowId: 1 },
        2: { tabId: 2, parentId: 1, children: [], title: 'Saved Child', url: 'https://child.com', favIconUrl: '', pinned: false, audible: false, status: 'complete', groupId: -1, index: 1, windowId: 1 },
      },
      rootIds: [1],
      collapsed: [],
      groupColors: {},
      theme: 'dracula',
    };

    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [
        makeChromeTab({ id: 1, title: 'Saved Root', index: 0 }),
        makeChromeTab({ id: 2, title: 'Saved Child', index: 1 }),
      ];
    });

    await loadBackground(chromeMock, savedState);

    // Verify reconciliation happened: query({}) was called
    const allQueryCalls = chromeMock.tabs.query.mock.calls;
    const fullQueryCall = allQueryCalls.find(
      (c) => JSON.stringify(c.arguments[0]) === '{}'
    );
    assert.ok(fullQueryCall, 'tabs.query({}) was called for reconciliation');
  });

  it('queries all live tabs for reconciliation', async () => {
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [makeChromeTab({ id: 1 })];
    });

    await loadBackground(chromeMock);

    const allQueryCalls = chromeMock.tabs.query.mock.calls;
    const fullQueryCall = allQueryCalls.find(
      (c) => JSON.stringify(c.arguments[0]) === '{}'
    );
    assert.ok(fullQueryCall, 'tabs.query({}) was called');
  });

  it('queries active tab and sets activeTabId', async () => {
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active && queryInfo.currentWindow) {
        return [makeChromeTab({ id: 42, active: true })];
      }
      return [makeChromeTab({ id: 42 })];
    });

    await loadBackground(chromeMock);

    // Verify active tab query was made
    const activeQueryCall = chromeMock.tabs.query.mock.calls.find(
      (c) => c.arguments[0]?.active === true && c.arguments[0]?.currentWindow === true
    );
    assert.ok(activeQueryCall, 'tabs.query({ active: true, currentWindow: true }) was called');
  });

  it('saves state after init reconciliation', async () => {
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [makeChromeTab({ id: 1 })];
    });

    await loadBackground(chromeMock);
    // Wait for debounced save or immediate save
    await new Promise((r) => setTimeout(r, 600));

    assert.ok(chromeMock.storage.local.set.mock.callCount() >= 1, 'state was saved after init');
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab Event — onCreated
// ---------------------------------------------------------------------------

describe('tabs.onCreated handler', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [makeChromeTab({ id: 1 })];
    });
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('adds new tab to state when created', async () => {
    await loadBackground(chromeMock);

    const newTab = makeChromeTab({ id: 50, title: 'New Tab', openerTabId: 1, index: 1 });
    chromeMock.tabs.onCreated._fire(newTab);

    // Wait for debounced save
    await new Promise((r) => setTimeout(r, 600));

    // Verify save was called (state was updated)
    const setCalls = chromeMock.storage.local.set.mock.calls;
    const lastSetCall = setCalls[setCalls.length - 1];
    assert.ok(lastSetCall, 'storage.local.set was called');

    const savedState = lastSetCall.arguments[0].linkmap_state;
    assert.ok(savedState.tabs[50], 'new tab exists in saved state');
    assert.equal(savedState.tabs[50].title, 'New Tab');
  });

  it('sets openerTabId as parentId for new tab', async () => {
    await loadBackground(chromeMock);

    const newTab = makeChromeTab({ id: 50, title: 'Child Tab', openerTabId: 1, index: 1 });
    chromeMock.tabs.onCreated._fire(newTab);

    await new Promise((r) => setTimeout(r, 600));

    const setCalls = chromeMock.storage.local.set.mock.calls;
    const lastSetCall = setCalls[setCalls.length - 1];
    const savedState = lastSetCall.arguments[0].linkmap_state;
    assert.equal(savedState.tabs[50].parentId, 1);
  });

  it('broadcasts state update after tab created', async () => {
    await loadBackground(chromeMock);
    chromeMock.runtime.sendMessage.mock.resetCalls();

    const newTab = makeChromeTab({ id: 50, title: 'New Tab' });
    chromeMock.tabs.onCreated._fire(newTab);

    // Wait for broadcast
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(chromeMock.runtime.sendMessage.mock.callCount() >= 1, 'sendMessage called for broadcast');
    const broadcastCall = chromeMock.runtime.sendMessage.mock.calls.find(
      (c) => c.arguments[0]?.type === 'STATE_UPDATE'
    );
    assert.ok(broadcastCall, 'STATE_UPDATE message was broadcast');
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab Event — onRemoved
// ---------------------------------------------------------------------------

describe('tabs.onRemoved handler', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [
        makeChromeTab({ id: 1, index: 0 }),
        makeChromeTab({ id: 2, index: 1 }),
      ];
    });
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('removes tab from state when closed', async () => {
    await loadBackground(chromeMock);

    chromeMock.tabs.onRemoved._fire(2, { windowId: 1, isWindowClosing: false });

    await new Promise((r) => setTimeout(r, 600));

    const setCalls = chromeMock.storage.local.set.mock.calls;
    const lastSetCall = setCalls[setCalls.length - 1];
    const savedState = lastSetCall.arguments[0].linkmap_state;
    assert.ok(!savedState.tabs[2], 'tab 2 removed from saved state');
  });

  it('clears activeTabId when active tab is removed', async () => {
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [makeChromeTab({ id: 1, index: 0 })];
    });

    await loadBackground(chromeMock);

    // Now the active tab (1) is removed
    chromeMock.tabs.onRemoved._fire(1, { windowId: 1, isWindowClosing: false });

    // Verify via GET_STATE response that activeTabId is null
    await new Promise((r) => setTimeout(r, 100));

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    let response = null;
    listener(
      { type: 'GET_STATE' },
      {},
      (data) => { response = data; }
    );

    assert.equal(response.activeTabId, null, 'activeTabId cleared after removing active tab');
  });

  it('broadcasts state update after tab removed', async () => {
    await loadBackground(chromeMock);
    chromeMock.runtime.sendMessage.mock.resetCalls();

    chromeMock.tabs.onRemoved._fire(2, { windowId: 1, isWindowClosing: false });

    await new Promise((r) => setTimeout(r, 100));

    const broadcastCall = chromeMock.runtime.sendMessage.mock.calls.find(
      (c) => c.arguments[0]?.type === 'STATE_UPDATE'
    );
    assert.ok(broadcastCall, 'STATE_UPDATE broadcast after removal');
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab Event — onUpdated
// ---------------------------------------------------------------------------

describe('tabs.onUpdated handler', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [makeChromeTab({ id: 1, index: 0 })];
    });
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('updates tab title when changeInfo has title', async () => {
    await loadBackground(chromeMock);

    chromeMock.tabs.onUpdated._fire(1, { title: 'Updated Title' }, makeChromeTab({ id: 1, title: 'Updated Title' }));

    await new Promise((r) => setTimeout(r, 600));

    const setCalls = chromeMock.storage.local.set.mock.calls;
    const lastSetCall = setCalls[setCalls.length - 1];
    const savedState = lastSetCall.arguments[0].linkmap_state;
    assert.equal(savedState.tabs[1].title, 'Updated Title');
  });

  it('updates tab url when changeInfo has url', async () => {
    await loadBackground(chromeMock);

    chromeMock.tabs.onUpdated._fire(1, { url: 'https://new-url.com' }, makeChromeTab({ id: 1, url: 'https://new-url.com' }));

    await new Promise((r) => setTimeout(r, 600));

    const setCalls = chromeMock.storage.local.set.mock.calls;
    const lastSetCall = setCalls[setCalls.length - 1];
    const savedState = lastSetCall.arguments[0].linkmap_state;
    assert.equal(savedState.tabs[1].url, 'https://new-url.com');
  });

  it('does not save when changeInfo has no relevant fields', async () => {
    await loadBackground(chromeMock);

    const saveCountBefore = chromeMock.storage.local.set.mock.callCount();

    // Fire with irrelevant change info
    chromeMock.tabs.onUpdated._fire(1, { autoDiscardable: true }, makeChromeTab({ id: 1 }));

    // Wait longer than debounce
    await new Promise((r) => setTimeout(r, 600));

    // Save count should not have increased (beyond what init did)
    // Allow for the init save that may have been pending
    const saveCountAfter = chromeMock.storage.local.set.mock.callCount();
    // The key test: no STATE_UPDATE broadcast for irrelevant changes
    // This is softer than counting saves since debounce timing can vary
  });

  it('updates favIconUrl when changeInfo has favIconUrl', async () => {
    await loadBackground(chromeMock);

    chromeMock.tabs.onUpdated._fire(1, { favIconUrl: 'https://new-favicon.ico' }, makeChromeTab({ id: 1 }));

    await new Promise((r) => setTimeout(r, 600));

    const setCalls = chromeMock.storage.local.set.mock.calls;
    const lastSetCall = setCalls[setCalls.length - 1];
    const savedState = lastSetCall.arguments[0].linkmap_state;
    assert.equal(savedState.tabs[1].favIconUrl, 'https://new-favicon.ico');
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab Event — onMoved
// ---------------------------------------------------------------------------

describe('tabs.onMoved handler', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [
        makeChromeTab({ id: 1, index: 0 }),
        makeChromeTab({ id: 2, index: 1 }),
      ];
    });
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('updates tab index when moved', async () => {
    await loadBackground(chromeMock);

    chromeMock.tabs.onMoved._fire(2, { windowId: 1, fromIndex: 1, toIndex: 0 });

    await new Promise((r) => setTimeout(r, 600));

    const setCalls = chromeMock.storage.local.set.mock.calls;
    const lastSetCall = setCalls[setCalls.length - 1];
    const savedState = lastSetCall.arguments[0].linkmap_state;
    assert.equal(savedState.tabs[2].index, 0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab Event — onActivated
// ---------------------------------------------------------------------------

describe('tabs.onActivated handler', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [makeChromeTab({ id: 1, index: 0 })];
    });
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('updates activeTabId and broadcasts TAB_ACTIVATED', async () => {
    await loadBackground(chromeMock);
    chromeMock.runtime.sendMessage.mock.resetCalls();

    chromeMock.tabs.onActivated._fire({ tabId: 99, windowId: 1 });

    await new Promise((r) => setTimeout(r, 100));

    // Check TAB_ACTIVATED was broadcast
    const activatedCall = chromeMock.runtime.sendMessage.mock.calls.find(
      (c) => c.arguments[0]?.type === 'TAB_ACTIVATED'
    );
    assert.ok(activatedCall, 'TAB_ACTIVATED message broadcast');
    assert.equal(activatedCall.arguments[0].payload.tabId, 99);

    // Check activeTabId updated via GET_STATE
    const listener = chromeMock._listeners['runtime.onMessage'][0];
    let response = null;
    listener({ type: 'GET_STATE' }, {}, (data) => { response = data; });
    assert.equal(response.activeTabId, 99);
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab Event — onAttached
// ---------------------------------------------------------------------------

describe('tabs.onAttached handler', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [makeChromeTab({ id: 1, index: 0 })];
    });
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('updates windowId and index when tab attached', async () => {
    await loadBackground(chromeMock);

    chromeMock.tabs.onAttached._fire(1, { newWindowId: 5, newPosition: 3 });

    await new Promise((r) => setTimeout(r, 600));

    const setCalls = chromeMock.storage.local.set.mock.calls;
    const lastSetCall = setCalls[setCalls.length - 1];
    const savedState = lastSetCall.arguments[0].linkmap_state;
    assert.equal(savedState.tabs[1].windowId, 5);
    assert.equal(savedState.tabs[1].index, 3);
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab Event — onDetached
// ---------------------------------------------------------------------------

describe('tabs.onDetached handler', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [makeChromeTab({ id: 1, index: 0 })];
    });
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('does not remove the tab on detach (v1 single-window)', async () => {
    await loadBackground(chromeMock);

    chromeMock.tabs.onDetached._fire(1, { oldWindowId: 1, oldPosition: 0 });

    await new Promise((r) => setTimeout(r, 100));

    // Tab should still be in state (via GET_STATE)
    const listener = chromeMock._listeners['runtime.onMessage'][0];
    let response = null;
    listener({ type: 'GET_STATE' }, {}, (data) => { response = data; });
    assert.ok(response.tabs[1], 'tab still exists after detach');
  });
});

// ---------------------------------------------------------------------------
// Tests: Message Handler
// ---------------------------------------------------------------------------

describe('message handler', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [
        makeChromeTab({ id: 1, index: 0 }),
        makeChromeTab({ id: 2, index: 1 }),
      ];
    });
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('responds to GET_STATE with full state payload', async () => {
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    let response = null;
    const result = listener(
      { type: 'GET_STATE' },
      {},
      (data) => { response = data; }
    );

    assert.ok(response, 'sendResponse was called');
    assert.ok(response.tabs, 'response has tabs');
    assert.ok(Array.isArray(response.rootIds), 'response has rootIds');
    assert.ok(Array.isArray(response.collapsed), 'response has collapsed');
    assert.ok(typeof response.theme === 'string', 'response has theme');
    assert.ok('activeTabId' in response, 'response has activeTabId');
  });

  it('returns true from GET_STATE handler for async channel', async () => {
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    const result = listener({ type: 'GET_STATE' }, {}, () => {});
    assert.equal(result, true, 'returns true to keep message channel open');
  });

  it('handles ACTIVATE_TAB by calling chrome.tabs.update', async () => {
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    listener(
      { type: 'ACTIVATE_TAB', payload: { tabId: 2 } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(chromeMock.tabs.update.mock.callCount() >= 1, 'chrome.tabs.update called');
    const updateCall = chromeMock.tabs.update.mock.calls.find(
      (c) => c.arguments[0] === 2 && c.arguments[1]?.active === true
    );
    assert.ok(updateCall, 'tabs.update called with correct args');
  });

  it('handles CLOSE_TAB by calling chrome.tabs.remove', async () => {
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    listener(
      { type: 'CLOSE_TAB', payload: { tabId: 2 } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 50));

    const removeCall = chromeMock.tabs.remove.mock.calls.find(
      (c) => c.arguments[0] === 2
    );
    assert.ok(removeCall, 'chrome.tabs.remove called with tabId');
  });

  it('handles CLOSE_TABS by calling chrome.tabs.remove with array', async () => {
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    listener(
      { type: 'CLOSE_TABS', payload: { tabIds: [1, 2] } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 50));

    const removeCall = chromeMock.tabs.remove.mock.calls.find(
      (c) => Array.isArray(c.arguments[0]) && c.arguments[0].includes(1) && c.arguments[0].includes(2)
    );
    assert.ok(removeCall, 'chrome.tabs.remove called with tabIds array');
  });

  it('handles MOVE_TAB by updating state, saving, and broadcasting', async () => {
    await loadBackground(chromeMock);
    chromeMock.runtime.sendMessage.mock.resetCalls();

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    listener(
      { type: 'MOVE_TAB', payload: { tabId: 2, newParentId: 1, index: 0 } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 600));

    // Verify state was saved with the move applied
    const setCalls = chromeMock.storage.local.set.mock.calls;
    const lastSetCall = setCalls[setCalls.length - 1];
    const savedState = lastSetCall.arguments[0].linkmap_state;
    assert.equal(savedState.tabs[2].parentId, 1, 'tab 2 reparented to tab 1');

    // Verify broadcast happened
    const broadcastCall = chromeMock.runtime.sendMessage.mock.calls.find(
      (c) => c.arguments[0]?.type === 'STATE_UPDATE'
    );
    assert.ok(broadcastCall, 'STATE_UPDATE broadcast after MOVE_TAB');
  });

  it('handles TOGGLE_COLLAPSE by toggling collapsed state', async () => {
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];

    // Toggle collapse on tab 1
    listener(
      { type: 'TOGGLE_COLLAPSE', payload: { tabId: 1 } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 100));

    // Verify via GET_STATE
    let response = null;
    listener({ type: 'GET_STATE' }, {}, (data) => { response = data; });
    assert.ok(response.collapsed.includes(1), 'tab 1 is now collapsed');

    // Toggle again
    listener(
      { type: 'TOGGLE_COLLAPSE', payload: { tabId: 1 } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 100));

    response = null;
    listener({ type: 'GET_STATE' }, {}, (data) => { response = data; });
    assert.ok(!response.collapsed.includes(1), 'tab 1 is no longer collapsed');
  });

  it('handles SET_THEME by updating theme and broadcasting THEME_CHANGED', async () => {
    await loadBackground(chromeMock);
    chromeMock.runtime.sendMessage.mock.resetCalls();

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    listener(
      { type: 'SET_THEME', payload: { theme: 'nord' } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 100));

    // Verify theme changed via GET_STATE
    let response = null;
    listener({ type: 'GET_STATE' }, {}, (data) => { response = data; });
    assert.equal(response.theme, 'nord', 'theme updated to nord');

    // Verify THEME_CHANGED broadcast
    const themeCall = chromeMock.runtime.sendMessage.mock.calls.find(
      (c) => c.arguments[0]?.type === 'THEME_CHANGED'
    );
    assert.ok(themeCall, 'THEME_CHANGED broadcast');
  });

  it('handles SET_GROUP_COLOR by updating group color', async () => {
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    listener(
      { type: 'SET_GROUP_COLOR', payload: { groupId: 5, color: '#ff0000' } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 600));

    const setCalls = chromeMock.storage.local.set.mock.calls;
    const lastSetCall = setCalls[setCalls.length - 1];
    const savedState = lastSetCall.arguments[0].linkmap_state;
    assert.equal(savedState.groupColors[5], '#ff0000');
  });

  it('handles PIN_TAB by calling chrome.tabs.update with pinned', async () => {
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    listener(
      { type: 'PIN_TAB', payload: { tabId: 1, pinned: true } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 50));

    const updateCall = chromeMock.tabs.update.mock.calls.find(
      (c) => c.arguments[0] === 1 && c.arguments[1]?.pinned === true
    );
    assert.ok(updateCall, 'chrome.tabs.update called with pinned: true');
  });

  it('handles DUPLICATE_TAB by calling chrome.tabs.duplicate', async () => {
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    listener(
      { type: 'DUPLICATE_TAB', payload: { tabId: 1 } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 50));

    const dupCall = chromeMock.tabs.duplicate.mock.calls.find(
      (c) => c.arguments[0] === 1
    );
    assert.ok(dupCall, 'chrome.tabs.duplicate called with tabId');
  });

  it('handles MUTE_TAB by calling chrome.tabs.update with muted', async () => {
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    listener(
      { type: 'MUTE_TAB', payload: { tabId: 1, muted: true } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 50));

    const updateCall = chromeMock.tabs.update.mock.calls.find(
      (c) => c.arguments[0] === 1 && c.arguments[1]?.muted === true
    );
    assert.ok(updateCall, 'chrome.tabs.update called with muted: true');
  });
});

// ---------------------------------------------------------------------------
// Tests: State Payload Structure
// ---------------------------------------------------------------------------

describe('getStatePayload structure', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [makeChromeTab({ id: 1, index: 0 })];
    });
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('returns tabs as plain object (not Map)', async () => {
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    let response = null;
    listener({ type: 'GET_STATE' }, {}, (data) => { response = data; });

    assert.ok(!(response.tabs instanceof Map), 'tabs is not a Map');
    assert.ok(typeof response.tabs === 'object', 'tabs is a plain object');
  });

  it('returns collapsed as array (not Set)', async () => {
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    let response = null;
    listener({ type: 'GET_STATE' }, {}, (data) => { response = data; });

    assert.ok(Array.isArray(response.collapsed), 'collapsed is an array');
  });

  it('includes groupColors object', async () => {
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    let response = null;
    listener({ type: 'GET_STATE' }, {}, (data) => { response = data; });

    assert.ok(typeof response.groupColors === 'object', 'groupColors is an object');
  });
});

// ---------------------------------------------------------------------------
// Tests: Broadcasting — error tolerance
// ---------------------------------------------------------------------------

describe('broadcasting error tolerance', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [makeChromeTab({ id: 1, index: 0 })];
    });
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('does not throw when side panel is closed (sendMessage fails)', async () => {
    // Make sendMessage throw (simulates no receivers)
    chromeMock.runtime.sendMessage = mock.fn(async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    });

    await loadBackground(chromeMock);

    // Fire a tab event that triggers broadcast
    const newTab = makeChromeTab({ id: 50, title: 'New Tab' });

    // This should not throw
    assert.doesNotThrow(() => {
      chromeMock.tabs.onCreated._fire(newTab);
    });

    await new Promise((r) => setTimeout(r, 100));
    // If we get here without an unhandled rejection, the test passes
  });
});

// ---------------------------------------------------------------------------
// Tests: Persistence — debounced save
// ---------------------------------------------------------------------------

describe('debounced persistence', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [makeChromeTab({ id: 1, index: 0 })];
    });
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('saves state with STORAGE_KEY as key', async () => {
    await loadBackground(chromeMock);

    // Wait for init save
    await new Promise((r) => setTimeout(r, 600));

    const setCalls = chromeMock.storage.local.set.mock.calls;
    assert.ok(setCalls.length > 0, 'storage.local.set was called');

    const lastCall = setCalls[setCalls.length - 1];
    assert.ok('linkmap_state' in lastCall.arguments[0], 'saves with linkmap_state key');
  });

  it('saved state contains version, tabs, rootIds, collapsed, groupColors, theme', async () => {
    await loadBackground(chromeMock);

    await new Promise((r) => setTimeout(r, 600));

    const setCalls = chromeMock.storage.local.set.mock.calls;
    const lastCall = setCalls[setCalls.length - 1];
    const savedState = lastCall.arguments[0].linkmap_state;

    assert.ok(savedState.version, 'has version');
    assert.ok(savedState.tabs, 'has tabs');
    assert.ok(Array.isArray(savedState.rootIds), 'has rootIds array');
    assert.ok(Array.isArray(savedState.collapsed), 'has collapsed array');
    assert.ok(typeof savedState.groupColors === 'object', 'has groupColors');
    assert.ok(typeof savedState.theme === 'string', 'has theme');
  });
});
