/**
 * sidepanel.js — Side panel entry point.
 *
 * Owns message handling, event delegation, and render orchestration.
 * DOM building is delegated to tree-renderer.js.
 */

import { MSG } from '../shared/constants.js';
import { renderTree } from './modules/tree-renderer.js';

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

  // Apply theme
  if (payload.theme) {
    document.documentElement.dataset.theme = payload.theme;
    if (themeSelect) themeSelect.value = payload.theme;
  }

  render();
}

function render() {
  if (!currentState) return;

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

// ---------------------------------------------------------------------------
// Event Delegation — Pinned Tabs
// ---------------------------------------------------------------------------

pinnedList.addEventListener('click', (e) => {
  const pinnedTab = e.target.closest('.pinned-tab');
  if (!pinnedTab) return;
  const tabId = Number(pinnedTab.dataset.tabId);
  chrome.runtime.sendMessage({ type: MSG.ACTIVATE_TAB, payload: { tabId } });
});

// ---------------------------------------------------------------------------
// Theme Selector
// ---------------------------------------------------------------------------

if (themeSelect) {
  themeSelect.addEventListener('change', (e) => {
    chrome.runtime.sendMessage({ type: MSG.SET_THEME, payload: { theme: e.target.value } });
  });
}

console.log('[LinkMap] Side panel loaded');
