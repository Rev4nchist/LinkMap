import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Stub chrome global before importing modules that touch it at eval time.
globalThis.chrome = globalThis.chrome || {
  runtime: { sendMessage() {} },
  tabs: {}, tabGroups: {}, windows: {},
  storage: { local: { get() {}, set() {} } },
  alarms: {}, commands: {}, sidePanel: { setPanelBehavior() {} },
};

const { createMessageHandler } = await import('../background/message-handlers.js');
const { ShadowState } = await import('../shared/shadow-state.js');
const { MSG } = await import('../shared/constants.js');

/** Builds a message handler with minimal stub dependencies and a real state. */
function makeHandler(initDone, ctx, state) {
  const context = {
    ctx, state,
    commitState() {},
    commitStateNow() {},
    broadcastState() {},
    getStatePayload: () => ({}),
    suppressGroupCollapseForBurst() {},
    suppressGroupTitleForBurst() {},
    saveWorkspaces() {},
    invalidateDuplicateMap() {},
  };
  return createMessageHandler({
    context,
    sessions: {},
    autoGrouper: { getRules: () => [], setRules: () => {} },
    moveHelpers: {
      repositionTabToGroup() {}, moveTabToGroup() {}, moveTabToWindow() {},
      moveTabAsChild() {}, moveTabBeforeAfter() {},
    },
    computeVisitFrequencies: async () => ({}),
    saveTreeAsBookmarks() {},
    openBookmarkFolder() {},
    normalizeUrl: (u) => u,
    initDone,
  });
}

describe('message handler init gating (SW-1)', () => {
  it('defers a state-mutating message until init completes, then applies it', async () => {
    let resolveInit;
    const initDone = new Promise((r) => { resolveInit = r; });
    const ctx = { initComplete: false, DEBUG: false, settings: {}, workspaces: [], tabNotes: {}, activeTabId: null };
    const state = new ShadowState();
    const handler = makeHandler(initDone, ctx, state);

    // Arrives while init() is still running.
    handler({ type: MSG.RENAME_WINDOW, payload: { windowId: 1, name: 'Research' } }, {}, () => {});
    assert.equal(state.getWindowName(1), null, 'mutation deferred during init, not lost');

    // init finishes and swaps in the real state.
    ctx.initComplete = true;
    resolveInit();
    await initDone;
    await Promise.resolve(); // flush the deferred re-dispatch microtask

    assert.equal(state.getWindowName(1), 'Research', 'deferred mutation applied after init');
  });

  it('does not gate pure chrome passthrough messages', () => {
    const ctx = { initComplete: false, DEBUG: false, settings: {}, workspaces: [], tabNotes: {}, activeTabId: null };
    const state = new ShadowState();
    let activated = null;
    globalThis.chrome.tabs.update = async (id) => { activated = id; return {}; };
    const handler = makeHandler(Promise.resolve(), ctx, state);

    // ACTIVATE_TAB is a passthrough — it should run immediately even pre-init.
    handler({ type: MSG.ACTIVATE_TAB, payload: { tabId: 7 } }, {}, () => {});
    assert.equal(activated, 7, 'passthrough ran without waiting for init');
  });
});

