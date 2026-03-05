/**
 * ShadowState — the core tree data structure for LinkMap.
 *
 * Owned by the background service worker. The side panel receives
 * serialized snapshots and never mutates state directly.
 *
 * Tree nodes (TabNode) are stored in a flat Map keyed by tabId.
 * Parent-child relationships are maintained via parentId / children[].
 */

import { STORAGE_VERSION, DEFAULT_THEME, UNGROUPED_GROUP_ID } from './constants.js';

// Properties that may be updated via updateTab().
const MUTABLE_PROPS = [
  'title', 'url', 'favIconUrl', 'pinned', 'audible', 'muted',
  'status', 'groupId', 'index', 'windowId',
];

/**
 * Creates a well-formed TabNode from partial input data.
 * Ensures every expected property exists and children is always an array.
 *
 * @param {number} tabId
 * @param {Object} data - Partial node data.
 * @returns {Object} A complete TabNode.
 */
function createNode(tabId, data) {
  return {
    tabId,
    parentId:   data.parentId ?? null,
    children:   [],
    title:      data.title ?? '',
    url:        data.url ?? '',
    favIconUrl: data.favIconUrl ?? '',
    pinned:     data.pinned ?? false,
    audible:    data.audible ?? false,
    muted:      data.muted ?? false,
    status:     data.status ?? 'complete',
    groupId:    data.groupId ?? UNGROUPED_GROUP_ID,
    index:      data.index ?? 0,
    windowId:   data.windowId ?? 0,
  };
}

export class ShadowState {
  constructor() {
    /** @type {Map<number, Object>} tabId -> TabNode */
    this.tabs = new Map();

    /** @type {number[]} Ordered root-level tab IDs */
    this.rootIds = [];

    /** @type {Set<number>} Tab IDs whose subtrees are collapsed in the UI */
    this.collapsed = new Set();

    /** @type {Map<number, Object>} groupId -> { id, title, color, collapsed, windowId } */
    this.groups = new Map();

    /** @type {Object<number, string>} groupId -> hex color (manual overrides) */
    this.groupColors = {};

    /** @type {string} Active theme name */
    this.theme = DEFAULT_THEME;
  }

  // -----------------------------------------------------------------------
  // Core Mutations
  // -----------------------------------------------------------------------

  /**
   * Adds a tab to the tree.
   *
   * If nodeData.parentId references an existing tab, the new tab becomes
   * a child of that parent. Otherwise it is inserted at root level.
   *
   * @param {number} tabId
   * @param {Object} nodeData
   */
  addTab(tabId, nodeData) {
    // Duplicate guard — prevent double-insertion of the same tab
    if (this.tabs.has(tabId)) return;

    const node = createNode(tabId, nodeData);
    const parent = node.parentId != null ? this.tabs.get(node.parentId) : null;

    if (parent) {
      parent.children.push(tabId);
    } else {
      // No valid parent — promote to root.
      node.parentId = null;
      this.rootIds.push(tabId);
    }

    this.tabs.set(tabId, node);
  }

  /**
   * Removes a tab from the tree. Children are reparented to the removed
   * tab's parent (or promoted to root), preserving their relative order
   * at the position the removed tab occupied.
   *
   * @param {number} tabId
   */
  removeTab(tabId) {
    const node = this.tabs.get(tabId);
    if (!node) return;

    const childIds = [...node.children];
    const grandParent = node.parentId != null ? this.tabs.get(node.parentId) : null;

    // Reparent children to grandparent (or root).
    for (const childId of childIds) {
      const child = this.tabs.get(childId);
      if (child) {
        child.parentId = node.parentId;
      }
    }

    if (grandParent) {
      // Splice children into grandparent at the position of the removed tab.
      const idx = grandParent.children.indexOf(tabId);
      if (idx !== -1) {
        grandParent.children.splice(idx, 1, ...childIds);
      }
    } else {
      // Tab was a root — splice children into rootIds at its position.
      const idx = this.rootIds.indexOf(tabId);
      if (idx !== -1) {
        this.rootIds.splice(idx, 1, ...childIds);
      }
    }

    this.tabs.delete(tabId);
    this.collapsed.delete(tabId);
  }

