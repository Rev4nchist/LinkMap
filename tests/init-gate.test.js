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
