/**
 * tree-renderer.js — Converts ShadowState payload to DOM tree.
 *
 * Pure rendering module: takes state in, produces DOM elements.
 * No event handling — that lives in sidepanel.js.
 */

import { el } from '../../shared/utils.js';
import { CHROME_GROUP_COLORS, UNGROUPED_GROUP_ID, DEFAULT_FAVICON, getFaviconUrl } from '../../shared/constants.js';

// Re-export for consumers that import from here
export { DEFAULT_FAVICON, getFaviconUrl };

/** Maximum nesting depth to prevent stack overflow on circular structures. */
const MAX_TREE_DEPTH = 50;

/** Per-render cache for countDescendants — reset at the top of renderTree. */
let _descendantCache = null;

/**
 * Renders the full tab tree into the provided containers.
 *
 * @param {Object} state - Payload from background: { tabs, rootIds, collapsed, groups, groupColors, theme }
 * @param {number|null} activeTabId - Currently active tab ID
 * @param {HTMLElement} container - The #tree-container element
 * @param {HTMLElement} pinnedContainer - The #pinned-list element
 * @param {number|null} homeWindowId - The side panel's own window ID (stable)
 * @param {Set<number>} collapsedWindowIds - Set of collapsed window IDs
 */
export function renderTree(state, activeTabId, container, pinnedContainer, homeWindowId, collapsedWindowIds) {
  _descendantCache = new Map();
  const { tabs, rootIds, collapsed, groupColors, groups, duplicates, visitFrequency, tabNotes, windowNames } = state;
  const duplicateTabIds = new Set();
  if (duplicates) {
    for (const ids of Object.values(duplicates)) {
      for (const id of ids) duplicateTabIds.add(id);
    }
  }
  const collapsedSet = new Set(collapsed);
  const groupsMap = groups || {};

  // Pre-compute group colors (avoids repeated lookups per tab)
  const groupColorCache = new Map();
  for (const gid of Object.keys(groupsMap)) {
    const id = Number(gid);
    groupColorCache.set(id, resolveGroupColor(id, groupsMap[id], groupColors));
  }

  // Separate pinned from non-pinned tabs
  const treeElements = [];

  // Partition rootIds by windowId (both pinned and non-pinned)
  const windowBuckets = new Map(); // windowId -> [rootId, ...] (non-pinned)
  const pinnedByWindow = new Map(); // windowId -> [rootId, ...] (pinned)

  for (const rootId of rootIds) {
    const tab = tabs[rootId];
    if (!tab) continue;
    if (tab.pinned) {
      const wid = tab.windowId ?? 0;
      if (!pinnedByWindow.has(wid)) pinnedByWindow.set(wid, []);
      pinnedByWindow.get(wid).push(rootId);
      continue;
    }
    const wid = tab.windowId ?? 0;
    if (!windowBuckets.has(wid)) windowBuckets.set(wid, []);
    windowBuckets.get(wid).push(rootId);
  }

  // Render pinned tab children into the tree (they are non-pinned children of pinned parents)
  for (const pinnedIds of pinnedByWindow.values()) {
    for (const rootId of pinnedIds) {
      const tab = tabs[rootId];
      if (tab.children && tab.children.length > 0) {
        for (const childId of tab.children) {
          const child = tabs[childId];
          if (!child || child.pinned) continue;
          renderSubtree(child, 0, tabs, collapsedSet, activeTabId, treeElements, groupColors, groupsMap, groupColorCache, duplicateTabIds, visitFrequency, tabNotes);
        }
      }
    }
  }

  // Sort windows: home window first (stable), then by windowId
  // Include windows that only have pinned tabs (no non-pinned roots)
  const allWindowIds = new Set([...windowBuckets.keys(), ...pinnedByWindow.keys()]);
  const sortedWindowIds = [...allWindowIds].sort((a, b) => {
    if (a === homeWindowId) return -1;
    if (b === homeWindowId) return 1;
    return a - b;
  });

  // Labels from render order: non-home windows numbered sequentially
  // Use user-assigned windowNames when available, fallback to "Window N"
  const windowLabels = new Map();
  let windowNum = 1;
  for (const wid of sortedWindowIds) {
    if (wid !== homeWindowId) {
      const userName = windowNames && windowNames[wid];
      windowLabels.set(wid, userName || `Window ${windowNum}`);
      windowNum++;
    }
  }

  // Render each window's tabs with separator headers
  for (const wid of sortedWindowIds) {
    const windowRootIds = windowBuckets.get(wid) || [];

    // Insert window separator (skip for single window)
    if (sortedWindowIds.length > 1) {
      const isHome = wid === homeWindowId;
      const homeLabel = windowNames && windowNames[homeWindowId];
      const label = isHome ? (homeLabel || 'This Window') : windowLabels.get(wid);
      const isCollapsible = !isHome;
      const isCollapsed = collapsedWindowIds && collapsedWindowIds.has(wid);
      treeElements.push(buildWindowSeparator(label, isCollapsible, isCollapsed, wid));

      // Skip tabs for collapsed non-home windows
      if (isCollapsed) continue;

      // Non-home windows: render pinned tabs inline in the scroller
      if (!isHome) {
        const windowPinned = pinnedByWindow.get(wid) || [];
        if (windowPinned.length > 0) {
          treeElements.push(buildPinnedBar(windowPinned, tabs, wid));
        }
      }
    }

    // Pre-compute group member counts for this window
    const windowGroupCounts = new Map();
    for (const rootId of windowRootIds) {
      const tab = tabs[rootId];
      if (!tab) continue;
      const gid = tab.groupId ?? UNGROUPED_GROUP_ID;
      if (gid !== UNGROUPED_GROUP_ID) {
        windowGroupCounts.set(gid, (windowGroupCounts.get(gid) || 0) + 1);
      }
    }

    // Render tabs for this window
    const emittedGroups = new Set();
    for (const rootId of windowRootIds) {
      const tab = tabs[rootId];
      if (!tab) continue;

      const groupId = tab.groupId ?? UNGROUPED_GROUP_ID;

      // Insert group header when entering a new group cluster (emit-once guard)
      if (groupId !== UNGROUPED_GROUP_ID && !emittedGroups.has(groupId)) {
        const group = groupsMap[groupId];
        const memberCount = windowGroupCounts.get(groupId) || 0;
        const resolvedColor = groupColorCache.get(groupId) || resolveGroupColor(groupId, group, groupColors);
        treeElements.push(buildGroupHeader(groupId, group, resolvedColor, memberCount));
        emittedGroups.add(groupId);
      }

      // Skip tabs in collapsed Chrome groups (group header remains visible)
      if (groupId !== UNGROUPED_GROUP_ID) {
        const group = groupsMap[groupId];
        if (group && group.collapsed) continue;
      }

      renderSubtree(tab, 0, tabs, collapsedSet, activeTabId, treeElements, groupColors, groupsMap, groupColorCache, duplicateTabIds, visitFrequency, tabNotes);
    }
  }

  // Swap DOM content — keyed reconciliation preserves scroll + DOM state
  const scrollTop = container.scrollTop;

  // Sticky pinned section: only home window's pinned tabs (outside the scroller).
  // Other windows' pinned tabs render inline under their window separator above.
  const homePinned = pinnedByWindow.get(homeWindowId) || [];
  const pinnedElements = [];
  for (const id of homePinned) {
    const tab = tabs[id];
    if (tab) pinnedElements.push(buildPinnedTab(tab));
  }
  // Single-window fallback: if no homeWindowId match, show all pinned
  if (pinnedElements.length === 0 && sortedWindowIds.length <= 1) {
    for (const ids of pinnedByWindow.values()) {
      for (const id of ids) {
        const tab = tabs[id];
        if (tab) pinnedElements.push(buildPinnedTab(tab));
      }
    }
  }
  pinnedContainer.replaceChildren(...pinnedElements);
  reconcileChildren(container, treeElements);

  container.scrollTop = scrollTop;
}

