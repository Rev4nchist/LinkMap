/**
 * move-helpers.test.js — Phase 4 (R4/A9) unit coverage for
 * background/move-helpers.js: collectGroupableTabIds and the group/ungroup
 * sync semantics of moveTabToGroup / moveTabAsChild / moveTabBeforeAfter.
 *
 * move-helpers.js reads the `chrome` global dynamically inside each function
 * body (it is not imported), so tests can freely reassign globalThis.chrome
 * per test without needing a cache-busted re-import of the module.
 */
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createMoveHelpers, collectGroupableTabIds } from '../background/move-helpers.js';
import { ShadowState } from '../shared/shadow-state.js';
import { UNGROUPED_GROUP_ID } from '../shared/constants.js';

/**
 * Builds: 1 (root, window 1)
 *          └─ 2 (child, window 1)
 *              └─ 3 (grandchild, window 1, PINNED)
 *         4 (unrelated root, window 1)
 */
function buildTree() {
  const state = new ShadowState();
  state.addTab(1, { tabId: 1, title: 'Parent', windowId: 1, groupId: UNGROUPED_GROUP_ID });
  state.addTab(2, { tabId: 2, parentId: 1, title: 'Child', windowId: 1, groupId: UNGROUPED_GROUP_ID });
  state.addTab(3, { tabId: 3, parentId: 2, title: 'Grandchild', windowId: 1, pinned: true, groupId: UNGROUPED_GROUP_ID });
  state.addTab(4, { tabId: 4, title: 'Unrelated', windowId: 1, groupId: UNGROUPED_GROUP_ID });
  return state;
}

// ---------------------------------------------------------------------------
// collectGroupableTabIds (A9 shared helper)
// ---------------------------------------------------------------------------

describe('collectGroupableTabIds (A9)', () => {
  it('includes the tab and all non-pinned descendants', () => {
    const state = buildTree();
    const ids = collectGroupableTabIds(state, 1);
    assert.deepEqual(ids, [1, 2], 'pinned grandchild (3) excluded, unrelated tab (4) excluded');
  });

  it('excludes the root tab itself when it is pinned', () => {
    const state = buildTree();
    state.updateTab(1, { pinned: true });
    const ids = collectGroupableTabIds(state, 1);
    assert.deepEqual(ids, [2]);
  });

  it('returns just the tab id when it has no descendants', () => {
    const state = buildTree();
    const ids = collectGroupableTabIds(state, 4);
    assert.deepEqual(ids, [4]);
  });

  it('is safe when the tab is not tracked in state', () => {
    const state = buildTree();
    const ids = collectGroupableTabIds(state, 999);
    assert.deepEqual(ids, [999], 'unknown tab passed through, not treated as pinned');
  });
});

// ---------------------------------------------------------------------------
// moveTabToGroup (4b/A9 — group-header drop)
// ---------------------------------------------------------------------------

describe('moveTabToGroup (4b/A9)', () => {
  let state;
  let commitState;
  let helpers;

  beforeEach(() => {
    state = buildTree();
    commitState = mock.fn();
    helpers = createMoveHelpers(() => state, commitState);
    globalThis.chrome = {
      tabs: {
        group: mock.fn(async () => 500),
        move: mock.fn(async () => ({})),
      },
    };
  });

  it('groups the tab and its non-pinned descendants in one call', async () => {
    state.groups.set(500, { id: 500, windowId: 1 }); // same window — no move needed
    helpers.moveTabToGroup(1, 500);
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(globalThis.chrome.tabs.group.mock.callCount(), 1);
    const call = globalThis.chrome.tabs.group.mock.calls[0].arguments[0];
    assert.deepEqual(call.tabIds, [1, 2]);
    assert.equal(call.groupId, 500);
    assert.equal(globalThis.chrome.tabs.move.mock.callCount(), 0, 'same-window drop does not move');
    assert.equal(commitState.mock.callCount(), 1);
  });

  it('moves the subtree into the group\'s window first when dropped from another window (4c/A9)', async () => {
    state.groups.set(500, { id: 500, windowId: 2 }); // group lives in window 2
    helpers.moveTabToGroup(1, 500);
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(globalThis.chrome.tabs.move.mock.callCount(), 1, 'cross-window group-header drop moves first');
    const moveCall = globalThis.chrome.tabs.move.mock.calls[0];
    assert.deepEqual(moveCall.arguments[0], [1, 2]);
    assert.equal(moveCall.arguments[1].windowId, 2);

    assert.equal(globalThis.chrome.tabs.group.mock.callCount(), 1, 'groups after the move confirms');
    assert.deepEqual(globalThis.chrome.tabs.group.mock.calls[0].arguments[0].tabIds, [1, 2]);
  });

  it('groups in place when the target group is untracked in state (defensive default)', async () => {
    // No state.groups entry for 500 — sourceTab/targetGroup comparison can't
    // detect a cross-window need, so it must fall back to grouping directly.
    helpers.moveTabToGroup(1, 500);
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(globalThis.chrome.tabs.move.mock.callCount(), 0);
    assert.equal(globalThis.chrome.tabs.group.mock.callCount(), 1);
  });
});

