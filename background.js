/**
 * LinkMap — Background Service Worker
 *
 * Owns the ShadowState, listens to Chrome tab events,
 * persists state to chrome.storage.local, and communicates
 * with the side panel via chrome.runtime messaging.
 */

import { ShadowState } from './shared/shadow-state.js';
import { MSG, STORAGE_KEY, SAVE_DEBOUNCE_MS } from './shared/constants.js';
import { debounce } from './shared/utils.js';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** @type {ShadowState} */
let state = new ShadowState();

/** @type {number|null} Currently active tab ID */
let activeTabId = null;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Debounced save — writes the serialized ShadowState to chrome.storage.local.
 * Called after every state mutation.
 */
const saveState = debounce(() => {
  chrome.storage.local.set({ [STORAGE_KEY]: state.toSerializable() });
  console.log('[LinkMap] State saved');
}, SAVE_DEBOUNCE_MS);

// ---------------------------------------------------------------------------
// Broadcasting
// ---------------------------------------------------------------------------

/**
 * Builds the state payload sent to the side panel.
 * Converts Maps and Sets to JSON-friendly formats.
 *
 * @returns {Object} State payload for messaging.
 */
function getStatePayload() {
  return {
    tabs: Object.fromEntries(state.tabs),
    rootIds: state.rootIds,
    collapsed: [...state.collapsed],
    groups: Object.fromEntries(state.groups),
    groupColors: state.groupColors,
    theme: state.theme,
    activeTabId: activeTabId,
  };
}

/**
 * Sends a STATE_UPDATE message to the side panel.
 * Debounced to coalesce rapid events (e.g., group toggle triggers
 * multiple tab updates). 16ms ≈ one animation frame.
 */
const broadcastState = debounce(() => {
  try {
    chrome.runtime.sendMessage({
      type: MSG.STATE_UPDATE,
      payload: getStatePayload(),
    }).catch(() => {
      // Side panel not open — expected, ignore.
    });
  } catch (_e) {
    // Synchronous throw — side panel not open.
  }
}, 16);

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initializes the service worker:
 * 1. Loads saved state from chrome.storage.local
 * 2. Reconstructs ShadowState from storage
 * 3. Reconciles with live Chrome tabs and groups
 * 4. Identifies the active tab
 * 5. Persists the reconciled state
 */
async function init() {
  try {
    // 1. Load saved state
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const savedData = result[STORAGE_KEY];

    // 2. Reconstruct from storage
    if (savedData) {
      state = ShadowState.fromStorage(savedData);
    }

    // 3. Query all live tabs and reconcile
    const liveTabs = await chrome.tabs.query({});
    state.reconcileWithLiveTabs(liveTabs);

    // 3b. Query all live tab groups and reconcile
    const liveGroups = await chrome.tabGroups.query({});
    state.reconcileWithLiveGroups(liveGroups);

    // 4. Identify the active tab
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTabs.length > 0) {
      activeTabId = activeTabs[0].id;
    }

    // 5. Save reconciled state
    saveState();
    broadcastState();

    console.log(`[LinkMap] Initialized with ${state.tabs.size} tabs, ${state.groups.size} groups`);
  } catch (err) {
    console.error('[LinkMap] Init error:', err);
  }
}

// ---------------------------------------------------------------------------
// Tab Event Listeners
// ---------------------------------------------------------------------------

/** @type {Set<string>} Fields in changeInfo that trigger an update. */
const RELEVANT_CHANGE_FIELDS = new Set([
  'title', 'url', 'favIconUrl', 'status', 'pinned', 'audible', 'groupId',
]);

/**
 * chrome.tabs.onCreated — A new tab was created.
 */
chrome.tabs.onCreated.addListener((tab) => {
  const node = {
    tabId: tab.id,
    parentId: tab.openerTabId || null,
    title: tab.title || 'New Tab',
    url: tab.url || '',
    favIconUrl: tab.favIconUrl || '',
    pinned: tab.pendingUrl ? false : tab.pinned,
    audible: false,
    status: tab.status || 'loading',
    groupId: tab.groupId || -1,
    index: tab.index,
    windowId: tab.windowId,
  };

  state.addTab(tab.id, node);
  saveState();
  broadcastState();

  console.log(`[LinkMap] Tab created: ${tab.id} "${node.title}"`);
});

