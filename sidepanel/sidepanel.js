/**
 * sidepanel.js — Side panel entry point.
 *
 * Owns message handling, event delegation, and render orchestration.
 * DOM building is delegated to tree-renderer.js.
 */

import { MSG, THEME_ACCENTS, UNGROUPED_GROUP_ID } from '../shared/constants.js';
import { escapeHtml, generateThemePalette } from '../shared/utils.js';
import { renderTree } from './modules/tree-renderer.js';
import { showContextMenu, showGroupContextMenu, hideContextMenu, setContextMenuState } from './modules/context-menu.js';
import { initSearch } from './modules/search.js';
import { initDragDrop, initPinnedDragDrop } from './modules/drag-drop.js';
import { undoCloseTab, toggleSessionManager, toggleRecentlyClosed, closeSessionManager, closeRecentlyClosed, setSessionState } from './modules/session-manager.js';
import { toggleCommandPalette, setCommandPaletteState, closeCommandPalette } from './modules/command-palette.js';
import { initWorkspaceUI, setWorkspaceState, getActiveWorkspaceTabIds } from './modules/workspace-ui.js';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const treeContainer = document.getElementById('tree-container');
const pinnedSection = document.getElementById('pinned-tabs');
const pinnedList = document.getElementById('pinned-list');
const tabCountNum = document.getElementById('tab-count-num');
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
const themeSelect = document.getElementById('theme-select');
const undoCloseBtn = document.getElementById('undo-close-btn');
const sessionsBtn = document.getElementById('sessions-btn');
const recentlyClosedBtn = document.getElementById('recently-closed-btn');
const collapseAllBtn = document.getElementById('collapse-all-btn');
const expandAllBtn = document.getElementById('expand-all-btn');
const focusModeBtn = document.getElementById('focus-mode-btn');
const workspaceBar = document.getElementById('workspace-bar');
const addNewTabBtn = document.getElementById('add-new-tab-btn');

// ---------------------------------------------------------------------------
// Current state
// ---------------------------------------------------------------------------

let currentState = null;
let currentActiveTabId = null;
let focusedTabId = null;
let homeWindowId = null;
let collapsedWindowIds = new Set();
let selectedTabIds = new Set();

// Query the side panel's own window once at init (stable, never changes)
chrome.windows.getCurrent().then(win => { homeWindowId = win.id; });

// ---------------------------------------------------------------------------
// Drag & Drop
// ---------------------------------------------------------------------------

initDragDrop(treeContainer);
initPinnedDragDrop(pinnedList);

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

initWorkspaceUI(workspaceBar, () => render());

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const search = initSearch(
  searchInput,
  treeContainer,
  () => currentState,
  () => render()
);

// Show/hide clear button based on search input content
searchInput.addEventListener('input', () => {
  searchClear.hidden = !searchInput.value;
});

searchClear.addEventListener('click', () => {
  search.clear();
  searchClear.hidden = true;
  searchInput.focus();
});

// Hide clear button when Escape clears the input (search.js sets value = '' directly)
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') searchClear.hidden = true;
});

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
    case 'CRASH_RECOVERY':
      showCrashRecoveryBanner(message.payload);
      break;
    case 'FOCUS_SEARCH':
      searchInput.focus();
      searchInput.select();
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
  setSessionState(currentState);
  setCommandPaletteState(currentState);
  setWorkspaceState(currentState);

  // Apply theme
  if (payload.theme) {
    document.documentElement.dataset.theme = payload.theme;
    if (themeSelect) themeSelect.value = payload.theme;
  }

  render();
}

let renderRafId = null;
let pendingScrollTabId = null;

/**
 * Filters state to only include tabs in the active workspace.
 * @param {Object} state - Full state payload
 * @param {Set<number>} wsTabIds - Tab IDs in the active workspace
 * @returns {Object} Filtered state with same shape
 */
function filterStateByWorkspace(state, wsTabIds) {
  const filteredTabs = {};
  for (const [id, tab] of Object.entries(state.tabs)) {
    if (wsTabIds.has(Number(id))) {
      filteredTabs[id] = tab;
    }
  }
  const filteredRootIds = state.rootIds.filter(id => wsTabIds.has(id));
  return {
    ...state,
    tabs: filteredTabs,
    rootIds: filteredRootIds,
  };
}

function render() {
  // Coalesce rapid re-renders via rAF
  if (renderRafId) cancelAnimationFrame(renderRafId);
  renderRafId = requestAnimationFrame(renderNow);
}

