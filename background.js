/**
 * LinkMap — Background Service Worker
 *
 * Owns the ShadowState, listens to Chrome tab events,
 * persists state to chrome.storage.local, and communicates
 * with the side panel via chrome.runtime messaging.
 */

import { ShadowState } from './shared/shadow-state.js';
import { MSG, STORAGE_KEY, SAVE_DEBOUNCE_MS, THEME_ACCENTS, UNGROUPED_GROUP_ID, SAVED_GROUPS_KEY, SESSIONS_KEY, AUTO_SAVE_INTERVAL_MINUTES, MAX_AUTO_SAVES, SETTINGS_KEY, AUTO_GROUP_RULES_KEY, WORKSPACES_KEY, TAB_NOTES_KEY, SUPPRESS_COLLAPSE_MS, SUPPRESS_TITLE_MS, RETRY_GROUP_TITLE_DELAYS, TREE_EDGES_KEY } from './shared/constants.js';
import { debounce } from './shared/utils.js';
import { nearestChromeGroupColor } from './shared/color-distance.js';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Set to true to enable verbose logging. */
const DEBUG = false;

/** @type {ShadowState} */
let state = new ShadowState();

/** True once init() has finished — guards event listeners from corrupting state during startup. */
let initComplete = false;

/** @type {number|null} Currently active tab ID */
let activeTabId = null;

/** @type {number|null} Currently focused window ID */
let currentWindowId = null;

/** Suppresses spurious group-collapse events after tab removal (counter pattern) */
let suppressGroupCollapseCount = 0;

/** Suppresses group-title overwrite from onUpdated during programmatic rename (counter pattern) */
let suppressGroupTitleCount = 0;

/** @type {Object} User-configurable settings */
let settings = {
  sleepOnCollapse: false,     // Discard tabs when collapsing branches
  autoSaveEnabled: true,      // Auto-save sessions periodically
  autoArchiveMinutes: 0,      // 0 = disabled; minutes of inactivity before archiving
};

/**
 * Workspaces: named tab sets with separate trees.
 * @type {{ id: string, name: string, color: string, tabIds: number[] }[]}
 */
let workspaces = [];
let activeWorkspaceId = null;

/**
 * Tab notes: per-tab text annotations persisted across sessions.
 * @type {Object<number, string>}
 */
let tabNotes = {};

/**
 * Temporarily suppresses group-collapse events for 200ms.
 * Chrome fires spurious tabGroups.onUpdated(collapsed: true) after
 * tab removal, group toggle, and group move operations.
 */
function suppressGroupCollapseForBurst() {
  suppressGroupCollapseCount++;
  setTimeout(() => { suppressGroupCollapseCount--; }, SUPPRESS_COLLAPSE_MS);
}

function suppressGroupTitleForBurst() {
  suppressGroupTitleCount++;
  setTimeout(() => { suppressGroupTitleCount--; }, SUPPRESS_TITLE_MS);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Debounced save — writes the serialized ShadowState to chrome.storage.local.
 * Called after every state mutation.
 */
const saveState = debounce(() => {
  try {
    chrome.storage.local.set({
      [STORAGE_KEY]: state.toSerializable(),
      [TREE_EDGES_KEY]: state.toTreeEdges(),
    }).catch(err => console.error('[LinkMap] saveState failed:', err));
  } catch (err) {
    console.error('[LinkMap] saveState serialization failed:', err);
  }
  DEBUG && console.log('[LinkMap] State saved');
}, SAVE_DEBOUNCE_MS);

/**
 * Immediate (non-debounced) save for critical tree structure changes.
 * Use for operations that modify parent-child relationships.
 */
function saveStateImmediate() {
  try {
    chrome.storage.local.set({
      [STORAGE_KEY]: state.toSerializable(),
      [TREE_EDGES_KEY]: state.toTreeEdges(),
    }).catch(err => console.error('[LinkMap] saveStateImmediate failed:', err));
  } catch (err) {
    console.error('[LinkMap] saveStateImmediate serialization failed:', err);
  }
  DEBUG && console.log('[LinkMap] State saved (immediate)');
}

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
    windowNames: Object.fromEntries(state.windowNames),
    activeTabId: activeTabId,
    currentWindowId: currentWindowId,
    duplicates: getDuplicateMap(),
    settings,
    workspaces,
    activeWorkspaceId,
    tabNotes,
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

/** Convenience: save + broadcast in one call. */
function commitState() { saveState(); broadcastState(); }

/** Save + broadcast with immediate save + tree edges for tree-structure changes. */
function commitTreeChange() { saveStateImmediate(); broadcastState(); }

// ---------------------------------------------------------------------------
// Initialization helpers
// ---------------------------------------------------------------------------

/**
 * Retries querying Chrome for group titles that weren't available at init time.
 * Chrome may not have restored all group titles by the time init() queries them.
 * Uses exponential backoff via RETRY_GROUP_TITLE_DELAYS.
 */
function retryMissingGroupTitles(state, commitState) {
  let retryCount = 0;
  const retryDelays = RETRY_GROUP_TITLE_DELAYS;
  function attempt() {
    if (retryCount >= retryDelays.length) return;
    setTimeout(async () => {
      try {
        const groups = await chrome.tabGroups.query({});
        let updated = false;
        let allHaveTitles = true;
        for (const g of groups) {
          const existing = state.groups.get(g.id);
          if (existing && !existing.title) {
            if (g.title) {
              existing.title = g.title;
              updated = true;
            } else {
              allHaveTitles = false;
            }
          }
        }
        if (updated) {
          commitState();
          DEBUG && console.log(`[LinkMap] Recovered group titles on retry ${retryCount + 1}`);
        }
        retryCount++;
        if (!allHaveTitles && retryCount < retryDelays.length) attempt();
      } catch (e) {
        // Service worker may have been suspended — safe to ignore
      }
    }, retryDelays[retryCount]);
  }
  attempt();
}

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

    // 1b. Load settings
    const settingsResult = await chrome.storage.local.get(SETTINGS_KEY);
    if (settingsResult[SETTINGS_KEY]) {
      settings = { ...settings, ...settingsResult[SETTINGS_KEY] };
    }

    // 2. Reconstruct from storage
    const savedTabCount = savedData ? Object.keys(savedData.tabs || {}).length : 0;
    if (savedData) {
      state = ShadowState.fromStorage(savedData);
    }

    // 2b. Snapshot group membership counts BEFORE tab reconciliation
    //     (reconcileWithLiveTabs overwrites groupId to new Chrome IDs)
    const savedGroupTabCounts = new Map();
    for (const [, tab] of state.tabs) {
      const gid = tab.groupId;
      if (gid && gid !== -1) {
        savedGroupTabCounts.set(gid, (savedGroupTabCounts.get(gid) || 0) + 1);
      }
    }

    // 3. Query all live tabs — wait for Chrome session restore to populate URLs
    const MAX_WAIT_MS = 10000;
    const POLL_MS = 300;
    const startTime = Date.now();
    let liveTabs = await chrome.tabs.query({});

    // Chrome restores tabs lazily on startup. Poll until URLs are available.
    while (Date.now() - startTime < MAX_WAIT_MS) {
      const withUrl = liveTabs.filter(t => t.url && t.url !== 'chrome://newtab/' && t.url !== 'about:blank');
      if (liveTabs.length === 0 || withUrl.length / liveTabs.length >= 0.8) break;
      console.log(`[LinkMap] Waiting for session restore: ${withUrl.length}/${liveTabs.length} tabs have URLs`);
      await new Promise(r => setTimeout(r, POLL_MS));
      liveTabs = await chrome.tabs.query({});
    }
    console.log(`[LinkMap] Session restore wait: ${Date.now() - startTime}ms, ${liveTabs.length} tabs`);

    const windowIdMap = state.reconcileWithLiveTabs(liveTabs);

    // 3c. Check for crash recovery
    checkForCrashRecovery(savedTabCount, liveTabs.length);

    // 3d. Tree edge repair: if reconciliation left tree mostly flat, restore from backup
    const rootCount = state.rootIds.length;
    const totalCount = state.tabs.size;
    if (totalCount > 3 && rootCount > totalCount * 0.8) {
      try {
        const edgesResult = await chrome.storage.local.get(TREE_EDGES_KEY);
        const savedEdges = edgesResult[TREE_EDGES_KEY];
        if (savedEdges) {
          const restored = state.repairFromTreeEdges(savedEdges);
          if (restored > 0) {
            console.log(`[LinkMap] Tree edge repair: restored ${restored} parent-child relationships`);
          }
        }
      } catch (err) {
        console.error('[LinkMap] Tree edge repair failed:', err);
      }
    }

    // 3b. Query all live tab groups and reconcile
    const liveGroups = await chrome.tabGroups.query({});
    state.reconcileWithLiveGroups(liveGroups, savedGroupTabCounts, windowIdMap);

    // 3d. Push rescued titles back to Chrome so its UI shows them
    //     and subsequent onUpdated events carry the correct title.
    for (const group of liveGroups) {
      const saved = state.groups.get(group.id);
      if (saved?.title && !group.title) {
        suppressGroupTitleForBurst();
        chrome.tabGroups.update(group.id, { title: saved.title }).catch(() => {});
      }
    }

    // 4. Identify the active tab and current window
    const currentWindow = await chrome.windows.getCurrent();
    currentWindowId = currentWindow.id;

    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTabs.length > 0) {
      activeTabId = activeTabs[0].id;
    }

    // 5. Save reconciled state (but don't broadcast yet)
    saveState();

    // 6. Set up alarms
    setupAutoSaveAlarm();
    setupAutoArchiveAlarm();

    // 7. Load auto-group rules + workspaces + notes
    await loadAutoGroupRules();
    const wsResult = await chrome.storage.local.get(WORKSPACES_KEY);
    if (wsResult[WORKSPACES_KEY]) {
      const wsData = wsResult[WORKSPACES_KEY];
      workspaces = wsData.workspaces || [];
      activeWorkspaceId = wsData.activeWorkspaceId || null;
    }
    const notesResult = await chrome.storage.local.get(TAB_NOTES_KEY);
    tabNotes = notesResult[TAB_NOTES_KEY] || {};

    // 8. Broadcast complete state (after all data loaded)
    broadcastState();

    initComplete = true;
    retryMissingGroupTitles(state, commitState);
    console.log(`[LinkMap] Initialized with ${state.tabs.size} tabs, ${state.groups.size} groups`);
  } catch (err) {
    console.error('[LinkMap] Init error:', err);
  }
}

