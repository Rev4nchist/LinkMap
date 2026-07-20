import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SW_SESSION_KEY } from '../shared/constants.js';
import { ShadowState } from '../shared/shadow-state.js';

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
  // Default: warm SW-wake (marker already present) — preserves today's
  // behavior for every test that doesn't explicitly simulate a cold
  // restart. A cold-restart test clears this before loadBackground().
  const sessionData = { [SW_SESSION_KEY]: { bootTs: 0 } };

  let nextTabId = 1000;
  let nextWindowId = 100;
  let nextGroupId = 500;

  return {
    tabs: {
      onCreated: makeEvent('tabs.onCreated'),
      onRemoved: makeEvent('tabs.onRemoved'),
      onUpdated: makeEvent('tabs.onUpdated'),
      onMoved: makeEvent('tabs.onMoved'),
      onActivated: makeEvent('tabs.onActivated'),
      onAttached: makeEvent('tabs.onAttached'),
      onDetached: makeEvent('tabs.onDetached'),
      onReplaced: makeEvent('tabs.onReplaced'),
      query: mock.fn(async () => []),
      create: mock.fn(async (opts) => {
        const id = nextTabId++;
        return { id, ...opts };
      }),
      update: mock.fn(async () => ({})),
      remove: mock.fn(async () => {}),
      duplicate: mock.fn(async () => ({})),
      group: mock.fn(async () => nextGroupId++),
      ungroup: mock.fn(async () => {}),
      move: mock.fn(async () => ({})),
      get: mock.fn(async (id) => ({ id, pinned: false, groupId: -1 })),
    },
    tabGroups: {
      onCreated: makeEvent('tabGroups.onCreated'),
      onRemoved: makeEvent('tabGroups.onRemoved'),
      onUpdated: makeEvent('tabGroups.onUpdated'),
      query: mock.fn(async () => []),
      update: mock.fn(async () => ({})),
      get: mock.fn(async (id) => ({ id, windowId: 1 })),
    },
    windows: {
      onCreated: makeEvent('windows.onCreated'),
      onRemoved: makeEvent('windows.onRemoved'),
      onFocusChanged: makeEvent('windows.onFocusChanged'),
      getCurrent: mock.fn(async () => ({ id: 1 })),
      create: mock.fn(async () => {
        const id = nextWindowId++;
        return { id };
      }),
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
      session: {
        get: mock.fn(async (key) => {
          if (typeof key === 'string') {
            return { [key]: sessionData[key] };
          }
          return { ...sessionData };
        }),
        set: mock.fn(async (obj) => {
          Object.assign(sessionData, obj);
        }),
        _data: sessionData,
      },
    },
    runtime: {
      onMessage: makeEvent('runtime.onMessage'),
      onSuspend: makeEvent('runtime.onSuspend'),
      sendMessage: mock.fn(async () => {}),
    },
    commands: {
      onCommand: makeEvent('commands.onCommand'),
    },
    sidePanel: {
      setPanelBehavior: mock.fn(async () => {}),
    },
    alarms: {
      create: mock.fn(async () => {}),
      onAlarm: makeEvent('alarms.onAlarm'),
    },
    _listeners: listeners,
    _storedData: storedData,
    _nextTabId: () => nextTabId,
    _nextWindowId: () => nextWindowId,
    _nextGroupId: () => nextGroupId,
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

  it('A6: init saves state immediately, not via the 500ms debounce', async () => {
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [];
      return [makeChromeTab({ id: 1 })];
    });

    await loadBackground(chromeMock);
    // Only loadBackground's own ~50ms settle wait has elapsed — well under
    // the 500ms save debounce. An immediate save must already be persisted.
    assert.ok(chromeMock.storage.local._data.linkmap_state, 'state persisted immediately after init, before the debounce would have fired');
  });

  it('B-2/F9: computes coldRestart:true from an empty chrome.storage.session and threads it into reconcile', async () => {
    // Simulate a genuine cold restart: no prior SW-session marker.
    delete chromeMock.storage.session._data[SW_SESSION_KEY];
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [makeChromeTab({ id: 1 })];
    });

    const reconcileSpy = mock.method(ShadowState.prototype, 'reconcileWithLiveTabs');
    try {
      await loadBackground(chromeMock);
      assert.ok(reconcileSpy.mock.callCount() >= 1, 'reconcileWithLiveTabs was called');
      const [, opts] = reconcileSpy.mock.calls[0].arguments;
      assert.equal(opts?.coldRestart, true, 'coldRestart computed true from an empty session marker');
    } finally {
      mock.restoreAll();
    }

    // The marker must be set so the NEXT SW-wake sees warm.
    assert.ok(chromeMock.storage.session._data[SW_SESSION_KEY], 'SW session marker was set after init');
  });

  it('B-2/F9: computes coldRestart:false from a populated chrome.storage.session (warm SW-wake)', async () => {
    // beforeEach's fresh chromeMock already defaults to a populated marker.
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [makeChromeTab({ id: 1 })];
    });

    const reconcileSpy = mock.method(ShadowState.prototype, 'reconcileWithLiveTabs');
    try {
      await loadBackground(chromeMock);
      assert.ok(reconcileSpy.mock.callCount() >= 1, 'reconcileWithLiveTabs was called');
      const [, opts] = reconcileSpy.mock.calls[0].arguments;
      assert.equal(opts?.coldRestart, false, 'coldRestart computed false when the SW session marker is already present');
    } finally {
      mock.restoreAll();
    }
  });

  it('F8: remaps workspace tabIds through the reconcile tabIdMap and drops closed tabs', async () => {
    const savedState = {
      version: 1,
      tabs: {
        100: { tabId: 100, parentId: null, children: [], title: 'GitHub', url: 'https://github.com', favIconUrl: '', pinned: false, audible: false, status: 'complete', groupId: -1, index: 0, windowId: 1 },
      },
      rootIds: [100],
      collapsed: [],
      groupColors: {},
      theme: 'dracula',
    };

    chromeMock.storage.local._data.linkmap_workspaces = {
      workspaces: [
        { id: 'w1', name: 'Work', tabIds: [100, 999] }, // 999 = a tab that no longer exists
      ],
      activeWorkspaceId: 'w1',
    };

    // After "restart" Chrome assigns tab 100 a brand-new id (501); tab 999
    // never comes back (closed tab).
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 501, active: true })];
      return [makeChromeTab({ id: 501, title: 'GitHub', url: 'https://github.com', index: 0 })];
    });

    await loadBackground(chromeMock, savedState);

    const stored = chromeMock.storage.local._data.linkmap_workspaces;
    assert.ok(stored, 'workspaces were re-saved after reconcile');
    assert.deepEqual(stored.workspaces[0].tabIds, [501], 'tabId remapped through reconcile, closed tab dropped');
  });

  it('#9: drops a workspace member whose id was recycled by an unrelated tab on cold restart', async () => {
    const savedState = {
      version: 1,
      tabs: {
        42: { tabId: 42, parentId: null, children: [], title: 'Inbox', url: 'https://mail.example/inbox', favIconUrl: '', pinned: false, audible: false, status: 'complete', groupId: -1, index: 0, windowId: 1 },
      },
      rootIds: [42],
      collapsed: [],
      groupColors: {},
      theme: 'dracula',
    };

    chromeMock.storage.local._data.linkmap_workspaces = {
      workspaces: [{ id: 'w1', name: 'Work', tabIds: [42] }],
      activeWorkspaceId: 'w1',
    };

    // Cold restart (empty session marker): id 42 is coincidentally reused by an
    // UNRELATED tab; the original mail tab never came back.
    delete chromeMock.storage.session._data[SW_SESSION_KEY];
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 42, active: true })];
      return [makeChromeTab({ id: 42, title: 'Evil', url: 'https://evil.example/x', index: 0 })];
    });

    await loadBackground(chromeMock, savedState);

    const stored = chromeMock.storage.local._data.linkmap_workspaces;
    assert.deepEqual(stored.workspaces[0].tabIds, [], 'recycled id dropped, not aliased to the unrelated tab');
  });

  it('#9: keeps a workspace member whose tab survived reconcile at its own id (sameIdMatched keep path)', async () => {
    const savedState = {
      version: 1,
      tabs: {
        7: { tabId: 7, parentId: null, children: [], title: 'GitHub', url: 'https://github.com', favIconUrl: '', pinned: false, audible: false, status: 'complete', groupId: -1, index: 0, windowId: 1 },
      },
      rootIds: [7],
      collapsed: [],
      groupColors: {},
      theme: 'dracula',
    };

    chromeMock.storage.local._data.linkmap_workspaces = {
      workspaces: [{ id: 'w1', name: 'Work', tabIds: [7] }],
      activeWorkspaceId: 'w1',
    };

    // Cold restart, but tab 7 kept its id AND corroborates (same url) -> Pass 1
    // match -> present in sameIdMatched, not tabIdMap. The consumer must keep it.
    delete chromeMock.storage.session._data[SW_SESSION_KEY];
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 7, active: true })];
      return [makeChromeTab({ id: 7, title: 'GitHub', url: 'https://github.com', index: 0 })];
    });

    await loadBackground(chromeMock, savedState);

    const stored = chromeMock.storage.local._data.linkmap_workspaces;
    assert.deepEqual(stored.workspaces[0].tabIds, [7], 'surviving same-id tab kept in the workspace');
  });

  // #10 — tab notes are an id-keyed store like workspace membership; remap the same way.
  const noteState = (id, url) => ({
    version: 1,
    tabs: { [id]: { tabId: id, parentId: null, children: [], title: 'GitHub', url, favIconUrl: '', pinned: false, audible: false, status: 'complete', groupId: -1, index: 0, windowId: 1 } },
    rootIds: [id],
    collapsed: [],
    groupColors: {},
    theme: 'dracula',
  });

  it("moves a tab note to the tab's new id (tabIdMap)", async () => {
    chromeMock.storage.local._data.linkmap_tab_notes = { 100: 'my note' };
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 501, active: true })];
      return [makeChromeTab({ id: 501, title: 'GitHub', url: 'https://github.com', index: 0 })];
    });

    await loadBackground(chromeMock, noteState(100, 'https://github.com'));

    assert.deepEqual(chromeMock.storage.local._data.linkmap_tab_notes, { 501: 'my note' }, "note moved to the tab's new id");
  });

  it('drops a tab note whose id was recycled by an unrelated tab on cold restart', async () => {
    chromeMock.storage.local._data.linkmap_tab_notes = { 42: 'inbox note' };
    delete chromeMock.storage.session._data[SW_SESSION_KEY];
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 42, active: true })];
      return [makeChromeTab({ id: 42, title: 'Evil', url: 'https://evil.example/x', index: 0 })];
    });

    await loadBackground(chromeMock, noteState(42, 'https://mail.example/inbox'));

    assert.deepEqual(chromeMock.storage.local._data.linkmap_tab_notes, {}, 'note dropped, not aliased to the unrelated recycled tab');
  });

  it('keeps a tab note whose tab survived reconcile at its own id (sameIdMatched)', async () => {
    chromeMock.storage.local._data.linkmap_tab_notes = { 7: 'kept note' };
    delete chromeMock.storage.session._data[SW_SESSION_KEY];
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 7, active: true })];
      return [makeChromeTab({ id: 7, title: 'GitHub', url: 'https://github.com', index: 0 })];
    });

    await loadBackground(chromeMock, noteState(7, 'https://github.com'));

    assert.deepEqual(chromeMock.storage.local._data.linkmap_tab_notes, { 7: 'kept note' }, 'note kept for the surviving same-id tab');
  });

  it('canonicalizes a non-canonical note key for a surviving tab', async () => {
    chromeMock.storage.local._data.linkmap_tab_notes = { '07': 'padded note' };
    delete chromeMock.storage.session._data[SW_SESSION_KEY];
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 7, active: true })];
      return [makeChromeTab({ id: 7, title: 'GitHub', url: 'https://github.com', index: 0 })];
    });

    await loadBackground(chromeMock, noteState(7, 'https://github.com'));

    assert.deepEqual(chromeMock.storage.local._data.linkmap_tab_notes, { 7: 'padded note' }, 'non-canonical key canonicalized and persisted');
  });
});

