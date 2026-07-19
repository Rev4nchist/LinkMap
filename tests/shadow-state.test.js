import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ShadowState } from '../shared/shadow-state.js';
import { ORPHANED_GROUP_TTL_MS, ORPHANED_GROUP_CAP } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a minimal TabNode-like object for testing. */
function makeTab(overrides = {}) {
  return {
    tabId: 1,
    parentId: null,
    title: 'Test Tab',
    url: 'https://example.com',
    favIconUrl: '',
    pinned: false,
    audible: false,
    status: 'complete',
    groupId: -1,
    index: 0,
    windowId: 1,
    ...overrides,
  };
}

/** Returns a minimal chrome.tabs.Tab-like object for reconciliation tests. */
function makeLiveTab(overrides = {}) {
  return {
    id: 1,
    title: 'Live Tab',
    url: 'https://live.com',
    favIconUrl: '',
    pinned: false,
    audible: false,
    status: 'complete',
    groupId: -1,
    index: 0,
    windowId: 1,
    openerTabId: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('ShadowState constructor', () => {
  it('initializes with empty tabs Map', () => {
    const s = new ShadowState();
    assert.ok(s.tabs instanceof Map);
    assert.equal(s.tabs.size, 0);
  });

  it('initializes with empty rootIds array', () => {
    const s = new ShadowState();
    assert.ok(Array.isArray(s.rootIds));
    assert.equal(s.rootIds.length, 0);
  });

  it('initializes with empty collapsed Set', () => {
    const s = new ShadowState();
    assert.ok(s.collapsed instanceof Set);
    assert.equal(s.collapsed.size, 0);
  });

  it('initializes with empty groupColors object', () => {
    const s = new ShadowState();
    assert.deepEqual(s.groupColors, {});
  });

  it('initializes with default theme "august-default"', () => {
    const s = new ShadowState();
    assert.equal(s.theme, 'august-default');
  });
});

// ---------------------------------------------------------------------------
// addTab
// ---------------------------------------------------------------------------

describe('addTab', () => {
  let s;
  beforeEach(() => { s = new ShadowState(); });

  it('adds a tab to the Map', () => {
    s.addTab(1, makeTab({ tabId: 1 }));
    assert.equal(s.tabs.size, 1);
    assert.equal(s.tabs.get(1).title, 'Test Tab');
  });

  it('adds root-level tab to rootIds', () => {
    s.addTab(1, makeTab({ tabId: 1, parentId: null }));
    assert.deepEqual(s.rootIds, [1]);
  });

  it('adds child tab to parent children array when parent exists', () => {
    s.addTab(1, makeTab({ tabId: 1, parentId: null }));
    s.addTab(2, makeTab({ tabId: 2, parentId: 1 }));
    assert.deepEqual(s.tabs.get(1).children, [2]);
    assert.equal(s.tabs.get(2).parentId, 1);
    // Not in rootIds
    assert.ok(!s.rootIds.includes(2));
  });

  it('falls back to root when parentId refers to non-existent tab', () => {
    s.addTab(2, makeTab({ tabId: 2, parentId: 999 }));
    assert.equal(s.tabs.get(2).parentId, null);
    assert.deepEqual(s.rootIds, [2]);
  });

  it('initializes children array on the new node', () => {
    s.addTab(1, makeTab({ tabId: 1 }));
    assert.ok(Array.isArray(s.tabs.get(1).children));
    assert.equal(s.tabs.get(1).children.length, 0);
  });
});

// ---------------------------------------------------------------------------
// removeTab
// ---------------------------------------------------------------------------

describe('removeTab', () => {
  let s;
  beforeEach(() => { s = new ShadowState(); });

  it('removes a root tab from Map and rootIds', () => {
    s.addTab(1, makeTab({ tabId: 1 }));
    s.removeTab(1);
    assert.equal(s.tabs.size, 0);
    assert.deepEqual(s.rootIds, []);
  });

  it('reparents children to grandparent when removing middle node', () => {
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2, parentId: 1 }));
    s.addTab(3, makeTab({ tabId: 3, parentId: 2 }));
    s.addTab(4, makeTab({ tabId: 4, parentId: 2 }));

    s.removeTab(2);

    // 3 and 4 should now be children of 1
    assert.deepEqual(s.tabs.get(1).children, [3, 4]);
    assert.equal(s.tabs.get(3).parentId, 1);
    assert.equal(s.tabs.get(4).parentId, 1);
    assert.ok(!s.tabs.has(2));
  });

  it('reparents children to root when removing root node with children', () => {
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2, parentId: 1 }));
    s.addTab(3, makeTab({ tabId: 3, parentId: 1 }));

    s.removeTab(1);

    // 2 and 3 should now be roots
    assert.ok(s.rootIds.includes(2));
    assert.ok(s.rootIds.includes(3));
    assert.equal(s.tabs.get(2).parentId, null);
    assert.equal(s.tabs.get(3).parentId, null);
  });

  it('removes from collapsed Set if present', () => {
    s.addTab(1, makeTab({ tabId: 1 }));
    s.collapsed.add(1);
    s.removeTab(1);
    assert.ok(!s.collapsed.has(1));
  });

  it('is a no-op for non-existent tab', () => {
    s.removeTab(999);
    assert.equal(s.tabs.size, 0);
  });

  it('preserves insertion position when reparenting children to grandparent', () => {
    // Tree: 1 -> [2, 5]  where 2 -> [3, 4]
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2, parentId: 1 }));
    s.addTab(3, makeTab({ tabId: 3, parentId: 2 }));
    s.addTab(4, makeTab({ tabId: 4, parentId: 2 }));
    s.addTab(5, makeTab({ tabId: 5, parentId: 1 }));

    // Parent 1 children: [2, 5]
    s.removeTab(2);

    // Children of 2 (3, 4) should replace 2 in parent 1's children: [3, 4, 5]
    assert.deepEqual(s.tabs.get(1).children, [3, 4, 5]);
  });

  it('preserves position when reparenting to rootIds', () => {
    // rootIds: [1, 2, 3] where 2 -> [4, 5]
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2 }));
    s.addTab(3, makeTab({ tabId: 3 }));
    s.addTab(4, makeTab({ tabId: 4, parentId: 2 }));
    s.addTab(5, makeTab({ tabId: 5, parentId: 2 }));

    s.removeTab(2);

    // rootIds should be [1, 4, 5, 3]
    assert.deepEqual(s.rootIds, [1, 4, 5, 3]);
  });
});

// ---------------------------------------------------------------------------
// moveTab
// ---------------------------------------------------------------------------

describe('moveTab', () => {
  let s;
  beforeEach(() => {
    s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2 }));
    s.addTab(3, makeTab({ tabId: 3 }));
  });

  it('moves a root tab under another tab', () => {
    s.moveTab(3, 1, 0);
    assert.equal(s.tabs.get(3).parentId, 1);
    assert.deepEqual(s.tabs.get(1).children, [3]);
    assert.ok(!s.rootIds.includes(3));
  });

  it('moves a child tab to root', () => {
    s.addTab(4, makeTab({ tabId: 4, parentId: 1 }));
    s.moveTab(4, null, 0);
    assert.equal(s.tabs.get(4).parentId, null);
    assert.equal(s.rootIds[0], 4);
    assert.ok(!s.tabs.get(1).children.includes(4));
  });

  it('inserts at the specified index', () => {
    // rootIds: [1, 2, 3]
    s.moveTab(3, null, 0);
    assert.equal(s.rootIds[0], 3);
  });

  it('moves between different parents', () => {
    s.addTab(4, makeTab({ tabId: 4, parentId: 1 }));
    s.moveTab(4, 2, 0);
    assert.equal(s.tabs.get(4).parentId, 2);
    assert.deepEqual(s.tabs.get(2).children, [4]);
    assert.ok(!s.tabs.get(1).children.includes(4));
  });

  it('is a no-op for non-existent tab', () => {
    const rootsBefore = [...s.rootIds];
    s.moveTab(999, null, 0);
    assert.deepEqual(s.rootIds, rootsBefore);
  });
});

// ---------------------------------------------------------------------------
// updateTab
// ---------------------------------------------------------------------------

describe('updateTab', () => {
  let s;
  beforeEach(() => {
    s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
  });

  it('updates known properties', () => {
    s.updateTab(1, { title: 'New Title', url: 'https://new.com' });
    assert.equal(s.tabs.get(1).title, 'New Title');
    assert.equal(s.tabs.get(1).url, 'https://new.com');
  });

  it('ignores unknown properties', () => {
    s.updateTab(1, { fakeProperty: 'nope' });
    assert.equal(s.tabs.get(1).fakeProperty, undefined);
  });

  it('is a no-op for non-existent tab', () => {
    // Should not throw
    s.updateTab(999, { title: 'Ghost' });
    assert.equal(s.tabs.size, 1);
  });

  it('updates all mutable fields', () => {
    s.updateTab(1, {
      title: 'T',
      url: 'U',
      favIconUrl: 'F',
      pinned: true,
      audible: true,
      status: 'loading',
      groupId: 5,
      index: 10,
      windowId: 2,
    });
    const node = s.tabs.get(1);
    assert.equal(node.title, 'T');
    assert.equal(node.url, 'U');
    assert.equal(node.favIconUrl, 'F');
    assert.equal(node.pinned, true);
    assert.equal(node.audible, true);
    assert.equal(node.status, 'loading');
    assert.equal(node.groupId, 5);
    assert.equal(node.index, 10);
    assert.equal(node.windowId, 2);
  });
});

// ---------------------------------------------------------------------------
// toggleCollapse
// ---------------------------------------------------------------------------

describe('toggleCollapse', () => {
  let s;
  beforeEach(() => { s = new ShadowState(); });

  it('adds tabId to collapsed Set', () => {
    s.toggleCollapse(1);
    assert.ok(s.collapsed.has(1));
  });

  it('removes tabId from collapsed Set on second call', () => {
    s.toggleCollapse(1);
    s.toggleCollapse(1);
    assert.ok(!s.collapsed.has(1));
  });
});

// ---------------------------------------------------------------------------
// setTheme & setGroupColor
// ---------------------------------------------------------------------------

describe('setTheme', () => {
  it('sets the theme', () => {
    const s = new ShadowState();
    s.setTheme('dracula');
    assert.equal(s.theme, 'dracula');
  });
});

describe('setGroupColor', () => {
  it('stores a group color', () => {
    const s = new ShadowState();
    s.setGroupColor(5, '#ff0000');
    assert.equal(s.groupColors[5], '#ff0000');
  });
});

// ---------------------------------------------------------------------------
// Query methods
// ---------------------------------------------------------------------------

describe('getTab', () => {
  it('returns the tab node', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1, title: 'Hello' }));
    const node = s.getTab(1);
    assert.equal(node.title, 'Hello');
  });

  it('returns null for non-existent tab', () => {
    const s = new ShadowState();
    assert.equal(s.getTab(999), null);
  });
});

describe('getChildren', () => {
  it('returns direct children as TabNode array', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2, parentId: 1 }));
    s.addTab(3, makeTab({ tabId: 3, parentId: 1 }));

    const children = s.getChildren(1);
    assert.equal(children.length, 2);
    assert.equal(children[0].tabId, 2);
    assert.equal(children[1].tabId, 3);
  });

  it('returns empty array for tab with no children', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    assert.deepEqual(s.getChildren(1), []);
  });

  it('returns empty array for non-existent tab', () => {
    const s = new ShadowState();
    assert.deepEqual(s.getChildren(999), []);
  });
});

describe('getDescendants', () => {
  it('returns all descendants depth-first', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2, parentId: 1 }));
    s.addTab(3, makeTab({ tabId: 3, parentId: 2 }));
    s.addTab(4, makeTab({ tabId: 4, parentId: 1 }));

    const desc = s.getDescendants(1);
    assert.equal(desc.length, 3);
    // Depth-first: 2, 3, 4
    assert.equal(desc[0].tabId, 2);
    assert.equal(desc[1].tabId, 3);
    assert.equal(desc[2].tabId, 4);
  });

  it('returns empty array for leaf node', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    assert.deepEqual(s.getDescendants(1), []);
  });

  it('returns empty array for non-existent tab', () => {
    const s = new ShadowState();
    assert.deepEqual(s.getDescendants(999), []);
  });
});