// ---------------------------------------------------------------------------
// Session Auto-Save (Alarm-based)
// ---------------------------------------------------------------------------

const AUTO_SAVE_ALARM = 'linkmap-auto-save';

/**
 * Sets up the periodic auto-save alarm.
 * Fires every AUTO_SAVE_INTERVAL_MINUTES (default 5 min).
 */
function setupAutoSaveAlarm() {
  chrome.alarms.create(AUTO_SAVE_ALARM, {
    delayInMinutes: AUTO_SAVE_INTERVAL_MINUTES,
    periodInMinutes: AUTO_SAVE_INTERVAL_MINUTES,
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_SAVE_ALARM) {
    if (!settings.autoSaveEnabled) return;
    saveSession('Auto-Save', true);
  }
});

/**
 * Serializes the current tree state into a session snapshot.
 * @param {string} name — session name
 * @param {boolean} isAutoSave — whether this is an auto-save
 */
async function saveSession(name, isAutoSave = false) {
  if (state.tabs.size === 0) return; // nothing to save

  // Compute window breakdown for session metadata
  const windowBreakdown = {};
  for (const [, tab] of state.tabs) {
    const wid = tab.windowId;
    if (!windowBreakdown[wid]) {
      windowBreakdown[wid] = {
        tabCount: 0,
        name: state.getWindowName(wid) || null,
      };
    }
    windowBreakdown[wid].tabCount++;
  }

  const session = {
    id: `${isAutoSave ? 'auto' : 'manual'}-${Date.now()}`,
    name,
    isAutoSave,
    savedAt: Date.now(),
    tabCount: state.tabs.size,
    windowCount: Object.keys(windowBreakdown).length,
    windows: windowBreakdown,
    data: state.toSerializable(),
  };

  try {
    const result = await chrome.storage.local.get(SESSIONS_KEY);
    const sessions = result[SESSIONS_KEY] || [];

    sessions.push(session);

    // Rotate auto-saves: keep only the latest MAX_AUTO_SAVES
    if (isAutoSave) {
      const autoSaves = sessions.filter(s => s.isAutoSave);
      if (autoSaves.length > MAX_AUTO_SAVES) {
        const toRemove = [...autoSaves]
          .sort((a, b) => a.savedAt - b.savedAt)
          .slice(0, autoSaves.length - MAX_AUTO_SAVES)
          .map(s => s.id);
        const removeSet = new Set(toRemove);
        const trimmed = sessions.filter(s => !removeSet.has(s.id));
        await chrome.storage.local.set({ [SESSIONS_KEY]: trimmed });
      } else {
        await chrome.storage.local.set({ [SESSIONS_KEY]: sessions });
      }
    } else {
      await chrome.storage.local.set({ [SESSIONS_KEY]: sessions });
    }

    DEBUG && console.log(`[LinkMap] Session saved: "${name}" (${state.tabs.size} tabs, auto=${isAutoSave})`);
  } catch (err) {
    console.error('[LinkMap] Failed to save session:', err);
  }
}

/**
 * Creates Chrome windows for session restore, mapping saved windowIds to new ones.
 * Reuses the current window for the first saved windowId, creates new windows for the rest.
 * @param {number[]} savedWindowIds - Unique window IDs from the saved session
 * @param {chrome.windows.Window} currentWindow - The currently focused Chrome window
 * @returns {Promise<{windowMap: Map<number, number>, defaultTabsToClose: number[]}>}
 *   windowMap: saved windowId -> new Chrome windowId
 *   defaultTabsToClose: IDs of default newtabs Chrome auto-creates in new windows
 */
async function createWindowsForRestore(savedWindowIds, currentWindow) {
  const windowMap = new Map();
  const defaultTabsToClose = [];

  for (let i = 0; i < savedWindowIds.length; i++) {
    if (i === 0) {
      windowMap.set(savedWindowIds[0], currentWindow.id);
    } else {
      try {
        const newWin = await chrome.windows.create({ focused: false });
        windowMap.set(savedWindowIds[i], newWin.id);
        // Track the default newtab Chrome creates so we can close it later
        const newWinTabs = await chrome.tabs.query({ windowId: newWin.id });
        if (newWinTabs.length > 0) {
          defaultTabsToClose.push(newWinTabs[0].id);
        }
      } catch (err) {
        console.error('[LinkMap] Failed to create window for restore:', err);
        // Fallback: use current window
        windowMap.set(savedWindowIds[i], currentWindow.id);
      }
    }
  }

  return { windowMap, defaultTabsToClose };
}

/**
 * Batch-creates tabs in correct windows, returning ID mappings.
 * Processes tabs in batches of 10 for controlled parallelism.
 * @param {Object[]} savedTabs - Array of saved tab objects
 * @param {Map<number, number>} windowMap - saved windowId -> new Chrome windowId
 * @param {chrome.windows.Window} currentWindow - Fallback window
 * @returns {Promise<{oldToNewId: Map<number, number>, newTabWindowId: Map<number, number>}>}
 *   oldToNewId: saved tabId -> new Chrome tabId
 *   newTabWindowId: new tabId -> actual windowId it was created in
 */
async function createTabsForRestore(savedTabs, windowMap, currentWindow) {
  const BATCH_SIZE = 10;
  const oldToNewId = new Map();
  const newTabWindowId = new Map();

  for (let i = 0; i < savedTabs.length; i += BATCH_SIZE) {
    const batch = savedTabs.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (savedTab) => {
      try {
        const targetWindowId = windowMap.get(savedTab.windowId) ?? currentWindow.id;
        const newTab = await chrome.tabs.create({
          url: savedTab.url || 'chrome://newtab',
          active: false,
          windowId: targetWindowId,
          pinned: savedTab.pinned || false,
        });
        oldToNewId.set(savedTab.tabId, newTab.id);
        newTabWindowId.set(newTab.id, targetWindowId);
      } catch (err) {
        console.error(`[LinkMap] Failed to restore tab "${savedTab.title}":`, err);
      }
    });
    await Promise.all(promises);
  }

  return { oldToNewId, newTabWindowId };
}

/**
 * Recreates Chrome tab groups from saved group data.
 * Partitions tabs by window to avoid cross-window grouping errors.
 * @param {[string, Object][]} groupEntries - Object.entries of saved groups
 * @param {Object[]} savedTabs - Array of saved tab objects
 * @param {Map<number, number>} oldToNewId - saved tabId -> new Chrome tabId
 * @param {Map<number, number>} newTabWindowId - new tabId -> actual windowId
 * @param {chrome.windows.Window} currentWindow - Fallback window
 * @param {number|null} windowIdFilter - Optional saved windowId filter
 */
