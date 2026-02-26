/**
 * sidepanel.js — Side panel entry point.
 *
 * Owns message handling, event delegation, and render orchestration.
 * DOM building is delegated to tree-renderer.js.
 */

import { MSG } from '../shared/constants.js';
import { renderTree } from './modules/tree-renderer.js';
import { showContextMenu, hideContextMenu, setContextMenuState } from './modules/context-menu.js';
import { initSearch } from './modules/search.js';
import { initDragDrop } from './modules/drag-drop.js';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const treeContainer = document.getElementById('tree-container');
const pinnedSection = document.getElementById('pinned-tabs');
const pinnedList = document.getElementById('pinned-list');
const tabCountNum = document.getElementById('tab-count-num');
const searchInput = document.getElementById('search-input');
const themeSelect = document.getElementById('theme-select');
const collapseAllBtn = document.getElementById('collapse-all-btn');
const expandAllBtn = document.getElementById('expand-all-btn');
const focusModeBtn = document.getElementById('focus-mode-btn');

// ---------------------------------------------------------------------------
// Current state
// ---------------------------------------------------------------------------

let currentState = null;
let currentActiveTabId = null;
let focusedTabId = null;

// ---------------------------------------------------------------------------
// Drag & Drop
// ---------------------------------------------------------------------------

initDragDrop(treeContainer);

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const search = initSearch(
  searchInput,
  treeContainer,
  () => currentState,
  () => render()
);

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

// Request state from background
chrome.runtime.sendMessage({ type: MSG.GET_STATE }, (response) => {
  if (chrome.runtime.lastError) {
    console.error('[LinkMap] Failed to get state:', chrome.runtime.lastError.message);
    return;
  }
  handleStateUpdate(response);
});

// ---------------------------------------------------------------------------
// Message Listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case MSG.STATE_UPDATE:
      handleStateUpdate(message.payload);
      break;
    case MSG.TAB_ACTIVATED:
      currentActiveTabId = message.payload.tabId;
      render();
      scrollToActiveTab(message.payload.tabId);
      break;
    case MSG.THEME_CHANGED:
      document.documentElement.dataset.theme = message.payload.theme;
      if (themeSelect) themeSelect.value = message.payload.theme;
      break;
  }
});

// ---------------------------------------------------------------------------
// State Handling
// ---------------------------------------------------------------------------

function handleStateUpdate(payload) {
  if (!payload) return;

  currentState = payload;
  currentActiveTabId = payload.activeTabId ?? currentActiveTabId;
  setContextMenuState(currentState);

  // Apply theme
  if (payload.theme) {
    document.documentElement.dataset.theme = payload.theme;
    if (themeSelect) themeSelect.value = payload.theme;
  }

  render();
}

let renderRafId = null;

function render() {
  if (!currentState) return;
  if (search.isActive()) return; // don't overwrite search results

  // Coalesce rapid re-renders via rAF
  if (renderRafId) cancelAnimationFrame(renderRafId);
  renderRafId = requestAnimationFrame(renderNow);
}

function renderNow() {
  renderRafId = null;
  if (!currentState) return;
  if (search.isActive()) return;

  renderTree(currentState, currentActiveTabId, treeContainer, pinnedList);

  // Update pinned section visibility
  const hasPinned = pinnedList.children.length > 0;
  pinnedSection.hidden = !hasPinned;

  // Update tab count
  const tabCount = Object.keys(currentState.tabs).length;
  tabCountNum.textContent = tabCount;

  // Re-apply keyboard focus ring after re-render
  updateFocusRing();
}

// ---------------------------------------------------------------------------
// Scroll-to-Active (Feature 3)
// ---------------------------------------------------------------------------

