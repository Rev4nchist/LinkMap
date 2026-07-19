/**
 * ShadowState — the core tree data structure for LinkMap.
 *
 * Owned by the background service worker. The side panel receives
 * serialized snapshots and never mutates state directly.
 *
 * Tree nodes (TabNode) are stored in a flat Map keyed by tabId.
 * Parent-child relationships are maintained via parentId / children[].
 */

import {
  STORAGE_VERSION, DEFAULT_THEME, UNGROUPED_GROUP_ID,
  ORPHANED_GROUP_TTL_MS, ORPHANED_GROUP_CAP,
} from './constants.js';

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

/**
 * Picks the best live candidate for a saved node during cross-restart matching,
 * or null when the choice is ambiguous — so the caller can REFUSE to match
 * rather than transplant saved lineage onto the wrong tab (the RR-1/RR-8 class
 * of bug). Disambiguates by the mapped windowId before falling back to weaker
 * signals, and never defaults to candidates[0].
 *
 * @param {Object[]} candidates - live tabs sharing the bucket key (url or title).
 * @param {Object} savedNode - the saved TabNode being matched.
 * @param {Map<number,number>} winMap - old->new windowId map from prior matches.
 * @param {boolean} useTitle - true for the URL pass (fingerprint on title+index);
 *   false for the title pass (the title is already the bucket key, so use index).
 * @returns {Object|null} the chosen live tab, or null if ambiguous.
 */
