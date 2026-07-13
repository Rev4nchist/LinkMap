/**
 * Tab Event Handler Callbacks
 *
 * Chrome tab, group, and window event handlers.
 * Returns handler objects that the orchestrator wires to chrome.*.addListener().
 */

import { MSG, UNGROUPED_GROUP_ID } from '../shared/constants.js';

/** @type {Set<string>} Fields in changeInfo that trigger an update. */
const RELEVANT_CHANGE_FIELDS = new Set([
  'title', 'url', 'favIconUrl', 'status', 'pinned', 'audible', 'mutedInfo', 'groupId',
]);

/**
 * Creates tab event handler callbacks.
 * @param {Object} params
 * @param {Object} params.context - context object from createContext()
 * @param {Function} params.applyAutoGroupRules - from auto-group module
 * @param {Function} params.repositionTabToGroup - from move-helpers
 * @param {Function} params.getPinnedBoundaryIndex - from move-helpers
 * @returns {Object} Event handler functions
 */
export function createTabEventHandlers({ context, applyAutoGroupRules, repositionTabToGroup, getPinnedBoundaryIndex }) {
  const { ctx, commitState, commitStateNow, broadcastState, invalidateDuplicateMap, suppressGroupCollapseForBurst, suppressGroupTitleForBurst } = context;

  /** @type {Array<{type: string, [key: string]: *}>} Events buffered before init completes. */
  const pendingEvents = [];

  function onCreated(tab) {
    if (!ctx.initComplete) {
      pendingEvents.push({ type: 'created', tab });
      return;
    }
    const state = context.state;
    const node = {
      tabId: tab.id,
      parentId: tab.openerTabId || null,
      title: tab.title || 'New Tab',
      url: tab.url || '',
      favIconUrl: tab.favIconUrl || '',
      pinned: tab.pinned ?? false,
      audible: false,
      status: tab.status || 'loading',
      groupId: tab.groupId ?? UNGROUPED_GROUP_ID,
      index: tab.index,
      windowId: tab.windowId,
    };

    state.addTab(tab.id, node);
    invalidateDuplicateMap();
    commitState();

    // Auto-group: check if new tab matches any domain rules
    if (tab.url) applyAutoGroupRules(tab);

    ctx.DEBUG && console.log(`[LinkMap] Tab created: ${tab.id} "${node.title}"`);
  }

  function onRemoved(tabId, _removeInfo) {
    if (!ctx.initComplete) {
      pendingEvents.push({ type: 'removed', tabId, removeInfo: _removeInfo });
      return;
    }
    const state = context.state;
    state.removeTab(tabId);
    invalidateDuplicateMap();

    if (ctx.activeTabId === tabId) {
      ctx.activeTabId = null;
    }

    // Clean up tab notes for closed tab
    delete ctx.tabNotes[tabId];

    // Prune closed tabId from all workspaces
    for (const ws of ctx.workspaces) {
      const idx = ws.tabIds.indexOf(tabId);
      if (idx !== -1) ws.tabIds.splice(idx, 1);
    }

    // Chrome fires spurious tabGroups.onUpdated(collapsed: true) after tab removal.
    suppressGroupCollapseForBurst();

    commitState();

    ctx.DEBUG && console.log(`[LinkMap] Tab removed: ${tabId}`);
  }

  function onUpdated(tabId, changeInfo, _tab) {
    if (!ctx.initComplete) {
      pendingEvents.push({ type: 'updated', tabId, changeInfo, tab: _tab });
      return;
    }
    const state = context.state;
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

    // Invalidate duplicate map on URL change
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

    // Pin transition handling
    if ('pinned' in changeInfo) {
      const node = state.tabs.get(tabId);
      if (node && changeInfo.pinned) {
        if (node.parentId != null) {
          state.moveTab(tabId, null, 0);
        }
        const boundary = getPinnedBoundaryIndex(tabId);
        state.moveTab(tabId, null, Math.max(0, boundary));
      } else if (node && !changeInfo.pinned) {
        const boundary = getPinnedBoundaryIndex(tabId);
        state.moveTab(tabId, null, boundary);
      }
    }

    commitState();
  }

  function onMoved(tabId, moveInfo) {
    if (!ctx.initComplete) {
      pendingEvents.push({ type: 'moved', tabId, moveInfo });
      return;
    }
    context.state.updateTab(tabId, { index: moveInfo.toIndex });
    commitState();

    ctx.DEBUG && console.log(`[LinkMap] Tab moved: ${tabId} to index ${moveInfo.toIndex}`);
  }

  function onActivated(activeInfo) {
    ctx.activeTabId = activeInfo.tabId;

    // SW-4: during init, record the active tab but skip the broadcast — the
    // panel isn't synced yet and init sets activeTabId at the end anyway.
    if (!ctx.initComplete) return;

    try {
      chrome.runtime.sendMessage({
        type: MSG.TAB_ACTIVATED,
        payload: { tabId: activeInfo.tabId },
      }).catch(() => {});
    } catch (_e) {
      // Side panel not open.
    }

    ctx.DEBUG && console.log(`[LinkMap] Tab activated: ${activeInfo.tabId}`);
  }

  function onAttached(tabId, attachInfo) {
    if (!ctx.initComplete) {
      pendingEvents.push({ type: 'attached', tabId, attachInfo });
      return;
    }
    context.state.updateTab(tabId, {
      windowId: attachInfo.newWindowId,
      index: attachInfo.newPosition,
    });
    commitState();

    ctx.DEBUG && console.log(`[LinkMap] Tab attached: ${tabId} to window ${attachInfo.newWindowId}`);
  }

  function onDetached(tabId, detachInfo) {
    if (!ctx.initComplete) {
      pendingEvents.push({ type: 'detached', tabId, detachInfo });
      return;
    }
    ctx.DEBUG && console.log(`[LinkMap] Tab detached: ${tabId} from window ${detachInfo.oldWindowId}`);
    commitState();
  }

  function onReplaced(addedTabId, removedTabId) {
    if (!ctx.initComplete) {
      // Buffer: a dropped replace would strand a dead tab id in Shadow State
      // with no recovery (SW-2).
      pendingEvents.push({ type: 'replaced', addedTabId, removedTabId });
      return;
    }
    context.state.replaceTabId(removedTabId, addedTabId);
    commitState();

    ctx.DEBUG && console.log(`[LinkMap] Tab replaced: ${removedTabId} -> ${addedTabId}`);
  }

  // -----------------------------------------------------------------------
  // Tab Group events
  // -----------------------------------------------------------------------

  function onGroupCreated(group) {
    if (!ctx.initComplete) {
      pendingEvents.push({ type: 'groupCreated', group });
      return;
    }
    context.state.addGroup(group);
    // Phase 5/R5: write-through — group creation is low-frequency and
    // losing it to a pre-debounce crash/quit is the reported bug class.
    commitStateNow();

    // 2e: a window restored from History minutes later (well past the 14s
    // sweep window) can create an untitled group that still has a quarantine
    // match — re-arm the sweep instead of waiting for the next SW start. The
    // single-flight guard (A5a) makes this safe to call unconditionally.
    if (!group.title && context.state.orphanedGroups.size > 0) {
      context.retryMissingGroupTitles();
    }

    ctx.DEBUG && console.log(`[LinkMap] Group created: ${group.id} "${group.title || 'untitled'}"`);
  }

  function onGroupUpdated(group) {
    if (!ctx.initComplete) {
      pendingEvents.push({ type: 'groupUpdated', group });
      return;
    }
    const state = context.state;
    const updates = {
      color: group.color,
      windowId: group.windowId,
    };
    if (ctx.suppressGroupTitleCount === 0) {
      const existing = state.groups.get(group.id);
      if (group.title || !existing?.title) {
        updates.title = group.title;
      }
    }
    if (!(ctx.suppressGroupCollapseCount > 0 && group.collapsed)) {
      updates.collapsed = group.collapsed;
    }
    state.updateGroup(group.id, updates);
    commitState();

    ctx.DEBUG && console.log(`[LinkMap] Group updated: ${group.id} "${group.title || 'untitled'}" collapsed=${group.collapsed}${ctx.suppressGroupCollapseCount > 0 ? ' (suppressed)' : ''}`);
  }

  function onGroupRemoved(group) {
    if (!ctx.initComplete) {
      // Buffer: a dropped removal leaves a phantom group with no recovery (SW-2).
      pendingEvents.push({ type: 'groupRemoved', group });
      return;
    }
    const state = context.state;
    // A10b: reset every tab that pointed at the removed group BEFORE the
    // immediate save — never serialize a tab referencing a dead group.
    for (const [tabId, tab] of state.tabs) {
      if (tab.groupId === group.id) {
        state.updateTab(tabId, { groupId: UNGROUPED_GROUP_ID });
      }
    }
    state.removeGroup(group.id);
    // Phase 5/R5: write-through — group removal is low-frequency and
    // structural; don't risk losing it to a pre-debounce crash/quit.
    commitStateNow();

    ctx.DEBUG && console.log(`[LinkMap] Group removed: ${group.id}`);
  }

  // -----------------------------------------------------------------------
  // Window events
  // -----------------------------------------------------------------------

  function onWindowFocusChanged(windowId) {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    ctx.currentWindowId = windowId;
    broadcastState();
  }

  /**
   * Replays events that were buffered while init was in progress.
   * Called once after reconciliation completes and ctx.initComplete = true.
   * Skips created/updated events for tabs already handled by reconciliation.
   */
  function drainPendingEvents() {
    while (pendingEvents.length > 0) {
      const evt = pendingEvents.shift();
      switch (evt.type) {
        case 'created':
          // Only process if not already captured by reconciliation
          if (!context.state.tabs.has(evt.tab.id)) {
            onCreated(evt.tab);
          }
          break;
        case 'removed':
          onRemoved(evt.tabId, evt.removeInfo);
          break;
        case 'updated':
          if (context.state.tabs.has(evt.tabId)) {
            onUpdated(evt.tabId, evt.changeInfo, evt.tab);
          }
          break;
        case 'moved':
          if (context.state.tabs.has(evt.tabId)) onMoved(evt.tabId, evt.moveInfo);
          break;
        case 'attached':
          if (context.state.tabs.has(evt.tabId)) onAttached(evt.tabId, evt.attachInfo);
          break;
        case 'detached':
          onDetached(evt.tabId, evt.detachInfo);
          break;
        case 'replaced':
          // No-op if the removed id was already reconciled away (guarded inside).
          onReplaced(evt.addedTabId, evt.removedTabId);
          break;
        case 'groupCreated':
          // Skip if reconciliation already created the group (mirrors 'created').
          if (!context.state.groups.has(evt.group.id)) onGroupCreated(evt.group);
          break;
        case 'groupUpdated':
          // Only update a group that still exists, to avoid upserting a phantom
          // (mirrors 'updated').
          if (context.state.groups.has(evt.group.id)) onGroupUpdated(evt.group);
          break;
        case 'groupRemoved':
          onGroupRemoved(evt.group);
          break;
      }
    }
  }

  return {
    onCreated,
    onRemoved,
    onUpdated,
    onMoved,
    onActivated,
    onAttached,
    onDetached,
    onReplaced,
    onGroupCreated,
    onGroupUpdated,
    onGroupRemoved,
    onWindowFocusChanged,
    drainPendingEvents,
  };
}