function scrollToActiveTab(tabId) {
  if (!currentState) return;
  const tab = currentState.tabs[tabId];
  if (!tab) return;

  // Auto-expand collapsed ancestors so the active tab is visible
  const collapsedSet = new Set(currentState.collapsed);
  let parentId = tab.parentId;
  while (parentId != null) {
    if (collapsedSet.has(parentId)) {
      chrome.runtime.sendMessage({
        type: MSG.TOGGLE_COLLAPSE,
        payload: { tabId: parentId },
      }).catch(() => {});
    }
    const parent = currentState.tabs[parentId];
    parentId = parent?.parentId ?? null;
  }

  // Scroll after state updates propagate
  setTimeout(() => {
    const el = treeContainer.querySelector(`[data-tab-id="${tabId}"]`);
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, 100);
}

// ---------------------------------------------------------------------------
// Event Delegation — Tree Container
// ---------------------------------------------------------------------------

// Click handling (event delegation)
treeContainer.addEventListener('click', (e) => {
  // Group header click — optimistic toggle + Chrome API sync
  const groupHeader = e.target.closest('.group-header');
  if (groupHeader) {
    const groupId = Number(groupHeader.dataset.groupId);
    const group = currentState?.groups?.[groupId];
    if (group) {
      // Optimistic: update local state immediately for instant UI
      group.collapsed = !group.collapsed;
      renderNow();
      // Sync with Chrome (background will confirm via broadcast)
      chrome.tabGroups.update(groupId, { collapsed: group.collapsed });
    }
    return;
  }

  const tabEntry = e.target.closest('.tab-entry');
  if (!tabEntry) return;

  const tabId = Number(tabEntry.dataset.tabId);

  // Close button clicked
  if (e.target.closest('.tab-close')) {
    chrome.runtime.sendMessage({ type: MSG.CLOSE_TAB, payload: { tabId } }).catch(() => {});
    return;
  }

  // Chevron clicked (collapse/expand)
  if (e.target.closest('.tab-chevron')) {
    chrome.runtime.sendMessage({ type: MSG.TOGGLE_COLLAPSE, payload: { tabId } }).catch(() => {});
    return;
  }

  // Tab clicked — activate it
  chrome.runtime.sendMessage({ type: MSG.ACTIVATE_TAB, payload: { tabId } }).catch(() => {});
});

// Middle-click to close
treeContainer.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return; // middle click only
  const tabEntry = e.target.closest('.tab-entry');
  if (!tabEntry) return;
  e.preventDefault();
  const tabId = Number(tabEntry.dataset.tabId);
  chrome.runtime.sendMessage({ type: MSG.CLOSE_TAB, payload: { tabId } }).catch(() => {});
});

// Right-click context menu
treeContainer.addEventListener('contextmenu', (e) => {
  const tabEntry = e.target.closest('.tab-entry');
  if (!tabEntry) return;
  e.preventDefault();
  const tabId = Number(tabEntry.dataset.tabId);
  showContextMenu(tabId, e.clientX, e.clientY);
});

// ---------------------------------------------------------------------------
// Event Delegation — Pinned Tabs
// ---------------------------------------------------------------------------

pinnedList.addEventListener('click', (e) => {
  const pinnedTab = e.target.closest('.pinned-tab');
  if (!pinnedTab) return;
  const tabId = Number(pinnedTab.dataset.tabId);
  chrome.runtime.sendMessage({ type: MSG.ACTIVATE_TAB, payload: { tabId } }).catch(() => {});
});

// Right-click context menu on pinned tabs
pinnedList.addEventListener('contextmenu', (e) => {
  const pinnedTab = e.target.closest('.pinned-tab');
  if (!pinnedTab) return;
  e.preventDefault();
  const tabId = Number(pinnedTab.dataset.tabId);
  showContextMenu(tabId, e.clientX, e.clientY);
});

// ---------------------------------------------------------------------------
// Theme Selector
// ---------------------------------------------------------------------------

if (themeSelect) {
  themeSelect.addEventListener('change', (e) => {
    chrome.runtime.sendMessage({ type: MSG.SET_THEME, payload: { theme: e.target.value } }).catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Toolbar Buttons (Feature 1: Collapse All / Expand All / Focus Mode)
// ---------------------------------------------------------------------------

if (collapseAllBtn) {
  collapseAllBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: MSG.COLLAPSE_ALL }).catch(() => {});
  });
}

if (expandAllBtn) {
  expandAllBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: MSG.EXPAND_ALL }).catch(() => {});
  });
}

if (focusModeBtn) {
  focusModeBtn.addEventListener('click', () => {
    if (currentActiveTabId) {
      chrome.runtime.sendMessage({
        type: MSG.FOCUS_MODE,
        payload: { tabId: currentActiveTabId },
      }).catch(() => {});
    }
  });
}

// ---------------------------------------------------------------------------
// Keyboard Navigation (Feature 4)
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  // Skip when search input is focused (except Escape)
  if (document.activeElement === searchInput && e.key !== 'Escape') return;

  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault();
      moveFocus(-1);
      break;

    case 'ArrowDown':
      e.preventDefault();
      moveFocus(1);
      break;

    case 'Enter':
      if (focusedTabId != null) {
        e.preventDefault();
        chrome.runtime.sendMessage({
          type: MSG.ACTIVATE_TAB,
          payload: { tabId: focusedTabId },
        }).catch(() => {});
      }
      break;

    case 'Delete':
      if (focusedTabId != null) {
        e.preventDefault();
        chrome.runtime.sendMessage({
          type: MSG.CLOSE_TAB,
          payload: { tabId: focusedTabId },
        }).catch(() => {});
        focusedTabId = null;
        updateFocusRing();
      }
      break;

    case 'ArrowLeft':
      if (focusedTabId != null) {
        e.preventDefault();
        const tabL = currentState?.tabs?.[focusedTabId];
        if (tabL?.children?.length > 0) {
          const isCollapsed = currentState.collapsed.includes(focusedTabId);
          if (!isCollapsed) {
            chrome.runtime.sendMessage({
              type: MSG.TOGGLE_COLLAPSE,
              payload: { tabId: focusedTabId },
            }).catch(() => {});
          }
        }
      }
      break;

    case 'ArrowRight':
      if (focusedTabId != null) {
        e.preventDefault();
        const tabR = currentState?.tabs?.[focusedTabId];
        if (tabR?.children?.length > 0) {
          const isCollapsed = currentState.collapsed.includes(focusedTabId);
          if (isCollapsed) {
            chrome.runtime.sendMessage({
              type: MSG.TOGGLE_COLLAPSE,
              payload: { tabId: focusedTabId },
            }).catch(() => {});
          }
        }
      }
      break;

    case 'Home':
      e.preventDefault();
      focusFirst();
      break;

    case 'End':
      e.preventDefault();
      focusLast();
      break;

    case 'Escape':
      if (document.activeElement === searchInput) return; // let search handle it
      focusedTabId = null;
      updateFocusRing();
      break;
  }
});

