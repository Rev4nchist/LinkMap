/**
 * tree-renderer.js — Converts ShadowState payload to DOM tree.
 *
 * Pure rendering module: takes state in, produces DOM elements.
 * No event handling — that lives in sidepanel.js.
 */

import { el } from '../../shared/utils.js';

/** Default favicon for tabs with missing or empty favIconUrl. */
const DEFAULT_FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
  '<circle cx="8" cy="8" r="6" fill="#666"/>' +
  '</svg>'
);

/**
 * Renders the full tab tree into the provided containers.
 *
 * @param {Object} state - Payload from background: { tabs, rootIds, collapsed, groupColors, theme }
 * @param {number|null} activeTabId - Currently active tab ID
 * @param {HTMLElement} container - The #tree-container element
 * @param {HTMLElement} pinnedContainer - The #pinned-list element
 */
export function renderTree(state, activeTabId, container, pinnedContainer) {
  const { tabs, rootIds, collapsed } = state;
  const collapsedSet = new Set(collapsed);

  // Separate pinned from non-pinned tabs
  const pinnedElements = [];
  const treeElements = [];

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
          renderSubtree(child, 0, tabs, collapsedSet, activeTabId, treeElements);
        }
      }
    } else {
      renderSubtree(tab, 0, tabs, collapsedSet, activeTabId, treeElements);
    }
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
 */
function renderSubtree(tab, depth, tabs, collapsedSet, activeTabId, elements) {
  elements.push(buildTabEntry(tab, depth, collapsedSet, activeTabId));

  const isCollapsed = collapsedSet.has(tab.tabId);
  if (!isCollapsed && tab.children && tab.children.length > 0) {
    for (const childId of tab.children) {
      const child = tabs[childId];
      if (!child) continue;
      if (child.pinned) continue; // pinned children go to pinned section
      renderSubtree(child, depth + 1, tabs, collapsedSet, activeTabId, elements);
    }
  }
}

/**
 * Builds a single tab entry DOM element.
 *
 * @param {Object} tab - TabNode
 * @param {number} depth - Nesting depth
 * @param {Set<number>} collapsedSet - Collapsed tab IDs
 * @param {number|null} activeTabId - Active tab ID
 * @returns {HTMLElement}
 */
function buildTabEntry(tab, depth, collapsedSet, activeTabId) {
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

  // Close button
  const closeBtn = el('button', {
    className: 'tab-close',
    title: 'Close tab',
  }, '\u00D7');

  // Entry classes
  const entryClasses = tab.audible
    ? 'tab-entry tab-audible'
    : 'tab-entry';

  return el('div', {
    className: entryClasses,
    dataset: {
      tabId: String(tab.tabId),
      depth: String(depth),
      active: String(isActive),
    },
  }, chevronOrSpacer, favicon, title, closeBtn);
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