// ---------------------------------------------------------------------------
// moveTabAsChild / moveTabBeforeAfter cross-window group sync (4c/A9)
// ---------------------------------------------------------------------------

describe('moveTabAsChild cross-window group sync (4c/A9)', () => {
  let state;
  let commitState;
  let helpers;

  beforeEach(() => {
    state = buildTree();
    commitState = mock.fn();
    helpers = createMoveHelpers(() => state, commitState);
    globalThis.chrome = {
      tabs: {
        group: mock.fn(async () => 700),
        ungroup: mock.fn(async () => {}),
        move: mock.fn(async () => ({})),
      },
    };
  });

  it('moves the full non-pinned subtree and regroups when targetGroupId is supplied', async () => {
    const mode = helpers.moveTabAsChild(1, null, true, 2, 700);
    assert.equal(mode, 'async');
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(globalThis.chrome.tabs.move.mock.callCount(), 1);
    assert.deepEqual(globalThis.chrome.tabs.move.mock.calls[0].arguments[0], [1, 2]);

    assert.equal(globalThis.chrome.tabs.group.mock.callCount(), 1, 'regroups after the window move confirms');
    const groupCall = globalThis.chrome.tabs.group.mock.calls[0].arguments[0];
    assert.deepEqual(groupCall.tabIds, [1, 2]);
    assert.equal(groupCall.groupId, 700);
    assert.equal(globalThis.chrome.tabs.ungroup.mock.callCount(), 0);
    assert.equal(commitState.mock.callCount(), 1);
  });

  it('ungroups after the move when targetGroupId is UNGROUPED_GROUP_ID and the tab was grouped', async () => {
    state.updateTab(1, { groupId: 42 });
    helpers.moveTabAsChild(1, null, true, 2, UNGROUPED_GROUP_ID);
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(globalThis.chrome.tabs.ungroup.mock.callCount(), 1);
    assert.deepEqual(globalThis.chrome.tabs.ungroup.mock.calls[0].arguments[0], [1, 2]);
    assert.equal(globalThis.chrome.tabs.group.mock.callCount(), 0);
  });

  it('skips the ungroup call when the tab was already ungrouped (nothing to undo)', async () => {
    helpers.moveTabAsChild(1, null, true, 2, UNGROUPED_GROUP_ID);
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(globalThis.chrome.tabs.ungroup.mock.callCount(), 0);
    assert.equal(globalThis.chrome.tabs.group.mock.callCount(), 0);
    assert.equal(commitState.mock.callCount(), 1, 'still commits the tree move itself');
  });

  it('does not touch group membership when targetGroupId is not supplied', async () => {
    helpers.moveTabAsChild(1, null, true, 2, undefined);
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(globalThis.chrome.tabs.group.mock.callCount(), 0);
    assert.equal(globalThis.chrome.tabs.ungroup.mock.callCount(), 0);
    assert.equal(commitState.mock.callCount(), 1);
  });
});

describe('moveTabBeforeAfter cross-window group sync (4c/A9)', () => {
  let state;
  let commitState;
  let helpers;

  beforeEach(() => {
    state = buildTree();
    commitState = mock.fn();
    helpers = createMoveHelpers(() => state, commitState);
    globalThis.chrome = {
      tabs: {
        group: mock.fn(async () => 700),
        ungroup: mock.fn(async () => {}),
        move: mock.fn(async () => ({})),
      },
    };
  });

  it('regroups the moved subtree after a cross-window before/after drop', async () => {
    const mode = helpers.moveTabBeforeAfter(1, null, 4, 'after', true, 2, 700);
    assert.equal(mode, 'async');
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(globalThis.chrome.tabs.move.mock.callCount(), 1);
    assert.deepEqual(globalThis.chrome.tabs.move.mock.calls[0].arguments[0], [1, 2]);
    assert.equal(globalThis.chrome.tabs.group.mock.callCount(), 1);
    assert.deepEqual(globalThis.chrome.tabs.group.mock.calls[0].arguments[0].tabIds, [1, 2]);
  });
});