describe('getRoots', () => {
  it('returns root tab nodes in order', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2 }));
    const roots = s.getRoots();
    assert.equal(roots.length, 2);
    assert.equal(roots[0].tabId, 1);
    assert.equal(roots[1].tabId, 2);
  });

  it('returns empty array when no tabs exist', () => {
    const s = new ShadowState();
    assert.deepEqual(s.getRoots(), []);
  });
});

describe('getAllTabs', () => {
  it('returns all tab nodes', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2, parentId: 1 }));
    const all = s.getAllTabs();
    assert.equal(all.length, 2);
  });
});

describe('isCollapsed', () => {
  it('returns true for collapsed tab', () => {
    const s = new ShadowState();
    s.collapsed.add(5);
    assert.equal(s.isCollapsed(5), true);
  });

  it('returns false for non-collapsed tab', () => {
    const s = new ShadowState();
    assert.equal(s.isCollapsed(5), false);
  });
});

// ---------------------------------------------------------------------------
// getVisibleTabs
// ---------------------------------------------------------------------------

describe('getVisibleTabs', () => {
  it('returns all roots at depth 0 with no collapsed nodes', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2 }));
    const visible = s.getVisibleTabs();
    assert.equal(visible.length, 2);
    assert.equal(visible[0].node.tabId, 1);
    assert.equal(visible[0].depth, 0);
    assert.equal(visible[1].node.tabId, 2);
    assert.equal(visible[1].depth, 0);
  });

  it('includes children at correct depth', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2, parentId: 1 }));
    s.addTab(3, makeTab({ tabId: 3, parentId: 2 }));

    const visible = s.getVisibleTabs();
    assert.equal(visible.length, 3);
    assert.equal(visible[0].depth, 0); // tab 1
    assert.equal(visible[1].depth, 1); // tab 2
    assert.equal(visible[2].depth, 2); // tab 3
  });

  it('skips children of collapsed nodes', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2, parentId: 1 }));
    s.addTab(3, makeTab({ tabId: 3, parentId: 2 }));
    s.addTab(4, makeTab({ tabId: 4 }));

    s.collapsed.add(1);

    const visible = s.getVisibleTabs();
    assert.equal(visible.length, 2); // tab 1 (collapsed) + tab 4
    assert.equal(visible[0].node.tabId, 1);
    assert.equal(visible[1].node.tabId, 4);
  });

  it('returns empty array when state is empty', () => {
    const s = new ShadowState();
    assert.deepEqual(s.getVisibleTabs(), []);
  });
});

// ---------------------------------------------------------------------------
// Serialization: toSerializable / fromStorage
// ---------------------------------------------------------------------------

describe('toSerializable', () => {
  it('returns a plain object with version and savedAt', () => {
    const s = new ShadowState();
    const data = s.toSerializable();
    assert.equal(data.version, 2);
    assert.ok(typeof data.savedAt === 'string');
  });

  it('converts tabs Map to plain object', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    const data = s.toSerializable();
    assert.ok(!(data.tabs instanceof Map));
    assert.ok(data.tabs[1] !== undefined);
    assert.equal(data.tabs[1].tabId, 1);
  });

  it('converts collapsed Set to array', () => {
    const s = new ShadowState();
    s.collapsed.add(5);
    s.collapsed.add(10);
    const data = s.toSerializable();
    assert.ok(Array.isArray(data.collapsed));
    assert.ok(data.collapsed.includes(5));
    assert.ok(data.collapsed.includes(10));
  });

  it('preserves rootIds, groupColors, and theme', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.groupColors[5] = '#ff0000';
    s.theme = 'dracula';
    const data = s.toSerializable();
    assert.deepEqual(data.rootIds, [1]);
    assert.equal(data.groupColors[5], '#ff0000');
    assert.equal(data.theme, 'dracula');
  });
});

describe('fromStorage', () => {
  it('reconstructs ShadowState from serialized data', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2, parentId: 1 }));
    s.collapsed.add(1);
    s.groupColors[3] = '#00ff00';
    s.theme = 'nord';

    const data = s.toSerializable();
    const restored = ShadowState.fromStorage(data);

    assert.ok(restored.tabs instanceof Map);
    assert.equal(restored.tabs.size, 2);
    assert.equal(restored.tabs.get(1).title, 'Test Tab');
    assert.deepEqual(restored.rootIds, [1]);
    assert.ok(restored.collapsed instanceof Set);
    assert.ok(restored.collapsed.has(1));
    assert.equal(restored.groupColors[3], '#00ff00');
    assert.equal(restored.theme, 'nord');
  });

  it('returns fresh ShadowState for null input', () => {
    const restored = ShadowState.fromStorage(null);
    assert.ok(restored instanceof ShadowState);
    assert.equal(restored.tabs.size, 0);
  });

  it('returns fresh ShadowState for undefined input', () => {
    const restored = ShadowState.fromStorage(undefined);
    assert.ok(restored instanceof ShadowState);
    assert.equal(restored.tabs.size, 0);
  });

  it('roundtrips correctly', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1, title: 'A' }));
    s.addTab(2, makeTab({ tabId: 2, parentId: 1, title: 'B' }));
    s.addTab(3, makeTab({ tabId: 3, title: 'C' }));
    s.collapsed.add(1);
    s.theme = 'oled';

    const restored = ShadowState.fromStorage(s.toSerializable());
    // Verify tree structure is preserved
    assert.deepEqual(restored.tabs.get(1).children, [2]);
    assert.equal(restored.tabs.get(2).parentId, 1);
    assert.deepEqual(restored.rootIds, [1, 3]);
    assert.equal(restored.theme, 'oled');
  });
});

// ---------------------------------------------------------------------------
// lmId — durable lineage key (B-1)
// ---------------------------------------------------------------------------

describe('lmId — durable lineage key (B-1)', () => {
  it('backfills a unique lmId for every node in a v1 fixture lacking lmId, and seeds nextLmId above the max', () => {
    // A pre-B-1 (v1) persisted snapshot: plain nodes with no lmId field at
    // all, and no top-level nextLmId — exactly what fromStorage() sees today
    // in production before this migration ships.
    const data = {
      tabs: {
        1: serializedNode({ tabId: 1, children: [2], index: 0 }),
        2: serializedNode({ tabId: 2, parentId: 1, index: 1 }),
        3: serializedNode({ tabId: 3, index: 2 }),
      },
      rootIds: [1, 3],
      collapsed: [],
    };

    const s = ShadowState.fromStorage(data);

    const lmIds = [1, 2, 3].map((id) => s.getTab(id).lmId);
    for (const lmId of lmIds) {
      assert.equal(typeof lmId, 'number', 'every migrated node gets a numeric lmId');
    }
    assert.equal(new Set(lmIds).size, 3, 'all backfilled lmIds are unique');
    assert.ok(s.nextLmId > Math.max(...lmIds), 'nextLmId is seeded strictly above the max assigned lmId');

    // _validateAndRepair must still pass — tree shape unaffected by the migration.
    assert.deepEqual(s.rootIds, [1, 3]);
    assert.deepEqual(s.getTab(1).children, [2]);
  });

  it('preserves lmId across replaceTabId (tabId churn does not lose lineage identity)', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    const originalLmId = s.getTab(1).lmId;
    assert.equal(typeof originalLmId, 'number');

    s.replaceTabId(1, 501);

    assert.equal(s.getTab(1), null, 'old id no longer present');
    assert.equal(s.getTab(501)?.lmId, originalLmId, 'lmId survives the tabId rename');
  });

  it('assigns a fresh, unique, monotonically-increasing lmId to each newly added tab', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2 }));
    s.addTab(3, makeTab({ tabId: 3 }));

    const lmIds = [1, 2, 3].map((id) => s.getTab(id).lmId);
    assert.equal(new Set(lmIds).size, 3, 'all lmIds are unique');
    assert.ok(lmIds[0] < lmIds[1] && lmIds[1] < lmIds[2], 'lmIds are assigned monotonically');
  });

  it('round-trips lmId and nextLmId through toSerializable / fromStorage', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2, parentId: 1 }));
    const lmId1 = s.getTab(1).lmId;
    const lmId2 = s.getTab(2).lmId;
    const nextLmIdBefore = s.nextLmId;

    const restored = ShadowState.fromStorage(s.toSerializable());

    assert.equal(restored.getTab(1).lmId, lmId1, 'parent lmId preserved through round-trip');
    assert.equal(restored.getTab(2).lmId, lmId2, 'child lmId preserved through round-trip');
    assert.equal(restored.nextLmId, nextLmIdBefore, 'nextLmId counter preserved through round-trip');
  });
});

// ---------------------------------------------------------------------------
// reconcileWithLiveTabs
// ---------------------------------------------------------------------------

describe('reconcileWithLiveTabs', () => {
  let s;
  beforeEach(() => {
    s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1, title: 'Old Tab 1', index: 0 }));
    s.addTab(2, makeTab({ tabId: 2, parentId: 1, title: 'Old Tab 2', index: 1 }));
  });

  it('removes tabs not present in liveTabs', () => {
    const liveTabs = [makeLiveTab({ id: 1, index: 0 })];
    s.reconcileWithLiveTabs(liveTabs);
    assert.ok(!s.tabs.has(2));
    assert.equal(s.tabs.size, 1);
  });

  it('updates metadata for existing tabs', () => {
    const liveTabs = [
      makeLiveTab({ id: 1, title: 'Updated Title', url: 'https://updated.com', index: 0 }),
      makeLiveTab({ id: 2, title: 'Updated Child', index: 1 }),
    ];
    s.reconcileWithLiveTabs(liveTabs);
    assert.equal(s.tabs.get(1).title, 'Updated Title');
    assert.equal(s.tabs.get(1).url, 'https://updated.com');
    assert.equal(s.tabs.get(2).title, 'Updated Child');
  });

  it('adds new tabs at root level', () => {
    const liveTabs = [
      makeLiveTab({ id: 1, index: 0 }),
      makeLiveTab({ id: 2, index: 1 }),
      makeLiveTab({ id: 3, title: 'Brand New', index: 2 }),
    ];
    s.reconcileWithLiveTabs(liveTabs);
    assert.ok(s.tabs.has(3));
    assert.equal(s.tabs.get(3).title, 'Brand New');
    assert.equal(s.tabs.get(3).parentId, null);
  });

  it('preserves parent-child relationships for existing tabs', () => {
    const liveTabs = [
      makeLiveTab({ id: 1, index: 0 }),
      makeLiveTab({ id: 2, index: 1 }),
    ];
    s.reconcileWithLiveTabs(liveTabs);
    // Parent-child relationship between 1 and 2 should be preserved
    assert.equal(s.tabs.get(2).parentId, 1);
    assert.ok(s.tabs.get(1).children.includes(2));
  });

  it('rebuilds rootIds ordered by index', () => {
    // Clear and build fresh
    const s2 = new ShadowState();
    s2.addTab(10, makeTab({ tabId: 10, index: 2 }));
    s2.addTab(20, makeTab({ tabId: 20, index: 0 }));
    s2.addTab(30, makeTab({ tabId: 30, index: 1 }));

    const liveTabs = [
      makeLiveTab({ id: 10, index: 2 }),
      makeLiveTab({ id: 20, index: 0 }),
      makeLiveTab({ id: 30, index: 1 }),
    ];
    s2.reconcileWithLiveTabs(liveTabs);

    // reconcileWithLiveTabs preserves existing rootIds order (tree order is source of truth)
    assert.deepEqual(s2.rootIds, [10, 20, 30]);
  });

  it('handles empty liveTabs (removes all)', () => {
    s.reconcileWithLiveTabs([]);
    assert.equal(s.tabs.size, 0);
    assert.deepEqual(s.rootIds, []);
  });

  it('handles empty state with liveTabs (adds all)', () => {
    const s2 = new ShadowState();
    const liveTabs = [
      makeLiveTab({ id: 1, index: 0 }),
      makeLiveTab({ id: 2, index: 1 }),
    ];
    s2.reconcileWithLiveTabs(liveTabs);
    assert.equal(s2.tabs.size, 2);
    assert.deepEqual(s2.rootIds, [1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('handles adding then immediately removing a tab', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.removeTab(1);
    assert.equal(s.tabs.size, 0);
    assert.deepEqual(s.rootIds, []);
  });

  it('handles deep nesting (5 levels)', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2, parentId: 1 }));
    s.addTab(3, makeTab({ tabId: 3, parentId: 2 }));
    s.addTab(4, makeTab({ tabId: 4, parentId: 3 }));
    s.addTab(5, makeTab({ tabId: 5, parentId: 4 }));

    const desc = s.getDescendants(1);
    assert.equal(desc.length, 4);

    const visible = s.getVisibleTabs();
    assert.equal(visible.length, 5);
    assert.equal(visible[4].depth, 4);
  });

  it('handles removing middle of deep chain (reparents correctly)', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2, parentId: 1 }));
    s.addTab(3, makeTab({ tabId: 3, parentId: 2 }));

    s.removeTab(2);

    assert.deepEqual(s.tabs.get(1).children, [3]);
    assert.equal(s.tabs.get(3).parentId, 1);
  });

  it('exports as both named and default', async () => {
    const mod = await import('../shared/shadow-state.js');
    assert.ok(mod.ShadowState);
    assert.ok(mod.default);
    assert.equal(mod.ShadowState, mod.default);
  });
});