/**
 * Recursively renders a tab and its visible children into the elements array.
 *
 * @param {Object} tab - TabNode from state
 * @param {number} depth - Current nesting depth
 * @param {Object} tabs - All tabs map
 * @param {Set<number>} collapsedSet - Set of collapsed tab IDs
 * @param {number|null} activeTabId - Active tab ID
 * @param {Array} elements - Output array to push elements into
 * @param {Object} groupColors - Manual group color overrides
 * @param {Object} groupsMap - Chrome group data
 */
function renderSubtree(tab, depth, tabs, collapsedSet, activeTabId, elements, groupColors, groupsMap, groupColorCache, duplicateTabIds, visitFrequency, tabNotes) {
  if (depth > MAX_TREE_DEPTH) return; // guard against infinite recursion

  elements.push(buildTabEntry(tab, depth, tabs, collapsedSet, activeTabId, groupColors, groupsMap, groupColorCache, duplicateTabIds, visitFrequency, tabNotes));

  const isCollapsed = collapsedSet.has(tab.tabId);
  if (!isCollapsed && tab.children && tab.children.length > 0) {
    for (const childId of tab.children) {
      const child = tabs[childId];
      if (!child) continue;
      if (child.pinned) continue; // pinned children go to pinned section
      renderSubtree(child, depth + 1, tabs, collapsedSet, activeTabId, elements, groupColors, groupsMap, groupColorCache, duplicateTabIds, visitFrequency, tabNotes);
    }
  }
}

