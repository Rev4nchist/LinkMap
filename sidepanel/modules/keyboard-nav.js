/**
 * keyboard-nav.js -- Keyboard navigation for the tree panel.
 *
 * Extracted from sidepanel.js. Handles arrow keys, Home/End,
 * Enter to activate, Delete to close, Left/Right to collapse/expand.
 */

import { MSG } from '../../shared/constants.js';

/**
 * Initialize keyboard navigation for the tree panel.
 * @param {Object} deps
 * @param {HTMLElement} deps.treeContainer
 * @param {HTMLInputElement} deps.searchInput
 * @param {Function} deps.getFocusedTabId - returns current focusedTabId
 * @param {Function} deps.setFocusedTabId - sets focusedTabId
 * @param {Function} deps.getCurrentState - returns currentState
 * @returns {{ updateFocusRing: Function, getVisibleTabIds: Function }}
 */
export function initKeyboardNav({ treeContainer, searchInput, getFocusedTabId, setFocusedTabId, getCurrentState }) {

  /**
   * Returns visible tab IDs in DOM order from the tree container.
   */
  function getVisibleTabIds() {
    const entries = treeContainer.querySelectorAll('.tab-entry[data-tab-id]');
    return [...entries].map((el) => Number(el.dataset.tabId));
  }

  /**
   * Moves keyboard focus up or down.
   */
  function moveFocus(direction) {
    const visibleIds = getVisibleTabIds();
    if (visibleIds.length === 0) return;

    const focusedTabId = getFocusedTabId();
    if (focusedTabId == null) {
      setFocusedTabId(visibleIds[direction > 0 ? 0 : visibleIds.length - 1]);
    } else {
      const currentIdx = visibleIds.indexOf(focusedTabId);
      if (currentIdx === -1) {
        setFocusedTabId(visibleIds[0]);
      } else {
        const nextIdx = Math.max(0, Math.min(visibleIds.length - 1, currentIdx + direction));
        setFocusedTabId(visibleIds[nextIdx]);
      }
    }
    updateFocusRing();
  }

  function focusFirst() {
    const visibleIds = getVisibleTabIds();
    if (visibleIds.length > 0) {
      setFocusedTabId(visibleIds[0]);
      updateFocusRing();
    }
  }

  function focusLast() {
    const visibleIds = getVisibleTabIds();
    if (visibleIds.length > 0) {
      setFocusedTabId(visibleIds[visibleIds.length - 1]);
      updateFocusRing();
    }
  }

  /**
   * Updates the visual focus ring on the focused tab entry.
   */
  function updateFocusRing() {
    // Clear all existing focus indicators
    treeContainer.querySelectorAll('[data-focused]').forEach((el) => {
      delete el.dataset.focused;
    });

    const focusedTabId = getFocusedTabId();
    if (focusedTabId != null) {
      const el = treeContainer.querySelector(`[data-tab-id="${focusedTabId}"]`);
      if (el) {
        el.dataset.focused = 'true';
        el.focus();
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  // --- Keydown listener ---
  document.addEventListener('keydown', (e) => {
    // Skip when search input is focused (except Escape)
    if (document.activeElement === searchInput && e.key !== 'Escape') return;

    const currentState = getCurrentState();
    const focusedTabId = getFocusedTabId();

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        moveFocus(-1);
        break;

      case 'ArrowDown':
        e.preventDefault();
        moveFocus(1);
        break;

      case 'Enter':
        if (focusedTabId != null) {
          e.preventDefault();
          chrome.runtime.sendMessage({
            type: MSG.ACTIVATE_TAB,
            payload: { tabId: focusedTabId },
          }).catch(() => {});
        }
        break;

      case 'Delete':
        if (focusedTabId != null) {
          e.preventDefault();
          chrome.runtime.sendMessage({
            type: MSG.CLOSE_TAB,
            payload: { tabId: focusedTabId },
          }).catch(() => {});
          setFocusedTabId(null);
          updateFocusRing();
        }
        break;

      case 'ArrowLeft':
        if (focusedTabId != null) {
          e.preventDefault();
          const tabL = currentState?.tabs?.[focusedTabId];
          if (tabL?.children?.length > 0) {
            const isCollapsed = currentState.collapsed.includes(focusedTabId);
            if (!isCollapsed) {
              chrome.runtime.sendMessage({
                type: MSG.TOGGLE_COLLAPSE,
                payload: { tabId: focusedTabId },
              }).catch(() => {});
            }
          }
        }
        break;

      case 'ArrowRight':
        if (focusedTabId != null) {
          e.preventDefault();
          const tabR = currentState?.tabs?.[focusedTabId];
          if (tabR?.children?.length > 0) {
            const isCollapsed = currentState.collapsed.includes(focusedTabId);
            if (isCollapsed) {
              chrome.runtime.sendMessage({
                type: MSG.TOGGLE_COLLAPSE,
                payload: { tabId: focusedTabId },
              }).catch(() => {});
            }
          }
        }
        break;

      case 'Home':
        e.preventDefault();
        focusFirst();
        break;

      case 'End':
        e.preventDefault();
        focusLast();
        break;

      case 'Escape':
        if (document.activeElement === searchInput) return; // let search handle it
        setFocusedTabId(null);
        updateFocusRing();
        break;
    }
  });

  return { updateFocusRing, getVisibleTabIds };
}
