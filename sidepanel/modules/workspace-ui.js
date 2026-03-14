/**
 * workspace-ui.js — Workspace switcher bar and management UI.
 *
 * Renders workspace pills above the footer. Supports create, switch,
 * rename, delete, and "Move to Workspace" in context menus.
 */

import { MSG } from '../../shared/constants.js';
import { el, positionMenu, inlinePrompt } from '../../shared/utils.js';

let currentState = null;
let containerEl = null;
let onWorkspaceChange = null;

/**
 * Initialize the workspace UI.
 * @param {HTMLElement} container - The #workspace-bar element
 * @param {Function} onChange - Called when workspace filter changes (triggers re-render)
 */
export function initWorkspaceUI(container, onChange) {
  containerEl = container;
  onWorkspaceChange = onChange;
  container.addEventListener('click', handleBarClick);
  container.addEventListener('contextmenu', handleBarContextMenu);
}

/**
 * Update workspace state from STATE_UPDATE.
 * @param {Object} state
 */
export function setWorkspaceState(state) {
  currentState = state;
  renderBar();
}

/**
 * Get the active workspace ID (or null for "All Tabs").
 * @returns {string|null}
 */
export function getActiveWorkspaceId() {
  return currentState?.activeWorkspaceId || null;
}

/**
 * Get tab IDs belonging to the active workspace.
 * Returns null if no workspace is active (show all tabs).
 * @returns {Set<number>|null}
 */
export function getActiveWorkspaceTabIds() {
  if (!currentState?.activeWorkspaceId) return null;
  const ws = (currentState.workspaces || []).find(w => w.id === currentState.activeWorkspaceId);
  if (!ws) return null;
  return new Set(ws.tabIds || []);
}

/**
 * Build "Move to Workspace" menu items for the context menu.
 * @param {number} tabId
 * @param {Function} menuItemFn - The menuItem(label, onClick) factory
 * @param {Function} separatorFn - The separator() factory
 * @returns {HTMLElement[]}
 */
export function buildWorkspaceMenuItems(tabId, menuItemFn, separatorFn) {
  const items = [];
  const workspaces = currentState?.workspaces || [];
  if (workspaces.length === 0) return items;

  items.push(separatorFn());

  for (const ws of workspaces) {
    // Skip if tab is already in this workspace
    if (ws.tabIds && ws.tabIds.includes(tabId)) continue;
    items.push(menuItemFn(`Move to "${ws.name}"`, () => {
      chrome.runtime.sendMessage({
        type: MSG.MOVE_TO_WORKSPACE,
        payload: { tabId, workspaceId: ws.id },
      }).catch(() => {});
    }));
  }

  return items;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderBar() {
  if (!containerEl) return;
  const workspaces = currentState?.workspaces || [];
  const activeId = currentState?.activeWorkspaceId || null;

  containerEl.innerHTML = '';

  // "All" pill — always present
  const allPill = el('button', {
    className: `ws-pill${!activeId ? ' ws-pill-active' : ''}`,
    dataset: { wsId: '' },
  }, 'All');
  containerEl.appendChild(allPill);

  // Workspace pills
  for (const ws of workspaces) {
    const isActive = ws.id === activeId;
    const pill = el('button', {
      className: `ws-pill${isActive ? ' ws-pill-active' : ''}`,
      dataset: { wsId: ws.id },
    });
    // Color dot
    const dot = el('span', { className: 'ws-pill-dot' });
    dot.style.backgroundColor = ws.color || '#c084fc';
    pill.appendChild(dot);
    pill.appendChild(document.createTextNode(ws.name || 'Untitled'));

    // Tab count badge
    const count = (ws.tabIds || []).length;
    if (count > 0) {
      const badge = el('span', { className: 'ws-pill-count' }, String(count));
      pill.appendChild(badge);
    }

    containerEl.appendChild(pill);
  }

  // "+" button
  const addBtn = el('button', {
    className: 'ws-add-btn',
    title: 'New Workspace',
  }, '+');
  containerEl.appendChild(addBtn);

  // Show the bar only if there are workspaces (or always show for discoverability)
  containerEl.hidden = false;
}

// ---------------------------------------------------------------------------
// Event Handlers
// ---------------------------------------------------------------------------

function handleBarClick(e) {
  // "+" button
  const addBtn = e.target.closest('.ws-add-btn');
  if (addBtn) {
    (async () => {
      const name = await inlinePrompt(addBtn, 'Workspace name');
      if (name) {
        chrome.runtime.sendMessage({
          type: MSG.CREATE_WORKSPACE,
          payload: { name },
        }).catch(() => {});
      }
    })();
    return;
  }

  // Pill click — switch workspace
  const pill = e.target.closest('.ws-pill');
  if (pill) {
    const wsId = pill.dataset.wsId || null;
    chrome.runtime.sendMessage({
      type: MSG.SWITCH_WORKSPACE,
      payload: { workspaceId: wsId },
    }).catch(() => {});
    if (onWorkspaceChange) onWorkspaceChange();
  }
}

function handleBarContextMenu(e) {
  const pill = e.target.closest('.ws-pill');
  if (!pill) return;
  const wsId = pill.dataset.wsId;
  if (!wsId) return; // can't edit "All"

  e.preventDefault();
  showWorkspaceContextMenu(wsId, e.clientX, e.clientY);
}

// ---------------------------------------------------------------------------
// Workspace Context Menu (inline, reuses main context menu element)
// ---------------------------------------------------------------------------

function showWorkspaceContextMenu(wsId, x, y) {
  const menuEl = document.getElementById('context-menu');
  if (!menuEl) return;

  const ws = (currentState?.workspaces || []).find(w => w.id === wsId);
  if (!ws) return;

  const items = [];

  // Rename
  const renameItem = el('div', { className: 'context-menu-item' }, 'Rename');
  renameItem.addEventListener('click', async () => {
    menuEl.hidden = true;
    const pill = containerEl?.querySelector(`[data-ws-id="${wsId}"]`);
    const anchor = pill || containerEl;
    const newName = await inlinePrompt(anchor, 'Rename workspace', ws.name);
    if (newName) {
      chrome.runtime.sendMessage({
        type: MSG.RENAME_WORKSPACE,
        payload: { workspaceId: wsId, name: newName },
      }).catch(() => {});
    }
  });
  items.push(renameItem);

  // Change color
  const colorItem = el('div', { className: 'context-menu-item' }, 'Change Color');
  colorItem.addEventListener('click', () => {
    // Cycle through preset colors
    const colors = ['#c084fc', '#f472b6', '#fb923c', '#facc15', '#4ade80', '#22d3ee', '#60a5fa', '#a78bfa'];
    const currentIdx = colors.indexOf(ws.color);
    const nextColor = colors[(currentIdx + 1) % colors.length];
    chrome.runtime.sendMessage({
      type: MSG.UPDATE_WORKSPACE,
      payload: { workspaceId: wsId, color: nextColor },
    }).catch(() => {});
    menuEl.hidden = true;
  });
  items.push(colorItem);

  // Separator
  items.push(el('div', { className: 'context-menu-separator' }));

  // Delete
  const deleteItem = el('div', { className: 'context-menu-item danger' }, 'Delete Workspace');
  deleteItem.addEventListener('click', () => {
    chrome.runtime.sendMessage({
      type: MSG.DELETE_WORKSPACE,
      payload: { workspaceId: wsId },
    }).catch(() => {});
    menuEl.hidden = true;
  });
  items.push(deleteItem);

  menuEl.replaceChildren(...items);
  menuEl.hidden = false;

  // Position
  requestAnimationFrame(() => positionMenu(menuEl, x, y));
}