// ---------------------------------------------------------------------------
// enforceGroupContiguity
// ---------------------------------------------------------------------------

describe('ShadowState#enforceGroupContiguity', () => {
  it('reorders rootIds so same-group tabs are contiguous', () => {
    const s = new ShadowState();
    // A(group=5), B(group=7), C(group=5), D(group=7)
    s.addTab(1, makeTab({ tabId: 1, groupId: 5 }));
    s.addTab(2, makeTab({ tabId: 2, groupId: 7 }));
    s.addTab(3, makeTab({ tabId: 3, groupId: 5 }));
    s.addTab(4, makeTab({ tabId: 4, groupId: 7 }));

    s.enforceGroupContiguity();

    // Group 5 first (A appeared first), then group 7
    assert.deepEqual(s.rootIds, [1, 3, 2, 4]);
  });

  it('preserves order when groups are already contiguous', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1, groupId: 5 }));
    s.addTab(2, makeTab({ tabId: 2, groupId: 5 }));
    s.addTab(3, makeTab({ tabId: 3, groupId: 7 }));
    s.addTab(4, makeTab({ tabId: 4, groupId: 7 }));

    s.enforceGroupContiguity();

    assert.deepEqual(s.rootIds, [1, 2, 3, 4]);
  });

  it('leaves ungrouped tabs (groupId = -1) in place; group blocks at first occurrence', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1, groupId: -1 }));
    s.addTab(2, makeTab({ tabId: 2, groupId: 5 }));
    s.addTab(3, makeTab({ tabId: 3, groupId: -1 }));
    s.addTab(4, makeTab({ tabId: 4, groupId: 5 }));

    s.enforceGroupContiguity();

    // Group 5 blocks at tab 2's position; ungrouped tabs 1 and 3 stay put
    assert.deepEqual(s.rootIds, [1, 2, 4, 3]);
  });

  it('does not sink a group below later ungrouped tabs (regression: groups migrated to bottom)', () => {
    const s = new ShadowState();
    // [ungrouped, GROUP, GROUP, ungrouped, ungrouped] — already contiguous.
    // The old pseudo-group bucketing coalesced ALL ungrouped tabs at tab 1's
    // position, producing [1, 4, 5, 2, 3] — the group sank to the bottom.
    s.addTab(1, makeTab({ tabId: 1, groupId: -1 }));
    s.addTab(2, makeTab({ tabId: 2, groupId: 5 }));
    s.addTab(3, makeTab({ tabId: 3, groupId: 5 }));
    s.addTab(4, makeTab({ tabId: 4, groupId: -1 }));
    s.addTab(5, makeTab({ tabId: 5, groupId: -1 }));

    s.enforceGroupContiguity();

    assert.deepEqual(s.rootIds, [1, 2, 3, 4, 5]);
  });

  it('handles single tab', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1, groupId: 5 }));

    s.enforceGroupContiguity();

    assert.deepEqual(s.rootIds, [1]);
  });

  it('handles empty rootIds', () => {
    const s = new ShadowState();

    s.enforceGroupContiguity();

    assert.deepEqual(s.rootIds, []);
  });

  it('preserves relative order within each group', () => {
    const s = new ShadowState();
    // Group 5: tabs 10, 30, 50 (in rootIds order)
    // Group 7: tabs 20, 40
    s.addTab(10, makeTab({ tabId: 10, groupId: 5 }));
    s.addTab(20, makeTab({ tabId: 20, groupId: 7 }));
    s.addTab(30, makeTab({ tabId: 30, groupId: 5 }));
    s.addTab(40, makeTab({ tabId: 40, groupId: 7 }));
    s.addTab(50, makeTab({ tabId: 50, groupId: 5 }));

    s.enforceGroupContiguity();

    // Group 5 first (tab 10 appeared first), internal order: 10, 30, 50
    // Group 7 second, internal order: 20, 40
    assert.deepEqual(s.rootIds, [10, 30, 50, 20, 40]);
  });

  it('handles three interleaved groups', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1, groupId: 10 }));
    s.addTab(2, makeTab({ tabId: 2, groupId: 20 }));
    s.addTab(3, makeTab({ tabId: 3, groupId: 30 }));
    s.addTab(4, makeTab({ tabId: 4, groupId: 10 }));
    s.addTab(5, makeTab({ tabId: 5, groupId: 20 }));
    s.addTab(6, makeTab({ tabId: 6, groupId: 30 }));

    s.enforceGroupContiguity();

    assert.deepEqual(s.rootIds, [1, 4, 2, 5, 3, 6]);
  });

  it('skips tabs missing from tabs Map (stale rootIds entries)', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1, groupId: 5 }));
    s.addTab(2, makeTab({ tabId: 2, groupId: 7 }));
    s.addTab(3, makeTab({ tabId: 3, groupId: 5 }));
    // Manually inject a stale id into rootIds
    s.rootIds.push(999);

    s.enforceGroupContiguity();

    // Stale id 999 is dropped, groups contiguous
    assert.deepEqual(s.rootIds, [1, 3, 2]);
  });
});

// ---------------------------------------------------------------------------
// Window Names (Track A)
// ---------------------------------------------------------------------------

describe('windowNames — constructor', () => {
  it('initializes with empty windowNames Map', () => {
    const s = new ShadowState();
    assert.ok(s.windowNames instanceof Map);
    assert.equal(s.windowNames.size, 0);
  });
});

describe('setWindowName / getWindowName', () => {
  let s;
  beforeEach(() => { s = new ShadowState(); });

  it('stores and retrieves a window name', () => {
    s.setWindowName(1, 'Work');
    assert.equal(s.getWindowName(1), 'Work');
  });

  it('trims whitespace from name', () => {
    s.setWindowName(1, '  Work  ');
    assert.equal(s.getWindowName(1), 'Work');
  });

  it('deletes name when set to empty string', () => {
    s.setWindowName(1, 'Work');
    s.setWindowName(1, '');
    assert.equal(s.getWindowName(1), null);
    assert.equal(s.windowNames.size, 0);
  });

  it('deletes name when set to whitespace-only', () => {
    s.setWindowName(1, 'Work');
    s.setWindowName(1, '   ');
    assert.equal(s.getWindowName(1), null);
  });

  it('deletes name when set to null', () => {
    s.setWindowName(1, 'Work');
    s.setWindowName(1, null);
    assert.equal(s.getWindowName(1), null);
  });

  it('returns null for unknown windowId', () => {
    assert.equal(s.getWindowName(999), null);
  });

  it('supports multiple window names', () => {
    s.setWindowName(1, 'Work');
    s.setWindowName(2, 'Personal');
    assert.equal(s.getWindowName(1), 'Work');
    assert.equal(s.getWindowName(2), 'Personal');
  });
});

describe('windowNames — serialization', () => {
  it('toSerializable includes windowNames as plain object', () => {
    const s = new ShadowState();
    s.setWindowName(1, 'Work');
    s.setWindowName(2, 'Personal');
    const data = s.toSerializable();
    assert.deepEqual(data.windowNames, { 1: 'Work', 2: 'Personal' });
  });

  it('toSerializable includes empty windowNames when none set', () => {
    const s = new ShadowState();
    const data = s.toSerializable();
    assert.deepEqual(data.windowNames, {});
  });

  it('fromStorage restores windowNames from data', () => {
    const s = new ShadowState();
    s.setWindowName(1, 'Work');
    s.setWindowName(2, 'Personal');
    const data = s.toSerializable();
    const restored = ShadowState.fromStorage(data);
    assert.ok(restored.windowNames instanceof Map);
    assert.equal(restored.getWindowName(1), 'Work');
    assert.equal(restored.getWindowName(2), 'Personal');
  });

  it('fromStorage handles missing windowNames gracefully', () => {
    const data = {
      version: 1,
      tabs: {},
      rootIds: [],
      collapsed: [],
      groups: {},
      groupColors: {},
      theme: 'midnight',
    };
    const restored = ShadowState.fromStorage(data);
    assert.ok(restored.windowNames instanceof Map);
    assert.equal(restored.windowNames.size, 0);
  });

  it('fromStorage coerces string keys to numbers', () => {
    const data = {
      version: 1,
      tabs: {},
      rootIds: [],
      collapsed: [],
      groups: {},
      groupColors: {},
      theme: 'midnight',
      windowNames: { '1': 'Work', '2': 'Personal' },
    };
    const restored = ShadowState.fromStorage(data);
    assert.equal(restored.getWindowName(1), 'Work');
    assert.equal(restored.getWindowName(2), 'Personal');
  });
});

describe('windowNames — reconciliation remap', () => {
  it('remaps window names when windowIds change during reconcile', () => {
    const s = new ShadowState();
    // Set up state with old window IDs (same tab IDs = Pass 1 match)
    s.addTab(1, makeTab({ tabId: 1, windowId: 100 }));
    s.addTab(2, makeTab({ tabId: 2, windowId: 200 }));
    s.setWindowName(100, 'Work');
    s.setWindowName(200, 'Personal');

    // Live tabs have same IDs but new window IDs (simulating window re-assignment)
    const liveTabs = [
      makeLiveTab({ id: 1, windowId: 300, index: 0 }),
      makeLiveTab({ id: 2, windowId: 400, index: 0 }),
    ];

    const windowIdMap = s.reconcileWithLiveTabs(liveTabs);
    // windowIdMap should map 100->300, 200->400
    // windowNames should now be keyed by new IDs
    assert.equal(s.getWindowName(300), 'Work');
    assert.equal(s.getWindowName(400), 'Personal');
    // Old IDs should no longer exist
    assert.equal(s.getWindowName(100), null);
    assert.equal(s.getWindowName(200), null);
  });

  it('remaps window names across restart (URL-matched tabs with new IDs)', () => {
    const s = new ShadowState();
    // Saved state: old tab IDs and old window IDs
    s.addTab(100, makeTab({ tabId: 100, windowId: 10, url: 'https://github.com', title: 'GitHub' }));
    s.addTab(200, makeTab({ tabId: 200, windowId: 20, url: 'https://google.com', title: 'Google' }));
    s.setWindowName(10, 'Dev');
    s.setWindowName(20, 'Research');

    // After restart: Chrome assigns new tab IDs AND new window IDs
    const liveTabs = [
      makeLiveTab({ id: 501, windowId: 50, url: 'https://github.com', title: 'GitHub', index: 0 }),
      makeLiveTab({ id: 502, windowId: 60, url: 'https://google.com', title: 'Google', index: 0 }),
    ];

    s.reconcileWithLiveTabs(liveTabs);

    // Window names should be remapped to new window IDs
    assert.equal(s.getWindowName(50), 'Dev');
    assert.equal(s.getWindowName(60), 'Research');
    // Old window IDs should be gone
    assert.equal(s.getWindowName(10), null);
    assert.equal(s.getWindowName(20), null);
  });

  it('remaps window name via fallback when vote-based mapping misses a window', () => {
    const s = new ShadowState();
    // Window 100 has 1 tab, window 200 has 1 tab
    s.addTab(1, makeTab({ tabId: 1, windowId: 100, url: 'https://a.com' }));
    s.addTab(2, makeTab({ tabId: 2, windowId: 200, url: 'https://b.com' }));
    s.setWindowName(100, 'Primary');
    s.setWindowName(200, 'Secondary');

    // After restart: both windows get new IDs
    // Tab from window 200 matches, tab from window 100 also matches
    const liveTabs = [
      { id: 50, url: 'https://a.com', title: '', windowId: 500, index: 0, pinned: false, audible: false, status: 'complete' },
      { id: 51, url: 'https://b.com', title: '', windowId: 600, index: 0, pinned: false, audible: false, status: 'complete' },
    ];

    s.reconcileWithLiveTabs(liveTabs);

    // Both names should survive under new window IDs
    assert.equal(s.getWindowName(500), 'Primary');
    assert.equal(s.getWindowName(600), 'Secondary');
  });

  it('preserves window names when windowIds do not change', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1, windowId: 100 }));
    s.setWindowName(100, 'Work');

    const liveTabs = [
      makeLiveTab({ id: 1, windowId: 100, index: 0 }),
    ];

    s.reconcileWithLiveTabs(liveTabs);
    assert.equal(s.getWindowName(100), 'Work');
  });
});