function pickReconcileCandidate(candidates, savedNode, winMap, useTitle) {
  const mappedWid = winMap.get(savedNode.windowId) ?? savedNode.windowId;

  // Prefer candidates that live in the (mapped) saved window.
  let pool = candidates;
  const sameWin = candidates.filter((c) => c.windowId === mappedWid);
  if (sameWin.length > 0) pool = sameWin;

  // Strongest signal: a UNIQUE exact fingerprint within the window-filtered pool.
  // If two candidates match identically (e.g. duplicate pinned tabs with the same
  // title and index), that is ambiguous and must not be guessed.
  const exact = pool.filter((c) =>
    useTitle
      ? (c.title === savedNode.title && c.index === savedNode.index)
      : (c.index === savedNode.index)
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null; // ambiguous fingerprint — refuse

  // A single remaining candidate is unambiguous and safe to take.
  if (pool.length === 1) return pool[0];

  // For the URL pass, a unique same-title candidate is also safe.
  if (useTitle) {
    const sameTitle = pool.filter((c) => c.title === savedNode.title);
    if (sameTitle.length === 1) return sameTitle[0];
  }

  // Otherwise the bucket is genuinely ambiguous — refuse rather than guess.
  return null;
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

    /**
     * @type {Map<number, Object>} quarantine for orphaned titled groups —
     * id -> { id, title, color, collapsed, rawWindowId, count, colorOverride,
     * orphanedAt }. Survives progressive session restore instead of being
     * hard-deleted; entries are match-gated back onto a live group (see
     * reconcileWithLiveGroups) and pruned after ORPHANED_GROUP_TTL_MS.
     */
    this.orphanedGroups = new Map();

    /** @type {string} Active theme name */
    this.theme = DEFAULT_THEME;

    /** @type {Map<number, string>} windowId -> user-assigned name */
    this.windowNames = new Map();
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

    // Walk from target up to root, expanding each ancestor.
    const seen = new Set(); // cycle guard for a corrupt ancestor chain
    let current = this.tabs.get(tabId);
    while (current && !seen.has(current.tabId)) {
      seen.add(current.tabId);
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
   * Sets or clears a user-assigned name for a window.
   * @param {number} windowId
   * @param {string|null} name
   */
  setWindowName(windowId, name) {
    if (name && name.trim()) {
      this.windowNames.set(windowId, name.trim());
    } else {
      this.windowNames.delete(windowId);
    }
  }

  /**
   * Gets the user-assigned name for a window, or null if none.
   * @param {number} windowId
   * @returns {string|null}
   */
  getWindowName(windowId) {
    return this.windowNames.get(windowId) || null;
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
      title: group.title ?? '',
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
    if ('windowId' in changes) group.windowId = changes.windowId;
  }

  /**
   * Removes a group from state.
   *
   * @param {number} groupId
   */
  removeGroup(groupId) {
    this.groups.delete(groupId);
    delete this.groupColors[groupId]; // prune the color override so it can't leak
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
    if (oldId === newId) return; // no-op rename — avoid the destructive collision path
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
    const visited = new Set([tabId]); // cycle guard — never revisit a node
    const walk = (ids) => {
      for (const id of ids) {
        if (visited.has(id)) continue;
        const child = this.tabs.get(id);
        if (child) {
          visited.add(id);
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
    const orderedSet = new Set(ordered);
    for (const id of memberSet) {
      if (!orderedSet.has(id)) ordered.push(id);
    }
    return ordered;
  }

  /**
   * Reorders rootIds so all tabs belonging to the same group are contiguous.
   * Preserves first-occurrence order of groups and relative order within groups.
   */
  enforceGroupContiguity() {
    // Build map: groupId -> [tabIds in rootIds order], real groups only.
    // Ungrouped tabs must keep their individual positions — bucketing them
    // as a pseudo-group coalesced every ungrouped tab at the first one's
    // position, sinking all groups below the ungrouped block on every
    // reconcile (each SW wake).
    const groupBuckets = new Map();

    for (const id of this.rootIds) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      const gid = tab.groupId ?? UNGROUPED_GROUP_ID;
      if (gid === UNGROUPED_GROUP_ID) continue;
      if (!groupBuckets.has(gid)) groupBuckets.set(gid, []);
      groupBuckets.get(gid).push(id);
    }

    // Rebuild rootIds: ungrouped tabs stay in place; each group's members
    // block together at the group's first-occurrence position.
    const seenGroups = new Set();
    const newRootIds = [];

    for (const id of this.rootIds) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      const gid = tab.groupId ?? UNGROUPED_GROUP_ID;

      if (gid === UNGROUPED_GROUP_ID) {
        newRootIds.push(id);
        continue;
      }
      if (!seenGroups.has(gid)) {
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
    const visited = new Set(); // cycle guard — a corrupt tree must not infinite-loop

    const walk = (ids, depth) => {
      for (const id of ids) {
        if (visited.has(id)) continue;
        const node = this.tabs.get(id);
        if (!node) continue;
        visited.add(id);
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
      orphanedGroups: Object.fromEntries(this.orphanedGroups),
      theme: this.theme,
      windowNames: Object.fromEntries(this.windowNames),
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

    if (data.groupColors) {
      for (const [key, val] of Object.entries(data.groupColors)) {
        state.groupColors[Number(key)] = val;
      }
    }

    if (data.orphanedGroups) {
      for (const [key, entry] of Object.entries(data.orphanedGroups)) {
        state.orphanedGroups.set(Number(key), entry);
      }
    }
    state.theme = data.theme ?? DEFAULT_THEME;

    if (data.windowNames) {
      for (const [key, name] of Object.entries(data.windowNames)) {
        state.windowNames.set(Number(key), name);
      }
    }

    state._validateAndRepair();
    return state;
  }

  /**
   * Validates and repairs the loaded tree in place so recursive walks always
   * terminate. Drops self/duplicate/dangling child references, breaks any
   * parent/child cycle, sets parentId authoritatively from the reachable path,
   * re-roots unreachable nodes, and prunes the collapsed set. Valid data passes
   * through unchanged (rootIds order and parent links preserved).
   */
  _validateAndRepair() {
    // 1. Sanitize children arrays: drop self-refs, duplicates, and dangling ids.
    for (const [id, node] of this.tabs) {
      if (!Array.isArray(node.children)) { node.children = []; continue; }
      const seen = new Set();
      node.children = node.children.filter((cid) => {
        if (cid === id || seen.has(cid) || !this.tabs.has(cid)) return false;
        seen.add(cid);
        return true;
      });
    }

    // 2. Walk from roots; a node already reached is a back-edge (cycle) — drop it.
    const reachable = new Set();
    const walk = (id, parentId) => {
      const node = this.tabs.get(id);
      if (!node) return;
      reachable.add(id);
      node.parentId = parentId;
      node.children = node.children.filter((cid) => !reachable.has(cid));
      for (const cid of [...node.children]) walk(cid, id);
    };

    // Seed from declared roots (preserve order), then any other parentId==null node.
    const seeds = [];
    const seedSet = new Set();
    for (const id of (Array.isArray(this.rootIds) ? this.rootIds : [])) {
      if (this.tabs.has(id) && !seedSet.has(id)) { seeds.push(id); seedSet.add(id); }
    }
    for (const [id, node] of this.tabs) {
      if (node.parentId == null && !seedSet.has(id)) { seeds.push(id); seedSet.add(id); }
    }
    for (const id of seeds) { if (!reachable.has(id)) walk(id, null); }

    // 3. Re-root anything still unreachable (orphaned by a broken cycle).
    const newRoots = [...seeds];
    const newRootSet = new Set(newRoots);
    for (const [id] of this.tabs) {
      if (!reachable.has(id)) {
        if (!newRootSet.has(id)) { newRoots.push(id); newRootSet.add(id); }
        walk(id, null);
      }
    }
    this.rootIds = newRoots;

    // 4. Drop collapsed entries for tabs that no longer exist.
    for (const cid of [...this.collapsed]) {
      if (!this.tabs.has(cid)) this.collapsed.delete(cid);
    }
  }

  // -----------------------------------------------------------------------
  // Reconciliation
  // -----------------------------------------------------------------------

  /**
   * Synchronizes in-memory state with the actual Chrome tab list.
   *
   * Four-pass matching for cross-restart resilience:
   *   Pass 1:  Match by tabId (same session, fast path)
   *   Pass 2:  Match unmatched saved tabs by URL fingerprint (cross-restart)
   *   Pass 2b: Title-based fallback (URL changed but title preserved — SPAs, redirects)
   *   Pass 3:  Positional matching within same window (generic URLs like newtab/blank)
   *
   * Passes 2/2b disambiguate same-URL/same-title duplicates by the mapped
   * windowId and REFUSE ambiguous buckets rather than guessing (RR-1/RR-8).
   * Pass 3 never positionally guesses a lineage-bearing node (RR-2).
   *
   * After matching, dead tabs are removed and orphaned children are re-rooted.
   *
   * @param {Object[]} liveTabs - Array from chrome.tabs.query({}).
   */
  reconcileWithLiveTabs(liveTabs) {
    const liveById = new Map(liveTabs.map((t) => [t.id, t]));
    const matchedLiveIds = new Set();
    let pass1Count = 0, pass2Count = 0, pass2bCount = 0, pass3Count = 0;
    const savedRelationships = [...this.tabs.values()].filter(n => n.parentId != null).length;
    // F8: accumulate old->new tabId remaps across passes 2/2b/3 so callers
    // (e.g. background.js init) can remap tabId references stored outside
    // the tree itself, such as workspace membership lists.
    const tabIdMap = new Map();

    // Snapshot saved windowIds BEFORE they get overwritten at the update pass
    const savedTabWindowIds = new Map();
    for (const [id, node] of this.tabs) {
      savedTabWindowIds.set(id, node.windowId);
    }

    // Build an old->new windowId map from the matches accumulated so far.
    // Used to disambiguate same-URL/same-title duplicates across windows.
    // Only genuinely matched live IDs vote, so a coincidental tab-ID collision
    // can never cast a phantom vote.
    const buildWindowMap = () => {
      const votes = new Map();
      for (const liveTab of liveTabs) {
        if (!matchedLiveIds.has(liveTab.id)) continue;
        const savedWid = savedTabWindowIds.get(liveTab.id);
        if (savedWid !== undefined && savedWid !== liveTab.windowId) {
          if (!votes.has(savedWid)) votes.set(savedWid, new Map());
          const v = votes.get(savedWid);
          v.set(liveTab.windowId, (v.get(liveTab.windowId) || 0) + 1);
        }
      }
      const map = new Map();
      for (const [oldWid, v] of votes) {
        let bestWid = oldWid, bestCount = 0;
        for (const [newWid, count] of v) {
          if (count > bestCount) { bestCount = count; bestWid = newWid; }
        }
        map.set(oldWid, bestWid);
      }
      return map;
    };

    // Pass 1: Match by tabId (same session)
    for (const id of this.tabs.keys()) {
      if (liveById.has(id)) {
        matchedLiveIds.add(id);
        pass1Count++;
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
      const url = tab.url || tab.pendingUrl || '';
      if (!url || url === 'chrome://newtab/' || url === 'about:blank') continue;
      if (!liveByUrl.has(url)) liveByUrl.set(url, []);
      liveByUrl.get(url).push(tab);
    }

    // Match saved → live by composite fingerprint (url + windowId + title + index).
    // RR-1: prefer candidates in the mapped window and refuse ambiguous same-URL
    // buckets rather than corrupting lineage onto another window's tab.
    const winMapP2 = buildWindowMap();
    for (const [savedId, savedNode] of unmatchedSaved) {
      const url = savedNode.url || '';
      if (!url || url === 'chrome://newtab/' || url === 'about:blank') continue;

      const candidates = liveByUrl.get(url);
      if (!candidates || candidates.length === 0) continue;

      const best = pickReconcileCandidate(candidates, savedNode, winMapP2, true);
      if (!best) continue; // ambiguous — let Pass 2b / 3 / dead-removal handle it

      // Remap saved ID to live ID — preserves tree structure
      this.replaceTabId(savedId, best.id);
      matchedLiveIds.add(best.id);
      tabIdMap.set(savedId, best.id);
      pass2Count++;

      // Propagate saved windowId to new tab ID so vote-counting can build windowIdMap
      const oldWid = savedTabWindowIds.get(savedId);
      if (oldWid !== undefined) savedTabWindowIds.set(best.id, oldWid);

      // Remove used candidate
      const idx = candidates.indexOf(best);
      if (idx !== -1) candidates.splice(idx, 1);
    }

    // Pass 2b: Title-based fallback for remaining unmatched tabs
    const unmatchedSavedP2b = [];
    for (const [id, node] of this.tabs) {
      if (!matchedLiveIds.has(id) && !liveById.has(id)) {
        unmatchedSavedP2b.push([id, node]);
      }
    }
    const unmatchedLiveP2b = liveTabs.filter(t => !matchedLiveIds.has(t.id));
    const liveByTitle = new Map();
    for (const tab of unmatchedLiveP2b) {
      const title = tab.title || '';
      if (!title || title === 'New Tab') continue;
      if (!liveByTitle.has(title)) liveByTitle.set(title, []);
      liveByTitle.get(title).push(tab);
    }
    // RR-8: map savedNode.windowId through accumulated matches (the raw saved
    // windowId is stale post-restart) and refuse ambiguous common-title buckets
    // instead of defaulting to candidates[0].
    const winMapP2b = buildWindowMap();
    for (const [savedId, savedNode] of unmatchedSavedP2b) {
      const title = savedNode.title || '';
      if (!title || title === 'New Tab') continue;
      const candidates = liveByTitle.get(title);
      if (!candidates || candidates.length === 0) continue;

      const best = pickReconcileCandidate(candidates, savedNode, winMapP2b, false);
      if (!best) continue;

      this.replaceTabId(savedId, best.id);
      matchedLiveIds.add(best.id);
      tabIdMap.set(savedId, best.id);
      pass2bCount++;
      const oldWid2b = savedTabWindowIds.get(savedId);
      if (oldWid2b !== undefined) savedTabWindowIds.set(best.id, oldWid2b);
      const idx = candidates.indexOf(best);
      if (idx !== -1) candidates.splice(idx, 1);
    }

    // Preliminary windowId map from Pass 1 + 2 + 2b matches, for Pass 3.
    const prelimWindowIdMap = buildWindowMap();

    // Pass 3: Positional matching for generic/remaining unmatched tabs
    const unmatchedLiveP3 = liveTabs.filter(t => !matchedLiveIds.has(t.id));
    const liveByWindow = new Map();
    for (const tab of unmatchedLiveP3) {
      if (!liveByWindow.has(tab.windowId)) liveByWindow.set(tab.windowId, []);
      liveByWindow.get(tab.windowId).push(tab);
    }
    for (const tabs of liveByWindow.values()) {
      tabs.sort((a, b) => a.index - b.index);
    }
    const unmatchedSavedP3 = [];
    for (const [id, node] of this.tabs) {
      if (!matchedLiveIds.has(id) && !liveById.has(id)) {
        unmatchedSavedP3.push([id, node]);
      }
    }
    for (const [savedId, savedNode] of unmatchedSavedP3) {
      // RR-2: never positionally guess a lineage-bearing node — there is no
      // identity check in this pass, so a wrong match would transplant a whole
      // subtree. Let these fall to dead-removal + orphan-repair instead.
      if (savedNode.children.length > 0 || savedNode.parentId != null) continue;
      const mappedWid = prelimWindowIdMap.get(savedNode.windowId) ?? savedNode.windowId;
      const windowTabs = liveByWindow.get(mappedWid);
      if (!windowTabs || windowTabs.length === 0) continue;
      let bestIdx = 0;
      let bestDist = Math.abs(windowTabs[0].index - savedNode.index);
      for (let i = 1; i < windowTabs.length; i++) {
        const dist = Math.abs(windowTabs[i].index - savedNode.index);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      }
      if (bestDist <= 3) {  // Only match if within 3 positions
        const matchedLiveTab = windowTabs[bestIdx];
        this.replaceTabId(savedId, matchedLiveTab.id);
        matchedLiveIds.add(matchedLiveTab.id);
        tabIdMap.set(savedId, matchedLiveTab.id);
        pass3Count++;
        const oldWid3 = savedTabWindowIds.get(savedId);
        if (oldWid3 !== undefined) savedTabWindowIds.set(matchedLiveTab.id, oldWid3);
        windowTabs.splice(bestIdx, 1);
      }
    }

    // (a) Remove dead tabs (saved tabs with no live match).
    const deadIds = [];
    for (const id of this.tabs.keys()) {
      if (!liveById.has(id)) deadIds.push(id);
    }
    for (const id of deadIds) {
      this.removeTab(id);
    }

    // Orphan repair: fix parentId references to non-existent tabs
    for (const [id, node] of this.tabs) {
      if (node.parentId != null && !this.tabs.has(node.parentId)) {
        node.parentId = null;
      }
    }

    // Build oldWindowId → newWindowId map from matched tabs (for group rescue)
    const windowIdVotes = new Map(); // oldWid → Map<newWid, count>
    for (const liveTab of liveTabs) {
      const savedWid = savedTabWindowIds.get(liveTab.id);
      if (savedWid !== undefined && savedWid !== liveTab.windowId) {
        if (!windowIdVotes.has(savedWid)) windowIdVotes.set(savedWid, new Map());
        const votes = windowIdVotes.get(savedWid);
        votes.set(liveTab.windowId, (votes.get(liveTab.windowId) || 0) + 1);
      }
    }
    const windowIdMap = new Map();
    for (const [oldWid, votes] of windowIdVotes) {
      let bestWid = oldWid, bestCount = 0;
      for (const [newWid, count] of votes) {
        if (count > bestCount) { bestCount = count; bestWid = newWid; }
      }
      windowIdMap.set(oldWid, bestWid);
    }

    // Fallback: ensure every saved window name has a windowId mapping.
    // If a window's tabs all failed to match, the vote-based map won't have it.
    // Scan savedTabWindowIds for any tab that was in the unmapped window.
    const liveWindowIds = new Set(liveTabs.map(t => t.windowId));
    for (const oldWid of this.windowNames.keys()) {
      if (windowIdMap.has(oldWid)) continue; // already mapped
      if (liveWindowIds.has(oldWid)) continue; // ID didn't change

      // Find any matched live tab that was in this old window
      for (const liveTab of liveTabs) {
        const savedWid = savedTabWindowIds.get(liveTab.id);
        if (savedWid === oldWid) {
          windowIdMap.set(oldWid, liveTab.windowId);
          break;
        }
      }
    }

    // (b) Update existing / add new.
    for (const tab of liveTabs) {
      const effectiveUrl = tab.url || tab.pendingUrl || '';
      const existingNode = this.tabs.get(tab.id);
      const favIconUrl = tab.favIconUrl
        || (existingNode?.url === effectiveUrl ? existingNode.favIconUrl : '')
        || '';
      const changes = {
        title:      tab.title,
        url:        effectiveUrl,
        favIconUrl,
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

    // Remap window names to new windowIds
    const remappedNames = new Map();
    for (const [oldWid, name] of this.windowNames) {
      const newWid = windowIdMap.get(oldWid) ?? oldWid;
      remappedNames.set(newWid, name);
    }
    this.windowNames = remappedNames;
    console.log('[LinkMap] Window name remap:', JSON.stringify({
      windowIdMap: Object.fromEntries(windowIdMap),
      names: Object.fromEntries(this.windowNames),
    }));

    const survivingRelationships = [...this.tabs.values()].filter(n => n.parentId != null).length;
    const stats = {
      savedCount: savedTabWindowIds.size,
      liveCount: liveTabs.length,
      pass1: pass1Count, pass2: pass2Count, pass2b: pass2bCount, pass3: pass3Count,
      deadRemoved: deadIds.length,
      savedRelationships,
      survivingRelationships,
    };
    console.log('[LinkMap] Reconciliation:', JSON.stringify(stats));

    return { windowIdMap, tabIdMap, stats };
  }

  /**
   * Synchronizes in-memory group state with live Chrome tab groups.
   *
   * @param {Object[]} liveGroups - Array from chrome.tabGroups.query({}).
   * @param {Map<number, number>} savedGroupTabCounts - Tab counts per saved group ID,
   *   snapshotted before reconcileWithLiveTabs() overwrites groupIds.
   * @param {Map<number, number>} windowIdMap - Old windowId → new windowId mapping,
   *   built by reconcileWithLiveTabs() from tab matching across restart.
   */
  reconcileWithLiveGroups(liveGroups, savedGroupTabCounts = new Map(), windowIdMap = new Map(), now = Date.now()) {
    const liveIds = new Set(liveGroups.map((g) => g.id));

    // Compute tab counts per NEW group from reconciled tab state
    const newGroupTabCounts = new Map();
    for (const [, tab] of this.tabs) {
      const gid = tab.groupId;
      if (gid && gid !== -1) {
        newGroupTabCounts.set(gid, (newGroupTabCounts.get(gid) || 0) + 1);
      }
    }

    // 1. Prune quarantine entries older than ORPHANED_GROUP_TTL_MS.
    for (const [id, entry] of this.orphanedGroups) {
      if (now - entry.orphanedAt > ORPHANED_GROUP_TTL_MS) {
        this.orphanedGroups.delete(id);
      }
    }

    // 2. Gated resurrection: Chrome group ids are small session-scoped ints
    // and get reused across restarts routinely, so a live group reusing a
    // quarantined id is NOT necessarily the same group. Only resurrect in
    // place when the live group looks like a match (empty title, same
    // color, and the quarantined windowId — re-mapped fresh, see A2 — is
    // either unmapped or agrees with the live group's window). On a
    // mismatch, keep the entry available for normal tier matching by
    // re-keying it under a synthetic negative id so it stops colliding with
    // the live group's id.
    //
    // A-7: orphanedGroups is persisted/serialized (fromStorage/toSerializable)
    // and this method can be called repeatedly on the SAME instance across
    // restarts, so a hardcoded "-1" start would silently collide with — and
    // overwrite — a negative-keyed entry already sitting in the map from an
    // earlier call or from deserialized state. Seed strictly below the
    // lowest key already present so a freshly-allocated key can never reuse
    // one that's still in use.
    let minExistingKey = 0;
    for (const key of this.orphanedGroups.keys()) {
      if (key < minExistingKey) minExistingKey = key;
    }
    let negativeKeySeq = minExistingKey - 1;
    for (const group of liveGroups) {
      const entry = this.orphanedGroups.get(group.id);
      if (!entry) continue;

      const widIsMapped = windowIdMap.has(entry.rawWindowId);
      const mappedWid = widIsMapped ? windowIdMap.get(entry.rawWindowId) : entry.rawWindowId;
      const widOk = !widIsMapped || mappedWid === group.windowId;

      if (!group.title && group.color === entry.color && widOk) {
        this.groups.set(group.id, {
          id: group.id,
          title: entry.title,
          color: group.color,
          collapsed: group.collapsed ?? entry.collapsed,
          windowId: group.windowId,
        });
        if (entry.colorOverride) this.groupColors[group.id] = entry.colorOverride;
        this.orphanedGroups.delete(group.id);
      } else {
        this.orphanedGroups.delete(group.id);
        this.orphanedGroups.set(negativeKeySeq, { ...entry, id: negativeKeySeq });
        negativeKeySeq--;
      }
    }

    // 3. Quarantine newly orphaned titled groups instead of hard-deleting
    // them — untitled orphans still have nothing worth rescuing, so they're
    // discarded as before.
    for (const [id, saved] of this.groups) {
      if (liveIds.has(id)) continue;
      if (saved.title) {
        this.orphanedGroups.set(id, {
          id,
          title: saved.title,
          color: saved.color,
          collapsed: saved.collapsed,
          rawWindowId: saved.windowId,
          count: savedGroupTabCounts.get(id) || 0,
          colorOverride: this.groupColors[id],
          orphanedAt: now,
        });
      }
      this.groups.delete(id);
      delete this.groupColors[id];
    }

    // Enforce the quarantine cap — evict the oldest entries, never silently.
    if (this.orphanedGroups.size > ORPHANED_GROUP_CAP) {
      const overflow = this.orphanedGroups.size - ORPHANED_GROUP_CAP;
      const oldestFirst = [...this.orphanedGroups.entries()]
        .sort((a, b) => a[1].orphanedAt - b[1].orphanedAt);
      for (let i = 0; i < overflow; i++) {
        const [key] = oldestFirst[i];
        this.orphanedGroups.delete(key);
        console.warn('[LinkMap] orphanedGroups cap eviction:', key);
      }
    }

    // 4/5. Add/update live groups — preserve saved title if Chrome has none,
    // rescuing from quarantine (built fresh each call — see
    // _matchOrphanedGroup) when Chrome returns an untitled group.
    for (const group of liveGroups) {
      const existing = this.groups.get(group.id);
      if (existing) {
        existing.color = group.color || existing.color;
        existing.collapsed = group.collapsed ?? existing.collapsed;
        existing.windowId = group.windowId;
        if (group.title) existing.title = group.title;
      } else {
        this.addGroup(group);
        if (!group.title) {
          const count = newGroupTabCounts.get(group.id) || 0;
          const matched = this._matchOrphanedGroup(group.color, group.windowId, count, now, windowIdMap);
          if (matched) {
            this.groups.get(group.id).title = matched.title;
            if (matched.colorOverride) this.groupColors[group.id] = matched.colorOverride;
          }
        } else {
          // A-2: Chrome preserved the title across the restart, so the
          // untitled-rescue tier above never fires — but a quarantined
          // colorOverride (custom hex) for this same group would otherwise
          // sit unused until the TTL and resolveGroupColor() would fall back
          // to the plain native color. Match by title AND color (never title
          // alone, to minimize the A-3 same-title-collision surface).
          for (const entry of this.orphanedGroups.values()) {
            if (now - entry.orphanedAt > ORPHANED_GROUP_TTL_MS) continue; // expired
            if (entry.title === group.title && entry.color === group.color) {
              if (entry.colorOverride) this.groupColors[group.id] = entry.colorOverride;
              this.orphanedGroups.delete(entry.id);
              break;
            }
          }
        }
      }
    }

    // A-4: normalize surviving quarantine entries to the current (post-restart)
    // window ids. The later map-less sweep (rescueUntitledLiveGroup ->
    // _matchOrphanedGroup with no windowIdMap) compares a live group's NEW
    // windowId against the entry's stale pre-restart rawWindowId, never matches
    // on window, and falls to the ambiguous color-only tier — so with >=2
    // same-color orphans it rescued NEITHER title and they expired at the TTL.
    // Rewriting rawWindowId through the map here lets the sweep match on the
    // real window. Empty map (a non-restart SW wake) is a no-op.
    if (windowIdMap.size > 0) {
      for (const entry of this.orphanedGroups.values()) {
        if (windowIdMap.has(entry.rawWindowId)) {
          entry.rawWindowId = windowIdMap.get(entry.rawWindowId);
        }
      }
    }
  }

  /**
   * Attempts to match a live, untitled tab group against a quarantined
   * orphaned group. Tries three progressively looser tiers: exact
   * color:windowId:count, then color:windowId, then color-only — the
   * color-only tier only fires when exactly one non-expired quarantined
   * group of that color exists (RR-5: with two same-color orphans the
   * title is ambiguous and could be pasted onto an unrelated group).
   *
   * windowId is re-mapped through windowIdMap fresh on every call (A2) — a
   * frozen mapping captured once would go stale across service-worker
   * restarts. Expired entries (older than ORPHANED_GROUP_TTL_MS) are never
   * matched, independent of whether reconcileWithLiveGroups has pruned them.
   *
   * On a match, deletes the matched entry from quarantine and returns it.
   *
   * @param {string} color
   * @param {number} windowId
   * @param {number} count
   * @param {number} now
   * @param {Map<number, number>} windowIdMap
   * @returns {Object|null} the matched quarantine entry, or null
   */
  _matchOrphanedGroup(color, windowId, count, now, windowIdMap = new Map()) {
    let countMatch = null;
    let colorMatch = null;
    let colorOnlyMatch = null;
    let colorOnlyCount = 0;

    for (const entry of this.orphanedGroups.values()) {
      if (now - entry.orphanedAt > ORPHANED_GROUP_TTL_MS) continue; // expired
      if (entry.color !== color) continue;

      colorOnlyCount++;
      if (!colorOnlyMatch) colorOnlyMatch = entry;

      const mappedWid = windowIdMap.has(entry.rawWindowId)
        ? windowIdMap.get(entry.rawWindowId)
        : entry.rawWindowId;
      if (mappedWid === windowId) {
        if (!colorMatch) colorMatch = entry;
        if (!countMatch && entry.count === count) countMatch = entry;
      }
    }

    const matched = countMatch || colorMatch || (colorOnlyCount === 1 ? colorOnlyMatch : null);
    if (matched) this.orphanedGroups.delete(matched.id);
    return matched || null;
  }

  /**
   * Rescues a title for an already-live, already-tracked group that is
   * still untitled — used by the retry sweep well after the initial
   * reconcile, once tab membership has settled. Only attempts a match once
   * the group has at least one member tab in state (A5b) — an empty group
   * at creation instant would otherwise produce false count=0 matches and
   * wrong color-only pushes.
   *
   * @param {Object} liveGroup - Chrome TabGroup object (or {id, color, windowId}).
   * @param {number} now
   * @returns {string|null} the rescued title, or null if no match applied.
   */
  rescueUntitledLiveGroup(liveGroup, now = Date.now()) {
    const existing = this.groups.get(liveGroup.id);
    if (!existing || existing.title) return null;

    let count = 0;
    for (const [, tab] of this.tabs) {
      if (tab.groupId === liveGroup.id) count++;
    }
    if (count === 0) return null;

    const matched = this._matchOrphanedGroup(liveGroup.color, liveGroup.windowId, count, now);
    if (!matched) return null;

    existing.title = matched.title;
    if (matched.colorOverride) this.groupColors[liveGroup.id] = matched.colorOverride;
    return matched.title;
  }
}

export default ShadowState;
