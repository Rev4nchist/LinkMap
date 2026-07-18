/**
 * Shared Context — State, Persistence, Broadcasting
 *
 * Creates the shared context object that all domain modules receive.
 * Owns: ShadowState instance, mutable settings, persistence, broadcast.
 */

import { ShadowState } from '../shared/shadow-state.js';
import { debounce } from '../shared/utils.js';
import {
  MSG, STORAGE_KEY, SAVE_DEBOUNCE_MS, SETTINGS_KEY,
  WORKSPACES_KEY, TAB_NOTES_KEY, SUPPRESS_COLLAPSE_MS,
  SUPPRESS_TITLE_MS, RETRY_GROUP_TITLE_DELAYS,
} from '../shared/constants.js';
import { createDuplicateDetector } from './duplicates.js';

/**
 * Creates the shared context used by all background modules.
 * @returns {Object} Context and utility functions
 */
export function createContext() {
  /** @type {ShadowState} */
  let state = new ShadowState();

  const ctx = {
    initComplete: false,
    activeTabId: null,
    currentWindowId: null,
    suppressGroupCollapseCount: 0,
    suppressGroupTitleCount: 0,
    settings: {
      sleepOnCollapse: false,
      autoSaveEnabled: true,
      autoArchiveMinutes: 0,
    },
    workspaces: [],
    activeWorkspaceId: null,
    tabNotes: {},
    DEBUG: false,
  };

  // Duplicate detection bound to state getter (survives state replacement during init)
  const { invalidateDuplicateMap, findDuplicateTabIds, getDuplicateMap } =
    createDuplicateDetector(() => state);

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  const saveState = debounce(() => {
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: state.toSerializable() })
        .catch(err => console.error('[LinkMap] saveState failed:', err));
    } catch (err) {
      console.error('[LinkMap] saveState serialization failed:', err);
    }
    ctx.DEBUG && console.log('[LinkMap] State saved');
  }, SAVE_DEBOUNCE_MS);

  function saveStateImmediate() {
    // A6: cancel any pending debounced save first — single-writer discipline,
    // a stale trailing debounce must never clobber this newer write.
    saveState.cancel();
    try {
      // A10c: return the write promise so callers (e.g. sessions.js onSuspend)
      // can await settlement instead of logging success before it lands.
      return chrome.storage.local.set({ [STORAGE_KEY]: state.toSerializable() })
        .catch(err => console.error('[LinkMap] saveState failed:', err));
    } catch (err) {
      console.error('[LinkMap] saveState serialization failed:', err);
      return Promise.resolve();
    }
  }

  // -----------------------------------------------------------------------
  // Broadcasting
  // -----------------------------------------------------------------------

  function getStatePayload() {
    return {
      tabs: Object.fromEntries(state.tabs),
      rootIds: state.rootIds,
      collapsed: [...state.collapsed],
      groups: Object.fromEntries(state.groups),
      groupColors: state.groupColors,
      theme: state.theme,
      windowNames: Object.fromEntries(state.windowNames),
      activeTabId: ctx.activeTabId,
      currentWindowId: ctx.currentWindowId,
      duplicates: getDuplicateMap(),
      settings: ctx.settings,
      workspaces: ctx.workspaces,
      activeWorkspaceId: ctx.activeWorkspaceId,
      tabNotes: ctx.tabNotes,
    };
  }

  const broadcastState = debounce(() => {
    try {
      chrome.runtime.sendMessage({
        type: MSG.STATE_UPDATE,
        payload: getStatePayload(),
      }).catch(() => {});
    } catch (_e) {
      // Side panel not open.
    }
  }, 16);

  function commitState() { saveState(); broadcastState(); }

  // Phase 5/R5: write-through for group-structural mutations — these are
  // low-frequency and losing them to a crash/quit before the debounce fires
  // is exactly the "create group, rename, quit" bug class. High-frequency
  // paths (tab moves, etc.) keep the debounced commitState().
  function commitStateNow() { saveStateImmediate(); broadcastState(); }

  // -----------------------------------------------------------------------
  // Suppress helpers
  // -----------------------------------------------------------------------

  function suppressGroupCollapseForBurst() {
    ctx.suppressGroupCollapseCount++;
    setTimeout(() => { ctx.suppressGroupCollapseCount--; }, SUPPRESS_COLLAPSE_MS);
  }

  function suppressGroupTitleForBurst() {
    ctx.suppressGroupTitleCount++;
    setTimeout(() => { ctx.suppressGroupTitleCount--; }, SUPPRESS_TITLE_MS);
  }

  // -----------------------------------------------------------------------
  // Workspace persistence
  // -----------------------------------------------------------------------

  function saveWorkspaces() {
    chrome.storage.local.set({
      [WORKSPACES_KEY]: { workspaces: ctx.workspaces, activeWorkspaceId: ctx.activeWorkspaceId },
    }).catch(() => {});
  }

  // -----------------------------------------------------------------------
  // Initialization helpers
  // -----------------------------------------------------------------------

  // A5a: single-flight guard — a re-trigger while a sweep chain is already
  // running (e.g. from tab-events.js's 2e re-arm) is queued instead of
  // starting a second concurrent attempt() chain.
  let sweepInFlight = false;
  let sweepRerunRequested = false;

  function retryMissingGroupTitles() {
    if (sweepInFlight) {
      sweepRerunRequested = true;
      return;
    }
    sweepInFlight = true;

    let retryCount = 0;
    const retryDelays = RETRY_GROUP_TITLE_DELAYS;

    function finish() {
      sweepInFlight = false;
      if (sweepRerunRequested) {
        sweepRerunRequested = false;
        retryMissingGroupTitles();
      }
    }

    function attempt() {
      if (retryCount >= retryDelays.length) { finish(); return; }
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
                // 2d: membership has usually settled by sweep time, so try
                // the count/color/window quarantine match the initial
                // reconcile may have missed.
                const rescuedTitle = state.rescueUntitledLiveGroup(g);
                if (rescuedTitle) {
                  suppressGroupTitleForBurst();
                  chrome.tabGroups.update(g.id, { title: rescuedTitle }).catch(() => {});
                  updated = true;
                } else {
                  allHaveTitles = false;
                }
              }
            }
          }
          if (updated) {
            commitState();
            ctx.DEBUG && console.log(`[LinkMap] Recovered group titles on retry ${retryCount + 1}`);
          }
          retryCount++;
          if (!allHaveTitles && retryCount < retryDelays.length) {
            attempt();
          } else {
            finish();
          }
        } catch (e) {
          // Service worker may have been suspended
          ctx.DEBUG && console.warn('[LinkMap] retryMissingGroupTitles failed:', e);
          finish();
        }
      }, retryDelays[retryCount]);
    }
    attempt();
  }

  return {
    // State is exposed via getter so it can be replaced during init
    get state() { return state; },
    set state(s) { state = s; },
    ctx,
    saveState,
    saveStateImmediate,
    broadcastState,
    commitState,
    commitStateNow,
    getStatePayload,
    suppressGroupCollapseForBurst,
    suppressGroupTitleForBurst,
    saveWorkspaces,
    retryMissingGroupTitles,
    invalidateDuplicateMap,
    findDuplicateTabIds,
    getDuplicateMap,
  };
}