// ---------------------------------------------------------------------------
// BUG 4: reconcileWithLiveTabs returns { windowIdMap, stats }
// ---------------------------------------------------------------------------

describe('reconcileWithLiveTabs — return value includes stats', () => {
  it('returns an object with windowIdMap and stats properties', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    const liveTabs = [makeLiveTab({ id: 1, index: 0 })];
    const result = s.reconcileWithLiveTabs(liveTabs);
    assert.ok(result.windowIdMap instanceof Map, 'should have windowIdMap');
    assert.ok(typeof result.stats === 'object', 'should have stats object');
  });

  it('stats includes pass counters', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    const liveTabs = [makeLiveTab({ id: 1, index: 0 })];
    const { stats } = s.reconcileWithLiveTabs(liveTabs);
    assert.equal(typeof stats.pass1, 'number');
    assert.equal(typeof stats.pass2, 'number');
    assert.equal(typeof stats.pass2b, 'number');
    assert.equal(typeof stats.pass3, 'number');
  });

  it('stats pass1 counts same-session ID matches', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2 }));
    const liveTabs = [
      makeLiveTab({ id: 1, index: 0 }),
      makeLiveTab({ id: 2, index: 1 }),
    ];
    const { stats } = s.reconcileWithLiveTabs(liveTabs);
    assert.equal(stats.pass1, 2);
  });

  it('stats pass2 counts URL-matched tabs', () => {
    const s = new ShadowState();
    s.addTab(100, makeTab({ tabId: 100, url: 'https://github.com', title: 'GitHub' }));
    const liveTabs = [
      makeLiveTab({ id: 501, url: 'https://github.com', title: 'GitHub', index: 0 }),
    ];
    const { stats } = s.reconcileWithLiveTabs(liveTabs);
    assert.equal(stats.pass2, 1);
  });

  it('stats includes savedRelationships and survivingRelationships', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1, parentId: null }));
    s.addTab(2, makeTab({ tabId: 2, parentId: 1 }));
    const liveTabs = [
      makeLiveTab({ id: 1, index: 0 }),
      makeLiveTab({ id: 2, index: 1 }),
    ];
    const { stats } = s.reconcileWithLiveTabs(liveTabs);
    assert.equal(stats.savedRelationships, 1, 'one saved parent-child');
    assert.equal(stats.survivingRelationships, 1, 'relationship should survive');
  });

  it('stats includes savedCount, liveCount, deadRemoved', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2 }));
    const liveTabs = [makeLiveTab({ id: 1, index: 0 })];
    const { stats } = s.reconcileWithLiveTabs(liveTabs);
    assert.equal(stats.savedCount, 2);
    assert.equal(stats.liveCount, 1);
    assert.equal(stats.deadRemoved, 1);
  });

  it('returns a tabIdMap of old->new tabIds for every remapped tab (F8)', () => {
    const s = new ShadowState();
    // Pass 1: same-session id, never remapped, should NOT appear in tabIdMap.
    s.addTab(1, makeTab({ tabId: 1, url: 'https://same.com' }));
    // Pass 2: URL-matched, remapped 100 -> 501.
    s.addTab(100, makeTab({ tabId: 100, url: 'https://github.com', title: 'GitHub' }));
    // Pass 2b: title-matched (URL changed within the SAME origin), remapped 200 -> 502.
    s.addTab(200, makeTab({ tabId: 200, url: 'https://docs.example/old', title: 'Docs' }));

    const liveTabs = [
      makeLiveTab({ id: 1, url: 'https://same.com', index: 0 }),
      makeLiveTab({ id: 501, url: 'https://github.com', title: 'GitHub', index: 1 }),
      makeLiveTab({ id: 502, url: 'https://docs.example', title: 'Docs', index: 2 }),
    ];

    const { tabIdMap } = s.reconcileWithLiveTabs(liveTabs);
    assert.ok(tabIdMap instanceof Map, 'should have tabIdMap');
    assert.equal(tabIdMap.get(100), 501, 'pass2 remap recorded');
    assert.equal(tabIdMap.get(200), 502, 'pass2b remap recorded');
    assert.ok(!tabIdMap.has(1), 'unremapped same-session tab not recorded');
  });

  it('tabIdMap records Pass 3 positional remaps', () => {
    const s = new ShadowState();
    s.addTab(300, makeTab({ tabId: 300, url: '', title: 'New Tab', windowId: 1, index: 0 }));

    const liveTabs = [
      makeLiveTab({ id: 900, url: '', title: 'New Tab', windowId: 1, index: 0 }),
    ];

    const { tabIdMap } = s.reconcileWithLiveTabs(liveTabs);
    assert.equal(tabIdMap.get(300), 900, 'pass3 positional remap recorded');
  });
});

// ---------------------------------------------------------------------------
// BUG 2: pendingUrl fallback in reconciliation
// ---------------------------------------------------------------------------

describe('reconcileWithLiveTabs — pendingUrl fallback', () => {
  it('matches live tab by pendingUrl when url is empty', () => {
    const s = new ShadowState();
    s.addTab(100, makeTab({ tabId: 100, url: 'https://github.com', title: 'GitHub' }));
    const liveTabs = [
      makeLiveTab({ id: 501, url: '', pendingUrl: 'https://github.com', title: 'GitHub', index: 0 }),
    ];
    const { stats } = s.reconcileWithLiveTabs(liveTabs);
    assert.equal(stats.pass2, 1, 'should match via pendingUrl in pass 2');
    assert.ok(s.tabs.has(501), 'remapped tab should exist');
  });

  it('stores pendingUrl as url when url is empty during update pass', () => {
    const s = new ShadowState();
    const liveTabs = [
      makeLiveTab({ id: 1, url: '', pendingUrl: 'https://loading.com', title: 'Loading', index: 0 }),
    ];
    s.reconcileWithLiveTabs(liveTabs);
    assert.equal(s.tabs.get(1).url, 'https://loading.com');
  });
});

// ---------------------------------------------------------------------------
// BUG 1: Pass 3 uses preliminary windowIdMap
// ---------------------------------------------------------------------------

describe('reconcileWithLiveTabs — Pass 3 windowId mapping', () => {
  it('matches positionally in mapped window after restart', () => {
    const s = new ShadowState();
    s.addTab(100, makeTab({ tabId: 100, windowId: 100, url: 'https://github.com', title: 'GitHub', index: 0 }));
    s.addTab(200, makeTab({ tabId: 200, windowId: 100, url: 'https://google.com', title: 'Google', index: 1 }));
    s.addTab(300, makeTab({ tabId: 300, windowId: 100, url: 'chrome://newtab/', title: 'New Tab', index: 2 }));

    const liveTabs = [
      makeLiveTab({ id: 501, windowId: 500, url: 'https://github.com', title: 'GitHub', index: 0 }),
      makeLiveTab({ id: 502, windowId: 500, url: 'https://google.com', title: 'Google', index: 1 }),
      makeLiveTab({ id: 503, windowId: 500, url: 'chrome://newtab/', title: 'New Tab', index: 2 }),
    ];

    const { stats } = s.reconcileWithLiveTabs(liveTabs);
    assert.equal(stats.pass3, 1, 'Pass 3 should match generic tab via mapped window');
    assert.ok(s.tabs.has(503), 'generic tab should be matched');
  });
});

// ---------------------------------------------------------------------------
// Reconciliation hardening (RR-1, RR-2, RR-6, RR-8)
// ---------------------------------------------------------------------------

describe('reconcileWithLiveTabs — RR-1: same-URL tabs across windows keep their own subtree', () => {
  it('does not swap subtrees between duplicate-URL tabs in different windows', () => {
    const s = new ShadowState();
    // Window A: dashboard (tab 1) with child A (tab 10).
    s.addTab(1, makeTab({ tabId: 1, windowId: 100, url: 'https://dash.com', title: 'Dash', index: 0 }));
    s.addTab(10, makeTab({ tabId: 10, parentId: 1, windowId: 100, url: 'https://child-a.com', title: 'A', index: 1 }));
    // Window B: dashboard (tab 2) with child B (tab 20) — identical dashboard URL/title.
    s.addTab(2, makeTab({ tabId: 2, windowId: 200, url: 'https://dash.com', title: 'Dash', index: 0 }));
    s.addTab(20, makeTab({ tabId: 20, parentId: 2, windowId: 200, url: 'https://child-b.com', title: 'B', index: 1 }));

    // After restart: ids + windowIds reassigned. The window-B dashboard appears
    // FIRST in the live list, so a naive candidates[0] match would cross-attach.
    const liveTabs = [
      makeLiveTab({ id: 601, windowId: 600, url: 'https://dash.com', title: 'Dash', index: 0 }),
      makeLiveTab({ id: 620, windowId: 600, url: 'https://child-b.com', title: 'B', index: 1 }),
      makeLiveTab({ id: 510, windowId: 500, url: 'https://child-a.com', title: 'A', index: 1 }),
      makeLiveTab({ id: 501, windowId: 500, url: 'https://dash.com', title: 'Dash', index: 0 }),
    ];

    s.reconcileWithLiveTabs(liveTabs);

    assert.equal(s.getTab(510)?.parentId, 501, 'child A stays under its own window dashboard');
    assert.equal(s.getTab(620)?.parentId, 601, 'child B stays under its own window dashboard');
    assert.notEqual(s.getTab(510)?.parentId, 601, 'child A is NOT cross-attached to window B');
  });

  it('matches duplicate-URL tabs in the same window by index', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1, windowId: 100, url: 'https://dup.com', title: 'Dup', index: 0 }));
    s.addTab(2, makeTab({ tabId: 2, windowId: 100, url: 'https://dup.com', title: 'Dup', index: 3 }));
    const liveTabs = [
      makeLiveTab({ id: 51, windowId: 100, url: 'https://dup.com', title: 'Dup', index: 0 }),
      makeLiveTab({ id: 52, windowId: 100, url: 'https://dup.com', title: 'Dup', index: 3 }),
    ];
    s.reconcileWithLiveTabs(liveTabs);
    assert.ok(s.tabs.has(51) && s.tabs.has(52), 'both live tabs present');
    assert.ok(!s.tabs.has(1) && !s.tabs.has(2), 'saved ids remapped, not duplicated');
  });
});

