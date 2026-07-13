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
    assert.equal(data.version, 1);
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

  it('handles ungrouped tabs (groupId = -1) as their own group', () => {
    const s = new ShadowState();
    s.addTab(1, makeTab({ tabId: 1, groupId: -1 }));
    s.addTab(2, makeTab({ tabId: 2, groupId: 5 }));
    s.addTab(3, makeTab({ tabId: 3, groupId: -1 }));
    s.addTab(4, makeTab({ tabId: 4, groupId: 5 }));

    s.enforceGroupContiguity();

    // Ungrouped first (tab 1 appeared first), then group 5
    assert.deepEqual(s.rootIds, [1, 3, 2, 4]);
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

describe('reconcileWithLiveTabs — RR-2: lineage-bearing nodes are not positionally guessed', () => {
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
