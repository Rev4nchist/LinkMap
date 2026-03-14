/**
 * settings.js -- Settings panel for group color customization.
 *
 * Extracted from sidepanel.js. Manages the settings overlay that lets
 * users customize tab group colors using theme-aware palettes.
 */

import { MSG, UNGROUPED_GROUP_ID, THEME_ACCENTS } from '../../shared/constants.js';
import { escapeHtml } from '../../shared/utils.js';

/**
 * Initialize the settings panel.
 * @param {Object} deps
 * @param {HTMLElement} deps.settingsBtn - The settings toggle button
 * @param {HTMLElement} deps.treeContainer - The tree container (panel inserts before it)
 * @param {Function} deps.getCurrentState - Returns current state
 * @param {Function} deps.generateThemePalette - Generates theme palette colors
 * @returns {{ showSettings: Function, hideSettings: Function }}
 */
export function initSettings({ settingsBtn, treeContainer, getCurrentState, generateThemePalette }) {
  let settingsOpen = false;

  settingsBtn.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    if (settingsOpen) {
      showSettings();
    } else {
      hideSettings();
    }
  });

  function showSettings() {
    hideSettings(); // remove stale panel first

    const panel = document.createElement('div');
    panel.id = 'settings-panel';
    panel.className = 'settings-panel';

    const currentState = getCurrentState();

    if (!currentState) {
      panel.innerHTML = `
        <div class="settings-section">
          <div class="settings-label">Settings</div>
          <div class="settings-hint">Loading state...</div>
        </div>
      `;
      treeContainer.before(panel);
      return;
    }

    // Collect unique non-default groupIds from current tabs
    const groups = new Set();
    for (const tab of Object.values(currentState.tabs)) {
      if (tab.groupId !== undefined && tab.groupId !== UNGROUPED_GROUP_ID) {
        groups.add(tab.groupId);
      }
    }

    if (groups.size === 0) {
      panel.innerHTML = `
        <div class="settings-section">
          <div class="settings-label">Group Colors</div>
          <div class="settings-hint">No tab groups found. Create tab groups in Chrome to customize their colors here.</div>
        </div>
      `;
      treeContainer.before(panel);
      return;
    }

    const themePalette = generateThemePalette(currentState.theme, THEME_ACCENTS);

    let html = '<div class="settings-section"><div class="settings-label">Group Colors</div>';
    for (const groupId of groups) {
      const groupData = currentState.groups?.[groupId];
      const groupName = groupData?.title || 'Untitled Group';
      const currentColor = currentState.groupColors?.[groupId] || '#6c8cff';
      const swatchesHtml = themePalette.map(hex =>
        `<span class="settings-swatch" data-group-id="${groupId}" data-color="${hex}" style="background:${hex}" title="${hex}"></span>`
      ).join('');
      html += `
        <div class="group-color-section">
          <div class="group-color-row">
            <span class="group-id-label">${escapeHtml(groupName)}</span>
            <input type="color" class="group-color-input" data-group-id="${groupId}" value="${currentColor}">
          </div>
          <div class="settings-swatch-row">${swatchesHtml}</div>
        </div>
      `;
    }
    html += '</div>';
    panel.innerHTML = html;

    panel.addEventListener('input', (e) => {
      if (!e.target.classList.contains('group-color-input')) return;
      const groupId = Number(e.target.dataset.groupId);
      const color = e.target.value;
      chrome.runtime.sendMessage({ type: MSG.SET_GROUP_COLOR, payload: { groupId, color } }).catch(() => {});
    });

    panel.addEventListener('click', (e) => {
      const swatch = e.target.closest('.settings-swatch');
      if (!swatch) return;
      const groupId = Number(swatch.dataset.groupId);
      const color = swatch.dataset.color;
      // Update the hex input to match
      const input = panel.querySelector(`.group-color-input[data-group-id="${groupId}"]`);
      if (input) input.value = color;
      chrome.runtime.sendMessage({ type: MSG.SET_GROUP_COLOR, payload: { groupId, color } }).catch(() => {});
    });

    treeContainer.before(panel);
  }

  function hideSettings() {
    const panel = document.getElementById('settings-panel');
    if (panel) panel.remove();
  }

  return { showSettings, hideSettings };
}
