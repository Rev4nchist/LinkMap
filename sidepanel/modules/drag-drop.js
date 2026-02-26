/**
 * drag-drop.js -- Drag and drop for tab reordering and reparenting.
 *
 * Uses the native HTML5 Drag and Drop API.
 * Supports three drop modes:
 *   - "before": insert before the target (top 25% of element)
 *   - "after":  insert after the target (bottom 25% of element)
 *   - "child":  reparent as child of the target (middle 50%)
 */

import { MSG } from '../../shared/constants.js';

let draggedTabId = null;
let dropIndicator = null;
let dropTarget = null;
let dropMode = null; // 'before' | 'after' | 'child'

/**
 * Initialize drag and drop on the tree container.
 * @param {HTMLElement} container -- #tree-container
 */
export function initDragDrop(container) {
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
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function onDragStart(e) {
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

  const tabEntry = e.target.closest('.tab-entry');
  if (!tabEntry) {
    clearDropTarget();
    return;
  }

  const targetTabId = Number(tabEntry.dataset.tabId);
  if (targetTabId === draggedTabId) {
    clearDropTarget();
    return;
  }

  const rect = tabEntry.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const mode = resolveDropMode(y, rect);

  setDropMode(tabEntry, mode, rect);
  dropTarget = tabEntry;
}

function onDragLeave(e) {
  const tabEntry = e.target.closest('.tab-entry');
  if (tabEntry) {
    tabEntry.classList.remove('drop-target-child');
  }
}

function onDrop(e) {
  e.preventDefault();

  const tabEntry = e.target.closest('.tab-entry');
  if (!tabEntry || draggedTabId === null) return;

  const targetTabId = Number(tabEntry.dataset.tabId);
  if (targetTabId === draggedTabId) return;

  const parentId = getParentFromDOM(tabEntry);
  const payload = buildMovePayload(draggedTabId, targetTabId, dropMode, parentId);

  // Send move message to background
  chrome.runtime.sendMessage({
    type: MSG.MOVE_TAB,
    payload,
  });

  cleanup();
}

function onDragEnd() {
  cleanup();
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

function setDropMode(tabEntry, mode, rect) {
  // Clear previous
  if (dropTarget) {
    dropTarget.classList.remove('drop-target-child');
  }

  dropMode = mode;

  if (mode === 'child') {
    // Highlight the target tab
    tabEntry.classList.add('drop-target-child');
    dropIndicator.hidden = true;
  } else {
    // Show insertion line
    tabEntry.classList.remove('drop-target-child');
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

function cleanup() {
  // Remove dragging styles
  const dragging = document.querySelector('.dragging');
  if (dragging) {
    dragging.classList.remove('dragging');
    dragging.style.opacity = '';
  }

  clearDropTarget();
  draggedTabId = null;
  dropMode = null;
}

// ---------------------------------------------------------------------------
// Test exports (pure logic functions, no DOM side effects)
// ---------------------------------------------------------------------------

export const _testing = { resolveDropMode, getParentFromDOM, buildMovePayload };