async function rebuildGroupsForRestore(groupEntries, savedTabs, oldToNewId, newTabWindowId, currentWindow, windowIdFilter) {
  for (const [oldGroupIdStr, groupData] of groupEntries) {
    const oldGroupId = Number(oldGroupIdStr);
    // Skip groups not in the filtered window
    if (windowIdFilter != null && groupData.windowId !== windowIdFilter) continue;

    const groupTabIds = savedTabs
      .filter(t => t.groupId === oldGroupId)
      .map(t => oldToNewId.get(t.tabId))
      .filter(Boolean);

    if (groupTabIds.length > 0) {
      try {
        // Partition tabs by actual window to avoid cross-window grouping error
        const tabsByWindow = new Map();
        for (const tid of groupTabIds) {
          const wid = newTabWindowId.get(tid) ?? currentWindow.id;
          if (!tabsByWindow.has(wid)) tabsByWindow.set(wid, []);
          tabsByWindow.get(wid).push(tid);
        }
        for (const [, windowTabIds] of tabsByWindow) {
          const newGroupId = await chrome.tabs.group({ tabIds: windowTabIds });
          await chrome.tabGroups.update(newGroupId, {
            title: groupData.title || '',
            color: groupData.color || 'grey',
            collapsed: groupData.collapsed || false,
          });
        }
      } catch (err) {
        console.error(`[LinkMap] Failed to restore group "${groupData.title}":`, err);
      }
    }
  }
}

/**
 * Restores a saved session: creates tabs in their original windows,
 * rebuilds tree structure, and recreates tab groups.
 *
 * When windowIdFilter is provided, only tabs from that saved windowId
 * are restored (single-window restore).
 *
 * @param {string} sessionId
 * @param {number|null} [windowIdFilter=null] - Optional saved windowId to restore selectively
 */
async function restoreSession(sessionId, windowIdFilter = null) {
  try {
    const result = await chrome.storage.local.get(SESSIONS_KEY);
    const sessions = result[SESSIONS_KEY] || [];
    const session = sessions.find(s => s.id === sessionId);
    if (!session?.data) return;

    let savedTabs = Object.values(session.data.tabs || {});
    if (windowIdFilter != null) {
      savedTabs = savedTabs.filter(t => t.windowId === windowIdFilter);
    }
    if (savedTabs.length === 0) return;

    // Identify unique saved windowIds (preserve insertion order for stability)
    const savedWindowIds = [...new Set(savedTabs.map(t => t.windowId))];

    const currentWindow = await chrome.windows.getCurrent();

    // 1. Create Chrome windows
    const { windowMap, defaultTabsToClose } = await createWindowsForRestore(savedWindowIds, currentWindow);

    // 2. Batch create tabs in correct windows
    const { oldToNewId, newTabWindowId } = await createTabsForRestore(savedTabs, windowMap, currentWindow);

    // Close default newtabs in newly created windows
    for (const tabId of defaultTabsToClose) {
      try { await chrome.tabs.remove(tabId); } catch (e) { /* may already be gone */ }
    }

    // 3. Rebuild tree structure — collect children per parent, sorted by saved index
    const childrenByParent = new Map();
    for (const savedTab of savedTabs) {
      const newId = oldToNewId.get(savedTab.tabId);
      if (!newId) continue;

      const newParentId = savedTab.parentId != null
        ? oldToNewId.get(savedTab.parentId) ?? null
        : null;

      if (newParentId != null) {
        if (!childrenByParent.has(newParentId)) childrenByParent.set(newParentId, []);
        childrenByParent.get(newParentId).push({ newId, index: savedTab.index ?? 0 });
      }
    }
    for (const [parentId, children] of childrenByParent) {
      children.sort((a, b) => a.index - b.index);
      for (const child of children) {
        state.moveTab(child.newId, parentId, Infinity);
      }
    }

    // 4. Recreate Chrome tab groups from saved group data
    if (session.data.groups) {
      const groupEntries = Object.entries(session.data.groups);
      await rebuildGroupsForRestore(groupEntries, savedTabs, oldToNewId, newTabWindowId, currentWindow, windowIdFilter);
    }

    // 5. Apply saved window names to the new windowIds
    if (session.data.windowNames) {
      for (const [savedWidStr, name] of Object.entries(session.data.windowNames)) {
        const newWid = windowMap.get(Number(savedWidStr));
        if (newWid) state.setWindowName(newWid, name);
      }
    }

    commitState();
    console.log(`[LinkMap] Session restored: "${session.name}" (${oldToNewId.size} tabs across ${savedWindowIds.length} windows)`);
  } catch (err) {
    console.error('[LinkMap] Failed to restore session:', err);
  }
}

/**
 * Deletes a saved session by ID.
 * @param {string} sessionId
 */
async function deleteSession(sessionId) {
  try {
    const result = await chrome.storage.local.get(SESSIONS_KEY);
    const sessions = (result[SESSIONS_KEY] || []).filter(s => s.id !== sessionId);
    await chrome.storage.local.set({ [SESSIONS_KEY]: sessions });
    DEBUG && console.log(`[LinkMap] Session deleted: ${sessionId}`);
  } catch (err) {
    console.error('[LinkMap] Failed to delete session:', err);
  }
}

/**
 * Returns all saved sessions (without full data payload, for listing).
 * @returns {Promise<Object[]>}
 */