function renderNow() {
  renderRafId = null;
  if (!currentState) return;
  if (search.isActive()) return;

  // Workspace filtering: if a workspace is active, build a filtered state
  const wsTabIds = getActiveWorkspaceTabIds();
  const stateToRender = wsTabIds ? filterStateByWorkspace(currentState, wsTabIds) : currentState;

  renderTree(stateToRender, currentActiveTabId, treeContainer, pinnedList, homeWindowId, collapsedWindowIds);

  // Update pinned section visibility
  const hasPinned = pinnedList.children.length > 0;
  pinnedSection.hidden = !hasPinned;

  // Update tab count (reflect workspace filter)
  const tabCount = Object.keys(stateToRender.tabs).length;
  tabCountNum.textContent = tabCount;

  // Re-apply keyboard focus ring after re-render
  updateFocusRing();

  // Post-render scroll (replaces setTimeout-based scrollToActiveTab)
  if (pendingScrollTabId != null) {
    const scrollId = pendingScrollTabId;
    pendingScrollTabId = null;
    const el = treeContainer.querySelector(`[data-tab-id="${scrollId}"]`);
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
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

  // Schedule scroll for after next render cycle
  pendingScrollTabId = tabId;
  render();
}

// ---------------------------------------------------------------------------
// Event Delegation — Tree Container
// ---------------------------------------------------------------------------

// Click handling (event delegation)
treeContainer.addEventListener('click', (e) => {
  // Window separator click — toggle collapse for non-home windows
  const windowSep = e.target.closest('.window-separator');
  if (windowSep) {
    const wid = Number(windowSep.dataset.windowId);
    if (wid && wid !== homeWindowId) {
      if (collapsedWindowIds.has(wid)) {
        collapsedWindowIds.delete(wid);
      } else {
        collapsedWindowIds.add(wid);
      }
      render();
    }
    return;
  }

  // Group header click — route through background to avoid race conditions
  const groupHeader = e.target.closest('.group-header');
  if (groupHeader) {
    const groupId = Number(groupHeader.dataset.groupId);
    chrome.runtime.sendMessage({
      type: MSG.TOGGLE_GROUP_COLLAPSE,
      payload: { groupId },
    }).catch(() => {});
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

  // Ctrl+Click — multi-select
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    if (selectedTabIds.has(tabId)) {
      selectedTabIds.delete(tabId);
    } else {
      selectedTabIds.add(tabId);
    }
    updateMultiSelectUI();
    return;
  }

  // Shift+Click — range select
  if (e.shiftKey && focusedTabId != null) {
    e.preventDefault();
    const visibleIds = getVisibleTabIds();
    const startIdx = visibleIds.indexOf(focusedTabId);
    const endIdx = visibleIds.indexOf(tabId);
    if (startIdx !== -1 && endIdx !== -1) {
      const from = Math.min(startIdx, endIdx);
      const to = Math.max(startIdx, endIdx);
      for (let i = from; i <= to; i++) {
        selectedTabIds.add(visibleIds[i]);
      }
      updateMultiSelectUI();
    }
    return;
  }

  // Clear multi-select on regular click
  if (selectedTabIds.size > 0) {
    selectedTabIds.clear();
    updateMultiSelectUI();
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
  const groupHeader = e.target.closest('.group-header');
  if (groupHeader) {
    e.preventDefault();
    showGroupContextMenu(Number(groupHeader.dataset.groupId), e.clientX, e.clientY);
    return;
  }
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
      // Scroll to active tab after re-render from state update
      setTimeout(() => {
        const el = treeContainer.querySelector(`[data-tab-id="${currentActiveTabId}"]`);
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }, 150);
    }
  });
}

// ---------------------------------------------------------------------------
// Session Management Buttons
// ---------------------------------------------------------------------------

if (undoCloseBtn) {
  undoCloseBtn.addEventListener('click', () => undoCloseTab());
}

if (sessionsBtn) {
  sessionsBtn.addEventListener('click', () => toggleSessionManager(treeContainer));
}

if (recentlyClosedBtn) {
  recentlyClosedBtn.addEventListener('click', () => {
    const footer = document.getElementById('footer');
    toggleRecentlyClosed(footer);
  });
}