/**
 * Reconciles a freshly-rebuilt retry ShadowState's groups against live
 * Chrome groups, then merges in whatever group-level progress the live
 * state made during the 2s retry window (renames, recolors, quarantine/
 * rescue) so the eventual `context.state = retryState` swap never regresses
 * it (A4). Called by background.js's 2s retry BEFORE that swap.
 *
 * 2a: `savedGroupTabCounts` must be the pre-any-reconcile snapshot taken at
 * the top of init() — recomputing counts from `retryState.tabs` here would
 * count post-reconcile LIVE groupIds, not the saved ones the quarantine/
 * rescue tiers key off (see reconcileWithLiveGroups' own JSDoc contract).
 *
 * @param {import('../shared/shadow-state.js').ShadowState} retryState
 * @param {Object[]} retryGroups - chrome.tabGroups.query({}) result
 * @param {Map<number, number>} savedGroupTabCounts - pre-reconcile snapshot
 * @param {Map<number, number>} retryWindowIdMap
 * @param {import('../shared/shadow-state.js').ShadowState} liveState - context.state as it stood just before the swap
 */
export function reconcileRetryGroups(retryState, retryGroups, savedGroupTabCounts, retryWindowIdMap, liveState) {
  retryState.reconcileWithLiveGroups(retryGroups, savedGroupTabCounts, retryWindowIdMap);

  // A4: merge live-state group progress into retryState — for each live
  // group id retryState is still tracking, overlay title/color when the
  // retry copy is untitled/default; copy groupColors overrides for ids
  // retryState tracks; union orphanedGroups (live wins on collision, since
  // it reflects everything that happened during the window).
  for (const [id, liveGroup] of liveState.groups) {
    const retryGroup = retryState.groups.get(id);
    if (!retryGroup) continue;
    if (!retryGroup.title && liveGroup.title) retryGroup.title = liveGroup.title;
    // 'grey' is addGroup()'s own fallback default (shared/shadow-state.js) —
    // treat it as "no real color yet" the same way an empty title is treated.
    if ((!retryGroup.color || retryGroup.color === 'grey') && liveGroup.color) {
      retryGroup.color = liveGroup.color;
    }
    retryGroup.collapsed = liveGroup.collapsed ?? retryGroup.collapsed;
  }
  for (const [id, color] of Object.entries(liveState.groupColors)) {
    if (retryState.groups.has(Number(id))) {
      retryState.groupColors[id] = color;
    }
  }
  for (const [id, entry] of liveState.orphanedGroups) {
    retryState.orphanedGroups.set(id, entry); // live wins on collision
  }
  for (const [wid, name] of liveState.windowNames) {
    retryState.windowNames.set(wid, name);
  }
}
