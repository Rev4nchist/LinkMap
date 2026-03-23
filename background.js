/**
 * LinkMap — Background Service Worker (Orchestrator)
 *
 * All chrome.*.addListener() registrations live here (MV3 requirement).
 * Domain logic is in background/*.js modules, wired together via
 * dependency injection (Context Object + Factory pattern).
 */

import { ShadowState } from './shared/shadow-state.js';
import { MSG, STORAGE_KEY, SETTINGS_KEY, WORKSPACES_KEY, TAB_NOTES_KEY } from './shared/constants.js';
import { createContext } from './background/context.js';
import { createAutoGrouper } from './background/auto-group.js';
import { createSessionManager } from './background/sessions.js';
import { createMoveHelpers } from './background/move-helpers.js';
import { createTabEventHandlers } from './background/tab-events.js';
import { createMessageHandler } from './background/message-handlers.js';
import { computeVisitFrequencies } from './background/visit-frequency.js';
import { saveTreeAsBookmarks, openBookmarkFolder } from './background/bookmarks.js';
import { normalizeUrl } from './background/duplicates.js';

// ---------------------------------------------------------------------------
// 1. Create shared context (state, persistence, broadcast)
// ---------------------------------------------------------------------------

const context = createContext();
const { ctx, saveState, commitState, broadcastState, suppressGroupTitleForBurst } = context;

// ---------------------------------------------------------------------------
// 2. Create domain modules (factory pattern — receive context via DI)
// ---------------------------------------------------------------------------

const autoGrouper = createAutoGrouper(ctx.DEBUG);

// State getter — ensures move helpers always see the current state (even after init replaces it)
const getState = () => context.state;

const moveHelpers = createMoveHelpers(getState, commitState);

const sessions = createSessionManager({
  getState,
  ctx,
  saveState,
  commitState,
  broadcastState,
  DEBUG: ctx.DEBUG,
});

const tabEvents = createTabEventHandlers({
  context,
  applyAutoGroupRules: autoGrouper.applyAutoGroupRules,
  repositionTabToGroup: moveHelpers.repositionTabToGroup,
  getPinnedBoundaryIndex: moveHelpers.getPinnedBoundaryIndex,
});

// ---------------------------------------------------------------------------
// 3. Initialization
// ---------------------------------------------------------------------------