// RR-2 was split for B-1 (durable lineage key): the anchored re-association
// pass adds a genuine new capability (RR-2a) on top of the pre-existing
// safety invariant (RR-2b, unchanged from before B-1).
describe('reconcileWithLiveTabs — RR-2a: anchored re-association (parent survives, child corroborated)', () => {
  it('re-attaches a corroborated child under its matched parent, even when the window map is not yet known when Pass 2b evaluates it', () => {
    const s = new ShadowState();
    // Parent (tab 1): title is globally unique among live tabs, but its URL
    // changes across restart, so neither Pass 1 (id changed) nor Pass 2 (URL
    // bucket miss) can match it — it only resolves in Pass 2b, by title.
    s.addTab(1, makeTab({
      tabId: 1, windowId: 100, url: 'https://photos.example/family-trip',
      title: 'Family Trip Photos 2024', index: 0,
    }));
    // Child (tab 5): its saved URL also changes across restart (no Pass 2
    // bucket hit), and its title ('Report') is shared by a decoy live tab in
    // an UNRELATED window. Because Pass 2b computes its window map ONCE
    // before its loop runs, and the parent match happens earlier IN THE SAME
    // loop, Pass 2b evaluates the child without yet knowing window 100 maps
    // to window 500 — so it sees a global, unresolved ambiguity ([511, 512])
    // and correctly refuses. Pass 3 also refuses it (RR-2: lineage-bearing).
    // Only the anchored pass — which looks up the parent's LIVE window
    // directly rather than through the vote-based map — can resolve it.
    s.addTab(5, makeTab({
      tabId: 5, parentId: 1, windowId: 100, url: 'https://docs.example/report-draft',
      title: 'Report', index: 1,
    }));

    const liveTabs = [
      // Parent's live tab: same title, different URL, window 500.
      makeLiveTab({ id: 550, windowId: 500, url: 'https://photos.example/family-trip?updated=1', title: 'Family Trip Photos 2024', index: 0 }),
      // Correct anchor-window candidate for the child.
      makeLiveTab({ id: 511, windowId: 500, url: 'https://docs.example/report-final', title: 'Report', index: 5 }),
      // Decoy: same title, wrong window — must NOT be chosen.
      makeLiveTab({ id: 512, windowId: 900, url: 'https://docs.example/other-report', title: 'Report', index: 9 }),
    ];

    const { stats, tabIdMap } = s.reconcileWithLiveTabs(liveTabs, { coldRestart: true });

    assert.equal(stats.pass1, 0, 'sanity: parent/child ids changed, Pass 1 does not fire');
    assert.equal(s.getTab(550)?.title, 'Family Trip Photos 2024', 'parent matched via Pass 2b');
    assert.equal(s.getTab(511)?.parentId, 550, 'child re-attaches under its matched parent');
    assert.equal(tabIdMap.get(5), 511, 'child (saved id 5) remapped to the correct in-window candidate');
    assert.equal(s.getTab(512)?.parentId, null, 'the wrong-window decoy remains an untouched root tab, not consumed as the child');
  });
});

describe('reconcileWithLiveTabs — RR-2b: lineage-bearing nodes are not positionally guessed', () => {
  it('re-roots a surviving child instead of attaching it to an unrelated nearby tab', () => {
    const s = new ShadowState();
    // Parent (tab 1) is generic (empty url/title) so it fails url+title matching; it has a real child (tab 5).
    s.addTab(1, makeTab({ tabId: 1, windowId: 100, url: '', title: '', index: 0 }));
    s.addTab(5, makeTab({ tabId: 5, parentId: 1, windowId: 100, url: 'https://kid.com', title: 'Kid', index: 1 }));

    // After restart: the parent DIED; the child survives (id 510); an UNRELATED tab
    // sits at index 0 in the same window — within Pass-3's ±3 positional tolerance.
    const liveTabs = [
      makeLiveTab({ id: 999, windowId: 500, url: 'https://unrelated.com', title: 'Unrelated', index: 0 }),
      makeLiveTab({ id: 510, windowId: 500, url: 'https://kid.com', title: 'Kid', index: 1 }),
    ];

    s.reconcileWithLiveTabs(liveTabs);

    assert.equal(s.getTab(510)?.parentId, null, 'surviving child is re-rooted, not mis-attached');
    assert.ok(!s.getTab(999)?.children.includes(510), 'unrelated tab did not adopt the orphan');
    assert.equal(s.getTab(1), null, 'dead parent removed');
  });
});

describe('reconcileWithLiveTabs — B-1: anchored pass refuses uncorroborated matches (coldRestart)', () => {
  it('does not graft an uncorroborated positionally-adjacent tab onto a matched parent', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({
      tabId: 1, windowId: 100, url: 'https://app.example/dashboard',
      title: 'Dashboard', index: 0,
    }));
    // Child has no usable url/title signal at all (fully generic).
    s.addTab(5, makeTab({
      tabId: 5, parentId: 1, windowId: 100, url: '', title: '', index: 1,
    }));

    const liveTabs = [
      // Parent matches cleanly via Pass 2 (unique URL match).
      makeLiveTab({ id: 601, windowId: 600, url: 'https://app.example/dashboard', title: 'Dashboard', index: 0 }),
      // The only other unmatched live tab in the parent's window — adjacent,
      // but carries no url/title relationship to the saved child whatsoever.
      makeLiveTab({ id: 602, windowId: 600, url: 'https://random.example/whatever', title: 'Something Unrelated', index: 1 }),
    ];

    s.reconcileWithLiveTabs(liveTabs, { coldRestart: true });

    assert.equal(s.getTab(5), null, 'the uncorroborated child is not silently kept under the wrong tab');
    assert.equal(s.getTab(602)?.parentId, null, 'unrelated adjacent live tab is not grafted as a child');
    assert.ok(!s.getTab(601)?.children.includes(602), 'parent does not adopt the uncorroborated adjacent tab');
  });
});

describe('reconcileWithLiveTabs — B-1: anchored pass is a no-op on warm wake (regression lock)', () => {
  it('leaves the RR-2a fixture unmatched when coldRestart is not passed', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({
      tabId: 1, windowId: 100, url: 'https://photos.example/family-trip',
      title: 'Family Trip Photos 2024', index: 0,
    }));
    s.addTab(5, makeTab({
      tabId: 5, parentId: 1, windowId: 100, url: 'https://docs.example/report-draft',
      title: 'Report', index: 1,
    }));

    const liveTabs = [
      makeLiveTab({ id: 550, windowId: 500, url: 'https://photos.example/family-trip?updated=1', title: 'Family Trip Photos 2024', index: 0 }),
      makeLiveTab({ id: 511, windowId: 500, url: 'https://docs.example/report-final', title: 'Report', index: 5 }),
      makeLiveTab({ id: 512, windowId: 900, url: 'https://docs.example/other-report', title: 'Report', index: 9 }),
    ];

    // No { coldRestart: true } — warm wake default.
    s.reconcileWithLiveTabs(liveTabs);

    assert.equal(s.getTab(5), null, 'child stays unmatched — the anchored pass never runs on warm wake');
    assert.equal(s.getTab(511)?.parentId, null, 'candidate tab is untouched, not grafted');
  });
});

describe('reconcileWithLiveTabs — B-1: anchored pass skips a cross-window child (Finding #2)', () => {
  it('does not anchor a child whose saved window differs from its parent (its true tab is elsewhere)', () => {
    const s = new ShadowState();
    // Parent saved in window 100; child parented but saved in a DIFFERENT
    // window 200 (dragged to another window pre-restart, keeping its parentId).
    s.addTab(1, makeTab({ tabId: 1, windowId: 100, url: 'https://p.example/home', title: 'ParentUnique', index: 0 }));
    s.addTab(5, makeTab({ tabId: 5, parentId: 1, windowId: 200, url: 'https://c.example/old', title: 'Report', index: 0 }));

    const liveTabs = [
      // Parent resolves via Pass 2b (title unique), lands in live window 500.
      makeLiveTab({ id: 550, windowId: 500, url: 'https://p.example/home2', title: 'ParentUnique', index: 0 }),
      // An UNRELATED 'Report' tab in the PARENT's window — the tempting wrong
      // graft the anchored pass must refuse for this cross-window child.
      makeLiveTab({ id: 511, windowId: 500, url: 'https://c.example/unrelated', title: 'Report', index: 1 }),
      // Decoy 'Report' in another window — makes the title globally ambiguous
      // so Pass 2b refuses the child (otherwise Pass 2b would match it directly
      // and the anchored pass — and this guard — would never engage).
      makeLiveTab({ id: 512, windowId: 900, url: 'https://c.example/decoy', title: 'Report', index: 9 }),
    ];

    s.reconcileWithLiveTabs(liveTabs, { coldRestart: true });

    assert.equal(s.getTab(5), null, 'cross-window child is not anchored — it is refused, then dead-swept');
    assert.equal(s.getTab(511)?.parentId, null, 'the parent-window Report tab stays an untouched root');
    assert.ok(!s.getTab(550)?.children.includes(511), 'parent did not adopt the unrelated same-title tab');
  });
});

describe('reconcileWithLiveTabs — B-1: anchored match requires same-origin for a url-changed child (Finding #3)', () => {
  it('anchors a same-origin url-changed child, but a cross-origin same-title candidate is not corroborated', () => {
    const s = new ShadowState();
    // Parent (title unique) resolves via Pass 2b to window 500. Child's url
    // changed but stays on the SAME origin (docs.example) with its title.
    s.addTab(1, makeTab({ tabId: 1, windowId: 100, url: 'https://p.example/home', title: 'ParentUnique', index: 0 }));
    s.addTab(5, makeTab({ tabId: 5, parentId: 1, windowId: 100, url: 'https://docs.example/report-draft', title: 'Report', index: 1 }));

    const liveTabs = [
      makeLiveTab({ id: 550, windowId: 500, url: 'https://p.example/home2', title: 'ParentUnique', index: 0 }),
      // Same-origin (docs.example) + same title, in the parent's window — the
      // correct anchored match for the url-changed child.
      makeLiveTab({ id: 511, windowId: 500, url: 'https://docs.example/report-final', title: 'Report', index: 5 }),
      // Same title but DIFFERENT origin, in another window — a decoy that makes
      // the title globally ambiguous (so Pass 2b refuses) and must never be
      // chosen: title alone across origins is not sufficient corroboration.
      makeLiveTab({ id: 512, windowId: 900, url: 'https://evil.example/report', title: 'Report', index: 9 }),
    ];

    s.reconcileWithLiveTabs(liveTabs, { coldRestart: true });

    assert.equal(s.getTab(511)?.parentId, 550, 'same-origin url-changed child anchored under its parent');
    assert.equal(s.getTab(512)?.parentId, null, 'the cross-origin same-title decoy is left an untouched root');
  });
});

describe('reconcileWithLiveTabs — RR-8: title matching is window-aware', () => {
  it('matches a renamed tab to its own window, not a same-title tab in another window', () => {
    const s = new ShadowState();
    // tab 1 (window 100): title 'Inbox', has a child (tab 5); its URL will change.
    s.addTab(1, makeTab({ tabId: 1, windowId: 100, url: 'https://app.com/old', title: 'Inbox', index: 0 }));
    s.addTab(5, makeTab({ tabId: 5, parentId: 1, windowId: 100, url: 'https://app.com/kid', title: 'Kid', index: 1 }));
    // tab 2 (window 200): also title 'Inbox', unrelated; its URL also changes.
    s.addTab(2, makeTab({ tabId: 2, windowId: 200, url: 'https://other.com/old', title: 'Inbox', index: 0 }));

    // The child anchors window 100->500; both 'Inbox' tabs changed URL (fail Pass 2)
    // and the window-600 Inbox appears first in the live list.
    const liveTabs = [
      makeLiveTab({ id: 601, windowId: 600, url: 'https://other.com/new', title: 'Inbox', index: 0 }),
      makeLiveTab({ id: 510, windowId: 500, url: 'https://app.com/kid', title: 'Kid', index: 1 }),
      makeLiveTab({ id: 501, windowId: 500, url: 'https://app.com/new', title: 'Inbox', index: 0 }),
    ];

    s.reconcileWithLiveTabs(liveTabs);

    assert.equal(s.getTab(510)?.parentId, 501, 'child stays under the window-500 Inbox');
    assert.notEqual(s.getTab(510)?.parentId, 601, 'child is NOT cross-attached to the window-600 Inbox');
  });
});

// ---------------------------------------------------------------------------
// B-2/F9: coldRestart — Pass 1 corroboration + windowId vote gating
// ---------------------------------------------------------------------------

describe('reconcileWithLiveTabs — coldRestart: Pass 1 requires corroboration', () => {
  it('does not graft a coincidental id collision into the tree or poison the windowId map', () => {
    const s = new ShadowState();
    // Saved node: id 42, window 100, distinct url/title.
    s.addTab(42, makeTab({
      tabId: 42, windowId: 100, url: 'https://mail.example/inbox',
      title: 'Inbox', index: 0,
    }));
    // A genuinely-matched anchor tab so the windowId vote machinery has a
    // real match to compare against (and to prove real votes still work).
    s.addTab(7, makeTab({
      tabId: 7, windowId: 100, url: 'https://mail.example/anchor',
      title: 'Anchor', index: 1,
    }));

    // Cold restart: Chrome reassigned ids. A totally unrelated live tab
    // now happens to hold id 42 in a DIFFERENT window, with unrelated
    // content (no url/title corroboration). The genuine anchor tab is
    // matched at a new id (107) in the same new window (500) via Pass 2
    // URL fingerprinting.
    const liveTabs = [
      makeLiveTab({ id: 42, windowId: 999, url: 'https://unrelated.example/x', title: 'Unrelated', index: 0 }),
      makeLiveTab({ id: 107, windowId: 500, url: 'https://mail.example/anchor', title: 'Anchor', index: 1 }),
    ];

    const { windowIdMap, stats } = s.reconcileWithLiveTabs(liveTabs, { coldRestart: true });

    assert.equal(stats.pass1, 0, 'coincidental id collision is not accepted by Pass 1 without corroboration');
    assert.notEqual(windowIdMap.get(100), 999, 'coincidental collision does not poison the windowId map');
    assert.equal(windowIdMap.get(100), 500, 'genuine match still produces the correct windowId vote');
  });
});