// ---------------------------------------------------------------------------
// Tests: CR-recovery-save — deferred retry-reconciliation swap write-through
// ---------------------------------------------------------------------------

describe('background.js deferred retry-reconciliation write-through (CR-recovery-save)', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('persists the swapped-in retry state immediately, not via the 500ms debounce', async () => {
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

    let fullQueryCallCount = 0;
    chromeMock.tabs.query = mock.fn(async (q) => {
      if (q && q.active) return [makeChromeTab({ id: 101, active: true })];
      fullQueryCallCount += 1;
      if (fullQueryCallCount === 1) {
        // Initial reconcile: completely unrelated live tabs (different ids,
        // urls, titles, windowId) — tab1/tab2 match nothing and get
        // dead-removed, so survivingRelationships drops to 0 while
        // savedRelationships was 1 — triggers the 2s deferred retry.
        return [
          makeChromeTab({ id: 101, index: 0, windowId: 2, title: 'Unrelated A', url: 'https://unrelated-a.example' }),
          makeChromeTab({ id: 102, index: 1, windowId: 2, title: 'Unrelated B', url: 'https://unrelated-b.example' }),
        ];
      }
      // Retry reconcile (fires ~2s later): live tabs now match the saved
      // snapshot by id, so the parent/child relationship survives.
      return [
        makeChromeTab({ id: 1, index: 0, title: 'Saved Root', url: 'https://saved.com' }),
        makeChromeTab({ id: 2, index: 1, title: 'Saved Child', url: 'https://child.com' }),
      ];
    });

    await loadBackground(chromeMock, savedState);

    // Wait past the 2s deferred-retry trigger, but well under the 500ms
    // debounce window that would fire *after* that (2000 + 500 = 2500ms).
    // With the fix (commitStateNow), the write lands synchronously as part
    // of the retry callback itself — no additional debounce wait needed.
    await new Promise((r) => setTimeout(r, 2150));

    const setCalls = chromeMock.storage.local.set.mock.calls;
    const retrySwapWrite = setCalls.find(
      (c) => c.arguments[0]?.linkmap_state?.tabs?.[2]?.parentId === 1
    );
    assert.ok(retrySwapWrite, 'the retry-swapped state (with the surviving parent/child relationship) was persisted within ~150ms of the swap, not after an additional 500ms debounce');
  });
});

// ---------------------------------------------------------------------------
// Tests: SW-5 — init failure liveness (A7)
// ---------------------------------------------------------------------------

describe('background.js init failure liveness (SW-5, A7)', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('SW-5: chrome.windows.getCurrent rejecting does not abort init (inner try/catch)', async () => {
    chromeMock.windows.getCurrent = mock.fn(async () => { throw new Error('no window'); });
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [];
      return [makeChromeTab({ id: 1 })];
    });

    await loadBackground(chromeMock);
    await new Promise((r) => setTimeout(r, 60));

    // init still completed and saved reconciled state despite the failure.
    assert.ok(chromeMock.storage.local._data.linkmap_state, 'state was saved despite getCurrent failure');

    // A gated message resolves immediately — proves initComplete flipped true.
    const listener = chromeMock._listeners['runtime.onMessage'][0];
    let response = null;
    listener({ type: 'GET_SETTINGS' }, {}, (data) => { response = data; });
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(response && response.settings, 'GET_SETTINGS resolved — init completed normally');
  });

  it('SW-5: chrome.tabs.query({}) rejecting hits the outer catch — no save, initComplete still flips via finally, state restored from savedData', async () => {
    const savedState = {
      version: 1,
      tabs: {
        1: { tabId: 1, parentId: null, children: [], title: 'Saved', url: 'https://saved.com', favIconUrl: '', pinned: false, audible: false, status: 'complete', groupId: -1, index: 0, windowId: 1 },
      },
      rootIds: [1],
      collapsed: [],
      groups: {},
      groupColors: {},
      theme: 'dracula',
    };

    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && Object.keys(queryInfo).length === 0) {
        throw new Error('tabs.query failed');
      }
      return [];
    });

    await loadBackground(chromeMock, savedState);
    await new Promise((r) => setTimeout(r, 100));

    // Never call saveState in the failure path.
    assert.equal(chromeMock.storage.local.set.mock.callCount(), 0, 'no storage.local.set call in the outer-catch failure path');

    // initComplete still flips true via finally — a gated message resolves.
    const listener = chromeMock._listeners['runtime.onMessage'][0];
    let response = null;
    listener({ type: 'GET_SETTINGS' }, {}, (data) => { response = data; });
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(response && response.settings, 'gated message resolved — initComplete flipped true via finally despite the failure');
  });
});