async function init() {
  try {
    // 1. Load saved state
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const savedData = result[STORAGE_KEY];

    // 1b. Load settings
    const settingsResult = await chrome.storage.local.get(SETTINGS_KEY);
    if (settingsResult[SETTINGS_KEY]) {
      ctx.settings = { ...ctx.settings, ...settingsResult[SETTINGS_KEY] };
    }

    // 2. Reconstruct from storage
    const savedTabCount = savedData ? Object.keys(savedData.tabs || {}).length : 0;
    if (savedData) {
      context.state = ShadowState.fromStorage(savedData);
    }

    // 2b. Snapshot group membership counts BEFORE tab reconciliation
    const savedGroupTabCounts = new Map();
    for (const [, tab] of context.state.tabs) {
      const gid = tab.groupId;
      if (gid && gid !== -1) {
        savedGroupTabCounts.set(gid, (savedGroupTabCounts.get(gid) || 0) + 1);
      }
    }

    // 3. Query all live tabs and reconcile
    const liveTabs = await chrome.tabs.query({});
    const { windowIdMap, stats } = context.state.reconcileWithLiveTabs(liveTabs);

    // 3c. Check for crash recovery
    sessions.checkForCrashRecovery(savedTabCount, liveTabs.length);

    // 3d. Schedule deferred re-reconciliation if matching quality was poor
    if (savedData && stats && stats.savedRelationships > 0 && stats.survivingRelationships < stats.savedRelationships * 0.7) {
      console.log('[LinkMap] Poor reconciliation quality — scheduling retry in 2s');
      setTimeout(async () => {
        try {
          const retryLiveTabs = await chrome.tabs.query({});
          const retryState = ShadowState.fromStorage(savedData);
          const { stats: retryStats } = retryState.reconcileWithLiveTabs(retryLiveTabs);

          // Only swap if retry preserved MORE relationships
          if (retryStats.survivingRelationships > stats.survivingRelationships) {
            console.log('[LinkMap] Retry improved reconciliation:', JSON.stringify(retryStats));
            context.state = retryState;

            // Re-run group reconciliation
            const retryGroups = await chrome.tabGroups.query({});
            const retryGroupCounts = new Map();
            for (const [, tab] of retryState.tabs) {
              const gid = tab.groupId;
              if (gid && gid !== -1) retryGroupCounts.set(gid, (retryGroupCounts.get(gid) || 0) + 1);
            }
            context.state.reconcileWithLiveGroups(retryGroups, retryGroupCounts, retryStats.windowIdMap || new Map());

            saveState();
            broadcastState();
          } else {
            console.log('[LinkMap] Retry did not improve — keeping original');
          }
        } catch (err) {
          console.error('[LinkMap] Retry reconciliation failed:', err);
        }
      }, 2000);
    }

    // 3b. Query all live tab groups and reconcile
    const liveGroups = await chrome.tabGroups.query({});
    context.state.reconcileWithLiveGroups(liveGroups, savedGroupTabCounts, windowIdMap);

    // 3d. Push rescued titles back to Chrome
    for (const group of liveGroups) {
      const saved = context.state.groups.get(group.id);
      if (saved?.title && !group.title) {
        suppressGroupTitleForBurst();
        chrome.tabGroups.update(group.id, { title: saved.title }).catch(() => {});
      }
    }

    // 4. Identify the active tab and current window
    const currentWindow = await chrome.windows.getCurrent();
    ctx.currentWindowId = currentWindow.id;

    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTabs.length > 0) {
      ctx.activeTabId = activeTabs[0].id;
    }

    // 5. Save reconciled state
    saveState();

    // 6. Set up alarms
    sessions.setupAutoSaveAlarm();
    sessions.setupAutoArchiveAlarm();

    // 7. Load auto-group rules + workspaces + notes
    await autoGrouper.loadAutoGroupRules();
    const wsResult = await chrome.storage.local.get(WORKSPACES_KEY);
    if (wsResult[WORKSPACES_KEY]) {
      const wsData = wsResult[WORKSPACES_KEY];
      ctx.workspaces = wsData.workspaces || [];
      ctx.activeWorkspaceId = wsData.activeWorkspaceId || null;
    }
    const notesResult = await chrome.storage.local.get(TAB_NOTES_KEY);
    ctx.tabNotes = notesResult[TAB_NOTES_KEY] || {};

    // 8. Broadcast complete state
    broadcastState();

    ctx.initComplete = true;
    tabEvents.drainPendingEvents();
    context.retryMissingGroupTitles();
    console.log(`[LinkMap] Initialized with ${context.state.tabs.size} tabs, ${context.state.groups.size} groups`);
  } catch (err) {
    console.error('[LinkMap] Init error:', err);
  }
}

const initDone = init();

// ---------------------------------------------------------------------------
// 4. Create message handler (needs initDone promise)
// ---------------------------------------------------------------------------

const handleMessage = createMessageHandler({
  context,
  sessions,
  autoGrouper,
  moveHelpers,
  computeVisitFrequencies,
  saveTreeAsBookmarks,
  openBookmarkFolder,
  normalizeUrl,
  initDone,
});

// ---------------------------------------------------------------------------
// 5. Register ALL Chrome event listeners (MV3: must be synchronous at top level)
// ---------------------------------------------------------------------------

// Tab events
chrome.tabs.onCreated.addListener(tabEvents.onCreated);
chrome.tabs.onRemoved.addListener(tabEvents.onRemoved);
chrome.tabs.onUpdated.addListener(tabEvents.onUpdated);
chrome.tabs.onMoved.addListener(tabEvents.onMoved);
chrome.tabs.onActivated.addListener(tabEvents.onActivated);
chrome.tabs.onAttached.addListener(tabEvents.onAttached);
chrome.tabs.onDetached.addListener(tabEvents.onDetached);
chrome.tabs.onReplaced.addListener(tabEvents.onReplaced);

// Tab group events
chrome.tabGroups.onCreated.addListener(tabEvents.onGroupCreated);
chrome.tabGroups.onUpdated.addListener(tabEvents.onGroupUpdated);
chrome.tabGroups.onRemoved.addListener(tabEvents.onGroupRemoved);

// Window events
chrome.windows.onFocusChanged.addListener(tabEvents.onWindowFocusChanged);

// Alarms
chrome.alarms.onAlarm.addListener(sessions.onAlarm);

// Runtime
chrome.runtime.onMessage.addListener(handleMessage);
chrome.runtime.onSuspend.addListener(() => {
  sessions.onSuspend();
});

// Keyboard shortcuts
chrome.commands.onCommand.addListener((command) => {
  switch (command) {
    case 'focus-search':
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
      sessions.undoCloseTab();
      break;
  }
});

// Side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

console.log('[LinkMap] Background service worker started');
