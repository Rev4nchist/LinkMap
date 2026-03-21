/**
 * context-menu.js — Custom right-click context menu for tab entries.
 *
 * Exports show/hide/setState helpers consumed by sidepanel.js.
 * Menu items delegate to tab-actions.js for actual operations.
 */

import { el, getDescendantIds, generateThemePalette, getGroupTabIds, getGroupDisplayOrder, positionMenu, inlinePrompt } from '../../shared/utils.js';
import { MSG, THEME_ACCENTS, UNGROUPED_GROUP_ID } from '../../shared/constants.js';
import * as actions from './tab-actions.js';
import { buildWorkspaceMenuItems } from './workspace-ui.js';

const menuEl = document.getElementById('context-menu');
let currentTabId = null;
let currentGroupId = null;

// State pattern: module-level mutable state updated via setContextMenuState().
// Alternative pattern (used by search.js): closure-based getState() callback.
// Both are valid — this module uses module-level state for simplicity since
// menu items reference state at click-time, not at render-time.
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

  // Close Branch — closes tab + all descendants
  const hasChildren = tab.children && tab.children.length > 0;
  if (hasChildren) {
    items.push(menuItem('Close Branch', () => {
      const ids = [tabId, ...getDescendantIds(currentState.tabs, tabId)];
      actions.closeTabs(ids);
    }));
  }

  items.push(separator());

  items.push(menuItem('New Tab Below', () => actions.newTabBelow(tabId)));
  items.push(menuItem('Duplicate', () => actions.duplicateTab(tabId)));

  items.push(menuItem(tab.pinned ? 'Unpin' : 'Pin', () => {
    actions.pinTab(tabId, !tab.pinned);
  }));

  items.push(menuItem(tab.muted ? 'Unmute Tab' : 'Mute Tab', () => {
    actions.muteTab(tabId, !tab.muted);
  }));

  if (tab.url) {
    items.push(menuItem('Copy URL', () => {
      navigator.clipboard.writeText(tab.url).catch(() => {});
    }));
  }

  items.push(menuItem('Reload', () => actions.reloadTab(tabId)));

  // Add Note
  const existingNote = currentState.tabNotes?.[tabId] || '';
  items.push(menuItem(existingNote ? 'Edit Note' : 'Add Note', async () => {
    const anchor = document.querySelector(`[data-tab-id="${tabId}"] .tab-title`);
    if (!anchor) return;
    const note = await inlinePrompt(anchor, 'Tab note', existingNote);
    if (note !== null) {
      chrome.runtime.sendMessage({
        type: MSG.SET_TAB_NOTE,
        payload: { tabId, note },
      }).catch(() => {});
    }
  }));

  // Sleep Tab — only show if not active and not already discarded
  if (tabId !== currentState.activeTabId && tab.status !== 'unloaded') {
    items.push(menuItem('Sleep Tab', () => actions.discardTabs([tabId])));
  }

  items.push(menuItem('Move to New Window', () => actions.moveToNewWindow(tabId)));

  // Close Duplicates — show if this tab has duplicates
  if (currentState.duplicates) {
    for (const ids of Object.values(currentState.duplicates)) {
      if (ids.includes(tabId) && ids.length > 1) {
        items.push(menuItem('Close Duplicates', () => {
          chrome.runtime.sendMessage({
            type: MSG.CLOSE_DUPLICATES,
            payload: { url: tab.url },
          }).catch(() => {});
        }));
        break;
      }
    }
  }

  // --- Group actions ---
  items.push(separator());

  if (tab.groupId !== undefined && tab.groupId !== UNGROUPED_GROUP_ID) {
    items.push(menuItem('Remove from Group', () => {
      actions.ungroupTabs([tabId]);
    }));
  }

  // Move to existing groups — dual-source discovery + sidebar ordering
  const stateGroups = currentState.groups || {};
  const allGroups = new Map();
  for (const [gId, group] of Object.entries(stateGroups)) {
    allGroups.set(Number(gId), group);
  }
  // Defense-in-depth: catch groups state missed (tab has groupId but state.groups doesn't)
  for (const t of Object.values(currentState.tabs)) {
    const gid = t.groupId ?? UNGROUPED_GROUP_ID;
    if (gid !== UNGROUPED_GROUP_ID && !allGroups.has(gid)) {
      allGroups.set(gid, { id: gid, title: '', color: 'grey' });
    }
  }

  // Sort by sidebar display order (first occurrence in rootIds)
  const groupOrder = getGroupDisplayOrder(currentState.tabs, currentState.rootIds, UNGROUPED_GROUP_ID);
  const sortedGroups = [...allGroups.entries()].sort((a, b) => {
    return (groupOrder.get(a[0]) ?? Infinity) - (groupOrder.get(b[0]) ?? Infinity);
  });

  for (const [groupId, group] of sortedGroups) {
    if (groupId === tab.groupId) continue;
    const label = group.title
      ? `Move to "${group.title}"`
      : `Move to Group ${groupId}`;
    items.push(menuItem(label, () => {
      actions.moveToGroup(tabId, groupId);
    }));
  }

  items.push(menuItem('New Group', async () => {
    const result = await actions.moveToGroup(tabId, null);
    if (result?.groupId != null) {
      setTimeout(() => showGroupContextMenu(result.groupId, x, y), 150);
    }
  }));

  // --- Workspace actions ---
  const wsItems = buildWorkspaceMenuItems(tabId, menuItem, separator);
  items.push(...wsItems);

  // Render
  menuEl.replaceChildren(...items);
  menuEl.hidden = false;
  positionMenu(menuEl, x, y);
}