async function getSessions() {
  try {
    const result = await chrome.storage.local.get(SESSIONS_KEY);
    const sessions = result[SESSIONS_KEY] || [];
    // Strip the heavy data field for listing
    return sessions.map(s => ({
      id: s.id,
      name: s.name,
      isAutoSave: s.isAutoSave,
      savedAt: s.savedAt,
      tabCount: s.tabCount,
      windowCount: s.windowCount,
      windows: s.windows,
    }));
  } catch (err) {
    console.error('[LinkMap] Failed to get sessions:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Undo Close / Recently Closed (chrome.sessions API)
// ---------------------------------------------------------------------------

/**
 * Restores the most recently closed tab, or a specific session entry.
 * @param {string} [sessionId] — specific session to restore, or omit for most recent
 */
async function undoCloseTab(sessionId) {
  try {
    if (sessionId) {
      await chrome.sessions.restore(sessionId);
    } else {
      const recentlyClosed = await chrome.sessions.getRecentlyClosed({ maxResults: 1 });
      if (recentlyClosed.length > 0) {
        const entry = recentlyClosed[0];
        const restoreId = entry.tab?.sessionId || entry.window?.sessionId;
        if (restoreId) {
          await chrome.sessions.restore(restoreId);
        }
      }
    }
  } catch (err) {
    console.error('[LinkMap] Undo close failed:', err);
  }
}

/**
 * Returns the last 25 recently closed tabs/windows.
 * @returns {Promise<Object[]>}
 */
async function getRecentlyClosed() {
  try {
    const entries = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
    // Filter to tabs only (not windows) for cleaner display
    return entries
      .filter(e => e.tab)
      .map(e => ({
        sessionId: e.tab.sessionId,
        tab: {
          title: e.tab.title,
          url: e.tab.url,
          favIconUrl: e.tab.favIconUrl,
        },
        lastModified: e.lastModified,
      }));
  } catch (err) {
    console.error('[LinkMap] Failed to get recently closed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Crash Detection
// ---------------------------------------------------------------------------

/**
 * Checks for a potential crash scenario: saved state had many tabs,
 * but Chrome currently has very few. If so, the most recent auto-save
 * should be offered for restore.
 * @param {number} savedTabCount — tabs in saved state before reconciliation
 * @param {number} liveTabCount — actual Chrome tabs
 */
function checkForCrashRecovery(savedTabCount, liveTabCount) {
  // If saved state had significantly more tabs than current Chrome
  // (at least 10 tabs lost and more than half gone), flag for recovery
  if (savedTabCount > 5 && liveTabCount < savedTabCount * 0.5) {
    // Broadcast a crash-recovery signal to the side panel
    try {
      chrome.runtime.sendMessage({
        type: MSG.CRASH_RECOVERY,
        payload: { savedTabCount, liveTabCount },
      }).catch(() => {});
    } catch (_e) {}

    console.log(`[LinkMap] Possible crash detected: had ${savedTabCount} tabs, now ${liveTabCount}`);
  }
}

// ---------------------------------------------------------------------------
// Auto-Archive Stale Tabs (Arc-inspired)
// ---------------------------------------------------------------------------

const AUTO_ARCHIVE_ALARM = 'linkmap-auto-archive';

function setupAutoArchiveAlarm() {
  // Check every 5 minutes for stale tabs
  chrome.alarms.create(AUTO_ARCHIVE_ALARM, {
    delayInMinutes: 5,
    periodInMinutes: 5,
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_ARCHIVE_ALARM) {
    archiveStaleTabs();
  }
});

async function archiveStaleTabs() {
  if (!settings.autoArchiveMinutes || settings.autoArchiveMinutes <= 0) return;

  const thresholdMs = settings.autoArchiveMinutes * 60 * 1000;
  const now = Date.now();

  try {
    const allTabs = await chrome.tabs.query({});
    for (const tab of allTabs) {
      // Skip: active tab, pinned tabs, already discarded
      if (tab.active || tab.pinned || tab.discarded) continue;

      // Check lastAccessed (Chrome 121+)
      const lastAccessed = tab.lastAccessed || 0;
      if (lastAccessed > 0 && (now - lastAccessed) > thresholdMs) {
        try {
          await chrome.tabs.discard(tab.id);
          DEBUG && console.log(`[LinkMap] Auto-archived stale tab: ${tab.id} "${tab.title}"`);
        } catch (_) { DEBUG && console.warn('[LinkMap] Archive error:', _); }
      }
    }
  } catch (err) {
    console.error('[LinkMap] Auto-archive error:', err);
  }
}

// ---------------------------------------------------------------------------
// Domain-Based Auto-Grouping
// ---------------------------------------------------------------------------

/** @type {Array<{pattern: string, group: string, color: string}>} */
let autoGroupRules = [];

/**
 * Validates a single auto-group rule to ensure it has the expected shape and safe values.
 * @param {unknown} rule
 * @returns {boolean}
 */
function validateRule(rule) {
  return (
    rule !== null &&
    typeof rule === 'object' &&
    typeof rule.pattern === 'string' &&
    rule.pattern.length > 0 &&
    rule.pattern.length < 500 &&
    typeof rule.group === 'string' &&
    rule.group.length > 0 &&
    (!rule.color || typeof rule.color === 'string')
  );
}

async function loadAutoGroupRules() {
  try {
    const result = await chrome.storage.local.get(AUTO_GROUP_RULES_KEY);
    autoGroupRules = (result[AUTO_GROUP_RULES_KEY] || []).filter(validateRule);
  } catch (_) {}
}

async function saveAutoGroupRules() {
  try {
    await chrome.storage.local.set({ [AUTO_GROUP_RULES_KEY]: autoGroupRules });
  } catch (err) {
    console.error('[LinkMap] saveAutoGroupRules failed:', err);
  }
}

// Serializes concurrent applyAutoGroupRules calls to prevent duplicate group creation.
let autoGroupLock = Promise.resolve();

/**
 * Checks if a tab URL matches any auto-group rule and groups it accordingly.
 * @param {Object} tab - Chrome tab object
 */
function applyAutoGroupRules(tab) {
  autoGroupLock = autoGroupLock.then(() => _applyAutoGroupRulesImpl(tab)).catch(() => {});
  return autoGroupLock;
}

async function _applyAutoGroupRulesImpl(tab) {
  if (!tab.url || autoGroupRules.length === 0) return;
  if (tab.pinned) return;

  for (const rule of autoGroupRules) {
    if (urlMatchesPattern(tab.url, rule.pattern)) {
      try {
        // Find or create the target group
        const existingGroups = await chrome.tabGroups.query({});
        let targetGroup = existingGroups.find(g => g.title === rule.group);

        if (targetGroup) {
          await chrome.tabs.group({ tabIds: [tab.id], groupId: targetGroup.id });
        } else {
          const newGroupId = await chrome.tabs.group({ tabIds: [tab.id] });
          await chrome.tabGroups.update(newGroupId, {
            title: rule.group,
            color: rule.color || 'grey',
          });
        }

        DEBUG && console.log(`[LinkMap] Auto-grouped tab "${tab.title}" into "${rule.group}"`);
      } catch (err) {
        console.error('[LinkMap] Auto-group failed:', err);
      }
      break; // first matching rule wins
    }
  }
}

/**
 * Matches a URL against a domain pattern.
 * Supports: "github.com", "*.google.com", "github.com/*"
 * @param {string} url
 * @param {string} pattern
 * @returns {boolean}
 */
function urlMatchesPattern(url, pattern) {
  try {
    const u = new URL(url);
    const hostname = u.hostname;

    // Wildcard subdomain: *.example.com
    if (pattern.startsWith('*.')) {
      const domain = pattern.slice(2);
      return hostname === domain || hostname.endsWith('.' + domain);
    }

    // Exact domain or domain with path wildcard
    const patternDomain = pattern.replace(/\/\*$/, '');
    return hostname === patternDomain || hostname.endsWith('.' + patternDomain);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Visit Frequency (chrome.history)
// ---------------------------------------------------------------------------

/** Cache of visit counts per URL to avoid repeated history lookups */
const visitCountCache = new Map();

/**
 * Gets visit frequency for a URL from chrome.history.
 * Results are cached to avoid excessive API calls.
 * @param {string} url
 * @returns {Promise<number>}
 */
async function getVisitCount(url) {
  if (!url) return 0;
  const cached = visitCountCache.get(url);
  if (cached && Date.now() - cached.time < 300000) return cached.count;

  try {
    const visits = await chrome.history.getVisits({ url });
    const count = visits.length;
    // Cap cache at 500 entries — evict oldest when exceeded
    if (visitCountCache.size >= 500) {
      const oldest = visitCountCache.keys().next().value;
      visitCountCache.delete(oldest);
    }
    visitCountCache.set(url, { count, time: Date.now() });
    return count;
  } catch {
    return 0;
  }
}

/**
 * Computes visit frequency tiers for all open tabs.
 * Returns a map of tabId -> { count, tier } where tier is 'hot', 'warm', 'normal'.
 * @returns {Promise<Object>}
 */
async function computeVisitFrequencies() {
  const result = {};
  const promises = [];

  for (const [tabId, node] of state.tabs) {
    if (!node.url) continue;
    promises.push(
      getVisitCount(node.url).then(count => {
        let tier = 'normal';
        if (count >= 20) tier = 'hot';
        else if (count >= 5) tier = 'warm';
        result[tabId] = { count, tier };
      })
    );
  }

  await Promise.all(promises);
  return result;
}

// ---------------------------------------------------------------------------
// Cross-Device Tab Access
// ---------------------------------------------------------------------------

/**
 * Gets tabs from other synced Chrome devices.
 * @returns {Promise<Object[]>}
 */
async function getOtherDevices() {
  try {
    const devices = await chrome.sessions.getDevices({ maxResults: 10 });
    return devices.map(device => ({
      deviceName: device.deviceName,
      sessions: device.sessions.map(session => ({
        lastModified: session.lastModified,
        tabs: session.window?.tabs?.map(tab => ({
          title: tab.title,
          url: tab.url,
          favIconUrl: tab.favIconUrl,
        })) || [],
      })),
    }));
  } catch (err) {
    console.error('[LinkMap] Failed to get devices:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tab Event Listeners
// ---------------------------------------------------------------------------

/** @type {Set<string>} Fields in changeInfo that trigger an update. */
const RELEVANT_CHANGE_FIELDS = new Set([
  'title', 'url', 'favIconUrl', 'status', 'pinned', 'audible', 'mutedInfo', 'groupId',
]);

/**
 * chrome.tabs.onCreated — A new tab was created.
 */
chrome.tabs.onCreated.addListener((tab) => {
  if (!initComplete) return;
  const node = {
    tabId: tab.id,
    parentId: tab.openerTabId || null,
    title: tab.title || 'New Tab',
    url: tab.url || '',
    favIconUrl: tab.favIconUrl || '',
    pinned: tab.pinned ?? false,
    audible: false,
    status: tab.status || 'loading',
    groupId: tab.groupId || UNGROUPED_GROUP_ID,
    index: tab.index,
    windowId: tab.windowId,
  };

  state.addTab(tab.id, node);
  invalidateDuplicateMap();
  commitTreeChange();

  // Auto-group: check if new tab matches any domain rules
  if (tab.url) applyAutoGroupRules(tab);

  DEBUG && console.log(`[LinkMap] Tab created: ${tab.id} "${node.title}"`);
});

/**
 * chrome.tabs.onRemoved — A tab was closed.
 */
chrome.tabs.onRemoved.addListener((tabId, _removeInfo) => {
  if (!initComplete) return;
  state.removeTab(tabId);
  invalidateDuplicateMap();

  if (activeTabId === tabId) {
    activeTabId = null;
  }

  // Clean up tab notes for closed tab
  delete tabNotes[tabId];

  // Prune closed tabId from all workspaces
  for (const ws of workspaces) {
    const idx = ws.tabIds.indexOf(tabId);
    if (idx !== -1) ws.tabIds.splice(idx, 1);
  }

  // Chrome fires spurious tabGroups.onUpdated(collapsed: true) after tab removal.
  suppressGroupCollapseForBurst();

  commitTreeChange();

  DEBUG && console.log(`[LinkMap] Tab removed: ${tabId}`);
});

/**
 * chrome.tabs.onUpdated — A tab's properties changed.
 * Only processes updates with relevant fields.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, _tab) => {
  if (!initComplete) return;
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
  if ('mutedInfo' in changeInfo) changes.muted = changeInfo.mutedInfo.muted;
  if ('groupId' in changeInfo) changes.groupId = changeInfo.groupId;

  state.updateTab(tabId, changes);

  // Invalidate duplicate map on URL change (URLs determine duplicates)
  if ('url' in changeInfo) invalidateDuplicateMap();

  // Auto-group: check on URL change
  if ('url' in changeInfo && changeInfo.url) {
    const node = state.tabs.get(tabId);
    if (node && (node.groupId === undefined || node.groupId === UNGROUPED_GROUP_ID)) {
      applyAutoGroupRules({ id: tabId, url: changeInfo.url, pinned: node.pinned });
    }
  }

  // Group membership change: reposition tab to be contiguous with group members
  if ('groupId' in changeInfo && changeInfo.groupId !== UNGROUPED_GROUP_ID) {
    repositionTabToGroup(tabId, changeInfo.groupId);
  }

  // Pin transition handling (BUGs 3 + 4)
  if ('pinned' in changeInfo) {
    const node = state.tabs.get(tabId);
    if (node && changeInfo.pinned) {
      // BUG 3: Promote nested tab to root before repositioning
      if (node.parentId != null) {
        state.moveTab(tabId, null, 0);
      }
      // BUG 4: Reposition to end of pinned zone (exclude self to avoid off-by-one)
      const boundary = getPinnedBoundaryIndex(tabId);
      state.moveTab(tabId, null, Math.max(0, boundary));
    } else if (node && !changeInfo.pinned) {
      // BUG 4: Move to just after pinned zone
      const boundary = getPinnedBoundaryIndex(tabId);
      state.moveTab(tabId, null, boundary);
    }
  }

  commitState();
});

/**
 * chrome.tabs.onMoved — A tab was moved in the tab strip.
 */
chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  if (!initComplete) return;
  state.updateTab(tabId, { index: moveInfo.toIndex });
  commitState();

  DEBUG && console.log(`[LinkMap] Tab moved: ${tabId} to index ${moveInfo.toIndex}`);
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

  DEBUG && console.log(`[LinkMap] Tab activated: ${activeInfo.tabId}`);
});

/**
 * chrome.tabs.onAttached — A tab was attached to a window.
 */
chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  if (!initComplete) return;
  state.updateTab(tabId, {
    windowId: attachInfo.newWindowId,
    index: attachInfo.newPosition,
  });
  commitState();

  DEBUG && console.log(`[LinkMap] Tab attached: ${tabId} to window ${attachInfo.newWindowId}`);
});

/**
 * chrome.tabs.onDetached — A tab was detached from a window.
 * v1: Single-window focus — just log it, don't remove the tab.
 */
chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
  if (!initComplete) return;
  DEBUG && console.log(`[LinkMap] Tab detached: ${tabId} from window ${detachInfo.oldWindowId}`);
  commitState();
});

/**
 * chrome.tabs.onReplaced — A tab ID was replaced (prerendered → real).
 * Remaps the old ID to the new ID in ShadowState, preserving tree structure.
 */
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (!initComplete) return;
  state.replaceTabId(removedTabId, addedTabId);
  commitState();

  DEBUG && console.log(`[LinkMap] Tab replaced: ${removedTabId} → ${addedTabId}`);
});

// ---------------------------------------------------------------------------
// Duplicate Tab Detection
// ---------------------------------------------------------------------------

/**
 * Normalizes a URL for duplicate comparison.
 * Strips trailing slashes, fragments, and common tracking params.
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    // Skip internal Chrome pages
    if (u.protocol === 'chrome:' || u.protocol === 'chrome-extension:' || u.protocol === 'about:') {
      return '';
    }
    // Remove tracking params
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid', 'gclid'];
    for (const p of trackingParams) u.searchParams.delete(p);
    u.searchParams.sort();
    // Remove fragment
    u.hash = '';
    // Remove trailing slash
    let path = u.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return `${u.origin}${path}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * Finds duplicate tab IDs for a given URL (tabs sharing the same normalized URL).
 * @param {string} url
 * @returns {number[]} Array of tab IDs that share this URL
 */
function findDuplicateTabIds(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return [];

  const matches = [];
  for (const [tabId, node] of state.tabs) {
    if (normalizeUrl(node.url) === normalized) {
      matches.push(tabId);
    }
  }
  return matches;
}

/**
 * Computes the full duplicate map: normalized URL -> [tabId, ...].
 * Only includes URLs with 2+ tabs.
 * @returns {Object<string, number[]>}
 */
let _duplicateMapCache = null;
let _duplicateMapDirty = true;

function invalidateDuplicateMap() { _duplicateMapDirty = true; }

function getDuplicateMap() {
  if (!_duplicateMapDirty && _duplicateMapCache) return _duplicateMapCache;
  const urlMap = {};
  for (const [tabId, node] of state.tabs) {
    const norm = normalizeUrl(node.url);
    if (!norm) continue;
    if (!urlMap[norm]) urlMap[norm] = [];
    urlMap[norm].push(tabId);
  }
  // Filter to only duplicates
  const result = {};
  for (const [url, ids] of Object.entries(urlMap)) {
    if (ids.length > 1) result[url] = ids;
  }
  _duplicateMapCache = result;
  _duplicateMapDirty = false;
  return result;
}

// ---------------------------------------------------------------------------
// Tab Group Event Listeners
// ---------------------------------------------------------------------------

/**
 * chrome.tabGroups.onCreated — A tab group was created.
 */
chrome.tabGroups.onCreated.addListener((group) => {
  if (!initComplete) return;
  state.addGroup(group);
  commitState();

  DEBUG && console.log(`[LinkMap] Group created: ${group.id} "${group.title || 'untitled'}"`);
});

/**
 * chrome.tabGroups.onUpdated — A tab group's properties changed.
 */
chrome.tabGroups.onUpdated.addListener((group) => {
  if (!initComplete) return;
  const updates = {
    color: group.color,
  };
  // Only apply title if not suppressed (prevents stale title overwrite during rename)
  if (suppressGroupTitleCount === 0) {
    // Don't overwrite a saved title with an empty one (session restore race)
    const existing = state.groups.get(group.id);
    if (group.title || !existing?.title) {
      updates.title = group.title;
    }
  }
  // Only apply collapse state if not suppressed (prevents spurious collapse on tab close)
  if (!(suppressGroupCollapseCount > 0 && group.collapsed)) {
    updates.collapsed = group.collapsed;
  }
  state.updateGroup(group.id, updates);
  commitState();

  DEBUG && console.log(`[LinkMap] Group updated: ${group.id} "${group.title || 'untitled'}" collapsed=${group.collapsed}${suppressGroupCollapseCount > 0 ? ' (suppressed)' : ''}`);
});

/**
 * chrome.tabGroups.onRemoved — A tab group was removed.
 */
chrome.tabGroups.onRemoved.addListener((group) => {
  if (!initComplete) return;
  state.removeGroup(group.id);
  commitState();

  DEBUG && console.log(`[LinkMap] Group removed: ${group.id}`);
});

// ---------------------------------------------------------------------------
// Window Event Listeners
// ---------------------------------------------------------------------------

/**
 * chrome.windows.onFocusChanged — Track the currently focused window.
 * WINDOW_ID_NONE (-1) means all windows lost focus (e.g., Alt-Tab away).
 */
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  currentWindowId = windowId;
  broadcastState();
});

// ---------------------------------------------------------------------------
// Service Worker Lifecycle
// ---------------------------------------------------------------------------

/**
 * chrome.runtime.onSuspend — Flush state before worker terminates.
 */
chrome.runtime.onSuspend.addListener(() => {
  chrome.storage.local.set({
    [STORAGE_KEY]: state.toSerializable(),
    [TREE_EDGES_KEY]: state.toTreeEdges(),
  });
  // Fire a quick auto-save before suspend
  saveSession('Auto-Save (Suspend)', true);
  console.log('[LinkMap] State flushed on suspend');
});

// ---------------------------------------------------------------------------
// Message Handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  const { type, payload } = message;

  switch (type) {
    case MSG.GET_STATE:
      initDone.then(async () => {
        const payload = getStatePayload();
        try {
          payload.visitFrequency = await computeVisitFrequencies();
        } catch (err) {
          DEBUG && console.warn('[LinkMap] Visit frequency error:', err);
          payload.visitFrequency = {};
        }
        sendResponse(payload);
      });
      return true; // keep channel open for async response

    case MSG.ACTIVATE_TAB:
      chrome.tabs.update(payload.tabId, { active: true }).catch(err => {
        console.warn('[LinkMap] ACTIVATE_TAB failed:', err);
      });
      break;

    case MSG.CLOSE_TAB:
      chrome.tabs.remove(payload.tabId).catch(() => {});
      break;

    case MSG.CLOSE_TABS:
      chrome.tabs.remove(payload.tabIds).catch(() => {});
      break;

    case MSG.MOVE_TAB: {
      const { tabId, newParentId, targetTabId, position, targetWindowId, targetGroupId } = payload;
      const sourceTab = state.getTab(tabId);
      const needsWindowMove = targetWindowId && sourceTab && sourceTab.windowId !== targetWindowId;
      let mode;

      if (position === 'group') {
        mode = moveTabToGroup(tabId, targetGroupId);
      } else if (position === 'window') {
        mode = needsWindowMove ? moveTabToWindow(tabId, targetWindowId) : 'async';
      } else if (position === 'child') {
        mode = moveTabAsChild(tabId, newParentId, needsWindowMove, targetWindowId);
      } else if (position === 'before' || position === 'after') {
        mode = moveTabBeforeAfter(tabId, newParentId, targetTabId, position, needsWindowMove, targetWindowId);
      } else {
        // Legacy format: { tabId, newParentId, index }
        state.moveTab(tabId, newParentId, payload.index ?? 0);
        mode = 'sync';
      }

      if (mode === 'sync') {
        // Sync Chrome group membership when dropping near grouped tabs
        if (targetGroupId !== undefined) {
          const currentGroupId = sourceTab?.groupId;
          if (currentGroupId !== targetGroupId) {
            chrome.tabs.group({ tabIds: [tabId], groupId: targetGroupId }).catch((err) => {
              console.error('[LinkMap] Group sync failed:', err);
            });
          }
        }
        commitTreeChange();
      }
      break;
    }

    case MSG.TOGGLE_COLLAPSE: {
      const wasCollapsed = state.isCollapsed(payload.tabId);
      state.toggleCollapse(payload.tabId);

      // Sleep on collapse: discard descendant tabs when collapsing
      if (!wasCollapsed && settings.sleepOnCollapse) {
        const descendants = state.getDescendants(payload.tabId);
        for (const desc of descendants) {
          if (desc.tabId !== activeTabId && desc.status !== 'unloaded') {
            chrome.tabs.discard(desc.tabId).catch(() => {});
          }
        }
      }

      commitState();
      break;
    }

    case MSG.COLLAPSE_ALL:
      state.collapseAll();
      commitState();
      break;

    case MSG.EXPAND_ALL:
      state.expandAll();
      commitState();
      break;

    case MSG.FOCUS_MODE:
      state.focusOnBranch(payload.tabId);
      commitState();
      break;

    case MSG.SET_THEME:
      state.setTheme(payload.theme);
      commitState();
      try {
        chrome.runtime.sendMessage({
          type: MSG.THEME_CHANGED,
          payload: { theme: payload.theme },
        }).catch(() => {});
      } catch (_e) {
        // Side panel not open.
      }
      // Smart Mapper: auto-update Chrome group colors to match theme accent
      syncGroupColorsToTheme(payload.theme);
      break;

    case MSG.SET_GROUP_COLOR: {
      state.setGroupColor(payload.groupId, payload.color);
      commitState();
      // Smart Mapper: sync custom hex to nearest Chrome enum
      const chromeColor = nearestChromeGroupColor(payload.color);
      chrome.tabGroups.update(payload.groupId, { color: chromeColor }).catch(() => {});
      break;
    }

    case MSG.PIN_TAB:
      chrome.tabs.update(payload.tabId, { pinned: payload.pinned }).catch((err) => {
        console.warn('[LinkMap] PIN_TAB failed:', err.message, 'tabId:', payload.tabId);
      });
      break;

    case MSG.DUPLICATE_TAB: {
      (async () => {
        try {
          const newTab = await chrome.tabs.duplicate(payload.tabId);
          // onCreated already fired — newTab is in state.tabs and rootIds
          if (newTab?.id) {
            const sourceIdx = state.rootIds.indexOf(payload.tabId);
            if (sourceIdx !== -1) {
              state.moveTab(newTab.id, null, sourceIdx + 1);
            }
            commitState();
          }
        } catch (err) {
          console.error('[LinkMap] Duplicate failed:', err);
        }
      })();
      break;
    }

    case MSG.MUTE_TAB:
      chrome.tabs.update(payload.tabId, { muted: payload.muted }).catch(() => {});
      break;

    case MSG.NEW_TAB_BELOW: {
      const refTab = state.getTab(payload.tabId);
      if (refTab) {
        (async () => {
          try {
            const newTab = await chrome.tabs.create({
              windowId: refTab.windowId,
              index: refTab.index + 1,
              openerTabId: payload.tabId,
            });
            // onCreated already fired — reposition in sidebar tree
            if (newTab?.id) {
              if (refTab.pinned) {
                // Pinned tab: place new tab at the top of the sidebar
                state.moveTab(newTab.id, null, 0);
              } else {
                // Normal tab: place as sibling immediately after ref tab
                const refParentId = refTab.parentId ?? null;
                if (refParentId != null) {
                  const parent = state.getTab(refParentId);
                  if (parent) {
                    const refIdx = parent.children.indexOf(payload.tabId);
                    state.moveTab(newTab.id, refParentId, refIdx + 1);
                  }
                } else {
                  const refIdx = state.rootIds.indexOf(payload.tabId);
                  if (refIdx !== -1) {
                    state.moveTab(newTab.id, null, refIdx + 1);
                  }
                }
              }
              commitTreeChange();
            }
          } catch (err) {
            console.error('[LinkMap] NEW_TAB_BELOW failed:', err);
          }
        })();
      }
      break;
    }

    case MSG.NEW_TAB_IN_GROUP: {
      const { groupId: newTabGid } = payload;
      (async () => {
        try {
          // Find a tab in this group to determine windowId and position
          const groupTabs = [];
          for (const [, t] of state.tabs) {
            if (t.groupId === newTabGid) groupTabs.push(t);
          }
          if (groupTabs.length > 0) {
            const lastTab = groupTabs.reduce((a, b) => a.index > b.index ? a : b);
            const newTab = await chrome.tabs.create({
              windowId: lastTab.windowId,
              index: lastTab.index + 1,
            });
            await chrome.tabs.group({ tabIds: [newTab.id], groupId: newTabGid }).catch(err => {
              console.warn('[LinkMap] NEW_TAB_IN_GROUP group assign failed:', err);
            });
          } else {
            const newTab = await chrome.tabs.create({});
            await chrome.tabs.group({ tabIds: [newTab.id], groupId: newTabGid }).catch(err => {
              console.warn('[LinkMap] NEW_TAB_IN_GROUP group assign failed:', err);
            });
          }
        } catch (err) {
          console.error('[LinkMap] NEW_TAB_IN_GROUP failed:', err);
        }
      })();
      break;
    }

    case MSG.TOGGLE_GROUP_COLLAPSE: {
      const { groupId: toggleGid } = payload;
      const toggleGroup = state.groups.get(toggleGid);
      if (!toggleGroup) break;
      const newCollapsed = !toggleGroup.collapsed;
      state.updateGroup(toggleGid, { collapsed: newCollapsed });
      suppressGroupCollapseForBurst();
      chrome.tabGroups.update(toggleGid, { collapsed: newCollapsed }).catch(() => {});
      commitState();
      break;
    }

    case MSG.RENAME_GROUP: {
      const { groupId: renameGid, title: newTitle } = payload;
      state.updateGroup(renameGid, { title: newTitle });
      suppressGroupTitleForBurst();
      chrome.tabGroups.update(renameGid, { title: newTitle }).catch((err) => {
        console.error('[LinkMap] Group rename failed:', err);
      });
      commitState();
      break;
    }

    case MSG.MOVE_GROUP: {
      const { groupId, anchorTabId, anchorGroupId, position } = payload;

      let resolvedAnchorTabId = anchorTabId;

      // If dropped on a group header, resolve to first/last member tab
      if (anchorGroupId !== undefined) {
        const anchorGroupTabs = state.rootIds.filter(id => {
          const tab = state.tabs.get(id);
          return tab && tab.groupId === anchorGroupId;
        });
        if (anchorGroupTabs.length === 0) break;
        resolvedAnchorTabId = position === 'before'
          ? anchorGroupTabs[0]
          : anchorGroupTabs[anchorGroupTabs.length - 1];
      }

      state.moveGroup(groupId, resolvedAnchorTabId, position);

      // Sync with Chrome tab strip
      // Suppress spurious collapse events — chrome.tabGroups.move() triggers onUpdated
      const anchorTab = state.getTab(resolvedAnchorTabId);
      if (anchorTab) {
        const targetIndex = position === 'before' ? anchorTab.index : anchorTab.index + 1;
        suppressGroupCollapseForBurst();
        chrome.tabGroups.move(groupId, { index: targetIndex }).catch(() => {});
      }

      commitState();
      break;
    }

    case MSG.MOVE_TO_GROUP: {
      (async () => {
        try {
          const tab = await chrome.tabs.get(payload.tabId);
          if (tab.pinned) {
            await chrome.tabs.update(payload.tabId, { pinned: false });
            // Poll until Chrome confirms unpin (max 500ms)
            let verified = false;
            for (let i = 0; i < 10; i++) {
              const fresh = await chrome.tabs.get(payload.tabId);
              if (!fresh.pinned) { verified = true; break; }
              await new Promise(r => setTimeout(r, 50));
            }
            if (!verified) {
              sendResponse({ error: 'unpin_failed' });
              return;
            }
          }
          const resultGroupId = payload.groupId != null
            ? await chrome.tabs.group({ tabIds: [payload.tabId], groupId: payload.groupId })
            : await chrome.tabs.group({ tabIds: [payload.tabId] });

          // Reorder rootIds: move tab adjacent to its group members
          repositionTabToGroup(payload.tabId, resultGroupId);
          commitState();

          sendResponse({ groupId: resultGroupId });
        } catch (err) {
          console.error('[LinkMap] MOVE_TO_GROUP error:', err);
          sendResponse({ error: err.message });
        }
      })();
      return true; // keep channel open for async sendResponse
    }

    case MSG.UNGROUP_TAB:
      chrome.tabs.ungroup(payload.tabIds || [payload.tabId]).catch((err) => {
        console.error('[LinkMap] Ungroup failed:', err);
      });
      break;

    case MSG.RELOAD_TAB:
      chrome.tabs.reload(payload.tabId).catch(() => {});
      break;

    case MSG.MOVE_TO_NEW_WINDOW:
      chrome.windows.create({ tabId: payload.tabId }).catch(err => {
        console.warn('[LinkMap] MOVE_TO_NEW_WINDOW failed:', err);
      });
      break;

    case MSG.RENAME_WINDOW: {
      const { windowId, name } = payload;
      state.setWindowName(windowId, name);
      commitState();
      break;
    }

    case MSG.DISCARD_TABS:
      (async () => {
        for (const id of payload.tabIds) {
          try { await chrome.tabs.discard(id); } catch (_) {}
        }
      })();
      break;

    case MSG.SAVE_GROUP: {
      (async () => {
        const groupData = state.groups.get(payload.groupId);
        const groupTabs = [...state.tabs.values()]
          .filter(t => t.groupId === payload.groupId)
          .map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl }));
        const saved = {
          groupId: payload.groupId,
          title: groupData?.title || 'Untitled Group',
          color: groupData?.color || 'grey',
          savedAt: new Date().toISOString(),
          tabs: groupTabs,
        };
        const result = await chrome.storage.local.get(SAVED_GROUPS_KEY);
        const list = result[SAVED_GROUPS_KEY] || [];
        list.push(saved);
        await chrome.storage.local.set({ [SAVED_GROUPS_KEY]: list });
        DEBUG && console.log(`[LinkMap] Group saved: "${saved.title}" (${groupTabs.length} tabs)`);
      })();
      break;
    }

    case MSG.CLOSE_DUPLICATES: {
      const tabUrl = payload.url;
      const norm = normalizeUrl(tabUrl);
      if (!norm) break;
      // Find all tabs with this URL, keep the oldest (lowest tabId), close the rest
      const dupes = [];
      for (const [tabId, node] of state.tabs) {
        if (normalizeUrl(node.url) === norm) dupes.push(tabId);
      }
      if (dupes.length > 1) {
        dupes.sort((a, b) => a - b); // keep lowest ID
        chrome.tabs.remove(dupes.slice(1)).catch(() => {});
      }
      break;
    }

    // -----------------------------------------------------------------
    // Session Management
    // -----------------------------------------------------------------

    case MSG.SAVE_SESSION: {
      const { name, isAutoSave } = payload;
      saveSession(name || 'Untitled', isAutoSave || false);
      break;
    }

    case MSG.RESTORE_SESSION: {
      restoreSession(payload.sessionId);
      break;
    }

    case MSG.RESTORE_SESSION_WINDOW: {
      const { sessionId, windowId } = payload;
      restoreSession(sessionId, windowId);
      break;
    }

    case MSG.DELETE_SESSION: {
      deleteSession(payload.sessionId);
      break;
    }

    case MSG.GET_SESSIONS: {
      getSessions().then(sessions => {
        sendResponse({ sessions });
      });
      return true; // keep channel open for async response
    }

    case MSG.UNDO_CLOSE: {
      undoCloseTab(payload?.sessionId);
      break;
    }

    case MSG.GET_RECENTLY_CLOSED: {
      getRecentlyClosed().then(entries => {
        sendResponse({ entries });
      });
      return true; // keep channel open for async response
    }

    case MSG.GET_SETTINGS: {
      sendResponse({ settings });
      break;
    }

    case MSG.UPDATE_SETTINGS: {
      const ALLOWED_SETTINGS = ['sleepOnCollapse', 'autoSaveEnabled', 'autoArchiveMinutes'];
      const filtered = {};
      for (const key of ALLOWED_SETTINGS) {
        if (key in payload) filtered[key] = payload[key];
      }
      settings = { ...settings, ...filtered };
      chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      broadcastState();
      break;
    }

    case MSG.GET_AUTO_GROUP_RULES: {
      sendResponse({ rules: autoGroupRules });
      break;
    }

    case MSG.SET_AUTO_GROUP_RULES: {
      const rules = Array.isArray(payload.rules) ? payload.rules : [];
      autoGroupRules = rules.filter(validateRule);
      saveAutoGroupRules();
      break;
    }

    case MSG.GET_OTHER_DEVICES: {
      getOtherDevices().then(devices => {
        sendResponse({ devices });
      });
      return true;
    }

    // -----------------------------------------------------------------
    // Workspaces
    // -----------------------------------------------------------------

    case MSG.CREATE_WORKSPACE: {
      const ws = {
        id: `ws-${Date.now()}`,
        name: payload.name || 'New Workspace',
        color: payload.color || '#c084fc',
        tabIds: [],
      };
      workspaces.push(ws);
      saveWorkspaces();
      broadcastState();
      break;
    }

    case MSG.SWITCH_WORKSPACE: {
      activeWorkspaceId = payload.workspaceId;
      saveWorkspaces();
      broadcastState();
      break;
    }

    case MSG.DELETE_WORKSPACE: {
      workspaces = workspaces.filter(ws => ws.id !== payload.workspaceId);
      if (activeWorkspaceId === payload.workspaceId) {
        activeWorkspaceId = workspaces.length > 0 ? workspaces[0].id : null;
      }
      saveWorkspaces();
      broadcastState();
      break;
    }

    case MSG.RENAME_WORKSPACE: {
      const ws = workspaces.find(w => w.id === payload.workspaceId);
      if (ws) {
        ws.name = payload.name || ws.name;
        if (payload.color) ws.color = payload.color;
        saveWorkspaces();
        broadcastState();
      }
      break;
    }

    case MSG.UPDATE_WORKSPACE: {
      const wsToUpdate = workspaces.find(w => w.id === payload.workspaceId);
      if (wsToUpdate) {
        if (payload.name) wsToUpdate.name = payload.name;
        if (payload.color) wsToUpdate.color = payload.color;
        saveWorkspaces();
        broadcastState();
      }
      break;
    }

    case MSG.GET_WORKSPACES: {
      sendResponse({ workspaces, activeWorkspaceId });
      break;
    }

    case MSG.MOVE_TO_WORKSPACE: {
      const targetWs = workspaces.find(w => w.id === payload.workspaceId);
      if (targetWs) {
        const tabIds = payload.tabIds || [payload.tabId];
        for (const id of tabIds) {
          // Remove from other workspaces
          for (const ws of workspaces) {
            ws.tabIds = ws.tabIds.filter(t => t !== id);
          }
          targetWs.tabIds.push(id);
        }
        saveWorkspaces();
        broadcastState();
      }
      break;
    }

    // -----------------------------------------------------------------
    // Tab Notes
    // -----------------------------------------------------------------

    case MSG.SET_TAB_NOTE: {
      const { tabId: noteTabId, note } = payload;
      if (note && note.trim()) {
        tabNotes[noteTabId] = note.trim();
      } else {
        delete tabNotes[noteTabId];
      }
      chrome.storage.local.set({ [TAB_NOTES_KEY]: tabNotes });
      broadcastState();
      break;
    }

    // -----------------------------------------------------------------
    // Multi-Select Bulk Operations
    // -----------------------------------------------------------------

    case MSG.MULTI_CLOSE: {
      if (payload.tabIds?.length > 0) {
        chrome.tabs.remove(payload.tabIds).catch(() => {});
      }
      break;
    }

    case MSG.MULTI_GROUP: {
      (async () => {
        if (!payload.tabIds?.length) return;
        try {
          const groupId = payload.groupId != null
            ? await chrome.tabs.group({ tabIds: payload.tabIds, groupId: payload.groupId })
            : await chrome.tabs.group({ tabIds: payload.tabIds });
          if (payload.title) {
            await chrome.tabGroups.update(groupId, { title: payload.title });
          }
        } catch (err) {
          console.error('[LinkMap] Multi-group failed:', err);
        }
      })();
      break;
    }

    case MSG.MULTI_SLEEP: {
      (async () => {
        for (const id of (payload.tabIds || [])) {
          if (id !== activeTabId) {
            try { await chrome.tabs.discard(id); } catch (_) {}
          }
        }
      })();
      break;
    }

    // -----------------------------------------------------------------
    // Bookmarks
    // -----------------------------------------------------------------

    case MSG.SAVE_TREE_AS_BOOKMARKS: {
      saveTreeAsBookmarks();
      break;
    }

    case MSG.OPEN_BOOKMARK_FOLDER: {
      openBookmarkFolder(payload.folderId);
      break;
    }

    case MSG.REORDER_PINNED: {
      const { tabId: reorderTabId, targetTabId: reorderTargetId, position: reorderPos } = payload;
      const source = state.tabs.get(reorderTabId);
      const target = state.tabs.get(reorderTargetId);
      if (!source?.pinned || !target?.pinned) break;

      const targetIdx = state.rootIds.indexOf(reorderTargetId);
      if (targetIdx === -1) break;

      const insertIdx = reorderPos === 'after' ? targetIdx + 1 : targetIdx;
      state.moveTab(reorderTabId, null, insertIdx);

      // Sync Chrome tab strip order
      chrome.tabs.move(reorderTabId, { index: insertIdx }).catch(() => {});

      commitState();
      break;
    }

    default:
      DEBUG && console.log(`[LinkMap] Unknown message type: ${type}`);
  }
});

