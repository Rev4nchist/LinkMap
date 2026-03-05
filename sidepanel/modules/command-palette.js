/**
 * command-palette.js — Ctrl+K command palette overlay.
 *
 * Searches across: open tabs, recently closed, actions.
 * Arrow keys to navigate, Enter to select, Escape to dismiss.
 */

import { MSG } from '../../shared/constants.js';
import { smartSearch, escapeHtml } from '../../shared/utils.js';

let overlayEl = null;
let stateRef = null;
let selectedIndex = 0;
let results = [];

/**
 * Sets the state reference for searching.
 * @param {Object} state
 */
export function setCommandPaletteState(state) {
  stateRef = state;
}

/**
 * Toggles the command palette.
 */
export function toggleCommandPalette() {
  if (overlayEl) {
    closeCommandPalette();
  } else {
    openCommandPalette();
  }
}

export function closeCommandPalette() {
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
    results = [];
    selectedIndex = 0;
  }
}

function openCommandPalette() {
  overlayEl = document.createElement('div');
  overlayEl.className = 'command-palette-overlay';
  overlayEl.innerHTML = `
    <div class="command-palette">
      <input type="text" class="cp-input" placeholder="Search tabs, actions..." autocomplete="off" autofocus>
      <div class="cp-results"></div>
    </div>
  `;

  const input = overlayEl.querySelector('.cp-input');
  const resultsContainer = overlayEl.querySelector('.cp-results');

  // Dismiss on backdrop click
  overlayEl.addEventListener('click', (e) => {
    if (e.target === overlayEl) closeCommandPalette();
  });

  input.addEventListener('input', () => {
    const query = input.value.trim();
    results = search(query);
    selectedIndex = 0;
    renderResults(resultsContainer);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCommandPalette();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
      renderResults(resultsContainer);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      renderResults(resultsContainer);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (results[selectedIndex]) {
        executeResult(results[selectedIndex]);
        closeCommandPalette();
      }
      return;
    }
  });

  document.body.appendChild(overlayEl);

  // Show initial results (actions + all tabs)
  results = search('');
  renderResults(resultsContainer);

  // Focus after append
  requestAnimationFrame(() => input.focus());
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Built-in actions */
const ACTIONS = [
  { type: 'action', label: 'Collapse All', icon: '−', action: () => chrome.runtime.sendMessage({ type: MSG.COLLAPSE_ALL }).catch(() => {}) },
  { type: 'action', label: 'Expand All', icon: '+', action: () => chrome.runtime.sendMessage({ type: MSG.EXPAND_ALL }).catch(() => {}) },
  { type: 'action', label: 'Close Duplicates', icon: '×', action: () => closeAllDuplicates() },
  { type: 'action', label: 'Save Session', icon: '💾', action: () => {
    const name = prompt('Session name:', `Session ${new Date().toLocaleDateString()}`);
    if (name) chrome.runtime.sendMessage({ type: MSG.SAVE_SESSION, payload: { name, isAutoSave: false } }).catch(() => {});
  }},
  { type: 'action', label: 'Undo Close Tab', icon: '↩', action: () => chrome.runtime.sendMessage({ type: MSG.UNDO_CLOSE }).catch(() => {}) },
];

function search(query) {
  const items = [];

  if (!stateRef) return items;

  // Tabs
  const tabs = Object.values(stateRef.tabs || {});
  for (const tab of tabs) {
    const titleMatch = smartSearch(query, tab.title || '');
    const urlMatch = smartSearch(query, tab.url || '');
    const bestScore = Math.max(titleMatch.score, urlMatch.score);
    if (!query || bestScore > 0) {
      items.push({
        type: 'tab',
        tabId: tab.tabId,
        label: tab.title || tab.url || 'Untitled',
        sublabel: extractDomain(tab.url || ''),
        favicon: tab.favIconUrl || '',
        score: bestScore,
      });
    }
  }

  // Actions
  for (const action of ACTIONS) {
    const match = smartSearch(query, action.label);
    if (!query || match.score > 0) {
      items.push({
        ...action,
        score: match.score + 50, // boost actions slightly
      });
    }
  }

  // Sort by score descending
  items.sort((a, b) => b.score - a.score);

  // Limit results
  return items.slice(0, 20);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderResults(container) {
  if (results.length === 0) {
    container.innerHTML = '<div class="cp-empty">No results</div>';
    return;
  }

  let html = '';
  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    const selected = i === selectedIndex ? ' cp-selected' : '';

    if (item.type === 'tab') {
      const favicon = item.favicon
        ? `<img src="${escapeHtml(item.favicon)}" width="14" height="14" class="cp-favicon" onerror="this.style.display='none'">`
        : '<span class="cp-favicon-placeholder"></span>';
      html += `
        <div class="cp-result${selected}" data-index="${i}">
          ${favicon}
          <div class="cp-result-info">
            <span class="cp-result-label">${escapeHtml(item.label)}</span>
            <span class="cp-result-sublabel">${escapeHtml(item.sublabel)}</span>
          </div>
          <span class="cp-result-type">Tab</span>
        </div>
      `;
    } else {
      html += `
        <div class="cp-result${selected}" data-index="${i}">
          <span class="cp-action-icon">${item.icon}</span>
          <div class="cp-result-info">
            <span class="cp-result-label">${escapeHtml(item.label)}</span>
          </div>
          <span class="cp-result-type">Action</span>
        </div>
      `;
    }
  }

  container.innerHTML = html;

  // Click handler
  container.onclick = (e) => {
    const resultEl = e.target.closest('.cp-result');
    if (resultEl) {
      const idx = Number(resultEl.dataset.index);
      if (results[idx]) {
        executeResult(results[idx]);
        closeCommandPalette();
      }
    }
  };

  // Scroll selected into view
  const selectedEl = container.querySelector('.cp-selected');
  if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function executeResult(item) {
  if (item.type === 'tab') {
    chrome.runtime.sendMessage({
      type: MSG.ACTIVATE_TAB,
      payload: { tabId: item.tabId },
    }).catch(() => {});
  } else if (item.type === 'action' && item.action) {
    item.action();
  }
}

function closeAllDuplicates() {
  if (!stateRef?.duplicates) return;
  for (const ids of Object.values(stateRef.duplicates)) {
    if (ids.length > 1) {
      const sorted = [...ids].sort((a, b) => a - b);
      chrome.tabs.remove(sorted.slice(1)).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}