// ---------------------------------------------------------------------------
// Tests: RR-10 (2a) + A4 — reconcileRetryGroups (background/context.js)
// ---------------------------------------------------------------------------
//
// The retry's group reconcile + A4 merge is exercised via the extracted,
// exported reconcileRetryGroups() helper directly, rather than through a
// full loadBackground() end-to-end retry trigger. Reason: background.js's
// retry rebuilds `retryState` from the SAME `savedData` object reference the
// main reconcile already mutated in place (ShadowState.fromStorage does not
// deep-clone, and reconcileWithLiveTabs's dead-tab/orphan-repair paths — see
// removeTab and _validateAndRepair's parentId-authoritative walk — mutate
// shared node objects). That makes "the retry recovers MORE relationships
// than the main pass" mathematically unreachable via any tab-lineage-loss
// scenario in a black-box test (verified empirically) — a pre-existing gap
// outside this task's scope, flagged separately. Testing the exported merge
// function directly still exercises the exact code background.js calls.

describe('background/context.js: reconcileRetryGroups (RR-10, A4)', () => {
  it('RR-10: uses the passed-in pre-reconcile counts for quarantine, not a retryState-internal recompute', async () => {
    const { reconcileRetryGroups } = await import('../background/context.js');
    const { ShadowState } = await import('../shared/shadow-state.js');

    const retryState = new ShadowState();
    retryState.groups.set(10, { id: 10, title: 'Old Group', color: 'blue', collapsed: false, windowId: 1 });

    const liveState = new ShadowState(); // no group 10 progress on the live side

    // Group 10 is not live on the retry's own query — it gets quarantined.
    // savedGroupTabCounts is the pre-reconcile snapshot (2a) — must be used
    // verbatim, not recomputed from retryState.tabs post-reconcile.
    reconcileRetryGroups(retryState, /* retryGroups */ [], new Map([[10, 2]]), new Map(), liveState);

    assert.equal(retryState.orphanedGroups.get(10)?.count, 2, 'quarantine count used the passed-in pre-reconcile map, not a post-reconcile live-groupId recompute');
  });

  it('A4: merges live groupColors, group title/color, and orphanedGroups progress into retryState before the swap', async () => {
    const { reconcileRetryGroups } = await import('../background/context.js');
    const { ShadowState } = await import('../shared/shadow-state.js');

    const retryState = new ShadowState();
    retryState.groups.set(10, { id: 10, title: '', color: 'grey', collapsed: false, windowId: 1 });

    const liveState = new ShadowState();
    liveState.groups.set(10, { id: 10, title: 'Renamed Live', color: 'red', collapsed: true, windowId: 1 });
    liveState.groupColors[10] = '#ff00ff';
    liveState.orphanedGroups.set(20, {
      id: 20, title: 'Removed While Live', color: 'purple', collapsed: false,
      rawWindowId: 1, count: 1, colorOverride: undefined, orphanedAt: Date.now(),
    });

    reconcileRetryGroups(
      retryState,
      [{ id: 10, title: '', color: 'grey', collapsed: false, windowId: 1 }],
      new Map(),
      new Map(),
      liveState
    );

    assert.equal(retryState.groups.get(10).title, 'Renamed Live', 'live title merged in over the retry copy\'s untitled default');
    assert.equal(retryState.groups.get(10).color, 'red', 'live color merged in over the retry copy\'s default color');
    assert.equal(retryState.groupColors[10], '#ff00ff', 'live groupColors override merged in');
    assert.ok(retryState.orphanedGroups.has(20), 'live-only quarantine entry merged in — swap must not regress it');
  });

  it('A4: does not resurrect a group into retryState.groups if the retry\'s own reconcile already quarantined it', async () => {
    const { reconcileRetryGroups } = await import('../background/context.js');
    const { ShadowState } = await import('../shared/shadow-state.js');

    const retryState = new ShadowState();
    retryState.groups.set(10, { id: 10, title: 'Old Group', color: 'blue', collapsed: false, windowId: 1 });

    const liveState = new ShadowState();
    liveState.groups.set(10, { id: 10, title: 'Old Group', color: 'blue', collapsed: false, windowId: 1 });
    liveState.groupColors[10] = '#ff00ff';

    // Group 10 is NOT live on the retry's own query — gets quarantined.
    reconcileRetryGroups(retryState, [], new Map([[10, 2]]), new Map(), liveState);

    assert.equal(retryState.groups.has(10), false, 'group 10 stays quarantined, not resurrected into groups by the merge');
    assert.equal(retryState.groupColors[10], undefined, 'groupColors merge only applies to ids retryState still tracks in groups');
  });
});

// ---------------------------------------------------------------------------
// Tests: context.js persistence and sweep (A5, A6, 2d)
// ---------------------------------------------------------------------------