// ---------------------------------------------------------------------------
// MOVE_TAB position handlers
// ---------------------------------------------------------------------------

/**
 * Handles drop on a group header — adds tab to end of that group.
 * Awaits Chrome API confirmation before mutating state to prevent drift.
 * @returns {'async'}
 */
function moveTabToGroup(tabId, targetGroupId) {
  chrome.tabs.group({ tabIds: [tabId], groupId: targetGroupId })
    .then(() => {
      repositionTabToGroup(tabId, targetGroupId);
      commitState();
    })
    .catch((err) => {
      console.error('[LinkMap] Group add failed:', err);
    });
  return 'async';
}

/**
 * Handles drop on a window separator — moves tab to end of that window.
 * @returns {'async'}
 */
function moveTabToWindow(tabId, targetWindowId) {
  chrome.tabs.move(tabId, { windowId: targetWindowId, index: -1 }).catch((err) => {
    console.error('[LinkMap] Cross-window move failed:', err);
  });
  // onAttached listener will update state and broadcast
  return 'async';
}

/**
 * Handles reparenting — makes tabId a child of parentId.
 * @returns {'sync'|'async'}
 */
function moveTabAsChild(tabId, parentId, needsWindowMove, targetWindowId) {
  if (needsWindowMove) {
    chrome.tabs.move(tabId, { windowId: targetWindowId, index: -1 }).then(() => {
      state.moveTab(tabId, parentId, 0);
      commitState();
    }).catch((err) => {
      console.error('[LinkMap] Cross-window move failed:', err);
    });
    return 'async';
  }
  state.moveTab(tabId, parentId, 0);
  return 'sync';
}

