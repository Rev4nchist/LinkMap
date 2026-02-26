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
    const rootIds = currentState.rootIds;
    const idx = rootIds.indexOf(tabId);
    if (idx >= 0) {
      const belowIds = rootIds.slice(idx + 1);
      actions.closeTabs(belowIds);
    }
  }));

  items.push(separator());

  items.push(menuItem('Duplicate', () => actions.duplicateTab(tabId)));

  items.push(menuItem(tab.pinned ? 'Unpin' : 'Pin', () => {
    actions.pinTab(tabId, !tab.pinned);
  }));

  items.push(menuItem(tab.audible ? 'Mute Tab' : 'Unmute Tab', () => {
    actions.muteTab(tabId, !tab.audible);
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
