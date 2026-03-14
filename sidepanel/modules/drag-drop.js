/**
 * drag-drop.js -- Drag and drop for tab reordering/reparenting and group reordering.
 *
 * Uses the native HTML5 Drag and Drop API.
 * Tab drops support three modes:
 *   - "before": insert before the target (top 25% of element)
 *   - "after":  insert after the target (bottom 25% of element)
 *   - "child":  reparent as child of the target (middle 50%)
 * Group drops support only before/after (top/bottom half).
 */

import { MSG, UNGROUPED_GROUP_ID } from '../../shared/constants.js';

let draggedTabId = null;
let draggedGroupId = null;
let dropIndicator = null;
let dropTarget = null;
let dropMode = null; // 'before' | 'after' | 'child'
let _dragOverRafId = null; // rAF throttle for dragover
let _autoScrollRafId = null;
let _treeContainer = null;

const AUTO_SCROLL_EDGE = 60;   // px from container edge to start auto-scroll
const AUTO_SCROLL_SPEED = 6;   // px per frame at edge
const AUTO_SCROLL_ACCEL = 0.8; // speed multiplier as cursor moves further out

/**
 * Initialize drag and drop on the tree container.
 * @param {HTMLElement} container -- #tree-container
 */
export function initDragDrop(container) {
  _treeContainer = container;

  // Create drop indicator element
  dropIndicator = document.createElement('div');
  dropIndicator.className = 'drop-indicator';
  dropIndicator.hidden = true;
  document.body.appendChild(dropIndicator);

  // Delegate drag events on the container
  container.addEventListener('dragstart', onDragStart);
  container.addEventListener('dragover', onDragOver);
  container.addEventListener('dragleave', onDragLeave);
  container.addEventListener('drop', onDrop);
  container.addEventListener('dragend', onDragEnd);

  // Document-level dragover for auto-scroll (works even when cursor leaves container)
  document.addEventListener('dragover', onDocumentDragOver);
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function onDragStart(e) {
  // Group header drag
  const groupHeader = e.target.closest('.group-header');
  if (groupHeader) {
    draggedGroupId = Number(groupHeader.dataset.groupId);
    groupHeader.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `group:${draggedGroupId}`);
    requestAnimationFrame(() => { groupHeader.style.opacity = '0.4'; });
    return;
  }

  // Tab entry drag
  const tabEntry = e.target.closest('.tab-entry');
  if (!tabEntry) return;

  draggedTabId = Number(tabEntry.dataset.tabId);
  tabEntry.classList.add('dragging');

  // Required for Firefox
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(draggedTabId));

  // Make it slightly transparent while dragging
  requestAnimationFrame(() => {
    tabEntry.style.opacity = '0.4';
  });
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  // Throttle DOM work to one rAF per frame
  if (_dragOverRafId) return;
  const clientY = e.clientY;
  const eventTarget = e.target;
  _dragOverRafId = requestAnimationFrame(() => {
    _dragOverRafId = null;
    _processDragOver(eventTarget, clientY);
  });
}

function _processDragOver(eventTarget, clientY) {
  // Find the nearest valid drop target
  const target = eventTarget.closest('.tab-entry') || eventTarget.closest('.group-header') || eventTarget.closest('.window-separator');
  if (!target) {
    clearDropTarget();
    return;
  }

  // Window separator: only valid for tab drags (move tab to that window)
  if (target.classList.contains('window-separator')) {
    if (draggedTabId === null) { clearDropTarget(); return; }
    const rect = target.getBoundingClientRect();
    setDropMode(target, 'child', rect);
    dropTarget = target;
    return;
  }

  // --- Self-drop guards ---
  if (draggedGroupId !== null) {
    const gh = target.closest('.group-header');
    if (gh && Number(gh.dataset.groupId) === draggedGroupId) {
      clearDropTarget();
      return;
    }
    const te = target.closest('.tab-entry');
    if (te && Number(te.dataset.groupId) === draggedGroupId) {
      clearDropTarget();
      return;
    }
  }

  if (draggedTabId !== null) {
    const te = target.closest('.tab-entry');
    if (te && Number(te.dataset.tabId) === draggedTabId) {
      clearDropTarget();
      return;
    }
  }

  const rect = target.getBoundingClientRect();
  const y = clientY - rect.top;

  // Group-on-group: before/after only.
  // Tab-on-group-header: always "child" (add to group, shows dashed outline).
  // Tab-on-tab: 3-zone (before/child/after).
  const isGroupDrag = draggedGroupId !== null;
  const isGroupTarget = target.classList.contains('group-header');
  let mode;
  if (isGroupDrag) {
    mode = resolveDropModeFlat(y, rect);
  } else if (isGroupTarget) {
    mode = 'child';
  } else {
    mode = resolveDropMode(y, rect);
  }

  setDropMode(target, mode, rect);
  dropTarget = target;
}