/**
 * Handles before/after reordering within siblings.
 * @returns {'sync'|'async'}
 */
function moveTabBeforeAfter(tabId, parentId, targetTabId, position, needsWindowMove, targetWindowId) {
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
  if (needsWindowMove) {
    chrome.tabs.move(tabId, { windowId: targetWindowId, index: -1 }).then(() => {
      state.moveTab(tabId, parentId, targetIndex);
      commitState();
    }).catch((err) => {
      console.error('[LinkMap] Cross-window move failed:', err);
    });
    return 'async';
  }
  state.moveTab(tabId, parentId, targetIndex);
  return 'sync';
}

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

function saveWorkspaces() {
  chrome.storage.local.set({
    [WORKSPACES_KEY]: { workspaces, activeWorkspaceId },
  });
}

// ---------------------------------------------------------------------------
// Bookmark helpers
// ---------------------------------------------------------------------------

/**
 * Saves the current tab tree as a bookmark folder structure.
 * Mirrors the tree hierarchy: root tabs become bookmarks, children become subfolders.
 */
async function saveTreeAsBookmarks() {
  try {
    const folderName = `LinkMap — ${new Date().toLocaleDateString()}`;
    const root = await chrome.bookmarks.create({ title: folderName });

    // Recursive tree walk
    async function saveSubtree(tabIds, parentBookmarkId) {
      for (const tabId of tabIds) {
        const node = state.tabs.get(tabId);
        if (!node) continue;

        if (node.children && node.children.length > 0) {
          // Tab with children: create a folder with the tab as the first bookmark
          const folder = await chrome.bookmarks.create({
            parentId: parentBookmarkId,
            title: node.title || 'Untitled',
          });
          // Add the tab URL itself as the first bookmark in the folder
          await chrome.bookmarks.create({
            parentId: folder.id,
            title: node.title || 'Untitled',
            url: node.url,
          });
          // Recurse for children
          await saveSubtree(node.children, folder.id);
        } else {
          // Leaf tab: just a bookmark
          await chrome.bookmarks.create({
            parentId: parentBookmarkId,
            title: node.title || 'Untitled',
            url: node.url,
          });
        }
      }
    }

    await saveSubtree(state.rootIds, root.id);
    console.log(`[LinkMap] Tree saved as bookmarks: "${folderName}"`);
  } catch (err) {
    console.error('[LinkMap] Failed to save bookmarks:', err);
  }
}