/**
 * Builds a single tab entry DOM element.
 *
 * @param {Object} tab - TabNode
 * @param {number} depth - Nesting depth
 * @param {Object} tabs - All tabs (for descendant counting)
 * @param {Set<number>} collapsedSet - Collapsed tab IDs
 * @param {number|null} activeTabId - Active tab ID
 * @param {Object} groupColors - Manual group color overrides
 * @param {Object} groupsMap - Chrome group data
 * @returns {HTMLElement}
 */
function buildTabEntry(tab, depth, tabs, collapsedSet, activeTabId, groupColors, groupsMap, groupColorCache, duplicateTabIds, visitFrequency, tabNotes) {
  const hasChildren = tab.children && tab.children.length > 0;
  const isActive = tab.tabId === activeTabId;
  const isCollapsed = collapsedSet.has(tab.tabId);
  const isDuplicate = duplicateTabIds && duplicateTabIds.has(tab.tabId);
  const isDiscarded = tab.status === 'unloaded';
  const freq = visitFrequency?.[tab.tabId];

  // Chevron or spacer
  let chevronOrSpacer;
  if (hasChildren) {
    chevronOrSpacer = el('span', {
      className: 'tab-chevron',
      dataset: { collapsed: String(isCollapsed) },
    }, '\u25B6');
    chevronOrSpacer.setAttribute('aria-expanded', String(!isCollapsed));
  } else {
    chevronOrSpacer = el('div', { className: 'tab-chevron-spacer' });
  }

  // Favicon
  const faviconSrc = getFaviconUrl(tab);
  const faviconClasses = tab.status === 'loading'
    ? 'tab-favicon tab-loading'
    : 'tab-favicon';

  const favicon = el('img', {
    className: faviconClasses,
    src: faviconSrc,
    width: '16',
    height: '16',
    alt: '',
  });
  armFaviconFallback(favicon);

  // Title
  const title = el('span', { className: 'tab-title' }, tab.title || tab.url || '');

  // Tab count badge on collapsed parents
  let badge = null;
  if (hasChildren && isCollapsed) {
    const descendantCount = countDescendants(tab, tabs);
    badge = el('span', { className: 'tab-badge' }, `+${descendantCount}`);
  }

  // Close button
  const closeBtn = el('button', {
    className: 'tab-close',
    title: 'Close tab',
  }, '\u00D7');

  // Entry classes
  const entryClasses = tab.audible
    ? 'tab-entry tab-audible'
    : 'tab-entry';

  // Duplicate indicator
  let dupBadge = null;
  if (isDuplicate) {
    dupBadge = el('span', { className: 'tab-badge tab-duplicate-badge', title: 'Duplicate tab' }, 'dup');
  }

  // Discarded (sleeping) indicator
  let sleepBadge = null;
  if (isDiscarded) {
    sleepBadge = el('span', { className: 'tab-badge tab-sleep-badge', title: 'Tab is sleeping (discarded)' }, 'zzz');
  }

  // Visit frequency indicator
  let freqDot = null;
  if (freq && freq.tier !== 'normal') {
    freqDot = el('span', {
      className: `tab-freq tab-freq-${freq.tier}`,
      title: `${freq.count} visits`,
    });
  }

  // Build children array for el()
  const children = [chevronOrSpacer, favicon, title];
  if (freqDot) children.push(freqDot);
  if (sleepBadge) children.push(sleepBadge);
  if (dupBadge) children.push(dupBadge);
  if (badge) children.push(badge);
  children.push(closeBtn);

  // Add discarded/duplicate classes
  let finalClasses = entryClasses;
  if (isDiscarded) finalClasses += ' tab-discarded';
  if (isDuplicate) finalClasses += ' tab-duplicate';

  const entry = el('div', {
    className: finalClasses,
    draggable: 'true',
    dataset: {
      tabId: String(tab.tabId),
      depth: String(depth),
      active: String(isActive),
      groupId: String(tab.groupId ?? UNGROUPED_GROUP_ID),
      windowId: String(tab.windowId ?? 0),
    },
  }, ...children);
  entry.setAttribute('role', 'treeitem');
  entry.setAttribute('tabindex', '-1');
  if (isActive) {
    entry.setAttribute('aria-current', 'page');
  }

  // Tab note subtitle
  const noteText = tabNotes?.[tab.tabId];
  if (noteText) {
    const noteEl = el('div', { className: 'tab-note' }, noteText);
    entry.appendChild(noteEl);
    entry.classList.add('tab-has-note');
  }

  // Apply group color as left border accent
  if (tab.groupId !== undefined && tab.groupId !== UNGROUPED_GROUP_ID) {
    const groupColor = groupColorCache?.get(tab.groupId) || resolveGroupColor(tab.groupId, groupsMap?.[tab.groupId], groupColors);
    if (groupColor) {
      entry.style.borderLeft = `3px solid ${groupColor}`;
    }
  }

  return entry;
}

