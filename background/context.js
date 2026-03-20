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
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: state.toSerializable() })
        .catch(err => console.error('[LinkMap] saveState failed:', err));
    } catch (err) {
      console.error('[LinkMap] saveState serialization failed:', err);
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

  function retryMissingGroupTitles() {
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
            ctx.DEBUG && console.log(`[LinkMap] Recovered group titles on retry ${retryCount + 1}`);
          }
          retryCount++;
          if (!allHaveTitles && retryCount < retryDelays.length) attempt();
        } catch (e) {
          // Service worker may have been suspended
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