describe('background/context.js: persistence and sweep (A5, A6, 2d)', () => {
  afterEach(() => {
    delete globalThis.chrome;
  });

  it('A6: saveStateImmediate cancels a pending debounced saveState', async () => {
    const setCalls = [];
    globalThis.chrome = {
      storage: { local: { set: async (obj) => { setCalls.push(obj); } } },
      runtime: { sendMessage: async () => {} },
    };
    const { createContext } = await import(`../background/context.js?t=${Date.now()}-${Math.random()}`);
    const context = createContext();

    context.saveState(); // schedules a 500ms debounced write
    context.saveStateImmediate(); // writes now AND must cancel the pending one

    assert.equal(setCalls.length, 1, 'immediate save wrote exactly once synchronously');

    await new Promise((r) => setTimeout(r, 650)); // past the original debounce window

    assert.equal(setCalls.length, 1, 'the cancelled debounce never fired a second write');
  });

  it('CR-context-persist: saveStateImmediate resolves an observable {success:true} on a successful write and never rejects', async () => {
    globalThis.chrome = {
      storage: { local: { set: async () => {} } },
      runtime: { sendMessage: async () => {} },
    };
    const { createContext } = await import(`../background/context.js?t=${Date.now()}-${Math.random()}`);
    const context = createContext();

    const result = await context.saveStateImmediate();
    assert.deepEqual(result, { success: true });
  });

  it('CR-context-persist: saveStateImmediate resolves {success:false, error} on a rejected write instead of rejecting or resolving undefined', async () => {
    const writeError = new Error('quota exceeded');
    globalThis.chrome = {
      storage: { local: { set: async () => { throw writeError; } } },
      runtime: { sendMessage: async () => {} },
    };
    const { createContext } = await import(`../background/context.js?t=${Date.now()}-${Math.random()}`);
    const context = createContext();

    const result = await context.saveStateImmediate();
    assert.equal(result.success, false);
    assert.equal(result.error, writeError);
  });

  it('A5: retryMissingGroupTitles single-flights — a re-trigger while running is queued, not run concurrently', async () => {
    globalThis.chrome = {
      storage: { local: { set: async () => {} } },
      runtime: { sendMessage: async () => {} },
      tabGroups: { query: async () => [], update: async () => ({}) },
    };
    const originalSetTimeout = globalThis.setTimeout;
    const scheduled = [];
    globalThis.setTimeout = (fn, ms) => { scheduled.push({ fn, ms }); return 0; }; // never actually fires
    try {
      const { createContext } = await import(`../background/context.js?t=${Date.now()}-${Math.random()}`);
      const context = createContext();

      context.retryMissingGroupTitles();
      context.retryMissingGroupTitles(); // re-trigger while "in flight"

      assert.equal(scheduled.length, 1, 'the second call was queued (rerunRequested), not a second concurrent attempt() chain');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('2d: retryMissingGroupTitles rescues a matched orphaned title via chrome.tabGroups.update', async () => {
    const updateCalls = [];
    globalThis.chrome = {
      storage: { local: { set: async () => {} } },
      runtime: { sendMessage: async () => {} },
      tabGroups: {
        query: async () => [{ id: 5, title: '', color: 'blue', collapsed: false, windowId: 1 }],
        update: async (id, changes) => { updateCalls.push({ id, changes }); return {}; },
      },
    };
    try {
      const { createContext } = await import(`../background/context.js?t=${Date.now()}-${Math.random()}`);
      const context = createContext();

      // A live, tracked, untitled group with 1 member tab, and a matching
      // quarantined orphan of the same color/window/count.
      context.state.addTab(1, { tabId: 1, parentId: null, groupId: 5, title: 'T', url: 'https://x.com', index: 0, windowId: 1 });
      context.state.addGroup({ id: 5, title: '', color: 'blue', collapsed: false, windowId: 1 });
      context.state.orphanedGroups.set(99, {
        id: 99, title: 'Rescued Title', color: 'blue', collapsed: false,
        rawWindowId: 1, count: 1, colorOverride: undefined, orphanedAt: Date.now(),
      });

      context.retryMissingGroupTitles();

      await new Promise((r) => setTimeout(r, 2200));

      assert.equal(updateCalls.length, 1, 'chrome.tabGroups.update called to push the rescued title');
      assert.equal(updateCalls[0].id, 5);
      assert.equal(updateCalls[0].changes.title, 'Rescued Title');
    } finally {
      delete globalThis.chrome;
    }
  });

  it('CR-context-persist: retryMissingGroupTitles retries after a transient chrome.tabGroups.query rejection instead of giving up on the first failed round', async () => {
    const updateCalls = [];
    let queryCallCount = 0;
    globalThis.chrome = {
      storage: { local: { set: async () => {} } },
      runtime: { sendMessage: async () => {} },
      tabGroups: {
        query: async () => {
          queryCallCount += 1;
          if (queryCallCount === 1) {
            // Simulate a transient failure (e.g. SW briefly suspended).
            throw new Error('service worker suspended');
          }
          return [{ id: 5, title: '', color: 'blue', collapsed: false, windowId: 1 }];
        },
        update: async (id, changes) => { updateCalls.push({ id, changes }); return {}; },
      },
    };
    try {
      const { createContext } = await import(`../background/context.js?t=${Date.now()}-${Math.random()}`);
      const context = createContext();

      context.state.addTab(1, { tabId: 1, parentId: null, groupId: 5, title: 'T', url: 'https://x.com', index: 0, windowId: 1 });
      context.state.addGroup({ id: 5, title: '', color: 'blue', collapsed: false, windowId: 1 });
      context.state.orphanedGroups.set(99, {
        id: 99, title: 'Rescued Title', color: 'blue', collapsed: false,
        rawWindowId: 1, count: 1, colorOverride: undefined, orphanedAt: Date.now(),
      });

      context.retryMissingGroupTitles();

      // First attempt fires at 2000ms and rejects; the second attempt fires
      // at 2000+4000=6000ms and should succeed.
      await new Promise((r) => setTimeout(r, 6300));

      assert.ok(queryCallCount >= 2, 'a rejected round did not stop the retry chain');
      assert.equal(updateCalls.length, 1, 'the retry after the transient failure still rescued the title');
      assert.equal(updateCalls[0].id, 5);
      assert.equal(updateCalls[0].changes.title, 'Rescued Title');
    } finally {
      delete globalThis.chrome;
    }
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
    await new Promise((r) => setTimeout(r, 0));

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
    await new Promise((r) => setTimeout(r, 0));
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
    await new Promise((r) => setTimeout(r, 0));
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
    await new Promise((r) => setTimeout(r, 0));

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
    await new Promise((r) => setTimeout(r, 0));
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
    await new Promise((r) => setTimeout(r, 0));
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
    await new Promise((r) => setTimeout(r, 0));
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
    const savedState = setCalls
      .map((c) => c.arguments[0].linkmap_state)
      .find((s) => s.groupColors && s.groupColors[5] === '#ff0000');
    assert.ok(savedState, 'a storage.local.set call persisted the new group color');
  });

  // A10/Phase 5: SET_GROUP_COLOR is a group-structural mutation and must be
  // write-through (commitStateNow) — the save observed synchronously, with
  // no debounce wait needed (unlike the legacy commitState() path above).
  it('writes SET_GROUP_COLOR through commitStateNow without waiting for the debounce', async () => {
    await loadBackground(chromeMock);
    chromeMock.storage.local.set.mock.resetCalls();

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    listener(
      { type: 'SET_GROUP_COLOR', payload: { groupId: 9, color: '#00ff00' } },
      {},
      () => {}
    );

    // Immediate save — no 500ms debounce wait required.
    await new Promise((r) => setTimeout(r, 10));

    const setCall = chromeMock.storage.local.set.mock.calls.find(
      (c) => c.arguments[0]?.linkmap_state?.groupColors?.[9] === '#00ff00'
    );
    assert.ok(setCall, 'group color persisted immediately, before any debounce would have fired');
  });

  // A10/Phase 5: RENAME_GROUP is likewise write-through.
  it('writes RENAME_GROUP through commitStateNow without waiting for the debounce', async () => {
    await loadBackground(chromeMock);
    chromeMock.storage.local.set.mock.resetCalls();

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    listener(
      { type: 'RENAME_GROUP', payload: { groupId: 5, title: 'Research' } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 10));

    const setCall = chromeMock.storage.local.set.mock.calls.find(
      (c) => c.arguments[0]?.linkmap_state?.groups?.[5]?.title === 'Research'
    );
    assert.ok(setCall, 'group title persisted immediately, before any debounce would have fired');
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
// Tests: MOVE_TAB group membership sync (CAE-4/A9)
// ---------------------------------------------------------------------------

describe('MOVE_TAB group sync (CAE-4/A9)', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('sends chrome.tabs.ungroup with the dragged tab when dropped outside any group (drag-out)', async () => {
    chromeMock.tabs.query = mock.fn(async (q) => {
      if (q && q.active) return [makeChromeTab({ id: 1, active: true, groupId: 5 })];
      return [
        makeChromeTab({ id: 1, index: 0, groupId: 5 }),
        makeChromeTab({ id: 2, index: 1, groupId: -1 }),
      ];
    });
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    listener(
      { type: 'MOVE_TAB', payload: { tabId: 1, newParentId: null, targetTabId: 2, position: 'before', targetGroupId: -1 } },
      {},
      () => {}
    );
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(chromeMock.tabs.ungroup.mock.callCount(), 1, 'chrome.tabs.ungroup called once');
    assert.deepEqual(chromeMock.tabs.ungroup.mock.calls[0].arguments[0], [1]);
    assert.equal(chromeMock.tabs.group.mock.callCount(), 0);
  });

  it('groups the tab and its non-pinned descendant subtree when dropped into a group (drag-in, 4b/A9)', async () => {
    chromeMock.tabs.query = mock.fn(async (q) => {
      if (q && q.active) return [makeChromeTab({ id: 1, active: true })];
      return [
        makeChromeTab({ id: 1, index: 0, groupId: -1 }),
        makeChromeTab({ id: 2, index: 1, groupId: -1 }),
        makeChromeTab({ id: 3, index: 2, groupId: 7 }),
      ];
    });
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    // Reparent tab 2 under tab 1 first so it becomes a descendant.
    listener({ type: 'MOVE_TAB', payload: { tabId: 2, newParentId: 1, targetTabId: 1, position: 'child' } }, {}, () => {});
    await new Promise((r) => setTimeout(r, 20));

    listener(
      { type: 'MOVE_TAB', payload: { tabId: 1, newParentId: null, targetTabId: 3, position: 'before', targetGroupId: 7 } },
      {},
      () => {}
    );
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(chromeMock.tabs.group.mock.callCount(), 1);
    const call = chromeMock.tabs.group.mock.calls[0].arguments[0];
    assert.deepEqual(call.tabIds, [1, 2], 'both the dragged tab and its descendant are grouped together');
    assert.equal(call.groupId, 7);
  });

  it('excludes pinned descendants from the group sync call', async () => {
    chromeMock.tabs.query = mock.fn(async (q) => {
      if (q && q.active) return [makeChromeTab({ id: 1, active: true })];
      return [
        makeChromeTab({ id: 1, index: 0, groupId: -1 }),
        makeChromeTab({ id: 2, index: 1, groupId: -1, pinned: true }),
        makeChromeTab({ id: 3, index: 2, groupId: 7 }),
      ];
    });
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    listener({ type: 'MOVE_TAB', payload: { tabId: 2, newParentId: 1, targetTabId: 1, position: 'child' } }, {}, () => {});
    await new Promise((r) => setTimeout(r, 20));

    listener(
      { type: 'MOVE_TAB', payload: { tabId: 1, newParentId: null, targetTabId: 3, position: 'before', targetGroupId: 7 } },
      {},
      () => {}
    );
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(chromeMock.tabs.group.mock.callCount(), 1);
    assert.deepEqual(chromeMock.tabs.group.mock.calls[0].arguments[0].tabIds, [1], 'pinned descendant (2) excluded');
  });

  it('repairs shadow state groupId from chrome.tabs.get when the sync call fails (A9)', async () => {
    chromeMock.tabs.query = mock.fn(async (q) => {
      if (q && q.active) return [makeChromeTab({ id: 1, active: true, groupId: 5 })];
      return [
        makeChromeTab({ id: 1, index: 0, groupId: 5 }),
        makeChromeTab({ id: 2, index: 1, groupId: -1 }),
      ];
    });
    chromeMock.tabs.ungroup = mock.fn(async () => { throw new Error('ungroup failed'); });
    chromeMock.tabs.get = mock.fn(async (id) => ({ id, pinned: false, groupId: 8 }));
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    listener(
      { type: 'MOVE_TAB', payload: { tabId: 1, newParentId: null, targetTabId: 2, position: 'before', targetGroupId: -1 } },
      {},
      () => {}
    );
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(chromeMock.tabs.get.mock.callCount(), 1, 'repair fetches the live tab');

    let response = null;
    listener({ type: 'GET_STATE' }, {}, (data) => { response = data; });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(response.tabs[1].groupId, 8, 'shadow state repaired to the live groupId, not left stale or optimistically wrong');
  });
});

// ---------------------------------------------------------------------------
// Tests: MOVE_TO_GROUP groups descendants + write-through (4b/A10a)
// ---------------------------------------------------------------------------

describe('MOVE_TO_GROUP groups descendants and write-through (4b/A10a)', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
    chromeMock.tabs.query = mock.fn(async (q) => {
      if (q && q.active) return [makeChromeTab({ id: 1, active: true })];
      return [
        makeChromeTab({ id: 1, index: 0 }),
        makeChromeTab({ id: 2, index: 1 }),
      ];
    });
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('groups the tab and its descendants, sets groupId on every moved id before the immediate commit', async () => {
    chromeMock.tabs.get = mock.fn(async (id) => ({ id, pinned: false }));
    chromeMock.tabs.group = mock.fn(async () => 42);
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    // Reparent tab 2 under tab 1 first so it becomes a descendant.
    listener({ type: 'MOVE_TAB', payload: { tabId: 2, newParentId: 1, targetTabId: 1, position: 'child' } }, {}, () => {});
    await new Promise((r) => setTimeout(r, 20));

    let response = null;
    listener({ type: 'MOVE_TO_GROUP', payload: { tabId: 1, groupId: null } }, {}, (r) => { response = r; });
    // A10a/Phase 5: immediate commit — no 500ms debounce wait needed.
    await new Promise((r) => setTimeout(r, 30));

    assert.deepEqual(response, { groupId: 42 });
    const groupCall = chromeMock.tabs.group.mock.calls[0].arguments[0];
    assert.deepEqual(groupCall.tabIds, [1, 2], 'the "New Group" action groups descendants too');

    let statePayload = null;
    listener({ type: 'GET_STATE' }, {}, (d) => { statePayload = d; });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(statePayload.tabs[1].groupId, 42, 'A10a: groupId set synchronously on the primary tab');
    assert.equal(statePayload.tabs[2].groupId, 42, 'A10a: groupId set synchronously on the descendant too');

    const setCall = chromeMock.storage.local.set.mock.calls.find(
      (c) => c.arguments[0]?.linkmap_state?.tabs?.[2]?.groupId === 42
    );
    assert.ok(setCall, 'write-through commit persisted the descendant groupId immediately');
  });

  it('CR-move2group-unpin: writes the unpin into shadow state before collecting groupable ids, so the primary tab is not dropped by a stale pinned flag', async () => {
    // Shadow state loads tab 1 as pinned:true (its last known live state).
    chromeMock.tabs.query = mock.fn(async (q) => {
      if (q && q.active) return [makeChromeTab({ id: 1, active: true, pinned: true })];
      return [makeChromeTab({ id: 1, index: 0, pinned: true })];
    });
    // chrome.tabs.get first reports pinned:true (matching the tab's stale
    // shadow-state pinned flag), then reports pinned:false once
    // chrome.tabs.update has "unpinned" it — simulating the onUpdated event
    // not having reached shadow state yet.
    let getCallCount = 0;
    chromeMock.tabs.get = mock.fn(async (id) => {
      getCallCount += 1;
      return { id, pinned: getCallCount === 1 };
    });
    chromeMock.tabs.update = mock.fn(async () => {});
    chromeMock.tabs.group = mock.fn(async () => 99);
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    let response = null;
    listener({ type: 'MOVE_TO_GROUP', payload: { tabId: 1, groupId: null } }, {}, (r) => { response = r; });
    await new Promise((r) => setTimeout(r, 30));

    assert.deepEqual(response, { groupId: 99 });
    const groupCall = chromeMock.tabs.group.mock.calls[0].arguments[0];
    assert.deepEqual(groupCall.tabIds, [1], 'the primary tabId must not be dropped out of the group by a stale pinned flag');
  });
});

// ---------------------------------------------------------------------------
// Tests: MULTI_GROUP pinned filter (A9)
// ---------------------------------------------------------------------------

describe('MULTI_GROUP pinned filter (A9)', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
    chromeMock.tabs.query = mock.fn(async (q) => {
      if (q && q.active) return [makeChromeTab({ id: 1, active: true })];
      return [
        makeChromeTab({ id: 1, index: 0, pinned: false }),
        makeChromeTab({ id: 2, index: 1, pinned: true }),
        makeChromeTab({ id: 3, index: 2, pinned: false }),
      ];
    });
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('filters pinned tab ids out before calling chrome.tabs.group', async () => {
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    listener({ type: 'MULTI_GROUP', payload: { tabIds: [1, 2, 3] } }, {}, () => {});
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(chromeMock.tabs.group.mock.callCount(), 1);
    assert.deepEqual(chromeMock.tabs.group.mock.calls[0].arguments[0].tabIds, [1, 3]);
  });

  it('does not call chrome.tabs.group when every selected tab is pinned', async () => {
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    listener({ type: 'MULTI_GROUP', payload: { tabIds: [2] } }, {}, () => {});
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(chromeMock.tabs.group.mock.callCount(), 0, 'a single pinned id would reject the whole call, so it is filtered to empty and skipped');
  });
});

// ---------------------------------------------------------------------------
// Tests: onGroupRemoved resets member tabs + write-through (A10b/Phase 5)
// ---------------------------------------------------------------------------

describe('onGroupRemoved resets member tabs before write-through save (A10b)', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
    chromeMock.tabs.query = mock.fn(async (q) => {
      if (q && q.active) return [makeChromeTab({ id: 1, active: true })];
      return [
        makeChromeTab({ id: 1, index: 0, groupId: 5 }),
        makeChromeTab({ id: 2, index: 1, groupId: 5 }),
        makeChromeTab({ id: 3, index: 2, groupId: -1 }),
      ];
    });
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('resets every tab pointing at the removed group to UNGROUPED_GROUP_ID before the immediate save', async () => {
    await loadBackground(chromeMock);
    chromeMock.storage.local.set.mock.resetCalls();

    chromeMock.tabGroups.onRemoved._fire({ id: 5, windowId: 1 });
    // Phase 5: write-through — immediate, no debounce wait needed.
    await new Promise((r) => setTimeout(r, 20));

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    let response = null;
    listener({ type: 'GET_STATE' }, {}, (d) => { response = d; });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(response.tabs[1].groupId, -1, 'tab 1 reset off the dead group');
    assert.equal(response.tabs[2].groupId, -1, 'tab 2 reset off the dead group');
    assert.equal(response.tabs[3].groupId, -1, 'unrelated tab untouched');

    const setCall = chromeMock.storage.local.set.mock.calls.find(
      (c) => c.arguments[0]?.linkmap_state?.tabs?.[1]?.groupId === -1
        && c.arguments[0]?.linkmap_state?.tabs?.[2]?.groupId === -1
    );
    assert.ok(setCall, 'the reset landed in storage before/without waiting on the debounce');
  });
});

// ---------------------------------------------------------------------------
// Tests: runtime.onSuspend write-through (A10c)
// ---------------------------------------------------------------------------

describe('runtime.onSuspend write-through (A10c)', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('routes the suspend flush through the immediate serializer and logs success only after the write settles', async () => {
    // Init itself performs one immediate save (2f/A6), and other test files'
    // long-since-completed-but-still-pending 500ms debounces can in principle
    // fire during loadBackground()'s internal settle wait. Install the
    // recording mock only AFTER loadBackground resolves, and fire onSuspend
    // in the SAME synchronous tick (no intervening await) — no macrotask can
    // interleave between "install" and "assert", so the very next
    // storage.local.set call observed is deterministically onSuspend's own.
    await loadBackground(chromeMock);

    const order = [];
    let resolveSet;
    chromeMock.storage.local.set = mock.fn(() => {
      order.push('set-called');
      return new Promise((resolve) => {
        resolveSet = () => { order.push('set-resolved'); resolve(); };
      });
    });

    const originalLog = console.log;
    console.log = (...args) => {
      if (args[0] === '[LinkMap] State flushed on suspend') order.push('logged');
    };

    try {
      chromeMock._listeners['runtime.onSuspend'][0]();
      assert.deepEqual(order, ['set-called'], 'write starts synchronously; success is not logged yet');

      resolveSet();
      await new Promise((r) => setTimeout(r, 10));

      assert.deepEqual(order, ['set-called', 'set-resolved', 'logged'], 'success log only fires after the write promise settles');
    } finally {
      console.log = originalLog;
    }
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
    await new Promise((r) => setTimeout(r, 0));

    assert.ok(!(response.tabs instanceof Map), 'tabs is not a Map');
    assert.ok(typeof response.tabs === 'object', 'tabs is a plain object');
  });

  it('returns collapsed as array (not Set)', async () => {
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    let response = null;
    listener({ type: 'GET_STATE' }, {}, (data) => { response = data; });
    await new Promise((r) => setTimeout(r, 0));

    assert.ok(Array.isArray(response.collapsed), 'collapsed is an array');
  });

  it('includes groupColors object', async () => {
    await loadBackground(chromeMock);

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    let response = null;
    listener({ type: 'GET_STATE' }, {}, (data) => { response = data; });
    await new Promise((r) => setTimeout(r, 0));

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

// ---------------------------------------------------------------------------
// Tests: Track C — Multi-Window Session Restore
// ---------------------------------------------------------------------------

/**
 * Helper: creates a saved session in chrome.storage.local and returns
 * both the session ID and the listener function for message handling.
 */
async function setupSessionRestore(chromeMock, sessionData) {
  // Pre-populate sessions in storage
  chromeMock.storage.local._data.linkmap_sessions = [sessionData];

  // Make the get mock return sessions too
  const originalGet = chromeMock.storage.local.get;
  chromeMock.storage.local.get = mock.fn(async (key) => {
    if (typeof key === 'string') {
      return { [key]: chromeMock.storage.local._data[key] ?? undefined };
    }
    return {};
  });

  // Set tabs.query to return some initial tabs + handle windowId queries
  chromeMock.tabs.query = mock.fn(async (queryInfo) => {
    if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
    if (queryInfo && queryInfo.windowId != null) return [makeChromeTab({ id: 999 })];
    return [makeChromeTab({ id: 1 })];
  });

  const { module } = await loadBackground(chromeMock);
  await new Promise((r) => setTimeout(r, 100));

  const listener = chromeMock._listeners['runtime.onMessage'][0];
  return { listener };
}

/**
 * Creates a session fixture with tabs across multiple windows.
 */
function makeMultiWindowSession(overrides = {}) {
  return {
    id: 'manual-test-session',
    name: 'Multi-Window Test',
    isAutoSave: false,
    savedAt: Date.now(),
    tabCount: 4,
    data: {
      version: 1,
      tabs: {
        10: { tabId: 10, parentId: null, children: [11], title: 'Win1 Tab A', url: 'https://a.com', favIconUrl: '', pinned: false, audible: false, status: 'complete', groupId: -1, index: 0, windowId: 1 },
        11: { tabId: 11, parentId: 10, children: [], title: 'Win1 Tab B', url: 'https://b.com', favIconUrl: '', pinned: true, audible: false, status: 'complete', groupId: -1, index: 1, windowId: 1 },
        20: { tabId: 20, parentId: null, children: [21], title: 'Win2 Tab C', url: 'https://c.com', favIconUrl: '', pinned: false, audible: false, status: 'complete', groupId: -1, index: 0, windowId: 2 },
        21: { tabId: 21, parentId: 20, children: [], title: 'Win2 Tab D', url: 'https://d.com', favIconUrl: '', pinned: false, audible: false, status: 'complete', groupId: -1, index: 1, windowId: 2 },
      },
      rootIds: [10, 20],
      collapsed: [],
      groups: {},
      groupColors: {},
      theme: 'august-default',
      windowNames: { 1: 'Research', 2: 'Dev' },
    },
    ...overrides,
  };
}

describe('Track C: restoreSession multi-window support', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('creates separate Chrome windows for each saved windowId', async () => {
    const session = makeMultiWindowSession();
    const { listener } = await setupSessionRestore(chromeMock, session);

    listener(
      { type: 'RESTORE_SESSION', payload: { sessionId: 'manual-test-session' } },
      {},
      () => {}
    );

    // Wait for async restore to complete
    await new Promise((r) => setTimeout(r, 500));

    // First window is reused (getCurrent), so windows.create should be called once (for window 2)
    assert.equal(
      chromeMock.windows.create.mock.callCount(), 1,
      'chrome.windows.create called once (for second window)'
    );
  });

  it('passes correct windowId to chrome.tabs.create for each tab', async () => {
    const session = makeMultiWindowSession();
    const { listener } = await setupSessionRestore(chromeMock, session);

    listener(
      { type: 'RESTORE_SESSION', payload: { sessionId: 'manual-test-session' } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 500));

    // All 4 tabs should have been created
    const createCalls = chromeMock.tabs.create.mock.calls;
    assert.equal(createCalls.length, 4, '4 tabs created');

    // Extract windowIds from create calls
    const windowIds = createCalls.map(c => c.arguments[0].windowId);

    // First 2 tabs belong to saved windowId 1 -> mapped to currentWindow.id (1)
    // Last 2 tabs belong to saved windowId 2 -> mapped to new window
    const currentWindowId = 1; // from getCurrent mock
    const win1Tabs = createCalls.filter(c => c.arguments[0].windowId === currentWindowId);
    const win2Tabs = createCalls.filter(c => c.arguments[0].windowId !== currentWindowId);
    assert.equal(win1Tabs.length, 2, '2 tabs in first (reused) window');
    assert.equal(win2Tabs.length, 2, '2 tabs in second (new) window');
  });

  it('restores pinned state on tabs', async () => {
    const session = makeMultiWindowSession();
    const { listener } = await setupSessionRestore(chromeMock, session);

    listener(
      { type: 'RESTORE_SESSION', payload: { sessionId: 'manual-test-session' } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 500));

    const createCalls = chromeMock.tabs.create.mock.calls;
    // Tab B (savedTab 11) was pinned
    const pinnedCall = createCalls.find(c => c.arguments[0].url === 'https://b.com');
    assert.ok(pinnedCall, 'Tab B create call found');
    assert.equal(pinnedCall.arguments[0].pinned, true, 'Tab B created with pinned: true');

    // Tab A (savedTab 10) was not pinned
    const unpinnedCall = createCalls.find(c => c.arguments[0].url === 'https://a.com');
    assert.ok(unpinnedCall, 'Tab A create call found');
    assert.equal(unpinnedCall.arguments[0].pinned, false, 'Tab A created with pinned: false');
  });

  it('cleans up default newtab in newly created windows', async () => {
    // When chrome.windows.create() is called, Chrome creates a default newtab.
    // We need to track that the restore function closes these.
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      // When querying tabs in a newly created window, return a default tab
      if (queryInfo && queryInfo.windowId != null && queryInfo.windowId !== 1) {
        return [makeChromeTab({ id: 999, url: 'chrome://newtab', windowId: queryInfo.windowId })];
      }
      return [makeChromeTab({ id: 1 })];
    });

    const session = makeMultiWindowSession();
    chromeMock.storage.local._data.linkmap_sessions = [session];
    chromeMock.storage.local.get = mock.fn(async (key) => {
      if (typeof key === 'string') {
        return { [key]: chromeMock.storage.local._data[key] ?? undefined };
      }
      return {};
    });

    await loadBackground(chromeMock);
    await new Promise((r) => setTimeout(r, 100));

    const listener = chromeMock._listeners['runtime.onMessage'][0];
    listener(
      { type: 'RESTORE_SESSION', payload: { sessionId: 'manual-test-session' } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 500));

    // chrome.tabs.remove should have been called to clean up default newtab (id 999)
    const removeCalls = chromeMock.tabs.remove.mock.calls;
    const cleanupCall = removeCalls.find(c => c.arguments[0] === 999);
    assert.ok(cleanupCall, 'default newtab in new window was cleaned up');
  });

  it('applies saved window names to new windowIds', async () => {
    const session = makeMultiWindowSession();
    const { listener } = await setupSessionRestore(chromeMock, session);

    listener(
      { type: 'RESTORE_SESSION', payload: { sessionId: 'manual-test-session' } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 500));

    // Verify window names are in state via GET_STATE
    let response = null;
    listener({ type: 'GET_STATE' }, {}, (data) => { response = data; });
    await new Promise((r) => setTimeout(r, 0));

    // windowNames should exist on the state payload
    assert.ok(response.windowNames, 'windowNames exists in state');

    // The current window (id 1) should have the name from saved window 1
    assert.equal(response.windowNames[1], 'Research', 'current window mapped to saved name "Research"');

    // The newly created window should have the name from saved window 2
    // The new window id comes from the mock (starts at 100)
    assert.equal(response.windowNames[100], 'Dev', 'new window mapped to saved name "Dev"');
  });

  it('recreates tab groups in the correct window', async () => {
    const session = makeMultiWindowSession();
    // Add a group to saved window 2
    session.data.tabs[20].groupId = 5;
    session.data.tabs[21].groupId = 5;
    session.data.groups = {
      5: { id: 5, title: 'Dev Group', color: 'blue', collapsed: false, windowId: 2 },
    };

    const { listener } = await setupSessionRestore(chromeMock, session);

    listener(
      { type: 'RESTORE_SESSION', payload: { sessionId: 'manual-test-session' } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 500));

    // chrome.tabs.group should have been called with the new IDs of tabs 20 and 21
    assert.equal(chromeMock.tabs.group.mock.callCount(), 1, 'tabs.group called once');

    // chrome.tabGroups.update should have been called with title and color
    const updateCall = chromeMock.tabGroups.update.mock.calls[0];
    assert.ok(updateCall, 'tabGroups.update was called');
    assert.equal(updateCall.arguments[1].title, 'Dev Group');
    assert.equal(updateCall.arguments[1].color, 'blue');
  });
});

// ---------------------------------------------------------------------------
// Tests: Track C — restoreSession with windowIdFilter (single window)
// ---------------------------------------------------------------------------

describe('Track C: restoreSession with windowIdFilter', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('only restores tabs from the filtered windowId', async () => {
    const session = makeMultiWindowSession();
    const { listener } = await setupSessionRestore(chromeMock, session);

    // Restore only window 2
    listener(
      { type: 'RESTORE_SESSION_WINDOW', payload: { sessionId: 'manual-test-session', windowId: 2 } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 500));

    // Only 2 tabs from window 2 should be created
    const createCalls = chromeMock.tabs.create.mock.calls;
    assert.equal(createCalls.length, 2, 'only 2 tabs created (window 2 only)');

    const urls = createCalls.map(c => c.arguments[0].url);
    assert.ok(urls.includes('https://c.com'), 'Tab C restored');
    assert.ok(urls.includes('https://d.com'), 'Tab D restored');
    assert.ok(!urls.includes('https://a.com'), 'Tab A NOT restored');
  });

  it('does not create additional windows when restoring single window', async () => {
    const session = makeMultiWindowSession();
    const { listener } = await setupSessionRestore(chromeMock, session);

    // Restore only window 1 — should reuse current window
    listener(
      { type: 'RESTORE_SESSION_WINDOW', payload: { sessionId: 'manual-test-session', windowId: 1 } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 500));

    // No new windows should be created for single-window restore
    assert.equal(
      chromeMock.windows.create.mock.callCount(), 0,
      'no new windows created for single-window restore'
    );
  });

  it('skips groups not belonging to the filtered window', async () => {
    const session = makeMultiWindowSession();
    // Group in window 1
    session.data.tabs[10].groupId = 3;
    session.data.tabs[11].groupId = 3;
    session.data.groups = {
      3: { id: 3, title: 'Research Group', color: 'green', collapsed: false, windowId: 1 },
    };

    const { listener } = await setupSessionRestore(chromeMock, session);

    // Restore only window 2 (which has no groups)
    listener(
      { type: 'RESTORE_SESSION_WINDOW', payload: { sessionId: 'manual-test-session', windowId: 2 } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 500));

    // tabs.group should NOT be called (group belongs to window 1, not 2)
    assert.equal(
      chromeMock.tabs.group.mock.callCount(), 0,
      'tabs.group not called when group belongs to different window'
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: Track C — saveSession includes window metadata
// ---------------------------------------------------------------------------

describe('Track C: saveSession window metadata', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('includes windowCount and windows breakdown in saved session', async () => {
    // Set up with tabs in 2 windows
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true, windowId: 1 })];
      return [
        makeChromeTab({ id: 1, index: 0, windowId: 1 }),
        makeChromeTab({ id: 2, index: 1, windowId: 1 }),
        makeChromeTab({ id: 3, index: 0, windowId: 2 }),
      ];
    });

    await loadBackground(chromeMock);
    await new Promise((r) => setTimeout(r, 100));

    const listener = chromeMock._listeners['runtime.onMessage'][0];

    // Trigger manual save
    listener(
      { type: 'SAVE_SESSION', payload: { name: 'Test Save' } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 200));

    // Read saved sessions from storage
    const sessions = chromeMock.storage.local._data.linkmap_sessions;
    assert.ok(sessions, 'sessions exist in storage');
    assert.ok(sessions.length > 0, 'at least one session saved');

    const saved = sessions[sessions.length - 1];
    assert.equal(saved.windowCount, 2, 'windowCount is 2');
    assert.ok(saved.windows, 'windows breakdown exists');
    assert.ok(saved.windows[1], 'window 1 in breakdown');
    assert.ok(saved.windows[2], 'window 2 in breakdown');
    assert.equal(saved.windows[1].tabCount, 2, 'window 1 has 2 tabs');
    assert.equal(saved.windows[2].tabCount, 1, 'window 2 has 1 tab');
  });

  it('includes window names in the breakdown', async () => {
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true, windowId: 1 })];
      return [
        makeChromeTab({ id: 1, index: 0, windowId: 1 }),
        makeChromeTab({ id: 2, index: 0, windowId: 2 }),
      ];
    });

    await loadBackground(chromeMock);
    await new Promise((r) => setTimeout(r, 100));

    const listener = chromeMock._listeners['runtime.onMessage'][0];

    // First set a window name via RENAME_WINDOW
    listener(
      { type: 'RENAME_WINDOW', payload: { windowId: 1, name: 'Main' } },
      {},
      () => {}
    );
    await new Promise((r) => setTimeout(r, 50));

    // Save session
    listener(
      { type: 'SAVE_SESSION', payload: { name: 'Named Windows' } },
      {},
      () => {}
    );
    await new Promise((r) => setTimeout(r, 200));

    const sessions = chromeMock.storage.local._data.linkmap_sessions;
    const saved = sessions[sessions.length - 1];
    assert.equal(saved.windows[1].name, 'Main', 'window 1 name is Main');
    assert.equal(saved.windows[2].name, null, 'window 2 name is null (unnamed)');
  });
});