  /**
   * Moves a tab to a new parent at a given index.
   *
   * @param {number} tabId
   * @param {number|null} newParentId - Target parent, or null for root.
   * @param {number} index - Position within new sibling list.
   */
  moveTab(tabId, newParentId, index) {
    const node = this.tabs.get(tabId);
    if (!node) return;

    // Cycle detection — abort if newParentId is a descendant of tabId
    if (newParentId != null) {
      let ancestor = this.tabs.get(newParentId);
      while (ancestor) {
        if (ancestor.tabId === tabId) return; // would create a cycle
        ancestor = ancestor.parentId != null ? this.tabs.get(ancestor.parentId) : null;
      }
    }

    // Detach from current location.
    if (node.parentId != null) {
      const oldParent = this.tabs.get(node.parentId);
      if (oldParent) {
        const idx = oldParent.children.indexOf(tabId);
        if (idx !== -1) oldParent.children.splice(idx, 1);
      }
    } else {
      const idx = this.rootIds.indexOf(tabId);
      if (idx !== -1) this.rootIds.splice(idx, 1);
    }

    // Attach to new location.
    if (newParentId != null && this.tabs.has(newParentId)) {
      const newParent = this.tabs.get(newParentId);
      const clampedIdx = Math.min(index, newParent.children.length);
      newParent.children.splice(clampedIdx, 0, tabId);
      node.parentId = newParentId;
    } else {
      const clampedIdx = Math.min(index, this.rootIds.length);
      this.rootIds.splice(clampedIdx, 0, tabId);
      node.parentId = null;
    }
  }

  /**
   * Merges partial updates into an existing tab node.
   * Only whitelisted properties are applied.
   *
   * @param {number} tabId
   * @param {Object} changes
   */
  updateTab(tabId, changes) {
    const node = this.tabs.get(tabId);
    if (!node) return;

    for (const key of MUTABLE_PROPS) {
      if (key in changes) {
        node[key] = changes[key];
      }
    }
  }

  /**
   * Toggles the collapsed state for a tab.
   *
   * @param {number} tabId
   */
  toggleCollapse(tabId) {
    if (this.collapsed.has(tabId)) {
      this.collapsed.delete(tabId);
    } else {
      this.collapsed.add(tabId);
    }
  }

  /**
   * Collapses all tabs that have children.
   */
  collapseAll() {
    for (const [id, node] of this.tabs) {
      if (node.children.length > 0) {
        this.collapsed.add(id);
      }
    }
  }

  /**
   * Expands all tabs (clears collapsed set).
   */
  expandAll() {
    this.collapsed.clear();
  }

  /**
   * Focus mode: collapses all, then expands the path from root to target tab.
   *
   * @param {number} tabId
   */
  focusOnBranch(tabId) {
    this.collapseAll();

    // Walk from target up to root, expanding each ancestor
    let current = this.tabs.get(tabId);
    while (current) {
      this.collapsed.delete(current.tabId);
      if (current.parentId != null) {
        current = this.tabs.get(current.parentId);
      } else {
        break;
      }
    }
  }

  /**
   * Sets the active theme.
   *
   * @param {string} themeName
   */
  setTheme(themeName) {
    this.theme = themeName;
  }

  /**
   * Stores a color override for a tab group.
   *
   * @param {number} groupId
   * @param {string} color - Hex color string.
   */
  setGroupColor(groupId, color) {
    this.groupColors[groupId] = color;
  }

  /**
   * Moves all root-level tabs belonging to a group as a block, positioning
   * them relative to an anchor tab.
   *
   * @param {number} groupId - Group to move.
   * @param {number} anchorTabId - Tab ID to position relative to.
   * @param {'before'|'after'} position - Insert before or after the anchor.
   */
  moveGroup(groupId, anchorTabId, position) {
    // Don't move relative to own member
    const anchorTab = this.tabs.get(anchorTabId);
    if (anchorTab && anchorTab.groupId === groupId) return;

    // Collect group member IDs in current rootIds order
    const groupTabIdSet = new Set();
    for (const id of this.rootIds) {
      const tab = this.tabs.get(id);
      if (tab && tab.groupId === groupId) groupTabIdSet.add(id);
    }
    if (groupTabIdSet.size === 0) return;

    const groupTabIds = this.rootIds.filter(id => groupTabIdSet.has(id));

    // Remove group tabs from rootIds
    this.rootIds = this.rootIds.filter(id => !groupTabIdSet.has(id));

    // Find anchor in filtered rootIds
    let insertIdx = this.rootIds.indexOf(anchorTabId);
    if (insertIdx === -1) insertIdx = this.rootIds.length;
    else if (position === 'after') insertIdx++;

    // Insert group block
    this.rootIds.splice(insertIdx, 0, ...groupTabIds);
  }

