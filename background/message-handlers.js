/**
 * Message Handlers — MSG switch dispatcher
 *
 * Handles all chrome.runtime.onMessage messages from the side panel.
 * Returns `true` for async sendResponse cases, `undefined` for sync cases.
 */

import { MSG, SAVED_GROUPS_KEY, SETTINGS_KEY, TAB_NOTES_KEY, UNGROUPED_GROUP_ID } from '../shared/constants.js';
import { nearestChromeGroupColor } from '../shared/color-distance.js';
import { syncGroupColorsToTheme } from './smart-mapper.js';
import { collectGroupableTabIds } from './move-helpers.js';

/**
 * Creates the message handler function.
 * @param {Object} params
 * @param {Object} params.context - shared context from createContext()
 * @param {Object} params.sessions - session manager from createSessionManager()
 * @param {Object} params.autoGrouper - auto-grouper from createAutoGrouper()
 * @param {Object} params.moveHelpers - move helpers from createMoveHelpers()
 * @param {Function} params.computeVisitFrequencies - from visit-frequency module
 * @param {Function} params.saveTreeAsBookmarks - from bookmarks module
 * @param {Function} params.openBookmarkFolder - from bookmarks module
 * @param {Function} params.normalizeUrl - from duplicates module
 * @param {Promise} params.initDone - resolves when init() completes
 * @returns {Function} Message listener function for chrome.runtime.onMessage.addListener
 */
