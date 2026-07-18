/**
 * Session Management
 *
 * Save/restore/delete sessions, alarm-based auto-save,
 * undo-close, crash recovery, auto-archive, and cross-device access.
 */

import {
  MSG, SESSIONS_KEY, AUTO_SAVE_INTERVAL_MINUTES, AUTO_ARCHIVE_CHECK_INTERVAL_MINUTES, MAX_AUTO_SAVES,
} from '../shared/constants.js';

const AUTO_SAVE_ALARM = 'linkmap-auto-save';
const AUTO_ARCHIVE_ALARM = 'linkmap-auto-archive';

/**
 * Creates session management functions.
 * @param {Object} params
 * @param {Function} params.getState - getter returning current ShadowState instance
 * @param {Object} params.ctx - mutable context (settings, workspaces, etc.)
 * @param {Function} params.saveState - debounced save
 * @param {Function} params.commitState - save + broadcast
 * @param {Function} params.broadcastState - broadcast only
 * @param {Function} params.saveStateImmediate - immediate, debounce-cancelling save; returns a Promise
 * @param {boolean} params.DEBUG - verbose logging
 * @returns {Object} Session management API
 */
export function createSessionManager({ getState, ctx, saveState, commitState, broadcastState, saveStateImmediate, DEBUG }) {

  // -----------------------------------------------------------------------
  // Alarm setup
  // -----------------------------------------------------------------------

  function setupAutoSaveAlarm() {
    chrome.alarms.create(AUTO_SAVE_ALARM, {
      delayInMinutes: AUTO_SAVE_INTERVAL_MINUTES,
      periodInMinutes: AUTO_SAVE_INTERVAL_MINUTES,
    });
  }

  function setupAutoArchiveAlarm() {
    // Check every AUTO_ARCHIVE_CHECK_INTERVAL_MINUTES for stale tabs
    chrome.alarms.create(AUTO_ARCHIVE_ALARM, {
      delayInMinutes: AUTO_ARCHIVE_CHECK_INTERVAL_MINUTES,
      periodInMinutes: AUTO_ARCHIVE_CHECK_INTERVAL_MINUTES,
    });
  }

  /**
   * Alarm handler — dispatch to auto-save or auto-archive.
   * @param {Object} alarm
   */
  function onAlarm(alarm) {
    if (alarm.name === AUTO_SAVE_ALARM) {
      if (!ctx.settings.autoSaveEnabled) return;
      saveSession('Auto-Save', true);
    } else if (alarm.name === AUTO_ARCHIVE_ALARM) {
      archiveStaleTabs();
    }
  }

  // -----------------------------------------------------------------------
  // Session save/restore/delete
  // -----------------------------------------------------------------------

  /**
   * Serializes the current tree state into a session snapshot.
   * @param {string} name - session name
   * @param {boolean} isAutoSave - whether this is an auto-save
   */
  async function saveSession(name, isAutoSave = false) {
    const state = getState();
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
          const newWinTabs = await chrome.tabs.query({ windowId: newWin.id });
          if (newWinTabs.length > 0) {
            defaultTabsToClose.push(newWinTabs[0].id);
          }
        } catch (err) {
          console.error('[LinkMap] Failed to create window for restore:', err);
          windowMap.set(savedWindowIds[i], currentWindow.id);
        }
      }
    }

    return { windowMap, defaultTabsToClose };
  }

  /**
   * Batch-creates tabs in correct windows, returning ID mappings.
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
   */
  async function rebuildGroupsForRestore(groupEntries, savedTabs, oldToNewId, newTabWindowId, currentWindow, windowIdFilter) {
    for (const [oldGroupIdStr, groupData] of groupEntries) {
      const oldGroupId = Number(oldGroupIdStr);
      if (windowIdFilter != null && groupData.windowId !== windowIdFilter) continue;

      const groupTabIds = savedTabs
        .filter(t => t.groupId === oldGroupId)
        .map(t => oldToNewId.get(t.tabId))
        .filter(Boolean);

      if (groupTabIds.length > 0) {
        try {
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
   * Restores a saved session.
   * @param {string} sessionId
   * @param {number|null} [windowIdFilter=null]
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

      // 3. Rebuild tree structure.
      //
      // FM-1: seed every restored tab into Shadow State authoritatively, rather
      // than depending on the async onCreated listener to have added them first.
      // addTab is idempotent (its duplicate guard makes a later onCreated a
      // no-op), so the reparent loop below always runs against nodes that exist
      // — no race, no silent flatten.
      for (const savedTab of savedTabs) {
        const newId = oldToNewId.get(savedTab.tabId);
        if (!newId) continue;
        getState().addTab(newId, {
          parentId: null,
          title: savedTab.title,
          url: savedTab.url,
          favIconUrl: savedTab.favIconUrl,
          pinned: savedTab.pinned,
          index: savedTab.index,
          windowId: newTabWindowId.get(newId) ?? savedTab.windowId,
        });
      }

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
          getState().moveTab(child.newId, parentId, Infinity);
        }
      }

      // FM-2: re-apply the saved collapsed state, remapped to the new tab IDs.
      for (const oldId of session.data.collapsed || []) {
        const newId = oldToNewId.get(oldId);
        if (newId != null) getState().collapsed.add(newId);
      }

      // 4. Recreate Chrome tab groups
      if (session.data.groups) {
        const groupEntries = Object.entries(session.data.groups);
        await rebuildGroupsForRestore(groupEntries, savedTabs, oldToNewId, newTabWindowId, currentWindow, windowIdFilter);
      }

      // 5. Apply saved window names
      if (session.data.windowNames) {
        for (const [savedWidStr, name] of Object.entries(session.data.windowNames)) {
          const newWid = windowMap.get(Number(savedWidStr));
          if (newWid) getState().setWindowName(newWid, name);
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

  // -----------------------------------------------------------------------
  // Undo Close / Recently Closed
  // -----------------------------------------------------------------------

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

  async function getRecentlyClosed() {
    try {
      const entries = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
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

  // -----------------------------------------------------------------------
  // Crash Detection
  // -----------------------------------------------------------------------

  function checkForCrashRecovery(savedTabCount, liveTabCount) {
    if (savedTabCount > 5 && liveTabCount < savedTabCount * 0.5) {
      try {
        chrome.runtime.sendMessage({
          type: MSG.CRASH_RECOVERY,
          payload: { savedTabCount, liveTabCount },
        }).catch(() => {});
      } catch (_e) {}

      console.log(`[LinkMap] Possible crash detected: had ${savedTabCount} tabs, now ${liveTabCount}`);
    }
  }

  // -----------------------------------------------------------------------
  // Auto-Archive Stale Tabs
  // -----------------------------------------------------------------------

  async function archiveStaleTabs() {
    if (!ctx.settings.autoArchiveMinutes || ctx.settings.autoArchiveMinutes <= 0) return;

    const thresholdMs = ctx.settings.autoArchiveMinutes * 60 * 1000;
    const now = Date.now();

    try {
      const allTabs = await chrome.tabs.query({});
      for (const tab of allTabs) {
        if (tab.active || tab.pinned || tab.discarded) continue;

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

  // -----------------------------------------------------------------------
  // Cross-Device
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Suspend handler
  // -----------------------------------------------------------------------

  function onSuspend() {
    // A10c: route the write through the same immediate serializer (cancels
    // any pending debounce — single-writer discipline) and don't log success
    // before the write promise actually settles.
    Promise.resolve(saveStateImmediate())
      .then(() => {
        console.log('[LinkMap] State flushed on suspend');
      })
      .catch((err) => {
        console.error('[LinkMap] State flush on suspend failed:', err);
      });
    // Best-effort — async save may not complete before MV3 worker terminates
    saveSession('Auto-Save (Suspend)', true).catch(() => {});
  }

  return {
    setupAutoSaveAlarm,
    setupAutoArchiveAlarm,
    onAlarm,
    saveSession,
    restoreSession,
    deleteSession,
    getSessions,
    undoCloseTab,
    getRecentlyClosed,
    checkForCrashRecovery,
    archiveStaleTabs,
    getOtherDevices,
    onSuspend,
  };
}
