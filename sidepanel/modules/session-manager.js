/**
 * session-manager.js — Session save/restore UI + recently closed tabs panel.
 *
 * Provides:
 * - Session manager overlay (save, restore, delete named sessions)
 * - Recently closed tabs panel (last 25 closed tabs via chrome.sessions API)
 * - Undo close button in toolbar
 */

import { MSG } from '../../shared/constants.js';
import { escapeHtml } from '../../shared/utils.js';

// ---------------------------------------------------------------------------
// DOM references (created dynamically)
// ---------------------------------------------------------------------------

let overlayEl = null;
let recentlyClosedEl = null;
let stateRef = null;

/**
 * Updates the state reference for rendering.
 * @param {Object} state
 */
export function setSessionState(state) {
  stateRef = state;
}

// ---------------------------------------------------------------------------
// Undo Close Tab
// ---------------------------------------------------------------------------

/**
 * Restores the most recently closed tab via the background service worker.
 */
export function undoCloseTab() {
  chrome.runtime.sendMessage({ type: MSG.UNDO_CLOSE }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Session Manager Overlay
// ---------------------------------------------------------------------------

/**
 * Toggles the session manager overlay.
 * @param {HTMLElement} container — element to insert before (tree-container)
 */
export function toggleSessionManager(container) {
  if (overlayEl) {
    closeSessionManager();
    return;
  }
  openSessionManager(container);
}

function openSessionManager(container) {
  overlayEl = document.createElement('div');
  overlayEl.id = 'session-manager';
  overlayEl.className = 'session-manager';

  overlayEl.innerHTML = `
    <div class="session-header">
      <span class="session-title">Sessions</span>
      <button class="session-close-btn" title="Close">&times;</button>
    </div>
    <div class="session-actions">
      <button class="session-save-btn">Save Current Session</button>
    </div>
    <div class="session-list" id="session-list">
      <div class="session-loading">Loading sessions...</div>
    </div>
  `;

  // Event delegation
  overlayEl.addEventListener('click', handleSessionClick);

  container.before(overlayEl);
  loadSessions();
}

export function closeSessionManager() {
  if (overlayEl) {
    overlayEl.removeEventListener('click', handleSessionClick);
    overlayEl.remove();
    overlayEl = null;
  }
}

function handleSessionClick(e) {
  // Close button
  if (e.target.closest('.session-close-btn')) {
    closeSessionManager();
    return;
  }

  // Save button
  if (e.target.closest('.session-save-btn')) {
    const name = prompt('Session name:', `Session ${new Date().toLocaleDateString()}`);
    if (name) {
      chrome.runtime.sendMessage({
        type: MSG.SAVE_SESSION,
        payload: { name, isAutoSave: false },
      }).catch(() => {});
      // Refresh list after save
      setTimeout(loadSessions, 300);
    }
    return;
  }

  // Restore button
  const restoreBtn = e.target.closest('.session-restore-btn');
  if (restoreBtn) {
    const id = restoreBtn.dataset.sessionId;
    chrome.runtime.sendMessage({
      type: MSG.RESTORE_SESSION,
      payload: { sessionId: id },
    }).catch(() => {});
    closeSessionManager();
    return;
  }

  // Delete button
  const deleteBtn = e.target.closest('.session-delete-btn');
  if (deleteBtn) {
    const id = deleteBtn.dataset.sessionId;
    chrome.runtime.sendMessage({
      type: MSG.DELETE_SESSION,
      payload: { sessionId: id },
    }).catch(() => {});
    setTimeout(loadSessions, 200);
    return;
  }
}

function loadSessions() {
  chrome.runtime.sendMessage({ type: MSG.GET_SESSIONS }, (response) => {
    if (chrome.runtime.lastError || !overlayEl) return;
    renderSessionList(response?.sessions || []);
  });
}

function renderSessionList(sessions) {
  const listEl = overlayEl?.querySelector('#session-list');
  if (!listEl) return;

  if (sessions.length === 0) {
    listEl.innerHTML = '<div class="session-empty">No saved sessions</div>';
    return;
  }

  // Sort: manual first (newest first), then auto-saves (newest first)
  const manual = sessions.filter(s => !s.isAutoSave).sort((a, b) => b.savedAt - a.savedAt);
  const auto = sessions.filter(s => s.isAutoSave).sort((a, b) => b.savedAt - a.savedAt);

  let html = '';

  if (manual.length > 0) {
    html += '<div class="session-group-label">Saved Sessions</div>';
    for (const s of manual) {
      html += sessionEntryHtml(s);
    }
  }

  if (auto.length > 0) {
    html += '<div class="session-group-label">Auto-Saves</div>';
    for (const s of auto) {
      html += sessionEntryHtml(s);
    }
  }

  listEl.innerHTML = html;
}

function sessionEntryHtml(session) {
  const date = new Date(session.savedAt);
  const timeStr = date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const tabCount = session.tabCount || 0;
  const name = escapeHtml(session.name || 'Untitled');

  return `
    <div class="session-entry" data-session-id="${escapeHtml(session.id)}">
      <div class="session-info">
        <span class="session-name">${name}</span>
        <span class="session-meta">${tabCount} tabs &middot; ${timeStr}</span>
      </div>
      <div class="session-entry-actions">
        <button class="session-restore-btn" data-session-id="${escapeHtml(session.id)}" title="Restore">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M2 6h8M6 2l4 4-4 4"/>
          </svg>
        </button>
        <button class="session-delete-btn" data-session-id="${escapeHtml(session.id)}" title="Delete">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 3l6 6M9 3l-6 6"/>
          </svg>
        </button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Recently Closed Tabs Panel
// ---------------------------------------------------------------------------

/**
 * Toggles the recently closed tabs section.
 * @param {HTMLElement} container — element to insert before (footer)
 */
export function toggleRecentlyClosed(container) {
  if (recentlyClosedEl) {
    closeRecentlyClosed();
    return;
  }
  openRecentlyClosed(container);
}

function openRecentlyClosed(container) {
  recentlyClosedEl = document.createElement('div');
  recentlyClosedEl.id = 'recently-closed';
  recentlyClosedEl.className = 'recently-closed';

  recentlyClosedEl.innerHTML = `
    <div class="rc-header">
      <span class="rc-title">Recently Closed</span>
      <button class="rc-close-btn" title="Close">&times;</button>
    </div>
    <div class="rc-list" id="rc-list">
      <div class="session-loading">Loading...</div>
    </div>
  `;

  recentlyClosedEl.addEventListener('click', handleRecentlyClosedClick);
  container.before(recentlyClosedEl);
  loadRecentlyClosed();
}

export function closeRecentlyClosed() {
  if (recentlyClosedEl) {
    recentlyClosedEl.removeEventListener('click', handleRecentlyClosedClick);
    recentlyClosedEl.remove();
    recentlyClosedEl = null;
  }
}

function handleRecentlyClosedClick(e) {
  if (e.target.closest('.rc-close-btn')) {
    closeRecentlyClosed();
    return;
  }

  const entry = e.target.closest('.rc-entry');
  if (entry) {
    const sessionId = entry.dataset.sessionId;
    if (sessionId) {
      chrome.runtime.sendMessage({
        type: MSG.UNDO_CLOSE,
        payload: { sessionId },
      }).catch(() => {});
      // Refresh the list
      setTimeout(loadRecentlyClosed, 300);
    }
  }
}

function loadRecentlyClosed() {
  chrome.runtime.sendMessage({ type: MSG.GET_RECENTLY_CLOSED }, (response) => {
    if (chrome.runtime.lastError || !recentlyClosedEl) return;
    renderRecentlyClosed(response?.entries || []);
  });
}

function renderRecentlyClosed(entries) {
  const listEl = recentlyClosedEl?.querySelector('#rc-list');
  if (!listEl) return;

  if (entries.length === 0) {
    listEl.innerHTML = '<div class="session-empty">No recently closed tabs</div>';
    return;
  }

  let html = '';
  for (const entry of entries) {
    const tab = entry.tab;
    if (!tab) continue;

    const favicon = tab.favIconUrl
      ? `<img src="${escapeHtml(tab.favIconUrl)}" width="14" height="14" class="rc-favicon" onerror="this.style.display='none'">`
      : '<span class="rc-favicon-placeholder"></span>';
    const title = escapeHtml(tab.title || tab.url || 'Untitled');
    const url = escapeHtml(extractDomain(tab.url || ''));

    html += `
      <div class="rc-entry" data-session-id="${escapeHtml(entry.sessionId)}" title="${escapeHtml(tab.url || '')}">
        ${favicon}
        <div class="rc-info">
          <span class="rc-tab-title">${title}</span>
          <span class="rc-tab-url">${url}</span>
        </div>
      </div>
    `;
  }

  listEl.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