export function createMessageHandler({
  context,
  sessions,
  autoGrouper,
  moveHelpers,
  computeVisitFrequencies,
  saveTreeAsBookmarks,
  openBookmarkFolder,
  normalizeUrl,
  initDone,
}) {
  const {
    ctx, commitState, commitStateNow, broadcastState, getStatePayload,
    suppressGroupCollapseForBurst, suppressGroupTitleForBurst,
    saveWorkspaces, invalidateDuplicateMap,
  } = context;

  const {
    repositionTabToGroup, moveTabToGroup, moveTabToWindow,
    moveTabAsChild, moveTabBeforeAfter,
  } = moveHelpers;

  // SW-1: message types that synchronously read/mutate context.state or a
  // persisted ctx.* collection. If one runs during the init() window (MV3 SW
  // restarted, side panel still open and unaware), it would operate on the
  // throwaway pre-init state that init() replaces — the mutation is silently
  // lost, or corrupts the about-to-be-reconciled tree. These are deferred until
  // init completes and then replayed. Pure chrome.* passthroughs (activate /
  // close / pin / mute / reload / etc.) are intentionally NOT gated — they
  // don't touch pre-init state. Some gated types DO use sendResponse (A8) —
  // see INIT_GATED_ASYNC below for which ones need the channel kept open.
  const INIT_GATED_TYPES = new Set([
    MSG.MOVE_TAB, MSG.TOGGLE_COLLAPSE, MSG.COLLAPSE_ALL, MSG.EXPAND_ALL,
    MSG.FOCUS_MODE, MSG.SET_THEME, MSG.SET_GROUP_COLOR, MSG.DUPLICATE_TAB,
    MSG.NEW_TAB_BELOW, MSG.NEW_TAB_IN_GROUP, MSG.TOGGLE_GROUP_COLLAPSE,
    MSG.RENAME_GROUP, MSG.MOVE_GROUP, MSG.RENAME_WINDOW, MSG.REORDER_PINNED,
    MSG.SAVE_GROUP, MSG.CLOSE_DUPLICATES, MSG.UPDATE_SETTINGS,
    MSG.SET_AUTO_GROUP_RULES, MSG.CREATE_WORKSPACE, MSG.SWITCH_WORKSPACE,
    MSG.DELETE_WORKSPACE, MSG.RENAME_WORKSPACE, MSG.UPDATE_WORKSPACE,
    MSG.MOVE_TO_WORKSPACE, MSG.SET_TAB_NOTE, MSG.SAVE_SESSION,
    MSG.RESTORE_SESSION, MSG.RESTORE_SESSION_WINDOW, MSG.SAVE_TREE_AS_BOOKMARKS,
    // A8: MOVE_TO_GROUP is the exact "New Group" message; UNGROUP_TAB and
    // MULTI_GROUP synchronously read context.state via moveHelpers/tabIds;
    // GET_SETTINGS/GET_WORKSPACES/GET_AUTO_GROUP_RULES currently answer with
    // pre-init defaults that a panel could persist back if run too early.
    MSG.MOVE_TO_GROUP, MSG.UNGROUP_TAB, MSG.MULTI_GROUP,
    MSG.GET_SETTINGS, MSG.GET_WORKSPACES, MSG.GET_AUTO_GROUP_RULES,
  ]);

  // A8: of the gated types above, only these call sendResponse (sync or via
  // an async IIFE) — they need the deferred replay's channel kept open.
  // Fire-and-forget gated types (UNGROUP_TAB, MULTI_GROUP, etc.) never use
  // sendResponse and must not keep the channel open.
  const INIT_GATED_ASYNC = new Set([
    MSG.MOVE_TO_GROUP, MSG.GET_SETTINGS, MSG.GET_WORKSPACES, MSG.GET_AUTO_GROUP_RULES,
  ]);

  return function handleMessage(message, _sender, sendResponse) {
    if (!message || typeof message !== 'object') return;
    const { type, payload } = message;

    // SW-1: defer state-mutating commands received before init completes, then
    // replay them once context.state is the real, reconciled instance.
    if (!ctx.initComplete && INIT_GATED_TYPES.has(type)) {
      initDone.then(() => handleMessage(message, _sender, sendResponse));
      // A8: keep the channel open for the subset that actually responds —
      // everything else is fire-and-forget, matching prior behavior.
      return INIT_GATED_ASYNC.has(type);
    }

    switch (type) {
      case MSG.GET_STATE:
        initDone.then(async () => {
          const statePayload = getStatePayload();
          try {
            statePayload.visitFrequency = await computeVisitFrequencies(context.state);
          } catch (err) {
            ctx.DEBUG && console.warn('[LinkMap] Visit frequency error:', err);
            statePayload.visitFrequency = {};
          }
          sendResponse(statePayload);
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
        const state = context.state;
        const { tabId, newParentId, targetTabId, position, targetWindowId, targetGroupId } = payload;
        const sourceTab = state.getTab(tabId);
        const needsWindowMove = targetWindowId && sourceTab && sourceTab.windowId !== targetWindowId;
        let mode;

        if (position === 'group') {
          mode = moveTabToGroup(tabId, targetGroupId);
        } else if (position === 'window') {
          mode = needsWindowMove ? moveTabToWindow(tabId, targetWindowId) : 'async';
        } else if (position === 'child') {
          mode = moveTabAsChild(tabId, newParentId, needsWindowMove, targetWindowId, targetGroupId);
        } else if (position === 'before' || position === 'after') {
          mode = moveTabBeforeAfter(tabId, newParentId, targetTabId, position, needsWindowMove, targetWindowId, targetGroupId);
        } else {
          // Legacy format: { tabId, newParentId, index }
          state.moveTab(tabId, newParentId, payload.index ?? 0);
          mode = 'sync';
        }

        if (mode === 'sync') {
          if (targetGroupId !== undefined) {
            // CAE-4/A9: normalize both sides so a drag-out (targetGroupId ===
            // UNGROUPED_GROUP_ID) is detected the same way as a drag-in —
            // Chrome, not the payload, stays source of truth for membership.
            const currentGroupId = sourceTab?.groupId ?? UNGROUPED_GROUP_ID;
            if (targetGroupId !== currentGroupId) {
              const ids = collectGroupableTabIds(state, tabId);
              const syncOp = targetGroupId === UNGROUPED_GROUP_ID
                ? chrome.tabs.ungroup(ids)
                : chrome.tabs.group({ tabIds: ids, groupId: targetGroupId });
              syncOp.catch(async (err) => {
                console.error('[LinkMap] Group sync failed:', err);
                // A9: repair shadow state from the live tab rather than
                // leaving it silently diverged from Chrome.
                try {
                  const fresh = await chrome.tabs.get(tabId);
                  state.updateTab(tabId, { groupId: fresh.groupId });
                  commitState();
                } catch (getErr) {
                  console.error('[LinkMap] Group sync repair failed:', getErr);
                }
              });
            }
          }
          commitState();
        }
        break;
      }

      case MSG.TOGGLE_COLLAPSE: {
        const state = context.state;
        const wasCollapsed = state.isCollapsed(payload.tabId);
        state.toggleCollapse(payload.tabId);

        if (!wasCollapsed && ctx.settings.sleepOnCollapse) {
          const descendants = state.getDescendants(payload.tabId);
          for (const desc of descendants) {
            if (desc.tabId !== ctx.activeTabId && desc.status !== 'unloaded') {
              chrome.tabs.discard(desc.tabId).catch(() => {});
            }
          }
        }

        commitState();
        break;
      }

      case MSG.COLLAPSE_ALL:
        context.state.collapseAll();
        commitState();
        break;

      case MSG.EXPAND_ALL:
        context.state.expandAll();
        commitState();
        break;

      case MSG.FOCUS_MODE:
        context.state.focusOnBranch(payload.tabId);
        commitState();
        break;

      case MSG.SET_THEME:
        context.state.setTheme(payload.theme);
        commitState();
        try {
          chrome.runtime.sendMessage({
            type: MSG.THEME_CHANGED,
            payload: { theme: payload.theme },
          }).catch(() => {});
        } catch (_e) {}
        syncGroupColorsToTheme(payload.theme);
        break;

      case MSG.SET_GROUP_COLOR: {
        context.state.setGroupColor(payload.groupId, payload.color);
        // Phase 5/R5: write-through — group-structural, low-frequency.
        commitStateNow();
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
            const state = context.state;
            const newTab = await chrome.tabs.duplicate(payload.tabId);
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
        const state = context.state;
        const refTab = state.getTab(payload.tabId);
        if (refTab) {
          (async () => {
            try {
              const newTab = await chrome.tabs.create({
                windowId: refTab.windowId,
                index: refTab.index + 1,
                openerTabId: payload.tabId,
              });
              if (newTab?.id) {
                if (refTab.pinned) {
                  // Pinned tab: place new tab at the top of the sidebar
                  state.moveTab(newTab.id, null, 0);
                } else {
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
                commitState();
              }
            } catch (err) {
              console.error('[LinkMap] NEW_TAB_BELOW failed:', err);
            }
          })();
        }
        break;
      }

      case MSG.NEW_TAB_IN_GROUP: {
        const state = context.state;
        const { groupId: newTabGid } = payload;
        (async () => {
          try {
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
        const state = context.state;
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
        context.state.updateGroup(renameGid, { title: newTitle });
        suppressGroupTitleForBurst();
        chrome.tabGroups.update(renameGid, { title: newTitle }).catch((err) => {
          console.error('[LinkMap] Group rename failed:', err);
        });
        // Phase 5/R5: write-through — group-structural, low-frequency.
        commitStateNow();
        break;
      }

      case MSG.MOVE_GROUP: {
        const state = context.state;
        const { groupId, anchorTabId, anchorGroupId, position } = payload;

        let resolvedAnchorTabId = anchorTabId;

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

        const anchorTab = state.getTab(resolvedAnchorTabId);
        if (anchorTab) {
          const targetIndex = position === 'before' ? anchorTab.index : anchorTab.index + 1;
          suppressGroupCollapseForBurst();
          chrome.tabGroups.move(groupId, { index: targetIndex }).catch((err) => {
            // CAE-3: state was already committed; surface the drift instead of
            // swallowing it (these silent failures made restart bugs hard to find).
            console.warn('[LinkMap] MOVE_GROUP move failed:', err);
          });
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
              // CR-move2group-unpin: write the unpin into shadow state
              // synchronously — otherwise, if the pinned->false onUpdated
              // event hasn't been processed yet, collectGroupableTabIds
              // below still sees the stale pinned:true and drops
              // payload.tabId itself out of the group.
              context.state.updateTab(payload.tabId, { pinned: false });
            }
            // 4b/A9: group the tab AND any non-pinned descendants together —
            // otherwise "New Group" on a parent leaves its children behind.
            const ids = collectGroupableTabIds(context.state, payload.tabId);
            const resultGroupId = payload.groupId != null
              ? await chrome.tabs.group({ tabIds: ids, groupId: payload.groupId })
              : await chrome.tabs.group({ tabIds: ids });

            // A10a: set groupId on every moved id synchronously — don't wait
            // for tabs.onUpdated to eventually catch up.
            for (const id of ids) {
              context.state.updateTab(id, { groupId: resultGroupId });
            }
            repositionTabToGroup(payload.tabId, resultGroupId);
            // Phase 5/R5: write-through — group creation is low-frequency
            // and structural; don't risk losing it to a pre-debounce quit.
            commitStateNow();

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
        context.state.setWindowName(windowId, name);
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
          const state = context.state;
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
          ctx.DEBUG && console.log(`[LinkMap] Group saved: "${saved.title}" (${groupTabs.length} tabs)`);
        })();
        break;
      }

      case MSG.CLOSE_DUPLICATES: {
        const state = context.state;
        const tabUrl = payload.url;
        const norm = normalizeUrl(tabUrl);
        if (!norm) break;
        const dupes = [];
        for (const [tabId, node] of state.tabs) {
          if (normalizeUrl(node.url) === norm) dupes.push(tabId);
        }
        if (dupes.length > 1) {
          dupes.sort((a, b) => a - b);
          chrome.tabs.remove(dupes.slice(1)).catch(() => {});
        }
        break;
      }

      // -----------------------------------------------------------------
      // Session Management
      // -----------------------------------------------------------------

      case MSG.SAVE_SESSION: {
        const { name, isAutoSave } = payload;
        sessions.saveSession(name || 'Untitled', isAutoSave || false);
        break;
      }

      case MSG.RESTORE_SESSION: {
        sessions.restoreSession(payload.sessionId);
        break;
      }

      case MSG.RESTORE_SESSION_WINDOW: {
        const { sessionId, windowId } = payload;
        sessions.restoreSession(sessionId, windowId);
        break;
      }

      case MSG.DELETE_SESSION: {
        sessions.deleteSession(payload.sessionId);
        break;
      }

      case MSG.GET_SESSIONS: {
        sessions.getSessions().then(sessionList => {
          sendResponse({ sessions: sessionList });
        });
        return true; // keep channel open for async response
      }

      case MSG.UNDO_CLOSE: {
        sessions.undoCloseTab(payload?.sessionId);
        break;
      }

      case MSG.GET_RECENTLY_CLOSED: {
        sessions.getRecentlyClosed().then(entries => {
          sendResponse({ entries });
        });
        return true; // keep channel open for async response
      }

      case MSG.GET_SETTINGS: {
        sendResponse({ settings: ctx.settings });
        break;
      }

      case MSG.UPDATE_SETTINGS: {
        const ALLOWED_SETTINGS = ['sleepOnCollapse', 'autoSaveEnabled', 'autoArchiveMinutes'];
        const filtered = {};
        for (const key of ALLOWED_SETTINGS) {
          if (key in payload) filtered[key] = payload[key];
        }
        ctx.settings = { ...ctx.settings, ...filtered };
        chrome.storage.local.set({ [SETTINGS_KEY]: ctx.settings });
        broadcastState();
        break;
      }

      case MSG.GET_AUTO_GROUP_RULES: {
        sendResponse({ rules: autoGrouper.getRules() });
        break;
      }

      case MSG.SET_AUTO_GROUP_RULES: {
        const rules = Array.isArray(payload.rules) ? payload.rules : [];
        autoGrouper.setRules(rules);
        break;
      }

      case MSG.GET_OTHER_DEVICES: {
        sessions.getOtherDevices().then(devices => {
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
        ctx.workspaces.push(ws);
        saveWorkspaces();
        broadcastState();
        break;
      }

      case MSG.SWITCH_WORKSPACE: {
        ctx.activeWorkspaceId = payload.workspaceId;
        saveWorkspaces();
        broadcastState();
        break;
      }

      case MSG.DELETE_WORKSPACE: {
        ctx.workspaces = ctx.workspaces.filter(ws => ws.id !== payload.workspaceId);
        if (ctx.activeWorkspaceId === payload.workspaceId) {
          ctx.activeWorkspaceId = ctx.workspaces.length > 0 ? ctx.workspaces[0].id : null;
        }
        saveWorkspaces();
        broadcastState();
        break;
      }

      case MSG.RENAME_WORKSPACE: {
        const ws = ctx.workspaces.find(w => w.id === payload.workspaceId);
        if (ws) {
          ws.name = payload.name || ws.name;
          if (payload.color) ws.color = payload.color;
          saveWorkspaces();
          broadcastState();
        }
        break;
      }

      case MSG.UPDATE_WORKSPACE: {
        const wsToUpdate = ctx.workspaces.find(w => w.id === payload.workspaceId);
        if (wsToUpdate) {
          if (payload.name) wsToUpdate.name = payload.name;
          if (payload.color) wsToUpdate.color = payload.color;
          saveWorkspaces();
          broadcastState();
        }
        break;
      }

      case MSG.GET_WORKSPACES: {
        sendResponse({ workspaces: ctx.workspaces, activeWorkspaceId: ctx.activeWorkspaceId });
        break;
      }

      case MSG.MOVE_TO_WORKSPACE: {
        const targetWs = ctx.workspaces.find(w => w.id === payload.workspaceId);
        if (targetWs) {
          const tabIds = payload.tabIds || [payload.tabId];
          for (const id of tabIds) {
            for (const ws of ctx.workspaces) {
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
          ctx.tabNotes[noteTabId] = note.trim();
        } else {
          delete ctx.tabNotes[noteTabId];
        }
        chrome.storage.local.set({ [TAB_NOTES_KEY]: ctx.tabNotes });
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
          // B-3: expand each selected tab to its groupable subtree so nested
          // children are grouped too (parity with every other group call site);
          // otherwise the panel and Chrome strip diverge and children are
          // ejected on restart. collectGroupableTabIds also drops pinned ids —
          // Chrome rejects grouping a pinned tab (A9).
          const state = context.state;
          const groupableIds = [...new Set(
            payload.tabIds.flatMap((id) => collectGroupableTabIds(state, id)),
          )];
          if (!groupableIds.length) return;
          try {
            const groupId = payload.groupId != null
              ? await chrome.tabs.group({ tabIds: groupableIds, groupId: payload.groupId })
              : await chrome.tabs.group({ tabIds: groupableIds });
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
            if (id !== ctx.activeTabId) {
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
        saveTreeAsBookmarks(context.state);
        break;
      }

      case MSG.OPEN_BOOKMARK_FOLDER: {
        openBookmarkFolder(payload.folderId);
        break;
      }

      case MSG.REORDER_PINNED: {
        const state = context.state;
        const { tabId: reorderTabId, targetTabId: reorderTargetId, position: reorderPos } = payload;
        const source = state.tabs.get(reorderTabId);
        const target = state.tabs.get(reorderTargetId);
        if (!source?.pinned || !target?.pinned) break;

        const targetIdx = state.rootIds.indexOf(reorderTargetId);
        if (targetIdx === -1) break;

        const insertIdx = reorderPos === 'after' ? targetIdx + 1 : targetIdx;
        state.moveTab(reorderTabId, null, insertIdx);

        chrome.tabs.move(reorderTabId, { index: insertIdx }).catch((err) => {
          // CAE-2: state was already committed; log the drift rather than swallow.
          console.warn('[LinkMap] REORDER_PINNED move failed:', err);
        });

        commitState();
        break;
      }

      default:
        ctx.DEBUG && console.log(`[LinkMap] Unknown message type: ${type}`);
    }
  };
}
