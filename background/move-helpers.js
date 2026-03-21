/**
 * Tab Move Helpers
 *
 * Position handlers for MOVE_TAB operations and pinned boundary logic.
 */

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
        getState().moveTab(tabId, parentId, 0);
        commitState();
      }).catch((err) => {
        console.error('[LinkMap] Cross-window move failed:', err);
      });
      return 'async';
    }
    getState().moveTab(tabId, parentId, 0);
    return 'sync';
  }

  /**
   * Handles before/after reordering within siblings.
   * @returns {'sync'|'async'}
   */
  function moveTabBeforeAfter(tabId, parentId, targetTabId, position, needsWindowMove, targetWindowId) {
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
      chrome.tabs.move(tabId, { windowId: targetWindowId, index: -1 }).then(() => {
        getState().moveTab(tabId, parentId, targetIndex);
        commitState();
      }).catch((err) => {
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