describe('reconcileWithLiveTabs — coldRestart: default (warm wake) is unchanged', () => {
  it('matches by id unconditionally when coldRestart is not passed (regression lock)', () => {
    const s = new ShadowState();
    s.addTab(42, makeTab({
      tabId: 42, windowId: 100, url: 'https://mail.example/inbox',
      title: 'Inbox', index: 0,
    }));
    s.addTab(7, makeTab({
      tabId: 7, windowId: 100, url: 'https://mail.example/anchor',
      title: 'Anchor', index: 1,
    }));

    const liveTabs = [
      makeLiveTab({ id: 42, windowId: 999, url: 'https://unrelated.example/x', title: 'Unrelated', index: 0 }),
      makeLiveTab({ id: 107, windowId: 500, url: 'https://mail.example/anchor', title: 'Anchor', index: 1 }),
    ];

    // No second argument — must match today's unconditional same-id Pass 1
    // match, including the (unrelated-but-still-current) vote outcome from
    // the id-42 collision. This is the byte-identical-on-warm-wake lock.
    const { windowIdMap, stats } = s.reconcileWithLiveTabs(liveTabs);

    assert.equal(stats.pass1, 1, 'default flag preserves unconditional same-id Pass 1 match');
    assert.equal(windowIdMap.get(100), 999, 'default flag preserves the unguarded vote outcome (regression lock)');
  });
});

// ---------------------------------------------------------------------------
// #6: cold-restart same-id collision stranding (sweep-only fix)
// ---------------------------------------------------------------------------

describe('reconcileWithLiveTabs — coldRestart #6: same-id collision must not wrong-graft', () => {
  it('sweeps the stranded child instead of grafting the unrelated tab under the parent (reincarnation present)', () => {
    const s = new ShadowState();
    // Saved parent + child. On cold restart Chrome reassigns ids, so the child's
    // saved id (42) coincidentally collides with an UNRELATED live tab; the child's
    // true reincarnation comes up under a different id (102).
    s.addTab(1, makeTab({ tabId: 1, windowId: 100, url: 'https://parent.example/home', title: 'Parent', index: 0 }));
    s.addTab(42, makeTab({ tabId: 42, parentId: 1, windowId: 100, url: 'https://child.example/page', title: 'Child', index: 1 }));

    const liveTabs = [
      makeLiveTab({ id: 1, windowId: 100, url: 'https://parent.example/home', title: 'Parent', index: 0 }),
      makeLiveTab({ id: 42, windowId: 100, url: 'https://unrelated.example/x', title: 'Unrelated', index: 2 }),
      makeLiveTab({ id: 102, windowId: 100, url: 'https://child.example/page', title: 'Child', index: 1 }),
    ];

    s.reconcileWithLiveTabs(liveTabs, { coldRestart: true });

    const unrelated = s.getTab(42);
    assert.ok(unrelated, 'the unrelated live tab exists as a node');
    assert.equal(unrelated.url, 'https://unrelated.example/x');
    assert.equal(unrelated.parentId, null, 'the unrelated tab is a ROOT, never grafted under the saved parent');

    const parent = s.getTab(1);
    assert.ok(parent, 'parent survived');
    const childUrls = parent.children.map((cid) => s.getTab(cid)?.url);
    assert.ok(!childUrls.includes('https://unrelated.example/x'), 'no wrong-graft: unrelated content is not a child of the parent');

    const trueChild = s.getTab(102);
    assert.ok(trueChild && trueChild.url === 'https://child.example/page', 'true child recovered as a node (re-rooted)');
  });

  it('sweeps the stranded child when its reincarnation is absent', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1, windowId: 100, url: 'https://parent.example/home', title: 'Parent', index: 0 }));
    s.addTab(42, makeTab({ tabId: 42, parentId: 1, windowId: 100, url: 'https://child.example/page', title: 'Child', index: 1 }));

    const liveTabs = [
      makeLiveTab({ id: 1, windowId: 100, url: 'https://parent.example/home', title: 'Parent', index: 0 }),
      makeLiveTab({ id: 42, windowId: 100, url: 'https://unrelated.example/x', title: 'Unrelated', index: 1 }),
    ];

    s.reconcileWithLiveTabs(liveTabs, { coldRestart: true });

    const parent = s.getTab(1);
    assert.equal(parent.children.length, 0, 'parent has no phantom child after the stranded child is swept');
    assert.equal(s.getTab(42).parentId, null, 'the unrelated tab is a clean root');
    assert.equal(s.getTab(42).url, 'https://unrelated.example/x');
  });

  // Regression locks: these pass on sweep-only and would go RED if #6 were ever
  // changed to re-map rejected nodes (the reproduced Q4/Q5b data-loss paths).
  it('does not starve a genuinely-unmatched node when another saved node is id-collided (Q4 lock)', () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      const s = new ShadowState();
      // A (id 42) collides with an unrelated live tab; A shares url/title with B.
      s.addTab(42, makeTab({ tabId: 42, windowId: 100, url: 'https://x.example/shared', title: 'Shared', index: 0 }));
      // B (id 1000): no live tab has this id — genuinely unmatched, must recover.
      s.addTab(1000, makeTab({ tabId: 1000, windowId: 100, url: 'https://x.example/shared', title: 'Shared', index: 5 }));

      const liveTabs = [
        makeLiveTab({ id: 42, windowId: 999, url: 'https://random.example/x', title: 'Random', index: 0 }),
        makeLiveTab({ id: 555, windowId: 100, url: 'https://x.example/shared', title: 'Shared', index: 1 }),
      ];

      const { tabIdMap } = s.reconcileWithLiveTabs(liveTabs, { coldRestart: true });

      assert.equal(tabIdMap.get(1000), 555, 'genuine node B recovered onto its live candidate (never starved)');
      assert.ok(!tabIdMap.has(42), 'the id-collided rejected node A is never remapped (sweep-only)');
      assert.ok(!warnings.some((w) => w.includes('replaceTabId collision')), 'no destructive replaceTabId collision');
    } finally {
      console.warn = origWarn;
    }
  });

  it('does not destroy lineage when two saved nodes collide on cold-restart ids (Q5b lock)', () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      const s = new ShadowState();
      // Grandparent with a pinned child C (saved id 1000).
      s.addTab(9, makeTab({ tabId: 9, windowId: 100, url: 'https://gp.example/home', title: 'GP', index: 0 }));
      s.addTab(1000, makeTab({ tabId: 1000, parentId: 9, pinned: true, windowId: 100, url: 'https://c-true.example/y', title: 'C-True', index: 1 }));
      // A (saved id 42) collides with an unrelated live tab; A's TRUE reincarnation is
      // live id 1000 — coincidentally the same id C is saved under.
      s.addTab(42, makeTab({ tabId: 42, windowId: 100, url: 'https://a-true.example/x', title: 'A-True', index: 2 }));

      const liveTabs = [
        makeLiveTab({ id: 9, windowId: 100, url: 'https://gp.example/home', title: 'GP', index: 0 }),
        makeLiveTab({ id: 42, windowId: 999, url: 'https://random.example/z', title: 'Random', index: 0 }),
        makeLiveTab({ id: 1000, windowId: 100, url: 'https://a-true.example/x', title: 'A-True', index: 1 }),
        makeLiveTab({ id: 2000, windowId: 100, url: 'https://c-true.example/y', title: 'C-True', index: 2 }),
      ];

      const { tabIdMap } = s.reconcileWithLiveTabs(liveTabs, { coldRestart: true });

      assert.ok(!warnings.some((w) => w.includes('replaceTabId collision')), 'no destructive replaceTabId collision guard fired');
      for (const [, node] of s.tabs) {
        if (node.parentId != null) {
          assert.ok(s.tabs.has(node.parentId), 'no dangling parentId (no corrupted lineage)');
        }
      }
      assert.ok(tabIdMap.get(1000) !== 2000, 'no false lineage-losing remap recorded for C');
    } finally {
      console.warn = origWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// #7: Pass 2b title match must be same-origin
// ---------------------------------------------------------------------------

describe('reconcileWithLiveTabs — #7: Pass 2b title match must be same-origin', () => {
  it('does not graft a url-changed CHILD onto a same-title CROSS-ORIGIN live tab', () => {
    const s = new ShadowState();
    // Parent + child. The child's url changed since save; a live tab shares the
    // child's TITLE but is a different origin. Pass 2b must refuse — grafting the
    // child's lineage onto a cross-origin tab is the bug (Codex #3). A lineage-
    // bearing node is refused by Pass 3 too (RR-2b), so it falls to dead-sweep.
    // (A lineage-FREE leaf is intentionally still recoverable by Pass 3 positional
    // matching — that carries no lineage, so it is out of scope for #7.)
    s.addTab(1, makeTab({ tabId: 1, windowId: 1, url: 'https://parent.example/home', title: 'Parent', index: 0 }));
    s.addTab(200, makeTab({ tabId: 200, parentId: 1, windowId: 1, url: 'https://docs.example/report-draft', title: 'Report', index: 1 }));

    const liveTabs = [
      makeLiveTab({ id: 1, windowId: 1, url: 'https://parent.example/home', title: 'Parent', index: 0 }),
      makeLiveTab({ id: 502, windowId: 1, url: 'https://evil.example/report', title: 'Report', index: 1 }),
    ];

    const { tabIdMap, stats } = s.reconcileWithLiveTabs(liveTabs);

    assert.ok(!tabIdMap.has(200), 'the child is NOT remapped onto the cross-origin live tab');
    assert.equal(stats.pass2b, 0, 'Pass 2b did not fire for the cross-origin title match');
    const crossOrigin = s.getTab(502);
    assert.ok(crossOrigin, 'the cross-origin live tab exists as its own node');
    assert.equal(crossOrigin.parentId, null, 'cross-origin tab is a root, not grafted under the saved parent');
    assert.equal(crossOrigin.url, 'https://evil.example/report');
  });

  it('still matches a same-origin different-path url change (SPA/redirect recovery not over-refused)', () => {
    const s = new ShadowState();
    s.addTab(200, makeTab({ tabId: 200, windowId: 1, url: 'https://app.example/old', title: 'Inbox', index: 0 }));

    const liveTabs = [
      makeLiveTab({ id: 502, windowId: 1, url: 'https://app.example/new', title: 'Inbox', index: 0 }),
    ];

    const { tabIdMap, stats } = s.reconcileWithLiveTabs(liveTabs);

    assert.equal(tabIdMap.get(200), 502, 'same-origin path change recovered via Pass 2b');
    assert.equal(stats.pass2b, 1, 'Pass 2b fired for the same-origin title match');
  });
});

// ---------------------------------------------------------------------------
// Tree-integrity hardening (TI-1, TI-2, TI-3)
// ---------------------------------------------------------------------------

function serializedNode(over = {}) {
  return {
    tabId: 1, parentId: null, children: [], title: 'T', url: 'u', favIconUrl: '',
    pinned: false, audible: false, status: 'complete', groupId: -1, index: 0, windowId: 1,
    ...over,
  };
}

describe('fromStorage — validate/repair (TI-2)', () => {
  it('repairs a persisted parent/child cycle so walks terminate', () => {
    const data = {
      tabs: {
        1: serializedNode({ tabId: 1, parentId: null, children: [2], index: 0 }),
        2: serializedNode({ tabId: 2, parentId: 1, children: [1], index: 1 }),
      },
      rootIds: [1],
      collapsed: [],
    };
    const s = ShadowState.fromStorage(data);
    const visible = s.getVisibleTabs(); // must terminate, not stack-overflow
    assert.ok(visible.length >= 1 && visible.length <= 2, 'walk terminates with finite result');
    assert.ok(s.getDescendants(1).length <= 1, 'descendants finite');
  });

  it('drops a dangling child reference', () => {
    const data = {
      tabs: {
        1: serializedNode({ tabId: 1, children: [2, 99] }),
        2: serializedNode({ tabId: 2, parentId: 1, index: 1 }),
      },
      rootIds: [1],
      collapsed: [],
    };
    const s = ShadowState.fromStorage(data);
    assert.deepEqual(s.getTab(1).children, [2], 'dangling child 99 removed');
  });

  it('preserves a valid tree unchanged (rootIds order + parent links)', () => {
    const data = {
      tabs: {
        1: serializedNode({ tabId: 1, children: [2], index: 0 }),
        2: serializedNode({ tabId: 2, parentId: 1, index: 1 }),
        3: serializedNode({ tabId: 3, index: 2 }),
      },
      rootIds: [1, 3],
      collapsed: [2],
    };
    const s = ShadowState.fromStorage(data);
    assert.deepEqual(s.rootIds, [1, 3], 'rootIds preserved');
    assert.equal(s.getTab(2).parentId, 1, 'parent link preserved');
    assert.deepEqual(s.getTab(1).children, [2], 'children preserved');
    assert.ok(s.isCollapsed(2), 'collapsed state preserved');
  });
});

describe('getVisibleTabs / getDescendants — cycle guard (TI-2)', () => {
  it('does not infinite-loop on an in-memory cycle', () => {
    const s = new ShadowState();
    s.tabs.set(1, serializedNode({ tabId: 1, children: [2] }));
    s.tabs.set(2, serializedNode({ tabId: 2, parentId: 1, children: [1], index: 1 }));
    s.rootIds = [1];
    assert.ok(s.getVisibleTabs().length <= 2, 'getVisibleTabs terminates');
    assert.ok(s.getDescendants(1).length <= 2, 'getDescendants terminates');
  });
});

describe('replaceTabId — self-rename guard (TI-1)', () => {
  it('is a no-op when oldId === newId', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1 }));
    s.addTab(2, makeTab({ tabId: 2, parentId: 1 }));
    s.replaceTabId(1, 1);
    assert.ok(s.tabs.has(1), 'tab 1 still present');
    assert.deepEqual(s.getTab(1).children, [2], 'children intact');
    assert.equal(s.getTab(2).parentId, 1, 'child link intact');
  });
});

