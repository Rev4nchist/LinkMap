/**
 * Tab Move Helpers
 *
 * Position handlers for MOVE_TAB operations and pinned boundary logic.
 */

import { UNGROUPED_GROUP_ID } from '../shared/constants.js';

/**
 * Returns [tabId, ...non-pinned descendant tabIds] — the single unified
 * id-set used at EVERY group/ungroup call site (A9). Pinned tabs are
 * excluded because Chrome rejects grouping (or ungrouping) a pinned tab.
 *
 * @param {import('../shared/shadow-state.js').ShadowState} state
 * @param {number} tabId
 * @returns {number[]}
 */
export function collectGroupableTabIds(state, tabId) {
  const ids = [tabId, ...state.getDescendants(tabId).map((d) => d.tabId)];
  return ids.filter((id) => {
    const tab = state.getTab(id);
    return !(tab && tab.pinned);
  });
}

/**
 * Returns [tabId, ...ALL descendant tabIds] — pinned tabs INCLUDED. This is
 * the id-set used at every chrome.tabs.move() call site: Chrome rejects
 * grouping/ungrouping a pinned tab, but moving one across windows is fine.
 * Using collectGroupableTabIds (pinned-excluded) for move() left pinned
 * descendants physically stranded in the source window while the shadow
 * tree re-nested them under the moved tab, going stale (CR-move-pinned).
 *
 * @param {import('../shared/shadow-state.js').ShadowState} state
 * @param {number} tabId
 * @returns {number[]}
 */
export function collectMovableTabIds(state, tabId) {
  return [tabId, ...state.getDescendants(tabId).map((d) => d.tabId)];
}

/**
 * Creates move helper functions bound to a state getter and commitState.
 * @param {Function} getState - getter that returns the current ShadowState instance
 * @param {Function} commitState - saves + broadcasts state
 * @returns {Object} Move helper API
 */