  // -----------------------------------------------------------------------
  // Group Mutations
  // -----------------------------------------------------------------------

  /**
   * Adds or updates a Chrome tab group.
   *
   * @param {Object} group - Chrome TabGroup object.
   */
  addGroup(group) {
    this.groups.set(group.id, {
      id: group.id,
      title: group.title || '',
      color: group.color || 'grey',
      collapsed: group.collapsed || false,
      windowId: group.windowId,
    });
  }

  /**
   * Updates properties of an existing group.
   *
   * @param {number} groupId
   * @param {Object} changes
   */
  updateGroup(groupId, changes) {
    let group = this.groups.get(groupId);
    if (!group) {
      // Upsert: register unknown group (handles onUpdated-before-onCreated race)
      group = { id: groupId, title: '', color: 'grey', collapsed: false, windowId: undefined };
      this.groups.set(groupId, group);
    }
    if ('title' in changes) group.title = changes.title;
    if ('color' in changes) group.color = changes.color;
    if ('collapsed' in changes) group.collapsed = changes.collapsed;
  }

  /**
   * Removes a group from state.
   *
   * @param {number} groupId
   */
  removeGroup(groupId) {
    this.groups.delete(groupId);
  }

  /**
   * Replaces a tab ID throughout the tree (for chrome.tabs.onReplaced).
   * Remaps the tab in this.tabs, updates parent/child pointers, rootIds,
   * and collapsed set.
   *
   * @param {number} oldId
   * @param {number} newId
   */
  replaceTabId(oldId, newId) {
    const node = this.tabs.get(oldId);
    if (!node) return;

    // Collision guard — if newId already exists, remove the stale entry
    if (this.tabs.has(newId)) {
      console.warn(`[ShadowState] replaceTabId collision: newId ${newId} already exists, removing stale entry`);
      this.removeTab(newId);
    }

    // Update the node's own tabId
    node.tabId = newId;

    // Remap in tabs Map
    this.tabs.delete(oldId);
    this.tabs.set(newId, node);

    // Update parent's children array
    if (node.parentId != null) {
      const parent = this.tabs.get(node.parentId);
      if (parent) {
        const idx = parent.children.indexOf(oldId);
        if (idx !== -1) parent.children[idx] = newId;
      }
    }

    // Update children's parentId
    for (const childId of node.children) {
      const child = this.tabs.get(childId);
      if (child) child.parentId = newId;
    }

    // Update rootIds
    const rootIdx = this.rootIds.indexOf(oldId);
    if (rootIdx !== -1) this.rootIds[rootIdx] = newId;

    // Update collapsed set
    if (this.collapsed.has(oldId)) {
      this.collapsed.delete(oldId);
      this.collapsed.add(newId);
    }
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /**
   * Returns the TabNode for a given tabId, or null.
   *
   * @param {number} tabId
   * @returns {Object|null}
   */
  getTab(tabId) {
    return this.tabs.get(tabId) ?? null;
  }

  /**
   * Returns an array of direct child TabNodes for the given tabId.
   *
   * @param {number} tabId
   * @returns {Object[]}
   */
  getChildren(tabId) {
    const node = this.tabs.get(tabId);
    if (!node) return [];
    return node.children
      .map((id) => this.tabs.get(id))
      .filter(Boolean);
  }

  /**
   * Returns a flat array of ALL descendant TabNodes (depth-first).
   *
   * @param {number} tabId
   * @returns {Object[]}
   */
  getDescendants(tabId) {
    const node = this.tabs.get(tabId);
    if (!node) return [];

    const result = [];
    const walk = (ids) => {
      for (const id of ids) {
        const child = this.tabs.get(id);
        if (child) {
          result.push(child);
          walk(child.children);
        }
      }
    };
    walk(node.children);
    return result;
  }

  /**
   * Returns root-level TabNodes in display order.
   *
   * @returns {Object[]}
   */
  getRoots() {
    return this.rootIds
      .map((id) => this.tabs.get(id))
      .filter(Boolean);
  }

  /**
   * Returns all tab IDs belonging to a group, ordered by rootIds position first,
   * then any nested (non-root) members appended.
   *
   * @param {number} groupId
   * @returns {number[]}
   */
  getGroupMemberIds(groupId) {
    const memberSet = new Set();
    for (const [id, tab] of this.tabs) {
      if (tab.groupId === groupId) memberSet.add(id);
    }
    // Root-level members in rootIds order first
    const ordered = [];
    for (const id of this.rootIds) {
      if (memberSet.has(id)) ordered.push(id);
    }
    // Append any nested members not in rootIds
    for (const id of memberSet) {
      if (!ordered.includes(id)) ordered.push(id);
    }
    return ordered;
  }

  /**
   * Reorders rootIds so all tabs belonging to the same group are contiguous.
   * Preserves first-occurrence order of groups and relative order within groups.
   */
  enforceGroupContiguity() {
    // Build map: groupId -> [tabIds in rootIds order]
    const groupBuckets = new Map();

    for (const id of this.rootIds) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      const gid = tab.groupId ?? UNGROUPED_GROUP_ID;
      if (!groupBuckets.has(gid)) groupBuckets.set(gid, []);
      groupBuckets.get(gid).push(id);
    }

    // Rebuild rootIds preserving first-occurrence order of groups
    const seenGroups = new Set();
    const newRootIds = [];

    for (const id of this.rootIds) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      const gid = tab.groupId ?? UNGROUPED_GROUP_ID;

      if (!seenGroups.has(gid)) {
        // First time seeing this group — add all its members
        seenGroups.add(gid);
        newRootIds.push(...groupBuckets.get(gid));
      }
      // Skip: already added via first occurrence
    }