describe('message handler init gating (A8 — widened INIT_GATED_TYPES/INIT_GATED_ASYNC)', () => {
  it('MOVE_TO_GROUP is gated pre-init and keeps the response channel open', async () => {
    let resolveInit;
    const initDone = new Promise((r) => { resolveInit = r; });
    const ctx = { initComplete: false, DEBUG: false, settings: {}, workspaces: [], tabNotes: {}, activeTabId: null };
    const state = new ShadowState();
    const handler = makeHandler(initDone, ctx, state);

    let getCalled = false;
    globalThis.chrome.tabs.get = async (id) => { getCalled = true; return { id, pinned: false }; };
    globalThis.chrome.tabs.group = async () => 777;

    let response = null;
    const keepOpen = handler(
      { type: MSG.MOVE_TO_GROUP, payload: { tabId: 7, groupId: 777 } },
      {},
      (r) => { response = r; }
    );

    assert.equal(keepOpen, true, 'gate keeps the async channel open for MOVE_TO_GROUP');
    assert.equal(response, null, 'response not sent yet — deferred until init completes');
    assert.equal(getCalled, false, 'handler body must not run at all until init completes — proves real deferral, not just async timing');

    ctx.initComplete = true;
    resolveInit();
    await initDone;
    await new Promise((r) => setTimeout(r, 10)); // let the deferred async handler settle

    assert.deepEqual(response, { groupId: 777 }, 'deferred MOVE_TO_GROUP eventually responds');
  });

  it('GET_SETTINGS is gated pre-init (returns true) and responds with settings post-init', async () => {
    let resolveInit;
    const initDone = new Promise((r) => { resolveInit = r; });
    const ctx = { initComplete: false, DEBUG: false, settings: { sleepOnCollapse: true }, workspaces: [], tabNotes: {}, activeTabId: null };
    const state = new ShadowState();
    const handler = makeHandler(initDone, ctx, state);

    let response = null;
    const keepOpen = handler({ type: MSG.GET_SETTINGS, payload: {} }, {}, (r) => { response = r; });

    assert.equal(keepOpen, true, 'gate keeps channel open for GET_SETTINGS');
    assert.equal(response, null, 'no response before init completes');

    ctx.initComplete = true;
    resolveInit();
    await initDone;
    await Promise.resolve();

    assert.deepEqual(response, { settings: { sleepOnCollapse: true } });
  });

  it('UNGROUP_TAB and MULTI_GROUP are gated but do not keep the response channel open', () => {
    const ctx = { initComplete: false, DEBUG: false, settings: {}, workspaces: [], tabNotes: {}, activeTabId: null };
    const state = new ShadowState();
    const handler = makeHandler(new Promise(() => {}), ctx, state); // never resolves — irrelevant here

    globalThis.chrome.tabs.ungroup = async () => {};
    globalThis.chrome.tabs.group = async () => 1;

    const r1 = handler({ type: MSG.UNGROUP_TAB, payload: { tabId: 1 } }, {}, () => {});
    const r2 = handler({ type: MSG.MULTI_GROUP, payload: { tabIds: [1, 2] } }, {}, () => {});

    assert.notEqual(r1, true, 'UNGROUP_TAB gate does not keep the channel open');
    assert.notEqual(r2, true, 'MULTI_GROUP gate does not keep the channel open');
  });
});

// ---------------------------------------------------------------------------
// Tests: MULTI_GROUP descendant expansion (B-3)
// A multi-select → Group must pull each selected tab's nested children into the
// group too (parity with every other group call site via collectGroupableTabIds),
// or the panel and the Chrome strip diverge and children are ejected on restart.
// ---------------------------------------------------------------------------

describe('MULTI_GROUP descendant expansion (B-3)', () => {
  it('groups a selected parent together with its nested children', async () => {
    const ctx = { initComplete: true, DEBUG: false, settings: {}, workspaces: [], tabNotes: {}, activeTabId: null };
    const state = new ShadowState();
    // root 1 with nested child 2; a separate childless root 10.
    state.addTab(1, { tabId: 1, parentId: null, groupId: -1, title: 'Parent', url: 'https://p.com', index: 0, windowId: 1 });
    state.addTab(2, { tabId: 2, parentId: 1, groupId: -1, title: 'Child', url: 'https://c.com', index: 1, windowId: 1 });
    state.addTab(10, { tabId: 10, parentId: null, groupId: -1, title: 'Other', url: 'https://o.com', index: 2, windowId: 1 });
    const handler = makeHandler(Promise.resolve(), ctx, state);

    let groupedIds = null;
    globalThis.chrome.tabs.group = async ({ tabIds }) => { groupedIds = tabIds; return 55; };

    handler({ type: MSG.MULTI_GROUP, payload: { tabIds: [1, 10] } }, {}, () => {});
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(groupedIds, 'chrome.tabs.group was called');
    assert.deepEqual(
      [...groupedIds].sort((a, b) => a - b),
      [1, 2, 10],
      'nested child 2 grouped along with selected parent 1 and root 10',
    );
  });

  it('excludes pinned descendants (A9 safety preserved)', async () => {
    const ctx = { initComplete: true, DEBUG: false, settings: {}, workspaces: [], tabNotes: {}, activeTabId: null };
    const state = new ShadowState();
    state.addTab(1, { tabId: 1, parentId: null, groupId: -1, title: 'Parent', url: 'https://p.com', index: 0, windowId: 1 });
    state.addTab(2, { tabId: 2, parentId: 1, pinned: true, groupId: -1, title: 'Pinned child', url: 'https://c.com', index: 1, windowId: 1 });
    const handler = makeHandler(Promise.resolve(), ctx, state);

    let groupedIds = null;
    globalThis.chrome.tabs.group = async ({ tabIds }) => { groupedIds = tabIds; return 55; };

    handler({ type: MSG.MULTI_GROUP, payload: { tabIds: [1] } }, {}, () => {});
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(groupedIds, 'chrome.tabs.group was called');
    assert.deepEqual([...groupedIds], [1], 'pinned descendant excluded — Chrome rejects grouping a pinned tab');
  });
});