describe('removeGroup — prunes groupColors (TI-3)', () => {
  it('deletes the color override when a group is removed', () => {
    const s = new ShadowState();
    s.addGroup({ id: 5, title: 'Dev', color: 'blue', collapsed: false, windowId: 1 });
    s.setGroupColor(5, '#ff0000');
    assert.equal(s.groupColors[5], '#ff0000');
    s.removeGroup(5);
    assert.ok(!(5 in s.groupColors), 'groupColors entry pruned on removeGroup');
  });
});

describe('reconcileWithLiveGroups — color-only title rescue (RR-5)', () => {
  it('does NOT paste a color-only title when multiple same-color orphans are ambiguous', () => {
    const s = new ShadowState();
    // Two orphaned grey groups (ids 1,2 absent from live), both titled.
    s.groups.set(1, { id: 1, title: 'Research', color: 'grey', collapsed: false, windowId: 10 });
    s.groups.set(2, { id: 2, title: 'Work', color: 'grey', collapsed: false, windowId: 20 });
    // Two new live grey groups with empty titles; precise tiers won't match.
    const liveGroups = [
      { id: 50, title: '', color: 'grey', collapsed: false, windowId: 500 },
      { id: 60, title: '', color: 'grey', collapsed: false, windowId: 600 },
    ];
    s.reconcileWithLiveGroups(liveGroups, new Map(), new Map());
    assert.equal(s.groups.get(50).title, '', 'ambiguous color-only rescue refused');
    assert.equal(s.groups.get(60).title, '', 'ambiguous color-only rescue refused');
  });

  it('DOES rescue a color-only title when exactly one same-color orphan exists', () => {
    const s = new ShadowState();
    s.groups.set(1, { id: 1, title: 'Research', color: 'blue', collapsed: false, windowId: 10 });
    const liveGroups = [
      { id: 50, title: '', color: 'blue', collapsed: false, windowId: 500 },
    ];
    s.reconcileWithLiveGroups(liveGroups, new Map(), new Map());
    assert.equal(s.groups.get(50).title, 'Research', 'unambiguous color-only rescue applies');
  });
});