/**
 * Opens all bookmarks in a folder as tabs.
 * @param {string} folderId
 */
async function openBookmarkFolder(folderId) {
  try {
    const children = await chrome.bookmarks.getChildren(folderId);
    for (const child of children) {
      if (child.url) {
        await chrome.tabs.create({ url: child.url, active: false });
      }
    }
  } catch (err) {
    console.error('[LinkMap] Failed to open bookmark folder:', err);
  }
}

// ---------------------------------------------------------------------------
// Pinned-tab helpers
// ---------------------------------------------------------------------------

/**
 * Returns the index in rootIds just past the last pinned tab.
 * If no pinned tabs exist, returns 0.
 */
function getPinnedBoundaryIndex(excludeTabId) {
  let lastPinned = -1;
  for (let i = 0; i < state.rootIds.length; i++) {
    if (state.rootIds[i] === excludeTabId) continue;
    const tab = state.tabs.get(state.rootIds[i]);
    if (tab && tab.pinned) lastPinned = i;
  }
  return lastPinned + 1;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Repositions a tab in rootIds to sit adjacent to its group members.
 * Scans ALL tabs (not just rootIds) via state.getGroupMemberIds().
 * Includes off-by-one correction when the tab is before the target index.
 *
 * @param {number} tabId - Tab to reposition
 * @param {number} groupId - Target group
 */
function repositionTabToGroup(tabId, groupId) {
  const memberSet = new Set(state.getGroupMemberIds(groupId));
  // Find the last root-level member that isn't the tab being moved
  let lastRootIdx = -1;
  for (let i = 0; i < state.rootIds.length; i++) {
    if (state.rootIds[i] !== tabId && memberSet.has(state.rootIds[i])) {
      lastRootIdx = i;
    }
  }
  if (lastRootIdx !== -1) {
    let targetIndex = lastRootIdx + 1;
    // Off-by-one: if tab is before target, removal shifts indices down
    const currentIndex = state.rootIds.indexOf(tabId);
    if (currentIndex !== -1 && currentIndex < targetIndex) {
      targetIndex--;
    }
    state.moveTab(tabId, null, targetIndex);
  }
}

// ---------------------------------------------------------------------------
// Smart Mapper — Theme → Chrome Group Color Sync
// ---------------------------------------------------------------------------

/**
 * When a theme is activated, update all Chrome tab groups to the nearest
 * Chrome color enum matching the theme's accent color.
 *
 * @param {string} themeName
 */
async function syncGroupColorsToTheme(themeName) {
  const accentHex = THEME_ACCENTS[themeName];
  if (!accentHex) return;

  const chromeColor = nearestChromeGroupColor(accentHex);

  try {
    const groups = await chrome.tabGroups.query({});
    for (const group of groups) {
      if (group.color !== chromeColor) {
        chrome.tabGroups.update(group.id, { color: chromeColor }).catch(() => {});
      }
    }
  } catch (_e) {
    // No groups or API not available.
  }
}

// ---------------------------------------------------------------------------
// Side Panel Behavior
// ---------------------------------------------------------------------------

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ---------------------------------------------------------------------------
// Global Keyboard Shortcuts (chrome.commands)
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener((command) => {
  switch (command) {
    case 'focus-search':
      // Send message to side panel to focus search
      try {
        chrome.runtime.sendMessage({ type: MSG.FOCUS_SEARCH }).catch(() => {});
      } catch (_e) {}
      break;
    case 'close-current-tab':
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab) chrome.tabs.remove(tab.id);
      });
      break;
    case 'undo-close-tab':
      undoCloseTab();
      break;
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const initDone = init();

console.log('[LinkMap] Background service worker started');