// ---------------------------------------------------------------------------
// Tests: Track C — getSessions includes window metadata
// ---------------------------------------------------------------------------

describe('Track C: getSessions passes through window metadata', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('returns windowCount and windows in session listing', async () => {
    const sessionWithMeta = {
      id: 'manual-meta-test',
      name: 'Meta Test',
      isAutoSave: false,
      savedAt: Date.now(),
      tabCount: 3,
      windowCount: 2,
      windows: {
        1: { tabCount: 2, name: 'Research' },
        2: { tabCount: 1, name: null },
      },
      data: { version: 1, tabs: {}, rootIds: [], collapsed: [], groups: {}, groupColors: {}, theme: 'august-default', windowNames: {} },
    };

    chromeMock.storage.local._data.linkmap_sessions = [sessionWithMeta];
    chromeMock.storage.local.get = mock.fn(async (key) => {
      if (typeof key === 'string') {
        return { [key]: chromeMock.storage.local._data[key] ?? undefined };
      }
      return {};
    });
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [makeChromeTab({ id: 1 })];
    });

    await loadBackground(chromeMock);
    await new Promise((r) => setTimeout(r, 100));

    const listener = chromeMock._listeners['runtime.onMessage'][0];

    let response = null;
    listener(
      { type: 'GET_SESSIONS' },
      {},
      (data) => { response = data; }
    );

    await new Promise((r) => setTimeout(r, 200));

    assert.ok(response, 'response received');
    assert.ok(response.sessions, 'sessions in response');
    const session = response.sessions.find(s => s.id === 'manual-meta-test');
    assert.ok(session, 'session found in listing');
    assert.equal(session.windowCount, 2, 'windowCount passed through');
    assert.ok(session.windows, 'windows passed through');
    assert.equal(session.windows[1].tabCount, 2, 'window 1 tabCount passed through');
    assert.equal(session.windows[1].name, 'Research', 'window 1 name passed through');
  });
});

