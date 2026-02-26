/**
 * ShadowState — the core tree data structure for LinkMap.
 *
 * Owned by the background service worker. The side panel receives
 * serialized snapshots and never mutates state directly.
 *
 * Tree nodes (TabNode) are stored in a flat Map keyed by tabId.
 * Parent-child relationships are maintained via parentId / children[].
 */

import { STORAGE_VERSION, DEFAULT_THEME } from './constants.js';

// Properties that may be updated via updateTab().
const MUTABLE_PROPS = [
  'title', 'url', 'favIconUrl', 'pinned', 'audible',
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
    status:     data.status ?? 'complete',
    groupId:    data.groupId ?? -1,
    index:      data.index ?? 0,
    windowId:   data.windowId ?? 1,
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

    /** @type {Object<number, string>} groupId -> hex color */
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
   * - Removes tabs no longer present in Chrome.
   * - Adds newly detected tabs at root level.
   * - Updates metadata for surviving tabs.
   * - Rebuilds rootIds ordered by Chrome's tab index.
   *
   * @param {Object[]} liveTabs - Array from chrome.tabs.query({}).
   */
  reconcileWithLiveTabs(liveTabs) {
    const liveIds = new Set(liveTabs.map((t) => t.id));

    // (a) Remove dead tabs.
    const deadIds = [];
    for (const id of this.tabs.keys()) {
      if (!liveIds.has(id)) deadIds.push(id);
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
        groupId:    tab.groupId ?? -1,
        index:      tab.index,
        windowId:   tab.windowId,
      };

      if (this.tabs.has(tab.id)) {
        this.updateTab(tab.id, changes);
      } else {
        this.addTab(tab.id, { tabId: tab.id, parentId: null, ...changes });
      }
    }

    // (c) Rebuild rootIds — tabs with parentId === null, ordered by index.
    this.rootIds = [...this.tabs.values()]
      .filter((n) => n.parentId === null)
      .sort((a, b) => a.index - b.index)
      .map((n) => n.tabId);
  }
}

export default ShadowState;
