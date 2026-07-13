import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal DOM + Chrome mock environment
// ---------------------------------------------------------------------------

// We test the pure logic functions exported for testing.
// The DOM event wiring (initDragDrop) is integration-level and verified manually.
// Here we test: getParentFromDOM, resolveDropMode, buildMovePayload

// Since drag-drop.js uses browser globals, we import the testable helpers
// that we'll export specifically for testing.

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Build a minimal tab-entry-like object for DOM simulation */
function makeMockTabEntry(tabId, depth, rect = {}) {
  return {
    tabId,
    depth,
    dataset: { tabId: String(tabId), depth: String(depth) },
    classList: {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      contains(c) { return this._classes.has(c); },
    },
    getBoundingClientRect() {
      return { top: 0, bottom: 28, left: 0, right: 200, width: 200, height: 28, ...rect };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: resolveDropMode
// ---------------------------------------------------------------------------

describe('resolveDropMode', () => {
  // We'll import this after creating the module
  let resolveDropMode;

  beforeEach(async () => {
    const mod = await import('../sidepanel/modules/drag-drop.js');
    resolveDropMode = mod._testing.resolveDropMode;
  });

  it('returns "before" when cursor is in top 25% of element', () => {
    const rect = { top: 0, bottom: 28, height: 28 };
    // clientY = 3, which is 3/28 = ~10.7% from top → "before"
    const result = resolveDropMode(3, rect);
    assert.equal(result, 'before');
  });

  it('returns "after" when cursor is in bottom 25% of element', () => {
    const rect = { top: 0, bottom: 28, height: 28 };
    // clientY = 25, which is 25/28 = ~89% from top → "after"
    const result = resolveDropMode(25, rect);
    assert.equal(result, 'after');
  });

  it('returns "child" when cursor is in middle 50% of element', () => {
    const rect = { top: 0, bottom: 28, height: 28 };
    // clientY = 14, which is 14/28 = 50% from top → "child"
    const result = resolveDropMode(14, rect);
    assert.equal(result, 'child');
  });

  it('returns "before" at exactly 25% boundary', () => {
    const rect = { top: 0, bottom: 100, height: 100 };
    // clientY = 24, which is 24/100 = 24% → "before" (< 25%)
    const result = resolveDropMode(24, rect);
    assert.equal(result, 'before');
  });

  it('returns "after" at exactly 75% boundary', () => {
    const rect = { top: 0, bottom: 100, height: 100 };
    // clientY = 76, which is 76/100 = 76% → "after" (> 75%)
    const result = resolveDropMode(76, rect);
    assert.equal(result, 'after');
  });
});

// ---------------------------------------------------------------------------
// Tests: getParentFromDOM
// ---------------------------------------------------------------------------

describe('getParentFromDOM', () => {
  let getParentFromDOM;

  beforeEach(async () => {
    const mod = await import('../sidepanel/modules/drag-drop.js');
    getParentFromDOM = mod._testing.getParentFromDOM;
  });

  it('returns null for root-level tab (depth 0)', () => {
    // Create a mock element with no previousElementSibling
    const entry = {
      dataset: { tabId: '10', depth: '0' },
      previousElementSibling: null,
      classList: { contains: () => true },
    };
    const result = getParentFromDOM(entry);
    assert.equal(result, null);
  });

  it('finds parent at depth-1 by walking previous siblings', () => {
    // Simulate: parent (depth 0, id 1) then child (depth 1, id 2)
    const parent = {
      dataset: { tabId: '1', depth: '0' },
      previousElementSibling: null,
      classList: { contains: (c) => c === 'tab-entry' },
    };
    const child = {
      dataset: { tabId: '2', depth: '1' },
      previousElementSibling: parent,
      classList: { contains: (c) => c === 'tab-entry' },
    };
    const result = getParentFromDOM(child);
    assert.equal(result, 1);
  });

  it('skips siblings at same depth to find parent', () => {
    // Simulate: parent(d0, id1) → sibling(d1, id2) → target(d1, id3)
    const parent = {
      dataset: { tabId: '1', depth: '0' },
      previousElementSibling: null,
      classList: { contains: (c) => c === 'tab-entry' },
    };
    const sibling = {
      dataset: { tabId: '2', depth: '1' },
      previousElementSibling: parent,
      classList: { contains: (c) => c === 'tab-entry' },
    };
    const target = {
      dataset: { tabId: '3', depth: '1' },
      previousElementSibling: sibling,
      classList: { contains: (c) => c === 'tab-entry' },
    };
    const result = getParentFromDOM(target);
    assert.equal(result, 1);
  });

  it('returns null when no shallower element exists', () => {
    // All previous siblings are same depth (unusual, but defensive)
    const sib = {
      dataset: { tabId: '2', depth: '1' },
      previousElementSibling: null,
      classList: { contains: (c) => c === 'tab-entry' },
    };
    const target = {
      dataset: { tabId: '3', depth: '1' },
      previousElementSibling: sib,
      classList: { contains: (c) => c === 'tab-entry' },
    };
    const result = getParentFromDOM(target);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildMovePayload
// ---------------------------------------------------------------------------

describe('buildMovePayload', () => {
  let buildMovePayload;

  beforeEach(async () => {
    const mod = await import('../sidepanel/modules/drag-drop.js');
    buildMovePayload = mod._testing.buildMovePayload;
  });

  it('builds child reparent payload', () => {
    const result = buildMovePayload(10, 20, 'child', null);
    assert.deepEqual(result, {
      tabId: 10,
      newParentId: 20,
      targetTabId: 20,
      position: 'child',
    });
  });

  it('builds "before" reorder payload with parent', () => {
    const result = buildMovePayload(10, 20, 'before', 5);
    assert.deepEqual(result, {
      tabId: 10,
      newParentId: 5,
      targetTabId: 20,
      position: 'before',
    });
  });

  it('builds "after" reorder payload with null parent (root)', () => {
    const result = buildMovePayload(10, 20, 'after', null);
    assert.deepEqual(result, {
      tabId: 10,
      newParentId: null,
      targetTabId: 20,
      position: 'after',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: resolveTargetGroupId (CAE-4)
// ---------------------------------------------------------------------------

describe('resolveTargetGroupId (CAE-4)', () => {
  let resolveTargetGroupId;
  let UNGROUPED_GROUP_ID;

  beforeEach(async () => {
    const mod = await import('../sidepanel/modules/drag-drop.js');
    resolveTargetGroupId = mod._testing.resolveTargetGroupId;
    ({ UNGROUPED_GROUP_ID } = await import('../shared/constants.js'));
  });

  it('resolves a numeric group id dataset value', () => {
    assert.equal(resolveTargetGroupId('42'), 42);
  });

  it('falls back to UNGROUPED_GROUP_ID for the stamped "-1" (drop outside any group)', () => {
    assert.equal(resolveTargetGroupId('-1'), UNGROUPED_GROUP_ID);
  });

  it('falls back to UNGROUPED_GROUP_ID for a missing/non-numeric dataset value', () => {
    assert.equal(resolveTargetGroupId(undefined), UNGROUPED_GROUP_ID);
    assert.equal(resolveTargetGroupId('not-a-number'), UNGROUPED_GROUP_ID);
  });
});

// ---------------------------------------------------------------------------
// Tests: Background MOVE_TAB handler logic
// (Tests the index calculation for reorder operations)
// ---------------------------------------------------------------------------

describe('MOVE_TAB reorder index calculation', () => {
  // This tests the logic that will live in the background MOVE_TAB handler.
  // We test it by importing ShadowState directly and running the same logic.

  let ShadowState;

  beforeEach(async () => {
    const mod = await import('../shared/shadow-state.js');
    ShadowState = mod.ShadowState;
  });

  it('moves tab before target at root level', () => {
    const state = new ShadowState();
    state.addTab(1, { tabId: 1, title: 'A' });
    state.addTab(2, { tabId: 2, title: 'B' });
    state.addTab(3, { tabId: 3, title: 'C' });
    // rootIds: [1, 2, 3]

    // Move tab 3 before tab 1 → rootIds should be [3, 1, 2]
    const siblings = state.rootIds;
    let targetIndex = siblings.indexOf(1); // 0
    // position: 'before' → no adjustment
    // tab 3 is currently at index 2, which is > targetIndex 0, so no adjustment
    state.moveTab(3, null, targetIndex);

    assert.deepEqual(state.rootIds, [3, 1, 2]);
  });

  it('moves tab after target at root level', () => {
    const state = new ShadowState();
    state.addTab(1, { tabId: 1, title: 'A' });
    state.addTab(2, { tabId: 2, title: 'B' });
    state.addTab(3, { tabId: 3, title: 'C' });
    // rootIds: [1, 2, 3]

    // Move tab 1 after tab 2 → rootIds should be [2, 1, 3]
    const siblings = [...state.rootIds];
    let targetIndex = siblings.indexOf(2); // 1
    targetIndex++; // 'after' → 2
    // tab 1 is currently at index 0, which is < targetIndex, so adjust: 2 - 1 = 1
    const currentIndex = siblings.indexOf(1); // 0
    if (currentIndex < targetIndex) targetIndex--;
    state.moveTab(1, null, targetIndex);

    assert.deepEqual(state.rootIds, [2, 1, 3]);
  });

  it('reparents tab as child of target', () => {
    const state = new ShadowState();
    state.addTab(1, { tabId: 1, title: 'Parent' });
    state.addTab(2, { tabId: 2, title: 'To Move' });
    // rootIds: [1, 2]

    // Make tab 2 a child of tab 1
    state.moveTab(2, 1, 0);

    assert.deepEqual(state.rootIds, [1]);
    assert.deepEqual(state.getTab(1).children, [2]);
    assert.equal(state.getTab(2).parentId, 1);
  });

  it('moves tab before target within same parent', () => {
    const state = new ShadowState();
    state.addTab(1, { tabId: 1, title: 'Parent' });
    state.addTab(2, { tabId: 2, parentId: 1, title: 'Child A' });
    state.addTab(3, { tabId: 3, parentId: 1, title: 'Child B' });
    state.addTab(4, { tabId: 4, parentId: 1, title: 'Child C' });
    // parent 1 children: [2, 3, 4]

    // Move child 4 before child 2 → children: [4, 2, 3]
    const siblings = [...state.getTab(1).children];
    let targetIndex = siblings.indexOf(2); // 0
    state.moveTab(4, 1, targetIndex);

    assert.deepEqual(state.getTab(1).children, [4, 2, 3]);
  });

  it('moves tab after target within same parent', () => {
    const state = new ShadowState();
    state.addTab(1, { tabId: 1, title: 'Parent' });
    state.addTab(2, { tabId: 2, parentId: 1, title: 'Child A' });
    state.addTab(3, { tabId: 3, parentId: 1, title: 'Child B' });
    state.addTab(4, { tabId: 4, parentId: 1, title: 'Child C' });
    // parent 1 children: [2, 3, 4]

    // Move child 2 after child 3 → children: [3, 2, 4]
    const siblings = [...state.getTab(1).children];
    let targetIndex = siblings.indexOf(3); // 1
    targetIndex++; // 'after' → 2
    const currentIndex = siblings.indexOf(2); // 0
    if (currentIndex < targetIndex) targetIndex--;
    state.moveTab(2, 1, targetIndex);

    assert.deepEqual(state.getTab(1).children, [3, 2, 4]);
  });

  it('does not create circular reference when dropping parent onto child', () => {
    const state = new ShadowState();
    state.addTab(1, { tabId: 1, title: 'Parent' });
    state.addTab(2, { tabId: 2, parentId: 1, title: 'Child' });
    // parent 1 → child 2

    // Move tab 1 as child of tab 2 — this would create a cycle.
    // ShadowState.moveTab has cycle detection and silently aborts the move.
    state.moveTab(1, 2, 0);

    // State should be unchanged — the move was rejected
    assert.equal(state.getTab(1).parentId, null, 'tab 1 should remain a root');
    assert.equal(state.getTab(2).parentId, 1, 'tab 2 should remain child of tab 1');
    assert.deepEqual(state.rootIds, [1], 'rootIds should be unchanged');
  });
});