function onDragLeave(e) {
  const el = e.target.closest('.tab-entry') || e.target.closest('.group-header') || e.target.closest('.window-separator');
  if (el) {
    el.classList.remove('drop-target-child');
  }
}

function onDrop(e) {
  e.preventDefault();

  if (draggedGroupId !== null) {
    handleGroupDrop(e);
  } else if (draggedTabId !== null) {
    // Check if dropped on a window separator
    const windowSep = e.target.closest('.window-separator');
    if (windowSep) {
      handleWindowDrop(windowSep);
    } else {
      handleTabDrop(e);
    }
  }

  cleanup();
}

function onDragEnd() {
  cleanup();
}

// ---------------------------------------------------------------------------
// Tab drop (existing behavior)
// ---------------------------------------------------------------------------

function handleTabDrop(e) {
  // Drop on a group header — add tab to that group
  const groupHeader = e.target.closest('.group-header');
  if (groupHeader && dropMode === 'child') {
    const targetGroupId = Number(groupHeader.dataset.groupId);
    chrome.runtime.sendMessage({
      type: MSG.MOVE_TAB,
      payload: {
        tabId: draggedTabId,
        targetGroupId,
        position: 'group',
      },
    }).catch(() => {});
    return;
  }

  const tabEntry = e.target.closest('.tab-entry');
  if (!tabEntry) return;

  const targetTabId = Number(tabEntry.dataset.tabId);
  if (targetTabId === draggedTabId) return;

  const parentId = getParentFromDOM(tabEntry);
  const payload = buildMovePayload(draggedTabId, targetTabId, dropMode, parentId);

  // Include target windowId so background can detect cross-window moves
  const targetWindowId = Number(tabEntry.dataset.windowId);
  if (targetWindowId) payload.targetWindowId = targetWindowId;

  // Include target group so background can sync Chrome group membership
  const targetGroupId = Number(tabEntry.dataset.groupId);
  if (targetGroupId !== UNGROUPED_GROUP_ID) {
    payload.targetGroupId = targetGroupId;
  }

  chrome.runtime.sendMessage({
    type: MSG.MOVE_TAB,
    payload,
  }).catch(() => {});
}

/**
 * Handle drop on a window separator — move tab to that window.
 * @param {HTMLElement} windowSep - The .window-separator element
 */
