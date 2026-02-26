/**
 * context-menu.js — Custom right-click context menu for tab entries.
 *
 * Exports show/hide/setState helpers consumed by sidepanel.js.
 * Menu items delegate to tab-actions.js for actual operations.
 */

import { el } from '../../shared/utils.js';
import * as actions from './tab-actions.js';

const menuEl = document.getElementById('context-menu');
let currentTabId = null;
let currentState = null;

/**
 * Update the state reference used when building menu items.
 * Called from sidepanel.js on every STATE_UPDATE.
 * @param {Object} state
 */
export function setContextMenuState(state) {
  currentState = state;
}

/**
 * Show context menu at (x, y) for a given tab.
 * @param {number} tabId
 * @param {number} x — clientX
 * @param {number} y — clientY
 */
export function showContextMenu(tabId, x, y) {
  currentTabId = tabId;
  const tab = currentState?.tabs?.[tabId];
  if (!tab) return;

  // Build menu items
  const items = [];

  items.push(menuItem('Close', () => actions.closeTab(tabId)));

  items.push(menuItem('Close Other Tabs', () => {
    const allIds = Object.keys(currentState.tabs).map(Number).filter(id => id !== tabId);
    actions.closeTabs(allIds);
  }));

  items.push(menuItem('Close Tabs Below', () => {
    // Build flat visible order via full tree walk (handles nested tabs)
    const visibleOrder = [];
    const walkTree = (ids) => {
      for (const id of ids) {
        const t = currentState.tabs[id];
        if (!t) continue;
        visibleOrder.push(id);
        if (t.children && t.children.length > 0) {
          walkTree(t.children);
        }
      }
    };
    walkTree(currentState.rootIds);

    const idx = visibleOrder.indexOf(tabId);
    if (idx >= 0) {
      const belowIds = visibleOrder.slice(idx + 1);
      if (belowIds.length > 0) actions.closeTabs(belowIds);
    }
  }));

  // Close Branch — closes tab + all descendants
  const hasChildren = tab.children && tab.children.length > 0;
  if (hasChildren) {
    items.push(menuItem('Close Branch', () => {
      const ids = [tabId, ...getDescendantIds(tabId)];
      actions.closeTabs(ids);
    }));
  }

  items.push(separator());

  items.push(menuItem('Duplicate', () => actions.duplicateTab(tabId)));

  items.push(menuItem(tab.pinned ? 'Unpin' : 'Pin', () => {
    actions.pinTab(tabId, !tab.pinned);
  }));

  items.push(menuItem(tab.audible ? 'Mute Tab' : 'Unmute Tab', () => {
    actions.muteTab(tabId, !tab.audible);
  }));

  // --- Group actions ---
  items.push(separator());

  if (tab.groupId !== undefined && tab.groupId !== -1) {
    items.push(menuItem('Remove from Group', () => {
      chrome.tabs.ungroup(tabId);
    }));
  }

  // Move to existing groups
  const groups = currentState.groups || {};
  for (const [gId, group] of Object.entries(groups)) {
    const groupId = Number(gId);
    if (groupId === tab.groupId) continue;
    const label = group.title ? `Move to "${group.title}"` : `Move to Group`;
    items.push(menuItem(label, () => {
      chrome.tabs.group({ tabIds: [tabId], groupId });
    }));
  }

  items.push(menuItem('New Group', () => {
    chrome.tabs.group({ tabIds: [tabId] });
  }));

  // Render
  menuEl.replaceChildren(...items);
  menuEl.hidden = false;

  // Position — keep within viewport
  const rect = menuEl.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  menuEl.style.left = `${Math.min(x, maxX)}px`;
  menuEl.style.top = `${Math.min(y, maxY)}px`;
}

/**
 * Hide the context menu.
 */
export function hideContextMenu() {
  menuEl.hidden = true;
  currentTabId = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function menuItem(label, onClick, danger = false) {
  const item = el('div', {
    className: `context-menu-item${danger ? ' danger' : ''}`
  }, label);
  item.addEventListener('click', () => {
    onClick();
    hideContextMenu();
  });
  return item;
}

function separator() {
  return el('div', { className: 'context-menu-separator' });
}

/**
 * Collects all descendant tab IDs via tree walk.
 */
function getDescendantIds(tabId) {
  const ids = [];
  const walk = (id) => {
    const tab = currentState?.tabs?.[id];
    if (!tab || !tab.children) return;
    for (const childId of tab.children) {
      ids.push(childId);
      walk(childId);
    }
  };
  walk(tabId);
  return ids;
}

// ---------------------------------------------------------------------------
// Global listeners — dismiss context menu
// ---------------------------------------------------------------------------

document.addEventListener('click', (e) => {
  if (!menuEl.contains(e.target)) {
    hideContextMenu();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideContextMenu();
});
