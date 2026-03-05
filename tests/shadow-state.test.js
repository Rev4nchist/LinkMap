import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ShadowState } from '../shared/shadow-state.js';

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

  it('initializes with default theme "midnight"', () => {
    const s = new ShadowState();
    assert.equal(s.theme, 'midnight');
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

    // rootIds should be ordered by index: 20 (idx 0), 30 (idx 1), 10 (idx 2)
    assert.deepEqual(s2.rootIds, [20, 30, 10]);
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