export function createMoveHelpers(getState, commitState) {

  /**
   * Repositions a tab in rootIds to sit adjacent to its group members.
   * Scans ALL tabs (not just rootIds) via state.getGroupMemberIds().
   * Includes off-by-one correction when the tab is before the target index.
   *
   * @param {number} tabId - Tab to reposition
   * @param {number} groupId - Target group
   */
  function repositionTabToGroup(tabId, groupId) {
    const state = getState();
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

  /**
   * Returns the index in rootIds just past the last pinned tab.
   * If no pinned tabs exist, returns 0.
   */
  function getPinnedBoundaryIndex(excludeTabId) {
    const state = getState();
    let lastPinned = -1;
    for (let i = 0; i < state.rootIds.length; i++) {
      if (state.rootIds[i] === excludeTabId) continue;
      const tab = state.tabs.get(state.rootIds[i]);
      if (tab && tab.pinned) lastPinned = i;
    }
    return lastPinned + 1;
  }

  /**
   * Handles drop on a group header — adds the tab AND its non-pinned
   * descendants to the end of that group (4b/A9). Groups are per-window, so
   * a drop from a different window moves the whole subtree (pinned
   * descendants included, CR-move-pinned) into the group's window first,
   * then groups the non-pinned subset in one call (4c/A9 — group-header
   * drop from another window).
   * Awaits Chrome API confirmation before mutating state to prevent drift.
   * @returns {'async'}
   */
  function moveTabToGroup(tabId, targetGroupId) {
    const state = getState();
    const sourceTab = state.getTab(tabId);
    const targetGroup = state.groups.get(targetGroupId);
    const groupableIds = collectGroupableTabIds(state, tabId);

    const applyGroup = () => chrome.tabs.group({ tabIds: groupableIds, groupId: targetGroupId })
      .then(() => {
        repositionTabToGroup(tabId, targetGroupId);
        commitState();
      })
      .catch((err) => {
        console.error('[LinkMap] Group add failed:', err);
      });

    if (sourceTab && targetGroup && sourceTab.windowId !== targetGroup.windowId) {
      const movableIds = collectMovableTabIds(state, tabId);
      chrome.tabs.move(movableIds, { windowId: targetGroup.windowId, index: -1 })
        .then(applyGroup)
        .catch((err) => {
          console.error('[LinkMap] Cross-window group-header move failed:', err);
        });
    } else {
      applyGroup();
    }
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
   * After a cross-window subtree move confirms, (re)group or ungroup the
   * moved set per targetGroupId (4c/A9). No-op when targetGroupId wasn't
   * supplied (drop wasn't group-aware), and skips the ungroup call when the
   * tab wasn't grouped to begin with (nothing to undo).
   * @param {number[]} ids
   * @param {number|undefined} targetGroupId
   * @param {number|undefined} wasGrouped - the moved tab's groupId before the move
   * @returns {Promise<void>}
   */
  /**
   * B-4: reconcile the moved tabs' groupId/windowId in shadow state from Chrome
   * truth. Called after a cross-window group/ungroup attempt so that a SWALLOWED
   * failure (or an async event that hasn't landed yet) can't leave the tabs
   * persisted with a stale groupId. On a failed group() the tabs are ungrouped
   * in the new window; chrome.tabs.get then reports groupId -1 and we persist
   * that truth instead of the pre-move group.
   * @param {number[]} ids
   * @returns {Promise<void>}
   */
  function repairGroupMembership(ids) {
    const state = getState();
    return Promise.all(ids.map((id) =>
      chrome.tabs.get(id)
        .then((t) => {
          if (t) state.updateTab(id, { groupId: t.groupId ?? UNGROUPED_GROUP_ID, windowId: t.windowId });
        })
        .catch(() => { /* tab closed mid-move — leave its node untouched */ })
    )).then(() => {});
  }

  function syncGroupAfterWindowMove(ids, targetGroupId, wasGrouped) {
    if (targetGroupId === undefined) return Promise.resolve();
    let op;
    if (targetGroupId === UNGROUPED_GROUP_ID) {
      if (wasGrouped === undefined || wasGrouped === UNGROUPED_GROUP_ID) return Promise.resolve();
      op = chrome.tabs.ungroup(ids).catch((err) => {
        console.error('[LinkMap] Cross-window ungroup failed:', err);
      });
    } else {
      op = chrome.tabs.group({ tabIds: ids, groupId: targetGroupId }).catch((err) => {
        console.error('[LinkMap] Cross-window group failed:', err);
      });
    }
    // Always reconcile membership from Chrome truth before the caller commits,
    // whether the group/ungroup succeeded or its error was swallowed above.
    return op.then(() => repairGroupMembership(ids));
  }

  /**
   * Handles reparenting — makes tabId a child of parentId. A cross-window
   * move carries the tab's full subtree (pinned descendants included) and,
   * when targetGroupId is supplied, (re)groups/ungroups the non-pinned
   * subset once the window move confirms (4c/A9, CR-move-pinned).
   * @returns {'sync'|'async'}
   */
  function moveTabAsChild(tabId, parentId, needsWindowMove, targetWindowId, targetGroupId) {
    if (needsWindowMove) {
      const state = getState();
      const wasGrouped = state.getTab(tabId)?.groupId;
      const movableIds = collectMovableTabIds(state, tabId);
      const groupableIds = collectGroupableTabIds(state, tabId);
      chrome.tabs.move(movableIds, { windowId: targetWindowId, index: -1 })
        .then(() => {
          getState().moveTab(tabId, parentId, 0);
          return syncGroupAfterWindowMove(groupableIds, targetGroupId, wasGrouped);
        })
        .then(() => {
          commitState();
        })
        .catch((err) => {
          console.error('[LinkMap] Cross-window move failed:', err);
        });
      return 'async';
    }
    getState().moveTab(tabId, parentId, 0);
    return 'sync';
  }

  /**
   * Handles before/after reordering within siblings. A cross-window move
   * carries the tab's full subtree (pinned descendants included) and, when
   * targetGroupId is supplied, (re)groups/ungroups the non-pinned subset
   * once the window move confirms (4c/A9, CR-move-pinned).
   * @returns {'sync'|'async'}
   */
  function moveTabBeforeAfter(tabId, parentId, targetTabId, position, needsWindowMove, targetWindowId, targetGroupId) {
    const state = getState();
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
      const wasGrouped = state.getTab(tabId)?.groupId;
      const movableIds = collectMovableTabIds(state, tabId);
      const groupableIds = collectGroupableTabIds(state, tabId);
      chrome.tabs.move(movableIds, { windowId: targetWindowId, index: -1 })
        .then(() => {
          getState().moveTab(tabId, parentId, targetIndex);
          return syncGroupAfterWindowMove(groupableIds, targetGroupId, wasGrouped);
        })
        .then(() => {
          commitState();
        })
        .catch((err) => {
          console.error('[LinkMap] Cross-window move failed:', err);
        });
      return 'async';
    }
    state.moveTab(tabId, parentId, targetIndex);
    return 'sync';
  }

  return {
    repositionTabToGroup,
    getPinnedBoundaryIndex,
    moveTabToGroup,
    moveTabToWindow,
    moveTabAsChild,
    moveTabBeforeAfter,
  };
}
