/**
 * tree-renderer.js — Converts ShadowState payload to DOM tree.
 *
 * Pure rendering module: takes state in, produces DOM elements.
 * No event handling — that lives in sidepanel.js.
 */

import { el } from '../../shared/utils.js';
import { CHROME_GROUP_COLORS } from '../../shared/constants.js';

/** Default favicon for tabs with missing or empty favIconUrl. */
export const DEFAULT_FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
  '<circle cx="8" cy="8" r="6" fill="#666"/>' +
  '</svg>'
);

/**
 * Renders the full tab tree into the provided containers.
 *
 * @param {Object} state - Payload from background: { tabs, rootIds, collapsed, groups, groupColors, theme }
 * @param {number|null} activeTabId - Currently active tab ID
 * @param {HTMLElement} container - The #tree-container element
 * @param {HTMLElement} pinnedContainer - The #pinned-list element
 */
export function renderTree(state, activeTabId, container, pinnedContainer) {
  const { tabs, rootIds, collapsed, groupColors, groups } = state;
  const collapsedSet = new Set(collapsed);
  const groupsMap = groups || {};

  // Separate pinned from non-pinned tabs
  const pinnedElements = [];
  const treeElements = [];
  let lastGroupId = null;

  for (const rootId of rootIds) {
    const tab = tabs[rootId];
    if (!tab) continue;

    if (tab.pinned) {
      pinnedElements.push(buildPinnedTab(tab));
      // Pinned tab's non-pinned children still render in the tree
      if (tab.children && tab.children.length > 0) {
        for (const childId of tab.children) {
          const child = tabs[childId];
          if (!child || child.pinned) continue;
          renderSubtree(child, 0, tabs, collapsedSet, activeTabId, treeElements, groupColors, groupsMap);
        }
      }
      continue;
    }

    const groupId = tab.groupId ?? -1;

    // Insert group header when entering a new group cluster
    if (groupId !== -1 && groupId !== lastGroupId) {
      const group = groupsMap[groupId];
      const memberCount = countGroupMembers(rootIds, tabs, groupId);
      const resolvedColor = resolveGroupColor(groupId, group, groupColors);
      treeElements.push(buildGroupHeader(groupId, group, resolvedColor, memberCount));
    }
    lastGroupId = groupId;

    // Skip tabs in collapsed Chrome groups (group header remains visible)
    if (groupId !== -1) {
      const group = groupsMap[groupId];
      if (group && group.collapsed) continue;
    }

    renderSubtree(tab, 0, tabs, collapsedSet, activeTabId, treeElements, groupColors, groupsMap);
  }

  // Swap DOM content
  pinnedContainer.replaceChildren(...pinnedElements);
  container.replaceChildren(...treeElements);
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
function renderSubtree(tab, depth, tabs, collapsedSet, activeTabId, elements, groupColors, groupsMap) {
  elements.push(buildTabEntry(tab, depth, tabs, collapsedSet, activeTabId, groupColors, groupsMap));

  const isCollapsed = collapsedSet.has(tab.tabId);
  if (!isCollapsed && tab.children && tab.children.length > 0) {
    for (const childId of tab.children) {
      const child = tabs[childId];
      if (!child) continue;
      if (child.pinned) continue; // pinned children go to pinned section
      renderSubtree(child, depth + 1, tabs, collapsedSet, activeTabId, elements, groupColors, groupsMap);
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
function buildTabEntry(tab, depth, tabs, collapsedSet, activeTabId, groupColors, groupsMap) {
  const hasChildren = tab.children && tab.children.length > 0;
  const isActive = tab.tabId === activeTabId;
  const isCollapsed = collapsedSet.has(tab.tabId);

  // Chevron or spacer
  const chevronOrSpacer = hasChildren
    ? el('span', {
        className: 'tab-chevron',
        dataset: { collapsed: String(isCollapsed) },
      }, '\u25B6')
    : el('div', { className: 'tab-chevron-spacer', style: 'width:16px' });

  // Favicon
  const faviconSrc = tab.favIconUrl || DEFAULT_FAVICON;
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

  // Build children array for el()
  const children = [chevronOrSpacer, favicon, title];
  if (badge) children.push(badge);
  children.push(closeBtn);

  const entry = el('div', {
    className: entryClasses,
    draggable: 'true',
    dataset: {
      tabId: String(tab.tabId),
      depth: String(depth),
      active: String(isActive),
    },
  }, ...children);

  // Apply group color as left border accent
  if (tab.groupId !== undefined && tab.groupId !== -1) {
    const group = groupsMap?.[tab.groupId];
    const groupColor = resolveGroupColor(tab.groupId, group, groupColors);
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
function buildPinnedTab(tab) {
  const faviconSrc = tab.favIconUrl || DEFAULT_FAVICON;

  const favicon = el('img', {
    src: faviconSrc,
    width: '16',
    height: '16',
    alt: '',
  });

  return el('div', {
    className: 'pinned-tab',
    dataset: { tabId: String(tab.tabId) },
    title: tab.title || tab.url || '',
  }, favicon);
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

  const swatch = el('span', { className: 'group-color-swatch' });
  swatch.style.backgroundColor = resolvedColor;

  const title = el('span', { className: 'group-title' },
    group?.title || 'Group');

  const count = el('span', { className: 'group-count' }, String(memberCount));

  const header = el('div', {
    className: 'group-header',
    dataset: { groupId: String(groupId) },
  }, chevron, swatch, title, count);

  // Tint the header background with the group color
  header.style.borderLeft = `3px solid ${resolvedColor}`;

  return header;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Counts root-level tabs belonging to a group.
 */
function countGroupMembers(rootIds, tabs, groupId) {
  let count = 0;
  for (const id of rootIds) {
    const tab = tabs[id];
    if (tab && tab.groupId === groupId) count++;
  }
  return count;
}

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
  return count;
}