/**
 * Hide the context menu.
 */
export function hideContextMenu() {
  menuEl.hidden = true;
  currentTabId = null;
  currentGroupId = null;
}

/**
 * Show context menu at (x, y) for a given tab group header.
 * @param {number} groupId
 * @param {number} x — clientX
 * @param {number} y — clientY
 */
export function showGroupContextMenu(groupId, x, y) {
  currentGroupId = groupId;
  const group = currentState?.groups?.[groupId];
  if (!group) return;

  const items = [];

  // --- Rename input ---
  const renameWrapper = el('div', { className: 'context-menu-rename' });
  const renameInput = document.createElement('input');
  renameInput.type = 'text';
  renameInput.className = 'context-menu-rename-input';
  renameInput.value = group.title || '';
  renameInput.placeholder = 'Group name';

  let renameCommitted = false;
  const commitRename = () => {
    if (renameCommitted) return;
    renameCommitted = true;
    const newTitle = renameInput.value.trim();
    if (!newTitle) return;
    // Route through background for reliable state update + Chrome sync
    chrome.runtime.sendMessage({
      type: MSG.RENAME_GROUP,
      payload: { groupId, title: newTitle },
    }).catch(e => console.warn('[LinkMap]', e));
  };
  renameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { commitRename(); hideContextMenu(); }
    if (e.key === 'Escape') { renameCommitted = true; hideContextMenu(); }
  });
  renameInput.addEventListener('click', (e) => e.stopPropagation());
  renameInput.addEventListener('mousedown', (e) => e.stopPropagation());
  renameInput.addEventListener('blur', () => commitRename());

  renameWrapper.appendChild(renameInput);
  items.push(renameWrapper);

  items.push(separator());

  // --- Color palette (theme palette only) ---
  const colorSection = el('div', { className: 'context-menu-color-picker' });
  colorSection.addEventListener('click', (e) => e.stopPropagation());

  const themePalette = generateThemePalette(currentState.theme, THEME_ACCENTS);
  const themeLabel = el('div', { className: 'context-menu-label' }, 'Theme Palette');
  const themeRow = el('div', { className: 'context-menu-color-row theme-palette-row' });
  for (const hex of themePalette) {
    const swatch = el('div', { className: 'context-menu-color-swatch theme-swatch' });
    swatch.style.backgroundColor = hex;
    swatch.title = hex;
    const currentHex = currentState.groupColors?.[groupId];
    if (currentHex === hex) swatch.classList.add('active');
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
      chrome.runtime.sendMessage({
        type: MSG.SET_GROUP_COLOR,
        payload: { groupId, color: hex },
      }).catch(e2 => console.warn('[LinkMap]', e2));
      hideContextMenu();
    });
    themeRow.appendChild(swatch);
  }
  colorSection.appendChild(themeLabel);
  colorSection.appendChild(themeRow);

  items.push(colorSection);

  items.push(separator());

  // --- Add New Tab to Group ---
  items.push(menuItem('Add New Tab', () => {
    chrome.runtime.sendMessage({ type: MSG.NEW_TAB_IN_GROUP, payload: { groupId } }).catch(() => {});
  }));

  // --- Save Group ---
  items.push(menuItem('Save Group', () => {
    chrome.runtime.sendMessage({ type: MSG.SAVE_GROUP, payload: { groupId } }).catch(err => {
      console.warn('[LinkMap] SAVE_GROUP failed:', err);
    });
  }));

  // --- Sleep All Tabs ---
  items.push(menuItem('Sleep All Tabs', () => {
    actions.discardTabs(getGroupTabIds(currentState.tabs, groupId));
  }));

  items.push(separator());

  // --- Delete Group (danger) ---
  items.push(menuItem('Delete Group', () => {
    const tabIds = getGroupTabIds(currentState.tabs, groupId);
    if (tabIds.length > 0) actions.ungroupTabs(tabIds);
  }, true));

  // Render
  menuEl.replaceChildren(...items);
  menuEl.hidden = false;
  positionMenu(menuEl, x, y);

  // Auto-focus rename input
  requestAnimationFrame(() => {
    renameInput.focus();
    renameInput.select();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function menuItem(label, onClick, danger = false) {
  const item = el('div', {
    className: `context-menu-item${danger ? ' danger' : ''}`
  }, label);
  item.setAttribute('role', 'menuitem');
  item.addEventListener('click', () => {
    onClick();
    hideContextMenu();
  });
  return item;
}

function separator() {
  const sep = el('div', { className: 'context-menu-separator' });
  sep.setAttribute('role', 'separator');
  return sep;
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