/**
 * Builds a compact pinned tab tile.
 *
 * @param {Object} tab - TabNode (pinned)
 * @returns {HTMLElement}
 */
const failedPinnedFaviconSrcs = new Map();

function armFaviconFallback(favicon, onFailure) {
  favicon.onerror = () => {
    const failedSrc = favicon.src;
    if (!failedSrc || failedSrc === DEFAULT_FAVICON) return;
    favicon.dataset.failedSrc = failedSrc;
    onFailure?.(failedSrc);
    favicon.src = DEFAULT_FAVICON;
    favicon.setAttribute('src', DEFAULT_FAVICON);
  };
}

function buildPinnedTab(tab) {
  const candidateSrc = getFaviconUrl(tab);
  const failedSrc = failedPinnedFaviconSrcs.get(tab.tabId);
  if (failedSrc && failedSrc !== candidateSrc) {
    failedPinnedFaviconSrcs.delete(tab.tabId);
  }
  const faviconSrc = failedSrc === candidateSrc ? DEFAULT_FAVICON : candidateSrc;

  const favicon = el('img', {
    src: faviconSrc,
    width: '16',
    height: '16',
    alt: '',
  });
  if (failedSrc === candidateSrc) favicon.dataset.failedSrc = candidateSrc;
  armFaviconFallback(favicon, (src) => failedPinnedFaviconSrcs.set(tab.tabId, src));

  return el('div', {
    className: 'pinned-tab',
    draggable: 'true',
    dataset: { tabId: String(tab.tabId) },
    title: tab.title || tab.url || '',
  }, favicon);
}

/**
 * Builds an inline pinned tab bar for a window section (multi-window mode).
 *
 * @param {number[]} pinnedIds - Root IDs of pinned tabs for this window
 * @param {Object} tabs - All tabs map
 * @returns {HTMLElement}
 */
function buildPinnedBar(pinnedIds, tabs, windowId) {
  const bar = el('div', { className: 'window-pinned-bar', dataset: { windowId: `pinned-${windowId}` } });
  for (const id of pinnedIds) {
    const tab = tabs[id];
    if (tab) bar.appendChild(buildPinnedTab(tab));
  }
  return bar;
}

// ---------------------------------------------------------------------------
// Group Header
// ---------------------------------------------------------------------------

/**
 * Builds a group header element.
 *
 * @param {number} groupId
 * @param {Object|undefined} group - Group data { title, color, collapsed }
 * @param {string} resolvedColor - Hex color for the group
 * @param {number} memberCount - Number of tabs in this group
 * @returns {HTMLElement}
 */
function buildGroupHeader(groupId, group, resolvedColor, memberCount) {
  const isCollapsed = group?.collapsed ?? false;

  const chevron = el('span', {
    className: 'group-chevron',
    dataset: { collapsed: String(isCollapsed) },
  }, '\u25B6');

  const title = el('span', { className: 'group-title' },
    group?.title || 'Group');

  const count = el('span', { className: 'group-count' }, String(memberCount));

  const header = el('div', {
    className: 'group-header',
    draggable: 'true',
    dataset: { groupId: String(groupId) },
  }, chevron, title, count);

  // Tint the header background with the group color
  header.style.borderLeft = `3px solid ${resolvedColor}`;

  return header;
}

