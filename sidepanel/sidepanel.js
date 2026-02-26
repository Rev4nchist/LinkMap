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

// ---------------------------------------------------------------------------
// Current state
// ---------------------------------------------------------------------------

let currentState = null;
let currentActiveTabId = null;

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

function render() {
  if (!currentState) return;
  if (search.isActive()) return; // don't overwrite search results

  renderTree(currentState, currentActiveTabId, treeContainer, pinnedList);

  // Update pinned section visibility
  const hasPinned = pinnedList.children.length > 0;
  pinnedSection.hidden = !hasPinned;

  // Update tab count
  const tabCount = Object.keys(currentState.tabs).length;
  tabCountNum.textContent = tabCount;
}

// ---------------------------------------------------------------------------
// Event Delegation — Tree Container
// ---------------------------------------------------------------------------

// Click handling (event delegation)
treeContainer.addEventListener('click', (e) => {
  const tabEntry = e.target.closest('.tab-entry');
  if (!tabEntry) return;

  const tabId = Number(tabEntry.dataset.tabId);

  // Close button clicked
  if (e.target.closest('.tab-close')) {
    chrome.runtime.sendMessage({ type: MSG.CLOSE_TAB, payload: { tabId } });
    return;
  }

  // Chevron clicked (collapse/expand)
  if (e.target.closest('.tab-chevron')) {
    chrome.runtime.sendMessage({ type: MSG.TOGGLE_COLLAPSE, payload: { tabId } });
    return;
  }

  // Tab clicked — activate it
  chrome.runtime.sendMessage({ type: MSG.ACTIVATE_TAB, payload: { tabId } });
});

// Middle-click to close
treeContainer.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return; // middle click only
  const tabEntry = e.target.closest('.tab-entry');
  if (!tabEntry) return;
  e.preventDefault();
  const tabId = Number(tabEntry.dataset.tabId);
  chrome.runtime.sendMessage({ type: MSG.CLOSE_TAB, payload: { tabId } });
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
  chrome.runtime.sendMessage({ type: MSG.ACTIVATE_TAB, payload: { tabId } });
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
    chrome.runtime.sendMessage({ type: MSG.SET_THEME, payload: { theme: e.target.value } });
  });
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
    chrome.runtime.sendMessage({ type: MSG.SET_GROUP_COLOR, payload: { groupId, color } });
  });

  treeContainer.before(panel);
}

function hideSettings() {
  const panel = document.getElementById('settings-panel');
  if (panel) panel.remove();
}

console.log('[LinkMap] Side panel loaded');