/**
 * Returns visible tab IDs in DOM order from the tree container.
 */
function getVisibleTabIds() {
  const entries = treeContainer.querySelectorAll('.tab-entry[data-tab-id]');
  return [...entries].map((el) => Number(el.dataset.tabId));
}

/**
 * Moves keyboard focus up or down.
 */
function moveFocus(direction) {
  const visibleIds = getVisibleTabIds();
  if (visibleIds.length === 0) return;

  if (focusedTabId == null) {
    focusedTabId = visibleIds[direction > 0 ? 0 : visibleIds.length - 1];
  } else {
    const currentIdx = visibleIds.indexOf(focusedTabId);
    if (currentIdx === -1) {
      focusedTabId = visibleIds[0];
    } else {
      const nextIdx = Math.max(0, Math.min(visibleIds.length - 1, currentIdx + direction));
      focusedTabId = visibleIds[nextIdx];
    }
  }
  updateFocusRing();
}

function focusFirst() {
  const visibleIds = getVisibleTabIds();
  if (visibleIds.length > 0) {
    focusedTabId = visibleIds[0];
    updateFocusRing();
  }
}

function focusLast() {
  const visibleIds = getVisibleTabIds();
  if (visibleIds.length > 0) {
    focusedTabId = visibleIds[visibleIds.length - 1];
    updateFocusRing();
  }
}

/**
 * Updates the visual focus ring on the focused tab entry.
 */
function updateFocusRing() {
  // Clear all existing focus indicators
  treeContainer.querySelectorAll('[data-focused]').forEach((el) => {
    delete el.dataset.focused;
  });

  if (focusedTabId != null) {
    const el = treeContainer.querySelector(`[data-tab-id="${focusedTabId}"]`);
    if (el) {
      el.dataset.focused = 'true';
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
}

// ---------------------------------------------------------------------------
// Settings Panel — Group Color Customization
// ---------------------------------------------------------------------------

const settingsBtn = document.getElementById('settings-btn');
let settingsOpen = false;

settingsBtn.addEventListener('click', () => {
  settingsOpen = !settingsOpen;
  if (settingsOpen) {
    showSettings();
  } else {
    hideSettings();
  }
});

function showSettings() {
  hideSettings(); // remove stale panel first

  const panel = document.createElement('div');
  panel.id = 'settings-panel';
  panel.className = 'settings-panel';

  if (!currentState) {
    panel.innerHTML = `
      <div class="settings-section">
        <div class="settings-label">Settings</div>
        <div class="settings-hint">Loading state...</div>
      </div>
    `;
    treeContainer.before(panel);
    return;
  }

  // Collect unique non-default groupIds from current tabs
  const groups = new Set();
  for (const tab of Object.values(currentState.tabs)) {
    if (tab.groupId !== undefined && tab.groupId !== -1) {
      groups.add(tab.groupId);
    }
  }

  if (groups.size === 0) {
    panel.innerHTML = `
      <div class="settings-section">
        <div class="settings-label">Group Colors</div>
        <div class="settings-hint">No tab groups found. Create tab groups in Chrome to customize their colors here.</div>
      </div>
    `;
    treeContainer.before(panel);
    return;
  }

  let html = '<div class="settings-section"><div class="settings-label">Group Colors</div>';
  for (const groupId of groups) {
    const currentColor = currentState.groupColors?.[groupId] || '#6c8cff';
    html += `
      <div class="group-color-row">
        <span class="group-id-label">Group ${groupId}</span>
        <input type="color" class="group-color-input" data-group-id="${groupId}" value="${currentColor}">
      </div>
    `;
  }
  html += '</div>';
  panel.innerHTML = html;

  panel.addEventListener('input', (e) => {
    if (!e.target.classList.contains('group-color-input')) return;
    const groupId = Number(e.target.dataset.groupId);
    const color = e.target.value;
    chrome.runtime.sendMessage({ type: MSG.SET_GROUP_COLOR, payload: { groupId, color } }).catch(() => {});
  });

  treeContainer.before(panel);
}

function hideSettings() {
  const panel = document.getElementById('settings-panel');
  if (panel) panel.remove();
}

console.log('[LinkMap] Side panel loaded');