// ---------------------------------------------------------------------------
// Window Separator
// ---------------------------------------------------------------------------

/**
 * Builds a window separator element.
 *
 * @param {string} label - Display label (e.g., "This Window", "Window 2")
 * @param {boolean} isCollapsible - Whether the separator can be collapsed
 * @param {boolean} isCollapsed - Whether the section is currently collapsed
 * @param {number} windowId - The window ID for click handling
 * @returns {HTMLElement}
 */
function buildWindowSeparator(label, isCollapsible, isCollapsed, windowId) {
  const children = [];

  if (isCollapsible) {
    children.push(el('span', {
      className: 'window-chevron',
      dataset: { collapsed: String(!!isCollapsed) },
    }, '\u25B6'));
  }

  children.push(label);

  const classes = isCollapsible ? 'window-separator window-collapsible' : 'window-separator';
  const dataset = windowId != null ? { windowId: String(windowId) } : {};

  return el('div', { className: classes, dataset }, ...children);
}

// ---------------------------------------------------------------------------
// Keyed DOM Reconciliation
// ---------------------------------------------------------------------------

/**
 * Extracts a stable key from a DOM element for reconciliation.
 * Returns null if the element has no identifiable key.
 */
export function getElementKey(el) {
  if (el.dataset?.tabId) return `tab-${el.dataset.tabId}`;
  if (el.dataset?.groupId) return `group-${el.dataset.groupId}`;
  if (el.dataset?.windowId) return `window-${el.dataset.windowId}`;
  return null;
}

/**
 * Patches an existing DOM element to match an incoming element's state,
 * avoiding full replacement. Only touches attributes that differ.
 */
export function patchElement(existing, incoming) {
  // Window pinned bar: replace children entirely (pinned tab tiles change on pin/unpin/close)
  if (existing.className && existing.className.includes('window-pinned-bar')) {
    if (existing.className !== incoming.className) {
      existing.className = incoming.className;
    }
    for (const key of Object.keys(incoming.dataset)) {
      if (existing.dataset[key] !== incoming.dataset[key]) {
        existing.dataset[key] = incoming.dataset[key];
      }
    }
    const newChildren = [...incoming.children];
    existing.replaceChildren(...newChildren);
    return;
  }

  // className
  if (existing.className !== incoming.className) {
    existing.className = incoming.className;
  }

  // dataset attributes
  for (const key of Object.keys(incoming.dataset)) {
    if (existing.dataset[key] !== incoming.dataset[key]) {
      existing.dataset[key] = incoming.dataset[key];
    }
  }

  // style.cssText (covers borderLeft, backgroundColor, etc.)
  if (existing.style.cssText !== incoming.style.cssText) {
    existing.style.cssText = incoming.style.cssText;
  }

  // Tab-specific patches
  const existingTitle = existing.querySelector?.('.tab-title');
  const incomingTitle = incoming.querySelector?.('.tab-title');
  if (existingTitle && incomingTitle && existingTitle.textContent !== incomingTitle.textContent) {
    existingTitle.textContent = incomingTitle.textContent;
  }

  const existingFav = existing.querySelector?.('.tab-favicon');
  const incomingFav = incoming.querySelector?.('.tab-favicon');
  if (existingFav && incomingFav) {
    const candidateSrc = incomingFav.src;
    const failedSrc = existingFav.dataset.failedSrc;
    if (candidateSrc !== failedSrc && existingFav.src !== candidateSrc) {
      if (failedSrc) delete existingFav.dataset.failedSrc;
      existingFav.src = candidateSrc;
      existingFav.setAttribute('src', candidateSrc);
    }
    armFaviconFallback(existingFav);
  }

  // Badge and note reconciliation — if child count changed (badge added/removed,
  // note subtitle added/removed), fall back to full child replacement to avoid stale DOM.
  if (existing.children.length !== incoming.children.length) {
    const newChildren = [...incoming.children];
    existing.replaceChildren(...newChildren);
    return;
  }

  // Group-specific patches
  const existingGroupTitle = existing.querySelector?.('.group-title');
  const incomingGroupTitle = incoming.querySelector?.('.group-title');
  if (existingGroupTitle && incomingGroupTitle && existingGroupTitle.textContent !== incomingGroupTitle.textContent) {
    existingGroupTitle.textContent = incomingGroupTitle.textContent;
  }

  const existingCount = existing.querySelector?.('.group-count');
  const incomingCount = incoming.querySelector?.('.group-count');
  if (existingCount && incomingCount && existingCount.textContent !== incomingCount.textContent) {
    existingCount.textContent = incomingCount.textContent;
  }

  // Chevron collapsed state (tab-chevron, group-chevron, window-chevron)
  for (const cls of ['.tab-chevron', '.group-chevron', '.window-chevron']) {
    const existingChevron = existing.querySelector?.(cls);
    const incomingChevron = incoming.querySelector?.(cls);
    if (existingChevron && incomingChevron) {
      if (existingChevron.dataset.collapsed !== incomingChevron.dataset.collapsed) {
        existingChevron.dataset.collapsed = incomingChevron.dataset.collapsed;
      }
      // Sync aria-expanded on chevrons
      const incomingExpanded = incomingChevron.getAttribute?.('aria-expanded');
      if (incomingExpanded != null && existingChevron.getAttribute?.('aria-expanded') !== incomingExpanded) {
        existingChevron.setAttribute('aria-expanded', incomingExpanded);
      }
    }
  }

  // Sync aria-current on tab entries (active tab indicator)
  const incomingCurrent = incoming.getAttribute?.('aria-current');
  const existingCurrent = existing.getAttribute?.('aria-current');
  if (incomingCurrent !== existingCurrent) {
    if (incomingCurrent) {
      existing.setAttribute('aria-current', incomingCurrent);
    } else if (existingCurrent) {
      existing.removeAttribute('aria-current');
    }
  }
}