describe('reconcileWithLiveGroups — orphaned titled groups are quarantined, not destroyed (RR-9)', () => {
  it('quarantines orphaned titled groups with rawWindowId/count/colorOverride; untitled orphans still deleted', () => {
    const s = new ShadowState();
    s.groups.set(1, { id: 1, title: 'Research', color: 'blue', collapsed: false, windowId: 10 });
    s.setGroupColor(1, '#123456');
    s.groups.set(2, { id: 2, title: '', color: 'grey', collapsed: false, windowId: 10 });

    s.reconcileWithLiveGroups([], new Map([[1, 3]]), new Map(), 1000);

    assert.ok(!s.groups.has(1), 'orphaned titled group removed from live groups');
    assert.ok(!s.groups.has(2), 'untitled orphan removed too');
    assert.ok(!(1 in s.groupColors), 'live color override removed');
    assert.ok(s.orphanedGroups.has(1), 'titled orphan quarantined');
    assert.ok(!s.orphanedGroups.has(2), 'untitled orphan NOT quarantined — nothing to rescue');

    const entry = s.orphanedGroups.get(1);
    assert.equal(entry.title, 'Research');
    assert.equal(entry.color, 'blue');
    assert.equal(entry.rawWindowId, 10);
    assert.equal(entry.count, 3);
    assert.equal(entry.colorOverride, '#123456');
    assert.equal(entry.orphanedAt, 1000);
  });

  it('rescues a quarantined title onto a new-id live group and remaps the color override', () => {
    const s = new ShadowState();
    s.groups.set(1, { id: 1, title: 'Research', color: 'blue', collapsed: false, windowId: 10 });
    s.setGroupColor(1, '#123456');
    s.reconcileWithLiveGroups([], new Map([[1, 2]]), new Map(), 1000);

    const liveGroups = [{ id: 99, title: '', color: 'blue', collapsed: false, windowId: 10 }];
    s.reconcileWithLiveGroups(liveGroups, new Map(), new Map(), 2000);

    assert.equal(s.groups.get(99).title, 'Research', 'title rescued onto new id');
    assert.equal(s.groupColors[99], '#123456', 'color override remapped to new id');
    assert.equal(s.orphanedGroups.size, 0, 'quarantine emptied after rescue');
  });

  it('A-2: rescues a quarantined colorOverride onto a new-id live group when Chrome preserved the title', () => {
    const s = new ShadowState();
    s.groups.set(1, { id: 1, title: 'Research', color: 'blue', collapsed: false, windowId: 10 });
    s.setGroupColor(1, '#123456');
    s.reconcileWithLiveGroups([], new Map([[1, 2]]), new Map(), 1000);
    assert.ok(s.orphanedGroups.has(1));

    // Chrome kept the TITLE alive under a brand-new id — this hits the
    // titled branch (existing untouched, group.title truthy), not the
    // untitled rescue tier.
    const liveGroups = [{ id: 99, title: 'Research', color: 'blue', collapsed: false, windowId: 10 }];
    s.reconcileWithLiveGroups(liveGroups, new Map(), new Map(), 2000);

    assert.equal(s.groups.get(99).title, 'Research', 'title came from Chrome, unaffected');
    assert.equal(s.groupColors[99], '#123456', 'custom colorOverride rescued onto the new id');
    assert.equal(s.orphanedGroups.size, 0, 'quarantine entry consumed, not left to expire at TTL');
  });

  it('A-2: does not rescue a colorOverride when title matches but color does not (A-3 collision guard)', () => {
    const s = new ShadowState();
    s.groups.set(1, { id: 1, title: 'Research', color: 'blue', collapsed: false, windowId: 10 });
    s.setGroupColor(1, '#123456');
    s.reconcileWithLiveGroups([], new Map([[1, 2]]), new Map(), 1000);

    const liveGroups = [{ id: 99, title: 'Research', color: 'red', collapsed: false, windowId: 10 }];
    s.reconcileWithLiveGroups(liveGroups, new Map(), new Map(), 2000);

    assert.ok(!(99 in s.groupColors), 'no colorOverride applied on color mismatch');
    assert.ok(s.orphanedGroups.size >= 1, 'quarantine entry survives (not consumed on non-match)');
  });

  it('prunes quarantine entries older than the TTL', () => {
    const s = new ShadowState();
    s.groups.set(1, { id: 1, title: 'Research', color: 'blue', collapsed: false, windowId: 10 });
    s.reconcileWithLiveGroups([], new Map(), new Map(), 1000);
    assert.ok(s.orphanedGroups.has(1), 'quarantined at t=1000');

    s.reconcileWithLiveGroups([], new Map(), new Map(), 1000 + ORPHANED_GROUP_TTL_MS + 1);
    assert.ok(!s.orphanedGroups.has(1), 'expired entry pruned on next reconcile');
  });

  it('round-trips orphanedGroups through toSerializable/fromStorage', () => {
    const s = new ShadowState();
    s.groups.set(1, { id: 1, title: 'Research', color: 'blue', collapsed: false, windowId: 10 });
    s.setGroupColor(1, '#123456');
    s.reconcileWithLiveGroups([], new Map([[1, 2]]), new Map(), 1000);

    const data = s.toSerializable();
    const restored = ShadowState.fromStorage(data);

    assert.ok(restored.orphanedGroups instanceof Map);
    assert.equal(restored.orphanedGroups.size, 1);
    const entry = restored.orphanedGroups.get(1);
    assert.equal(entry.title, 'Research');
    assert.equal(entry.rawWindowId, 10);
    assert.equal(entry.count, 2);
    assert.equal(entry.colorOverride, '#123456');
    assert.equal(entry.orphanedAt, 1000);
  });

  it('normalizes surviving quarantine window ids through windowIdMap so the map-less sweep still matches (A-4)', () => {
    const s = new ShadowState();
    // Two same-color titled groups in DIFFERENT windows, orphaned pre-restart.
    s.groups.set(1, { id: 1, title: 'Research', color: 'blue', collapsed: false, windowId: 10 });
    s.groups.set(2, { id: 2, title: 'Docs', color: 'blue', collapsed: false, windowId: 20 });
    s.reconcileWithLiveGroups([], new Map([[1, 1], [2, 1]]), new Map(), 1000);
    assert.equal(s.orphanedGroups.size, 2, 'both same-color titled groups quarantined');

    // Restart reconcile: windows 10/20 came back with new ids 110/120.
    s.reconcileWithLiveGroups([], new Map(), new Map([[10, 110], [20, 120]]), 2000);
    assert.equal(s.orphanedGroups.get(1).rawWindowId, 110, 'orphan 1 window normalized to current id');
    assert.equal(s.orphanedGroups.get(2).rawWindowId, 120, 'orphan 2 window normalized to current id');

    // The later MAP-LESS sweep: an untitled live group reappears in window 110.
    // Without normalization both orphans keep stale windows (10/20), neither
    // matches window 110, and the color-only tier refuses (2 same-color) —
    // rescuing nothing. With normalization the window match fires correctly.
    s.addGroup({ id: 99, title: '', color: 'blue', collapsed: false, windowId: 110 });
    s.addTab(500, { tabId: 500, title: 't', windowId: 110, groupId: 99 });
    const rescued = s.rescueUntitledLiveGroup({ id: 99, color: 'blue', windowId: 110 }, 3000);

    assert.equal(rescued, 'Research', 'sweep matched the RIGHT same-color orphan by its normalized window');
    assert.equal(s.groups.get(99).title, 'Research');
    assert.ok(!s.orphanedGroups.has(1), 'matched orphan removed from quarantine');
    assert.ok(s.orphanedGroups.has(2), 'the other same-color orphan is untouched');
  });

  it('evicts the oldest quarantine entries once the cap is exceeded, always warning', () => {
    const s = new ShadowState();
    for (let i = 1; i <= ORPHANED_GROUP_CAP + 1; i++) {
      s.groups.set(i, { id: i, title: `Group ${i}`, color: 'blue', collapsed: false, windowId: 10 });
    }
    const originalWarn = console.warn;
    const warnCalls = [];
    console.warn = (...args) => warnCalls.push(args);
    try {
      s.reconcileWithLiveGroups([], new Map(), new Map(), 1000);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(s.orphanedGroups.size, ORPHANED_GROUP_CAP, 'capped at ORPHANED_GROUP_CAP');
    assert.ok(!s.orphanedGroups.has(1), 'oldest entry evicted');
    assert.ok(s.orphanedGroups.has(ORPHANED_GROUP_CAP + 1), 'newest entry retained');
    assert.ok(warnCalls.length >= 1, 'eviction warns, never silent');
  });
});

describe('reconcileWithLiveGroups — gated resurrection (RR-9)', () => {
  it('restores a quarantined entry onto a live group with the same id when title empty, color matches, window maps', () => {
    const s = new ShadowState();
    s.groups.set(7, { id: 7, title: 'Research', color: 'blue', collapsed: true, windowId: 10 });
    s.setGroupColor(7, '#123456');
    s.reconcileWithLiveGroups([], new Map(), new Map(), 1000);
    assert.ok(s.orphanedGroups.has(7));

    const liveGroups = [{ id: 7, title: '', color: 'blue', collapsed: false, windowId: 10 }];
    s.reconcileWithLiveGroups(liveGroups, new Map(), new Map(), 2000);

    assert.equal(s.groups.get(7).title, 'Research', 'title restored');
    assert.equal(s.groupColors[7], '#123456', 'color override restored');
    assert.ok(!s.orphanedGroups.has(7), 'quarantine entry consumed');
  });

  it('does NOT resurrect when the live group with the same id has a different color', () => {
    const s = new ShadowState();
    s.groups.set(7, { id: 7, title: 'Research', color: 'blue', collapsed: false, windowId: 10 });
    s.setGroupColor(7, '#123456');
    s.reconcileWithLiveGroups([], new Map(), new Map(), 1000);

    const liveGroups = [{ id: 7, title: '', color: 'red', collapsed: false, windowId: 10 }];
    s.reconcileWithLiveGroups(liveGroups, new Map(), new Map(), 2000);

    assert.equal(s.groups.get(7).title, '', 'title NOT restored on color mismatch');
    assert.ok(!(7 in s.groupColors), 'no color override applied on mismatch');

    const survivors = [...s.orphanedGroups.values()].filter((e) => e.title === 'Research');
    assert.equal(survivors.length, 1, 'quarantine entry survives, re-keyed, for normal tier matching');
    assert.ok(!s.orphanedGroups.has(7), 'old id key freed for the live group');
  });
});

describe('reconcileWithLiveGroups — negative-key collision guard (A-7)', () => {
  it('does not overwrite a pre-existing negative-keyed quarantine entry on a later gated-resurrection requeue', () => {
    const s = new ShadowState();
    // Simulates a quarantine entry already re-keyed to -1 by a PRIOR call
    // (or carried over via persisted/deserialized state) before this call.
    s.orphanedGroups.set(-1, { id: -1, title: 'PriorRequeue', color: 'grey', collapsed: false, rawWindowId: 1, count: 1, colorOverride: undefined, orphanedAt: Date.now() - 1000 });
    // A group still quarantined at its original (positive) id.
    s.orphanedGroups.set(5, { id: 5, title: 'ThisRequeue', color: 'red', collapsed: false, rawWindowId: 1, count: 1, colorOverride: undefined, orphanedAt: Date.now() - 1000 });

    // Chrome reuses id 5 for an unrelated live group -> gated resurrection
    // mismatches (title present, color differs) -> requeue.
    const liveGroups = [{ id: 5, title: 'Unrelated Live Group', color: 'green', collapsed: false, windowId: 1 }];
    s.reconcileWithLiveGroups(liveGroups, new Map(), new Map(), Date.now());

    const titles = [...s.orphanedGroups.values()].map((e) => e.title);
    assert.ok(titles.includes('PriorRequeue'), 'pre-existing negative-keyed entry survives, not overwritten');
    assert.ok(titles.includes('ThisRequeue'), 'newly re-keyed entry is also present at a distinct key');
  });

  it('cross-instance union (reconcileRetryGroups) preserves retryState\'s own accumulated quarantine entries alongside liveState\'s', async () => {
    const { reconcileRetryGroups } = await import('../background/context.js');

    const retryState = new ShadowState();
    // retryState already has two previously re-keyed entries plus one group
    // still quarantined at its original id, about to fail resurrection.
    retryState.orphanedGroups.set(-1, { id: -1, title: 'RetryEarlier1', color: 'grey', collapsed: false, rawWindowId: 1, count: 1, colorOverride: undefined, orphanedAt: Date.now() - 1000 });
    retryState.orphanedGroups.set(-2, { id: -2, title: 'RetryEarlier2', color: 'grey', collapsed: false, rawWindowId: 1, count: 1, colorOverride: undefined, orphanedAt: Date.now() - 900 });
    retryState.orphanedGroups.set(5, { id: 5, title: 'RetryOrphan5', color: 'red', collapsed: false, rawWindowId: 1, count: 1, colorOverride: undefined, orphanedAt: Date.now() - 800 });

    const liveState = new ShadowState();
    liveState.orphanedGroups.set(-1, { id: -1, title: 'LiveOnly', color: 'purple', collapsed: false, rawWindowId: 1, count: 1, colorOverride: undefined, orphanedAt: Date.now() - 700 });

    // Chrome reuses id 5 for an unrelated live group -> retryState's own
    // gated resurrection mismatches and requeues it during its own reconcile.
    const retryGroups = [{ id: 5, title: 'Unrelated Live Group', color: 'green', collapsed: false, windowId: 1 }];

    reconcileRetryGroups(retryState, retryGroups, new Map(), new Map(), liveState);

    const titles = [...retryState.orphanedGroups.values()].map((e) => e.title);
    assert.ok(titles.includes('RetryEarlier2'), 'retryState\'s own earlier quarantine entry survives the fresh requeue + union');
    assert.ok(titles.includes('RetryOrphan5'), 'freshly requeued entry (seeded below retryState\'s own min) survives the union');
    assert.ok(titles.includes('LiveOnly'), 'liveState\'s own entry merged in');
  });
});

describe('rescueUntitledLiveGroup (RR-9)', () => {
  it('rescues via the exact count tier', () => {
    const s = new ShadowState();
    s.groups.set(1, { id: 1, title: 'Research', color: 'blue', collapsed: false, windowId: 10 });
    s.reconcileWithLiveGroups([], new Map([[1, 2]]), new Map(), 1000);

    s.addGroup({ id: 99, title: '', color: 'blue', collapsed: false, windowId: 10 });
    s.addTab(101, makeTab({ tabId: 101, groupId: 99 }));
    s.addTab(102, makeTab({ tabId: 102, groupId: 99 }));

    const title = s.rescueUntitledLiveGroup({ id: 99, color: 'blue', windowId: 10 }, 2000);
    assert.equal(title, 'Research');
    assert.equal(s.groups.get(99).title, 'Research');
    assert.ok(!s.orphanedGroups.has(1));
  });

  it('falls back to the color:windowId tier when member counts differ', () => {
    const s = new ShadowState();
    s.groups.set(1, { id: 1, title: 'Research', color: 'blue', collapsed: false, windowId: 10 });
    s.reconcileWithLiveGroups([], new Map([[1, 5]]), new Map(), 1000);

    s.addGroup({ id: 99, title: '', color: 'blue', collapsed: false, windowId: 10 });
    s.addTab(101, makeTab({ tabId: 101, groupId: 99 }));

    const title = s.rescueUntitledLiveGroup({ id: 99, color: 'blue', windowId: 10 }, 2000);
    assert.equal(title, 'Research');
  });

  it('refuses a color-only rescue when two same-color orphans are ambiguous (RR-5)', () => {
    const s = new ShadowState();
    s.groups.set(1, { id: 1, title: 'Research', color: 'grey', collapsed: false, windowId: 10 });
    s.groups.set(2, { id: 2, title: 'Work', color: 'grey', collapsed: false, windowId: 20 });
    s.reconcileWithLiveGroups([], new Map(), new Map(), 1000);

    s.addGroup({ id: 99, title: '', color: 'grey', collapsed: false, windowId: 999 });
    s.addTab(101, makeTab({ tabId: 101, groupId: 99 }));

    const title = s.rescueUntitledLiveGroup({ id: 99, color: 'grey', windowId: 999 }, 2000);
    assert.equal(title, null, 'ambiguous color-only rescue refused');
  });

  it('returns null for a zero-member group (membership-stable guard)', () => {
    const s = new ShadowState();
    s.groups.set(1, { id: 1, title: 'Research', color: 'blue', collapsed: false, windowId: 10 });
    s.reconcileWithLiveGroups([], new Map(), new Map(), 1000);

    s.addGroup({ id: 99, title: '', color: 'blue', collapsed: false, windowId: 10 });

    const title = s.rescueUntitledLiveGroup({ id: 99, color: 'blue', windowId: 10 }, 2000);
    assert.equal(title, null);
    assert.ok(s.orphanedGroups.has(1), 'entry untouched — no match attempted');
  });

  it('never rescues from an expired quarantine entry', () => {
    const s = new ShadowState();
    s.groups.set(1, { id: 1, title: 'Research', color: 'blue', collapsed: false, windowId: 10 });
    s.reconcileWithLiveGroups([], new Map(), new Map(), 1000);

    s.addGroup({ id: 99, title: '', color: 'blue', collapsed: false, windowId: 10 });
    s.addTab(101, makeTab({ tabId: 101, groupId: 99 }));

    const title = s.rescueUntitledLiveGroup(
      { id: 99, color: 'blue', windowId: 10 },
      1000 + ORPHANED_GROUP_TTL_MS + 1
    );
    assert.equal(title, null);
  });
});

describe('reconcileWithLiveGroups — windowId re-mapping is fresh per reconcile (RR-9 / A2)', () => {
  it('re-maps rawWindowId through a fresh windowIdMap on every call', () => {
    const s = new ShadowState();
    s.groups.set(1, { id: 1, title: 'Research', color: 'blue', collapsed: false, windowId: 10 });
    s.reconcileWithLiveGroups([], new Map(), new Map(), 1000);

    const liveGroups = [{ id: 99, title: '', color: 'blue', collapsed: false, windowId: 200 }];
    const windowIdMap = new Map([[10, 200]]);
    s.reconcileWithLiveGroups(liveGroups, new Map(), windowIdMap, 2000);

    assert.equal(s.groups.get(99).title, 'Research', 'matched via color:wid tier using freshly-mapped windowId');
  });
});

describe('updateGroup — windowId persistence (RR-11)', () => {
  it('applies windowId from changes when present', () => {
    const s = new ShadowState();
    s.addGroup({ id: 5, title: 'Dev', color: 'blue', collapsed: false, windowId: 1 });
    s.updateGroup(5, { windowId: 42 });
    assert.equal(s.groups.get(5).windowId, 42);
  });

  it('leaves windowId untouched when not present in changes', () => {
    const s = new ShadowState();
    s.addGroup({ id: 5, title: 'Dev', color: 'blue', collapsed: false, windowId: 1 });
    s.updateGroup(5, { title: 'Renamed' });
    assert.equal(s.groups.get(5).windowId, 1);
  });
});

describe('reconcileWithLiveTabs — favicon trust gate (RR-12)', () => {
  it('preserves a saved favicon when the live icon is empty and the URL is unchanged', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ favIconUrl: 'https://example.com/saved.ico' }));

    s.reconcileWithLiveTabs([makeLiveTab({ url: 'https://example.com', favIconUrl: '' })]);

    assert.equal(s.tabs.get(1).favIconUrl, 'https://example.com/saved.ico');
  });

  it('clears a saved favicon when the live icon is empty and the effective URL changed', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ favIconUrl: 'https://example.com/saved.ico' }));

    s.reconcileWithLiveTabs([makeLiveTab({ url: '', pendingUrl: 'https://other.test', favIconUrl: '' })]);

    assert.equal(s.tabs.get(1).url, 'https://other.test');
    assert.equal(s.tabs.get(1).favIconUrl, '');
  });

  it('uses a non-empty live favicon even when the URL is unchanged', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ favIconUrl: 'https://example.com/saved.ico' }));

    s.reconcileWithLiveTabs([makeLiveTab({
      url: 'https://example.com',
      favIconUrl: 'https://example.com/live.ico',
    })]);

    assert.equal(s.tabs.get(1).favIconUrl, 'https://example.com/live.ico');
  });
});