/**
 * chrome.tabs.onRemoved — A tab was closed.
 */
chrome.tabs.onRemoved.addListener((tabId, _removeInfo) => {
  state.removeTab(tabId);

  if (activeTabId === tabId) {
    activeTabId = null;
  }

  saveState();
  broadcastState();

  console.log(`[LinkMap] Tab removed: ${tabId}`);
});

/**
 * chrome.tabs.onUpdated — A tab's properties changed.
 * Only processes updates with relevant fields.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, _tab) => {
  // Filter: only act on relevant changes
  const hasRelevant = Object.keys(changeInfo).some((key) =>
    RELEVANT_CHANGE_FIELDS.has(key)
  );
  if (!hasRelevant) return;

  const changes = {};
  if ('title' in changeInfo) changes.title = changeInfo.title;
  if ('url' in changeInfo) changes.url = changeInfo.url;
  if ('favIconUrl' in changeInfo) changes.favIconUrl = changeInfo.favIconUrl;
  if ('status' in changeInfo) changes.status = changeInfo.status;
  if ('pinned' in changeInfo) changes.pinned = changeInfo.pinned;
  if ('audible' in changeInfo) changes.audible = changeInfo.audible;
  if ('groupId' in changeInfo) changes.groupId = changeInfo.groupId;

  state.updateTab(tabId, changes);
  saveState();
  broadcastState();
});

/**
 * chrome.tabs.onMoved — A tab was moved in the tab strip.
 */
chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  state.updateTab(tabId, { index: moveInfo.toIndex });
  saveState();
  broadcastState();

  console.log(`[LinkMap] Tab moved: ${tabId} to index ${moveInfo.toIndex}`);
});

/**
 * chrome.tabs.onActivated — The active tab changed.
 */
chrome.tabs.onActivated.addListener((activeInfo) => {
  activeTabId = activeInfo.tabId;

  try {
    chrome.runtime.sendMessage({
      type: MSG.TAB_ACTIVATED,
      payload: { tabId: activeInfo.tabId },
    }).catch(() => {});
  } catch (_e) {
    // Side panel not open.
  }

  console.log(`[LinkMap] Tab activated: ${activeInfo.tabId}`);
});

/**
 * chrome.tabs.onAttached — A tab was attached to a window.
 */
chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  state.updateTab(tabId, {
    windowId: attachInfo.newWindowId,
    index: attachInfo.newPosition,
  });
  saveState();
  broadcastState();

  console.log(`[LinkMap] Tab attached: ${tabId} to window ${attachInfo.newWindowId}`);
});

/**
 * chrome.tabs.onDetached — A tab was detached from a window.
 * v1: Single-window focus — just log it, don't remove the tab.
 */
chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
  console.log(`[LinkMap] Tab detached: ${tabId} from window ${detachInfo.oldWindowId}`);
  saveState();
});

/**
 * chrome.tabs.onReplaced — A tab ID was replaced (prerendered → real).
 * Remaps the old ID to the new ID in ShadowState, preserving tree structure.
 */
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  state.replaceTabId(removedTabId, addedTabId);
  saveState();
  broadcastState();

  console.log(`[LinkMap] Tab replaced: ${removedTabId} → ${addedTabId}`);
});

// ---------------------------------------------------------------------------
// Tab Group Event Listeners
// ---------------------------------------------------------------------------

/**
 * chrome.tabGroups.onCreated — A tab group was created.
 */
chrome.tabGroups.onCreated.addListener((group) => {
  state.addGroup(group);
  saveState();
  broadcastState();

  console.log(`[LinkMap] Group created: ${group.id} "${group.title || 'untitled'}"`);
});

/**
 * chrome.tabGroups.onUpdated — A tab group's properties changed.
 */
chrome.tabGroups.onUpdated.addListener((group) => {
  state.updateGroup(group.id, {
    title: group.title,
    color: group.color,
    collapsed: group.collapsed,
  });
  saveState();
  broadcastState();

  console.log(`[LinkMap] Group updated: ${group.id} "${group.title || 'untitled'}"`);
});

