/**
 * LinkMap — Background Service Worker (Orchestrator)
 *
 * All chrome.*.addListener() registrations live here (MV3 requirement).
 * Domain logic is in background/*.js modules, wired together via
 * dependency injection (Context Object + Factory pattern).
 */

import { ShadowState } from './shared/shadow-state.js';
import { MSG, STORAGE_KEY, SETTINGS_KEY, WORKSPACES_KEY, TAB_NOTES_KEY, SW_SESSION_KEY } from './shared/constants.js';
import { createContext, reconcileRetryGroups } from './background/context.js';
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
const { ctx, saveState, saveStateImmediate, commitState, commitStateNow, broadcastState, suppressGroupTitleForBurst } = context;

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
  saveStateImmediate,
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
  // 2c/A7: hoisted so the outer catch can always restore the last-known-good
  // saved snapshot, regardless of how far the try block got before failing.
  let savedData;
  try {
    // 0. Restart-detection: chrome.storage.session is in-memory and is
    // CLEARED on a full browser restart (and on extension reload/update),
    // but SURVIVES service-worker suspend/wake — exactly the boundary where
    // Chrome reassigns tab ids. Read it before any other await so no
    // buffered tab event can race the check (MV3 guarantees a single SW).
    const sessResult = await chrome.storage.session.get(SW_SESSION_KEY);
    const coldRestart = !sessResult[SW_SESSION_KEY];
    await chrome.storage.session.set({ [SW_SESSION_KEY]: { bootTs: Date.now() } });

    // 1. Load saved state
    const result = await chrome.storage.local.get(STORAGE_KEY);
    savedData = result[STORAGE_KEY];

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
    const { windowIdMap, tabIdMap, sameIdMatched, stats } = context.state.reconcileWithLiveTabs(liveTabs, { coldRestart });

    // 3c. Check for crash recovery
    sessions.checkForCrashRecovery(savedTabCount, liveTabs.length);

    // 3d. Schedule deferred re-reconciliation if matching quality was poor
    if (savedData && stats && stats.savedRelationships > 0 && stats.survivingRelationships < stats.savedRelationships * 0.7) {
      console.log('[LinkMap] Poor reconciliation quality — scheduling retry in 2s');
      setTimeout(async () => {
        try {
          const retryLiveTabs = await chrome.tabs.query({});
          const retryState = ShadowState.fromStorage(savedData);
          const { windowIdMap: retryWindowIdMap, stats: retryStats } = retryState.reconcileWithLiveTabs(retryLiveTabs, { coldRestart });

          // Only swap if retry preserved MORE relationships
          if (retryStats.survivingRelationships > stats.survivingRelationships) {
            console.log('[LinkMap] Retry improved reconciliation:', JSON.stringify(retryStats));

            // SW-3/RR-7: once initComplete is true, buffering is off and live tab
            // events mutate context.state directly during this 2s window. retryState
            // is rebuilt from the original snapshot, so a wholesale swap would drop
            // those interim edits. Carry over the lineage and collapsed state the
            // live state established (re-parents from openerTabId, panel collapses)
            // before swapping. A4: the swap must also never regress first-pass
            // group-level quarantine/rescue/color-override progress the live state
            // made during this window — reconcileRetryGroups() runs retryState's own
            // group reconcile (2a: using the pre-reconcile savedGroupTabCounts
            // snapshot, not a post-reconcile live-groupId recompute) and merges that
            // live progress in, all before the swap below.
            const liveState = context.state;
            for (const [id, liveNode] of liveState.tabs) {
              const retryNode = retryState.tabs.get(id);
              if (!retryNode) continue;
              if (liveNode.parentId != null && retryNode.parentId == null
                  && retryState.tabs.has(liveNode.parentId)) {
                retryState.moveTab(id, liveNode.parentId, Infinity);
              }
            }
            for (const cid of liveState.collapsed) {
              if (retryState.tabs.has(cid)) retryState.collapsed.add(cid);
            }

            // Re-run group reconciliation on retryState BEFORE the swap.
            const retryGroups = await chrome.tabGroups.query({});
            reconcileRetryGroups(retryState, retryGroups, savedGroupTabCounts, retryWindowIdMap, liveState);

            context.state = retryState;

            // CR-recovery-save: write-through immediately — the debounced
            // saveState() left a window where an SW suspend right after this
            // swap would lose the improved retry reconciliation entirely.
            commitStateNow();
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

    // 4. Identify the active tab and current window — best-effort only. A
    // failure here (e.g. "no current window" during a cold Chrome startup)
    // is benign, leaves ctx.currentWindowId/activeTabId null, and must not
    // abort the rest of init (2c/R6).
    try {
      const currentWindow = await chrome.windows.getCurrent();
      ctx.currentWindowId = currentWindow.id;

      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTabs.length > 0) {
        ctx.activeTabId = activeTabs[0].id;
      }
    } catch (innerErr) {
      console.warn('[LinkMap] Active window/tab lookup failed (non-fatal):', innerErr);
    }

    // 5. Save reconciled state immediately (A6) — the trailing 500ms
    // debounce must never be the only write between a fresh reconcile and a
    // possible SW suspend/crash. CR-context-persist: await it and observe
    // failure — saveStateImmediate() never rejects, so this is safe inside
    // the awaited init() and won't silently swallow a write failure.
    const initSaveResult = await saveStateImmediate();
    if (!initSaveResult?.success) {
      console.error('[LinkMap] Initial state save after reconciliation failed:', initSaveResult?.error);
    }

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

      // F8: workspace tabIds are saved membership lists outside the tree —
      // reconcileWithLiveTabs() never touched them. Remap through tabIdMap
      // (tabs that moved to a new id), keep ids in sameIdMatched (still the same
      // tab at their original id), and drop everything else — a tab that never
      // came back, OR (#9) an id recycled by a DIFFERENT tab on cold restart.
      // `context.state.tabs.has(id)` must NOT be used here: after a same-id
      // collision is swept, an unrelated new tab can occupy the old id, so
      // has(id) would alias the workspace to the wrong tab.
      let workspacesChanged = false;
      for (const ws of ctx.workspaces) {
        if (!Array.isArray(ws.tabIds) || ws.tabIds.length === 0) continue;
        const remapped = [];
        for (const id of ws.tabIds) {
          if (tabIdMap.has(id)) {
            remapped.push(tabIdMap.get(id));
          } else if (sameIdMatched.has(id)) {
            remapped.push(id);
          }
          // else: tab closed, or its id was recycled by a different tab — drop
        }
        if (remapped.length !== ws.tabIds.length || remapped.some((id, i) => id !== ws.tabIds[i])) {
          workspacesChanged = true;
        }
        ws.tabIds = remapped;
      }
      if (workspacesChanged) context.saveWorkspaces();
    }
    const notesResult = await chrome.storage.local.get(TAB_NOTES_KEY);
    ctx.tabNotes = notesResult[TAB_NOTES_KEY] || {};

    console.log(`[LinkMap] Initialized with ${context.state.tabs.size} tabs, ${context.state.groups.size} groups`);
  } catch (err) {
    console.error('[LinkMap] Init error:', err);
    // A7: a failure after a partial reconcile can leave context.state
    // corrupted (half-applied tab/group reconcile). Always restore the
    // last-known-good saved snapshot when we have one — never save from the
    // failure path.
    if (savedData) {
      context.state = ShadowState.fromStorage(savedData);
    }
  } finally {
    // R6: always flip initComplete and drain/sweep/broadcast, even after an
    // init error — otherwise gated messages re-dispatch against a
    // permanently-unresolved initDone and events buffer forever.
    ctx.initComplete = true;
    tabEvents.drainPendingEvents();
    context.retryMissingGroupTitles();
    broadcastState();
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
        if (tab) return chrome.tabs.remove(tab.id);
      }).catch(() => {}); // tab may be gone / no focused window (CAE-1)
      break;
    case 'undo-close-tab':
      sessions.undoCloseTab();
      break;
  }
});

// Side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

console.log('[LinkMap] Background service worker started');