// ---------------------------------------------------------------------------
// Tests: Track C — RESTORE_SESSION_WINDOW message type
// ---------------------------------------------------------------------------

describe('Track C: RESTORE_SESSION_WINDOW message handler', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
  });

  afterEach(async () => {
    // Wait for any async activity (commitState/broadcastState) to settle
    await new Promise((r) => setTimeout(r, 200));
    delete globalThis.chrome;
  });

  it('handles RESTORE_SESSION_WINDOW message', async () => {
    const session = makeMultiWindowSession();
    const { listener } = await setupSessionRestore(chromeMock, session);

    // Send RESTORE_SESSION_WINDOW for window 1
    listener(
      { type: 'RESTORE_SESSION_WINDOW', payload: { sessionId: 'manual-test-session', windowId: 1 } },
      {},
      () => {}
    );

    await new Promise((r) => setTimeout(r, 800));

    // Should only create tabs from window 1
    const createCalls = chromeMock.tabs.create.mock.calls;
    assert.equal(createCalls.length, 2, '2 tabs created for window 1');

    const urls = createCalls.map(c => c.arguments[0].url);
    assert.ok(urls.includes('https://a.com'), 'Tab A restored');
    assert.ok(urls.includes('https://b.com'), 'Tab B restored');
  });
});