/**
 * chrome.tabGroups.onRemoved — A tab group was removed.
 */
chrome.tabGroups.onRemoved.addListener((group) => {
  state.removeGroup(group.id);
  saveState();
  broadcastState();

  console.log(`[LinkMap] Group removed: ${group.id}`);
});

// ---------------------------------------------------------------------------
// Service Worker Lifecycle
// ---------------------------------------------------------------------------

/**
 * chrome.runtime.onSuspend — Flush state before worker terminates.
 */
chrome.runtime.onSuspend.addListener(() => {
  chrome.storage.local.set({ [STORAGE_KEY]: state.toSerializable() });
  console.log('[LinkMap] State flushed on suspend');
});

// ---------------------------------------------------------------------------
// Message Handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case MSG.GET_STATE:
      initDone.then(() => {
        sendResponse(getStatePayload());
      });
      return true; // keep channel open for async response

    case MSG.ACTIVATE_TAB:
      chrome.tabs.update(payload.tabId, { active: true });
      break;

    case MSG.CLOSE_TAB:
      chrome.tabs.remove(payload.tabId);
      break;

    case MSG.CLOSE_TABS:
      chrome.tabs.remove(payload.tabIds);
      break;

    case MSG.MOVE_TAB: {
      const { tabId, newParentId, targetTabId, position } = payload;

      if (position === 'child') {
        // Reparent: make tabId a child of newParentId (which is targetTabId)
        state.moveTab(tabId, newParentId, 0);
      } else if (position === 'before' || position === 'after') {
        // Reorder: place before/after targetTabId at the same level
        const parentId = newParentId;
        const siblings = parentId != null
          ? (state.getTab(parentId)?.children || [])
          : state.rootIds;
        let targetIndex = siblings.indexOf(targetTabId);
        if (targetIndex === -1) targetIndex = siblings.length;
        if (position === 'after') targetIndex++;
        // If moving within same parent and currently before target, adjust
        const currentParent = state.getTab(tabId)?.parentId ?? null;
        if (currentParent === parentId) {
          const currentIndex = siblings.indexOf(tabId);
          if (currentIndex !== -1 && currentIndex < targetIndex) {
            targetIndex--;
          }
        }
        state.moveTab(tabId, parentId, targetIndex);
      } else {
        // Legacy format: { tabId, newParentId, index }
        state.moveTab(tabId, newParentId, payload.index ?? 0);
      }

      saveState();
      broadcastState();
      break;
    }

    case MSG.TOGGLE_COLLAPSE:
      state.toggleCollapse(payload.tabId);
      saveState();
      broadcastState();
      break;

    case MSG.COLLAPSE_ALL:
      state.collapseAll();
      saveState();
      broadcastState();
      break;

    case MSG.EXPAND_ALL:
      state.expandAll();
      saveState();
      broadcastState();
      break;

    case MSG.FOCUS_MODE:
      state.focusOnBranch(payload.tabId);
      saveState();
      broadcastState();
      break;

    case MSG.SET_THEME:
      state.setTheme(payload.theme);
      saveState();
      try {
        chrome.runtime.sendMessage({
          type: MSG.THEME_CHANGED,
          payload: { theme: payload.theme },
        }).catch(() => {});
      } catch (_e) {
        // Side panel not open.
      }
      break;

    case MSG.SET_GROUP_COLOR:
      state.setGroupColor(payload.groupId, payload.color);
      saveState();
      broadcastState();
      break;

    case MSG.PIN_TAB:
      chrome.tabs.update(payload.tabId, { pinned: payload.pinned });
      break;

    case MSG.DUPLICATE_TAB:
      chrome.tabs.duplicate(payload.tabId);
      break;

    case MSG.MUTE_TAB:
      chrome.tabs.update(payload.tabId, { muted: payload.muted });
      break;

    default:
      console.log(`[LinkMap] Unknown message type: ${type}`);
  }
});

// ---------------------------------------------------------------------------
// Side Panel Behavior
// ---------------------------------------------------------------------------

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const initDone = init();

console.log('[LinkMap] Background service worker started');