// Add New Tab button
if (addNewTabBtn) {
  addNewTabBtn.addEventListener('click', () => {
    chrome.tabs.create({});
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
    if (tab.groupId !== undefined && tab.groupId !== UNGROUPED_GROUP_ID) {
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

  const themePalette = generateThemePalette(currentState.theme, THEME_ACCENTS);

  let html = '<div class="settings-section"><div class="settings-label">Group Colors</div>';
  for (const groupId of groups) {
    const groupData = currentState.groups?.[groupId];
    const groupName = groupData?.title || 'Untitled Group';
    const currentColor = currentState.groupColors?.[groupId] || '#6c8cff';
    const swatchesHtml = themePalette.map(hex =>
      `<span class="settings-swatch" data-group-id="${groupId}" data-color="${hex}" style="background:${hex}" title="${hex}"></span>`
    ).join('');
    html += `
      <div class="group-color-section">
        <div class="group-color-row">
          <span class="group-id-label">${escapeHtml(groupName)}</span>
          <input type="color" class="group-color-input" data-group-id="${groupId}" value="${currentColor}">
        </div>
        <div class="settings-swatch-row">${swatchesHtml}</div>
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

  panel.addEventListener('click', (e) => {
    const swatch = e.target.closest('.settings-swatch');
    if (!swatch) return;
    const groupId = Number(swatch.dataset.groupId);
    const color = swatch.dataset.color;
    // Update the hex input to match
    const input = panel.querySelector(`.group-color-input[data-group-id="${groupId}"]`);
    if (input) input.value = color;
    chrome.runtime.sendMessage({ type: MSG.SET_GROUP_COLOR, payload: { groupId, color } }).catch(() => {});
  });

  treeContainer.before(panel);
}

function hideSettings() {
  const panel = document.getElementById('settings-panel');
  if (panel) panel.remove();
}

// ---------------------------------------------------------------------------
// Multi-Select UI
// ---------------------------------------------------------------------------

function updateMultiSelectUI() {
  // Update data-selected attributes on tab entries
  treeContainer.querySelectorAll('.tab-entry[data-tab-id]').forEach(el => {
    const tabId = Number(el.dataset.tabId);
    el.dataset.selected = String(selectedTabIds.has(tabId));
  });

  // Show/hide multi-select toolbar
  let toolbar = document.getElementById('multi-select-toolbar');
  if (selectedTabIds.size > 0) {
    if (!toolbar) {
      toolbar = document.createElement('div');
      toolbar.id = 'multi-select-toolbar';
      toolbar.className = 'multi-select-toolbar';
      treeContainer.before(toolbar);
    }
    toolbar.innerHTML = `
      <span class="ms-count">${selectedTabIds.size} selected</span>
      <button data-action="close">Close</button>
      <button data-action="group">Group</button>
      <button data-action="sleep">Sleep</button>
      <button data-action="copy">Copy URLs</button>
      <button class="ms-clear" data-action="clear">&times;</button>
    `;
    toolbar.onclick = (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const action = btn.dataset.action;
      const ids = [...selectedTabIds];
      switch (action) {
        case 'close':
          chrome.runtime.sendMessage({ type: MSG.MULTI_CLOSE, payload: { tabIds: ids } }).catch(() => {});
          break;
        case 'group':
          chrome.runtime.sendMessage({ type: MSG.MULTI_GROUP, payload: { tabIds: ids } }).catch(() => {});
          break;
        case 'sleep':
          chrome.runtime.sendMessage({ type: MSG.MULTI_SLEEP, payload: { tabIds: ids } }).catch(() => {});
          break;
        case 'copy': {
          const urls = ids
            .map(id => currentState?.tabs?.[id]?.url)
            .filter(Boolean)
            .join('\n');
          navigator.clipboard.writeText(urls).catch(() => {});
          break;
        }
        case 'clear':
          break; // handled below
      }
      selectedTabIds.clear();
      updateMultiSelectUI();
    };
  } else if (toolbar) {
    toolbar.remove();
  }
}

// ---------------------------------------------------------------------------
// Crash Recovery Banner
// ---------------------------------------------------------------------------

function showCrashRecoveryBanner({ savedTabCount, liveTabCount }) {
  // Check if there's an auto-save to restore
  chrome.runtime.sendMessage({ type: MSG.GET_SESSIONS }, (response) => {
    if (chrome.runtime.lastError) return;
    const sessions = response?.sessions || [];
    const latestAutoSave = sessions
      .filter(s => s.isAutoSave)
      .sort((a, b) => b.savedAt - a.savedAt)[0];

    if (!latestAutoSave) return;

    const banner = document.createElement('div');
    banner.className = 'crash-recovery-banner';
    banner.innerHTML = `
      <span class="cr-text"><strong>${savedTabCount - liveTabCount} tabs lost.</strong> Restore from auto-save? (${latestAutoSave.tabCount} tabs)</span>
      <div style="display:flex;gap:4px">
        <button class="cr-restore-btn">Restore</button>
        <button class="cr-dismiss-btn">Dismiss</button>
      </div>
    `;

    banner.querySelector('.cr-restore-btn').addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: MSG.RESTORE_SESSION,
        payload: { sessionId: latestAutoSave.id },
      }).catch(() => {});
      banner.remove();
    });

    banner.querySelector('.cr-dismiss-btn').addEventListener('click', () => {
      banner.remove();
    });

    const app = document.getElementById('app');
    app.insertBefore(banner, app.firstChild.nextSibling); // after header
  });
}

// ---------------------------------------------------------------------------
// Ctrl+Z — Undo Close Tab, Ctrl+K — Command Palette
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  // Ctrl+K — Command Palette
  if (e.ctrlKey && e.key === 'k' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    toggleCommandPalette();
    return;
  }

  // Ctrl+Z — Undo Close Tab
  if (e.ctrlKey && e.key === 'z' && !e.shiftKey && !e.altKey) {
    if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
    e.preventDefault();
    undoCloseTab();
  }
});

console.log('[LinkMap] Side panel loaded');