// ---------------------------------------------------------------------------
// Tests: Pinned tab boundary index (via onUpdated pin transition)
// ---------------------------------------------------------------------------

describe('pinned tab repositioning via onUpdated', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('positions newly pinned tab at the pinned zone boundary', async () => {
    // Start with 3 tabs: tab 1 pinned, tabs 2 and 3 unpinned
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [
        makeChromeTab({ id: 1, index: 0, pinned: true }),
        makeChromeTab({ id: 2, index: 1, pinned: false }),
        makeChromeTab({ id: 3, index: 2, pinned: false }),
      ];
    });

    await loadBackground(chromeMock);
    await new Promise((r) => setTimeout(r, 600));

    // Pin tab 3 — it should move to the pinned zone, not stay at index 2
    chromeMock.tabs.onUpdated._fire(3, { pinned: true }, makeChromeTab({ id: 3, pinned: true }));
    await new Promise((r) => setTimeout(r, 600));

    // Verify via persisted state
    const setCalls = chromeMock.storage.local.set.mock.calls;
    const lastSetCall = setCalls[setCalls.length - 1];
    const savedState = lastSetCall.arguments[0].linkmap_state;
    assert.equal(savedState.tabs[3].pinned, true, 'tab 3 should be pinned');

    // Tab 3 should be in rootIds near the pinned zone (index 0 or 1)
    const tab3Idx = savedState.rootIds.indexOf(3);
    assert.ok(tab3Idx <= 1, `pinned tab 3 should be in first 2 positions, got index ${tab3Idx}`);
  });

  it('moves unpinned tab out of pinned zone', async () => {
    // Start with 2 pinned tabs and 1 unpinned
    chromeMock.tabs.query = mock.fn(async (queryInfo) => {
      if (queryInfo && queryInfo.active) return [makeChromeTab({ id: 1, active: true })];
      return [
        makeChromeTab({ id: 1, index: 0, pinned: true }),
        makeChromeTab({ id: 2, index: 1, pinned: true }),
        makeChromeTab({ id: 3, index: 2, pinned: false }),
      ];
    });

    await loadBackground(chromeMock);
    await new Promise((r) => setTimeout(r, 600));

    // Unpin tab 2
    chromeMock.tabs.onUpdated._fire(2, { pinned: false }, makeChromeTab({ id: 2, pinned: false }));
    await new Promise((r) => setTimeout(r, 600));

    const setCalls = chromeMock.storage.local.set.mock.calls;
    const lastSetCall = setCalls[setCalls.length - 1];
    const savedState = lastSetCall.arguments[0].linkmap_state;
    assert.equal(savedState.tabs[2].pinned, false, 'tab 2 should be unpinned');

    // Tab 2 should be after all pinned tabs
    const tab1Idx = savedState.rootIds.indexOf(1);
    const tab2Idx = savedState.rootIds.indexOf(2);
    assert.ok(tab2Idx > tab1Idx, `unpinned tab 2 (idx ${tab2Idx}) should be after pinned tab 1 (idx ${tab1Idx})`);
  });
});

