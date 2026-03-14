/**
 * sidepanel.js — Side panel entry point.
 *
 * Owns message handling, event delegation, and render orchestration.
 * DOM building is delegated to tree-renderer.js.
 */

import { MSG } from '../shared/constants.js';
import { generateThemePalette } from '../shared/utils.js';
import { renderTree } from './modules/tree-renderer.js';
import { showContextMenu, showGroupContextMenu, hideContextMenu, setContextMenuState } from './modules/context-menu.js';
import { initSearch } from './modules/search.js';
import { initDragDrop, initPinnedDragDrop } from './modules/drag-drop.js';
import { undoCloseTab, toggleSessionManager, toggleRecentlyClosed, closeSessionManager, closeRecentlyClosed, setSessionState } from './modules/session-manager.js';
import { toggleCommandPalette, setCommandPaletteState, closeCommandPalette } from './modules/command-palette.js';
import { initWorkspaceUI, setWorkspaceState, getActiveWorkspaceTabIds } from './modules/workspace-ui.js';
import { initKeyboardNav } from './modules/keyboard-nav.js';
import { initSettings } from './modules/settings.js';
import { initMultiSelect } from './modules/multi-select.js';


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
let sidebarActivatedTabId = null; // suppress scroll when sidebar initiated the activation

// Query the side panel's own window once at init (stable, never changes)
const homeWindowReady = chrome.windows.getCurrent().then(win => { homeWindowId = win.id; });

// ---------------------------------------------------------------------------
// Drag & Drop
// ---------------------------------------------------------------------------

initDragDrop(treeContainer);
initPinnedDragDrop(pinnedList);
initPinnedDragDrop(treeContainer); // inline pinned bars in multi-window mode


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

// Request state from background — wait for homeWindowId to resolve first
homeWindowReady.then(() => {
  chrome.runtime.sendMessage({ type: MSG.GET_STATE }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('[LinkMap] Failed to get state:', chrome.runtime.lastError.message);
      return;
    }
    handleStateUpdate(response);
  });
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
      // Only scroll when activation came from outside the sidebar (e.g. Chrome tab bar)
      if (sidebarActivatedTabId === message.payload.tabId) {
        sidebarActivatedTabId = null;
      } else {
        scrollToActiveTab(message.payload.tabId);
      }
      break;
    case MSG.THEME_CHANGED:
      document.documentElement.dataset.theme = message.payload.theme;
      if (themeSelect) themeSelect.value = message.payload.theme;
      break;
    case MSG.CRASH_RECOVERY:
      showCrashRecoveryBanner(message.payload);
      break;
    case MSG.FOCUS_SEARCH:
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

  // Pinned tab click inside window pinned bar — activate tab
  const pinnedTab = e.target.closest('.pinned-tab');
  if (pinnedTab) {
    const tabId = Number(pinnedTab.dataset.tabId);
    sidebarActivatedTabId = tabId;
    chrome.runtime.sendMessage({ type: MSG.ACTIVATE_TAB, payload: { tabId } }).catch(() => {});
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

  // Tab clicked — activate it (flag to suppress scroll-to-active since tab is already visible)
  sidebarActivatedTabId = tabId;
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

// Double-click window separator to rename
treeContainer.addEventListener('dblclick', (e) => {
  const sep = e.target.closest('.window-separator');
  if (!sep) return;
  const wid = Number(sep.dataset.windowId);
  if (!wid) return;

  // Don't create input if already editing
  const existingInput = sep.querySelector('input');
  if (existingInput) return;

  // Get current label text from text nodes
  const textNodes = [...sep.childNodes].filter(n => n.nodeType === Node.TEXT_NODE);
  const labelText = textNodes.map(n => n.textContent).join('').trim();

  // Replace text with inline input
  const input = document.createElement('input');
  input.type = 'text';
  input.value = labelText;
  input.className = 'window-rename-input';

  // Remove text nodes
  for (const tn of textNodes) tn.remove();
  // Insert input after chevron if present, otherwise at start
  const chevron = sep.querySelector('.window-chevron');
  if (chevron) {
    chevron.after(input);
  } else {
    sep.prepend(input);
  }
  input.focus();
  input.select();

  let done = false;
  let cancelled = false;
  function finish(save) {
    if (done) return;
    done = true;
    const newName = save ? input.value.trim() : labelText;
    if (save) {
      chrome.runtime.sendMessage({
        type: MSG.RENAME_WINDOW,
        payload: { windowId: wid, name: newName },
      }).catch(() => {});
    }
    // Restore text node and remove input immediately
    const textNode = document.createTextNode(` ${newName} `);
    input.replaceWith(textNode);
  }

  input.addEventListener('keydown', (ke) => {
    if (ke.key === 'Enter') { finish(true); ke.preventDefault(); }
    if (ke.key === 'Escape') { cancelled = true; input.blur(); }
  });
  input.addEventListener('blur', () => finish(!cancelled));
});

// Right-click context menu
treeContainer.addEventListener('contextmenu', (e) => {
  const groupHeader = e.target.closest('.group-header');
  if (groupHeader) {
    e.preventDefault();
    showGroupContextMenu(Number(groupHeader.dataset.groupId), e.clientX, e.clientY);
    return;
  }
  // Pinned tabs inside window pinned bars
  const pinnedTab = e.target.closest('.pinned-tab');
  if (pinnedTab) {
    e.preventDefault();
    showContextMenu(Number(pinnedTab.dataset.tabId), e.clientX, e.clientY);
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
  sidebarActivatedTabId = tabId;
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
// Keyboard Navigation (Feature 4) — delegated to keyboard-nav.js
// ---------------------------------------------------------------------------

const { updateFocusRing, getVisibleTabIds } = initKeyboardNav({
  treeContainer,
  searchInput,
  getFocusedTabId: () => focusedTabId,
  setFocusedTabId: (id) => { focusedTabId = id; },
  getCurrentState: () => currentState,
});

// ---------------------------------------------------------------------------
// Settings Panel — delegated to settings.js
// ---------------------------------------------------------------------------

const settingsBtn = document.getElementById('settings-btn');
initSettings({
  settingsBtn,
  treeContainer,
  getCurrentState: () => currentState,
  generateThemePalette,
});

// ---------------------------------------------------------------------------
// Multi-Select UI — delegated to multi-select.js
// ---------------------------------------------------------------------------

const { updateMultiSelectUI } = initMultiSelect({
  treeContainer,
  getSelectedTabIds: () => selectedTabIds,
  getCurrentState: () => currentState,
});

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