function handleWindowDrop(windowSep) {
  const targetWindowId = Number(windowSep.dataset.windowId);
  if (!targetWindowId || draggedTabId === null) return;

  chrome.runtime.sendMessage({
    type: MSG.MOVE_TAB,
    payload: {
      tabId: draggedTabId,
      targetWindowId,
      position: 'window', // signals a cross-window move to end of window
    },
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Group drop
// ---------------------------------------------------------------------------

function handleGroupDrop(e) {
  const target = e.target.closest('.tab-entry') || e.target.closest('.group-header');
  if (!target) return;

  const payload = { groupId: draggedGroupId, position: dropMode };

  if (target.classList.contains('group-header')) {
    // Dropped on another group header — resolve via anchorGroupId
    payload.anchorGroupId = Number(target.dataset.groupId);
  } else {
    // Dropped on a tab entry
    payload.anchorTabId = Number(target.dataset.tabId);
  }

  chrome.runtime.sendMessage({
    type: MSG.MOVE_GROUP,
    payload,
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Drop zone logic
// ---------------------------------------------------------------------------

/**
 * Determines the drop mode based on cursor Y position within the element.
 *
 * Top 25%    -> "before"
 * Middle 50% -> "child"
 * Bottom 25% -> "after"
 *
 * @param {number} y - Cursor Y relative to element top (clientY - rect.top)
 * @param {{ height: number }} rect - Element bounding rect
 * @returns {'before' | 'after' | 'child'}
 */
function resolveDropMode(y, rect) {
  const ratio = y / rect.height;
  if (ratio < 0.25) return 'before';
  if (ratio > 0.75) return 'after';
  return 'child';
}

/**
 * Flat drop mode — before/after only (top/bottom half).
 * Used for group drags and when hovering over group headers.
 */
function resolveDropModeFlat(y, rect) {
  return (y / rect.height) < 0.5 ? 'before' : 'after';
}

/**
 * Walk previous siblings to find the parent tab entry (first element at a
 * shallower depth).
 *
 * @param {HTMLElement} tabEntry - The target tab entry element
 * @returns {number|null} Parent tab ID, or null if at root level
 */
function getParentFromDOM(tabEntry) {
  const depth = Number(tabEntry.dataset.depth || 0);
  if (depth === 0) return null;

  let el = tabEntry.previousElementSibling;
  while (el) {
    if (el.classList.contains('tab-entry')) {
      const elDepth = Number(el.dataset.depth || 0);
      if (elDepth < depth) {
        return Number(el.dataset.tabId);
      }
    }
    el = el.previousElementSibling;
  }
  return null;
}

/**
 * Builds the MOVE_TAB message payload.
 *
 * @param {number} draggedId - Tab being dragged
 * @param {number} targetId - Tab being dropped on
 * @param {'before'|'after'|'child'} position - Drop mode
 * @param {number|null} parentId - Parent of the target (from DOM walk)
 * @returns {Object} Message payload for MOVE_TAB
 */
function buildMovePayload(draggedId, targetId, position, parentId) {
  return {
    tabId: draggedId,
    newParentId: position === 'child' ? targetId : parentId,
    targetTabId: targetId,
    position,
  };
}

// ---------------------------------------------------------------------------
// Visual feedback
// ---------------------------------------------------------------------------

function setDropMode(target, mode, rect) {
  // Clear previous
  if (dropTarget) {
    dropTarget.classList.remove('drop-target-child');
  }

  dropMode = mode;

  if (mode === 'child') {
    // Highlight the target tab
    target.classList.add('drop-target-child');
    dropIndicator.hidden = true;
  } else {
    // Show insertion line
    target.classList.remove('drop-target-child');
    dropIndicator.hidden = false;

    const left = rect.left;
    const width = rect.width;

    if (mode === 'before') {
      dropIndicator.style.top = `${rect.top - 1}px`;
    } else {
      dropIndicator.style.top = `${rect.bottom - 1}px`;
    }
    dropIndicator.style.left = `${left}px`;
    dropIndicator.style.width = `${width}px`;
  }
}

function clearDropTarget() {
  if (dropTarget) {
    dropTarget.classList.remove('drop-target-child');
  }
  if (dropIndicator) {
    dropIndicator.hidden = true;
  }
  dropMode = null;
}

// ---------------------------------------------------------------------------
// Auto-scroll during drag
// ---------------------------------------------------------------------------

/**
 * Document-level dragover — auto-scrolls the tree container when cursor is
 * near or beyond its top/bottom edge. Works even when dragging outside the
 * sidebar entirely.
 */
function onDocumentDragOver(e) {
  if (draggedTabId === null && draggedGroupId === null) return;
  if (!_treeContainer) return;

  const rect = _treeContainer.getBoundingClientRect();
  const cursorY = e.clientY;

  // Distance from top/bottom edge (negative = outside container)
  const fromTop = cursorY - rect.top;
  const fromBottom = rect.bottom - cursorY;

  if (fromTop < AUTO_SCROLL_EDGE) {
    // Cursor near or above top edge — scroll up
    // Speed increases the further above the edge (negative fromTop = outside)
    const intensity = Math.min(1, (AUTO_SCROLL_EDGE - fromTop) / AUTO_SCROLL_EDGE);
    startAutoScroll(-1, intensity);
  } else if (fromBottom < AUTO_SCROLL_EDGE) {
    // Cursor near or below bottom edge — scroll down
    const intensity = Math.min(1, (AUTO_SCROLL_EDGE - fromBottom) / AUTO_SCROLL_EDGE);
    startAutoScroll(1, intensity);
  } else {
    stopAutoScroll();
  }
}

function startAutoScroll(direction, intensity) {
  // Already scrolling in this direction — just update speed via closure
  if (_autoScrollRafId && _autoScrollDir === direction) {
    _autoScrollIntensity = intensity;
    return;
  }
  stopAutoScroll();
  _autoScrollDir = direction;
  _autoScrollIntensity = intensity;

  function step() {
    const speed = AUTO_SCROLL_SPEED * (AUTO_SCROLL_ACCEL + _autoScrollIntensity);
    _treeContainer.scrollTop += speed * _autoScrollDir;
    _autoScrollRafId = requestAnimationFrame(step);
  }
  _autoScrollRafId = requestAnimationFrame(step);
}

let _autoScrollDir = 0;
let _autoScrollIntensity = 0;

function stopAutoScroll() {
  if (_autoScrollRafId) {
    cancelAnimationFrame(_autoScrollRafId);
    _autoScrollRafId = null;
  }
  _autoScrollDir = 0;
  _autoScrollIntensity = 0;
}

function cleanup() {
  // Remove dragging styles
  const dragging = document.querySelector('.dragging');
  if (dragging) {
    dragging.classList.remove('dragging');
    dragging.style.opacity = '';
  }

  stopAutoScroll();
  clearDropTarget();
  draggedTabId = null;
  draggedGroupId = null;
  dropMode = null;
  if (_dragOverRafId) {
    cancelAnimationFrame(_dragOverRafId);
    _dragOverRafId = null;
  }
}

// ---------------------------------------------------------------------------
// Pinned tab drag-to-reorder
// ---------------------------------------------------------------------------

let draggedPinnedTabId = null;
let pinnedDropIndicator = null;

/**
 * Initialize drag-and-drop reordering for pinned tab tiles.
 * Can be called on multiple containers (e.g. #pinned-list AND #tree-container
 * for inline pinned bars in multi-window mode). The drop indicator is shared.
 * @param {HTMLElement} container - element whose descendants include .pinned-tab tiles
 */
export function initPinnedDragDrop(container) {
  if (!pinnedDropIndicator) {
    pinnedDropIndicator = document.createElement('div');
    pinnedDropIndicator.className = 'pinned-drop-indicator';
    pinnedDropIndicator.hidden = true;
    document.body.appendChild(pinnedDropIndicator);
  }

  container.addEventListener('dragstart', onPinnedDragStart);
  container.addEventListener('dragover', onPinnedDragOver);
  container.addEventListener('dragleave', onPinnedDragLeave);
  container.addEventListener('drop', onPinnedDrop);
  container.addEventListener('dragend', onPinnedDragEnd);
}

function onPinnedDragStart(e) {
  const pinnedTab = e.target.closest('.pinned-tab');
  if (!pinnedTab) return;

  draggedPinnedTabId = Number(pinnedTab.dataset.tabId);
  pinnedTab.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', `pinned:${draggedPinnedTabId}`);
  requestAnimationFrame(() => { pinnedTab.style.opacity = '0.4'; });
}

function onPinnedDragOver(e) {
  if (draggedPinnedTabId === null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const target = e.target.closest('.pinned-tab');
  if (!target || Number(target.dataset.tabId) === draggedPinnedTabId) {
    pinnedDropIndicator.hidden = true;
    return;
  }

  const rect = target.getBoundingClientRect();
  const midX = rect.left + rect.width / 2;
  const position = e.clientX < midX ? 'before' : 'after';

  // Show vertical line indicator
  pinnedDropIndicator.hidden = false;
  pinnedDropIndicator.style.top = `${rect.top}px`;
  pinnedDropIndicator.style.height = `${rect.height}px`;
  pinnedDropIndicator.style.left = position === 'before'
    ? `${rect.left - 1}px`
    : `${rect.right - 1}px`;

  pinnedDropIndicator.dataset.position = position;
  pinnedDropIndicator.dataset.targetTabId = target.dataset.tabId;
}

function onPinnedDragLeave() {
  // Indicator hides when cursor leaves the container (onDragOver stops firing)
}

function onPinnedDrop(e) {
  e.preventDefault();
  if (draggedPinnedTabId === null) return;

  const targetTabId = Number(pinnedDropIndicator.dataset.targetTabId);
  const position = pinnedDropIndicator.dataset.position;

  if (targetTabId && position && targetTabId !== draggedPinnedTabId) {
    chrome.runtime.sendMessage({
      type: MSG.REORDER_PINNED,
      payload: {
        tabId: draggedPinnedTabId,
        targetTabId,
        position,
      },
    }).catch(() => {});
  }

  pinnedCleanup();
}

function onPinnedDragEnd() {
  pinnedCleanup();
}

function pinnedCleanup() {
  const dragging = document.querySelector('.pinned-tab.dragging');
  if (dragging) {
    dragging.classList.remove('dragging');
    dragging.style.opacity = '';
  }
  if (pinnedDropIndicator) {
    pinnedDropIndicator.hidden = true;
    delete pinnedDropIndicator.dataset.position;
    delete pinnedDropIndicator.dataset.targetTabId;
  }
  draggedPinnedTabId = null;
}

// ---------------------------------------------------------------------------
// Test exports (pure logic functions, no DOM side effects)
// ---------------------------------------------------------------------------

export const _testing = { resolveDropMode, resolveDropModeFlat, getParentFromDOM, buildMovePayload };