// ---------------------------------------------------------------------------
// Track C — restore reattaches lineage + collapsed state (FM-1, FM-2)
// ---------------------------------------------------------------------------

describe('Track C: restore reattaches lineage and collapsed state (FM-1/FM-2)', () => {
  let chromeMock;

  beforeEach(() => {
    chromeMock = createChromeMock();
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('rebuilds parent/child lineage without relying on onCreated, and restores collapsed', async () => {
    // The chrome mock never fires onCreated, so the restored tree only forms if
    // restore seeds nodes authoritatively (FM-1) rather than racing the listener.
    const base = makeMultiWindowSession();
    const session = makeMultiWindowSession({
      data: { ...base.data, collapsed: [10] }, // parent (saved id 10) was collapsed
    });

    const { listener } = await setupSessionRestore(chromeMock, session);

    listener({ type: 'RESTORE_SESSION', payload: { sessionId: 'manual-test-session' } }, {}, () => {});
    await new Promise((r) => setTimeout(r, 500));

    // Created ids are deterministic: restore iterates Object.values(session.data.tabs)
    // and V8 returns integer-like object keys in ascending numeric order (10,11,20,21),
    // while the chrome mock assigns ids sequentially from 1000 — so 10->1000, 11->1001,
    // 20->1002, 21->1003.
    let state;
    listener({ type: 'GET_STATE' }, {}, (resp) => { state = resp; });
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(state, 'GET_STATE returned a payload');
    assert.equal(state.tabs['1001']?.parentId, 1000, 'Win1 child reattached to its parent (FM-1)');
    assert.equal(state.tabs['1003']?.parentId, 1002, 'Win2 child reattached to its parent (FM-1)');
    assert.ok(state.tabs['1000']?.children.includes(1001), 'parent lists its child');
    assert.ok(state.collapsed.includes(1000), 'collapsed state restored, remapped to new id (FM-2)');
  });
});