/**
 * Keyed reconciliation: efficiently updates container's children to match
 * newElements by reusing existing DOM nodes where keys match.
 *
 * Algorithm:
 * 1. Build a map of existing children by key.
 * 2. For each new element, reuse+patch if key exists, otherwise insert.
 * 3. Remove any old children not in the new list.
 * 4. Reorder to match the new element order.
 */
export function reconcileChildren(container, newElements) {
  // Build key -> existing element map
  const existingByKey = new Map();
  for (const child of [...container.children]) {
    const key = getElementKey(child);
    if (key) existingByKey.set(key, child);
  }

  // Build the reconciled list
  const reconciledChildren = [];
  const usedKeys = new Set();

  for (const incoming of newElements) {
    const key = getElementKey(incoming);
    if (key && existingByKey.has(key)) {
      const existing = existingByKey.get(key);
      patchElement(existing, incoming);
      reconciledChildren.push(existing);
      usedKeys.add(key);
    } else {
      reconciledChildren.push(incoming);
    }
  }

  // Remove old children not in the new list
  for (const [key, child] of existingByKey) {
    if (!usedKeys.has(key)) {
      child.remove();
    }
  }

  // Reorder: walk through reconciled list and move/insert as needed
  let cursor = container.children[0] || null;
  for (let i = 0; i < reconciledChildren.length; i++) {
    const target = reconciledChildren[i];
    if (target === cursor) {
      // Already in position
      cursor = cursor.nextElementSibling;
    } else if (target.parentNode === container) {
      // Exists but wrong position — move it
      container.insertBefore(target, cursor);
    } else {
      // New element — insert it
      container.insertBefore(target, cursor);
    }
  }

  // Remove any trailing children not in the reconciled list
  while (container.children.length > reconciledChildren.length) {
    container.children[reconciledChildren.length].remove();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the display color for a group.
 * Priority: manual override → Chrome color name → fallback grey.
 */
function resolveGroupColor(groupId, group, groupColors) {
  if (groupColors && groupColors[groupId]) return groupColors[groupId];
  if (group && group.color && CHROME_GROUP_COLORS[group.color]) {
    return CHROME_GROUP_COLORS[group.color];
  }
  return '#666';
}

/**
 * Counts all descendants of a tab recursively.
 */
function countDescendants(tab, tabs) {
  const tabId = tab.tabId ?? tab.id;
  if (_descendantCache && _descendantCache.has(tabId)) {
    return _descendantCache.get(tabId);
  }
  let count = 0;
  const walk = (ids) => {
    for (const id of ids) {
      const child = tabs[id];
      if (child) {
        count++;
        if (child.children && child.children.length > 0) walk(child.children);
      }
    }
  };
  if (tab.children) walk(tab.children);
  if (_descendantCache) _descendantCache.set(tabId, count);
  return count;
}