    this.rootIds = newRootIds;
  }

  /**
   * Returns every TabNode as a flat array.
   *
   * @returns {Object[]}
   */
  getAllTabs() {
    return [...this.tabs.values()];
  }

  /**
   * Returns whether a tab is collapsed.
   *
   * @param {number} tabId
   * @returns {boolean}
   */
  isCollapsed(tabId) {
    return this.collapsed.has(tabId);
  }

  /**
   * Returns the list of tabs that should be rendered, respecting collapsed
   * state. Each entry is { node, depth }.
   *
   * @returns {{ node: Object, depth: number }[]}
   */
  getVisibleTabs() {
    const result = [];

    const walk = (ids, depth) => {
      for (const id of ids) {
        const node = this.tabs.get(id);
        if (!node) continue;
        result.push({ node, depth });
        if (!this.collapsed.has(id)) {
          walk(node.children, depth + 1);
        }
      }
    };

    walk(this.rootIds, 0);
    return result;
  }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  /**
   * Converts the state to a plain, JSON-safe object suitable for
   * chrome.storage.local.
   *
   * @returns {Object}
   */
  toSerializable() {
    return {
      version: STORAGE_VERSION,
      savedAt: new Date().toISOString(),
      tabs: Object.fromEntries(this.tabs),
      rootIds: [...this.rootIds],
      collapsed: [...this.collapsed],
      groups: Object.fromEntries(this.groups),
      groupColors: { ...this.groupColors },
      theme: this.theme,
    };
  }

  /**
   * Reconstructs a ShadowState from storage data.
   * Returns a fresh empty instance if data is null/undefined.
   *
   * @param {Object|null|undefined} data
   * @returns {ShadowState}
   */
  static fromStorage(data) {
    if (!data) return new ShadowState();

    const state = new ShadowState();

    // Rebuild tabs Map — keys from Object.entries are strings, coerce to numbers.
    if (data.tabs) {
      for (const [key, node] of Object.entries(data.tabs)) {
        state.tabs.set(Number(key), node);
      }
    }

    state.rootIds = Array.isArray(data.rootIds) ? [...data.rootIds] : [];
    state.collapsed = new Set(Array.isArray(data.collapsed) ? data.collapsed : []);

    // Rebuild groups Map
    if (data.groups) {
      for (const [key, group] of Object.entries(data.groups)) {
        state.groups.set(Number(key), group);
      }
    }

    state.groupColors = data.groupColors ? { ...data.groupColors } : {};
    state.theme = data.theme ?? DEFAULT_THEME;

    return state;
  }

  // -----------------------------------------------------------------------
  // Reconciliation
  // -----------------------------------------------------------------------

  /**
   * Synchronizes in-memory state with the actual Chrome tab list.
   *
   * Two-pass matching for cross-restart resilience:
   *   Pass 1: Match by tabId (same session, fast path)
   *   Pass 2: Match unmatched saved tabs by URL fingerprint (cross-restart)
   *
   * @param {Object[]} liveTabs - Array from chrome.tabs.query({}).
   */
  reconcileWithLiveTabs(liveTabs) {
    const liveById = new Map(liveTabs.map((t) => [t.id, t]));
    const matchedLiveIds = new Set();

    // Pass 1: Match by tabId (same session)
    for (const id of this.tabs.keys()) {
      if (liveById.has(id)) {
        matchedLiveIds.add(id);
      }
    }

    // Pass 2: URL-based matching for cross-restart recovery
    const unmatchedSaved = [];
    for (const [id, node] of this.tabs) {
      if (!matchedLiveIds.has(id) && !liveById.has(id)) {
        unmatchedSaved.push([id, node]);
      }
    }

    const unmatchedLive = liveTabs.filter((t) => !matchedLiveIds.has(t.id));

    // Build URL index for unmatched live tabs (skip generic URLs)
    const liveByUrl = new Map();
    for (const tab of unmatchedLive) {
      const url = tab.url || '';
      if (!url || url === 'chrome://newtab/' || url === 'about:blank') continue;
      if (!liveByUrl.has(url)) liveByUrl.set(url, []);
      liveByUrl.get(url).push(tab);
    }

    // Match saved → live by composite fingerprint (url, title, index)
    for (const [savedId, savedNode] of unmatchedSaved) {
      const url = savedNode.url || '';
      if (!url || url === 'chrome://newtab/' || url === 'about:blank') continue;

      const candidates = liveByUrl.get(url);
      if (!candidates || candidates.length === 0) continue;

      // Pick best match: prefer same title + index, then same title
      let best = candidates[0];
      for (const c of candidates) {
        if (c.title === savedNode.title && c.index === savedNode.index) {
          best = c;
          break;
        }
        if (c.title === savedNode.title) best = c;
      }

      // Remap saved ID to live ID — preserves tree structure
      this.replaceTabId(savedId, best.id);
      matchedLiveIds.add(best.id);

      // Remove used candidate
      const idx = candidates.indexOf(best);
      if (idx !== -1) candidates.splice(idx, 1);
    }

    // (a) Remove dead tabs (saved tabs with no live match).
    const deadIds = [];
    for (const id of this.tabs.keys()) {
      if (!liveById.has(id)) deadIds.push(id);
    }
    for (const id of deadIds) {
      this.removeTab(id);
    }

    // (b) Update existing / add new.
    for (const tab of liveTabs) {
      const changes = {
        title:      tab.title,
        url:        tab.url,
        favIconUrl: tab.favIconUrl ?? '',
        pinned:     tab.pinned,
        audible:    tab.audible,
        status:     tab.status,
        groupId:    tab.groupId ?? UNGROUPED_GROUP_ID,
        index:      tab.index,
        windowId:   tab.windowId,
      };

      if (this.tabs.has(tab.id)) {
        this.updateTab(tab.id, changes);
      } else {
        this.addTab(tab.id, { tabId: tab.id, parentId: null, ...changes });
      }
    }

    // (c) Rebuild rootIds — preserve existing order, append new roots at correct position.
    const allRootSet = new Set(
      [...this.tabs.values()].filter((n) => n.parentId === null).map((n) => n.tabId)
    );
    // Keep existing rootIds that are still roots (preserves drag-drop ordering)
    const preserved = this.rootIds.filter((id) => allRootSet.has(id));
    const preservedSet = new Set(preserved);
    // Append any new roots not already in the list, sorted by index
    const newRoots = [...allRootSet]
      .filter((id) => !preservedSet.has(id))
      .sort((a, b) => (this.tabs.get(a)?.index ?? 0) - (this.tabs.get(b)?.index ?? 0));
    this.rootIds = [...preserved, ...newRoots];
    this.enforceGroupContiguity(); // Ensure group members are contiguous
  }

  /**
   * Synchronizes in-memory group state with live Chrome tab groups.
   *
   * @param {Object[]} liveGroups - Array from chrome.tabGroups.query({}).
   */
  reconcileWithLiveGroups(liveGroups) {
    const liveIds = new Set(liveGroups.map((g) => g.id));

    // Remove dead groups
    for (const id of this.groups.keys()) {
      if (!liveIds.has(id)) this.groups.delete(id);
    }

    // Add/update live groups
    for (const group of liveGroups) {
      this.addGroup(group);
    }
  }
}

export default ShadowState;
