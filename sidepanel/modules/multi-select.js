/**
 * multi-select.js -- Multi-select toolbar for batch tab operations.
 *
 * Extracted from sidepanel.js. Manages the floating toolbar that
 * appears when tabs are selected via Ctrl+Click or Shift+Click.
 */

import { el } from '../../shared/utils.js';
import { MSG } from '../../shared/constants.js';

/**
 * Initialize multi-select toolbar.
 * @param {Object} deps
 * @param {HTMLElement} deps.treeContainer - The tree container (toolbar inserts before it)
 * @param {Function} deps.getSelectedTabIds - Returns current Set of selected tab IDs
 * @param {Function} deps.getCurrentState - Returns current state
 * @returns {{ updateMultiSelectUI: Function }}
 */
export function initMultiSelect({ treeContainer, getSelectedTabIds, getCurrentState }) {

  function updateMultiSelectUI() {
    const selectedTabIds = getSelectedTabIds();

    // Update data-selected and aria-selected attributes on tab entries
    const hasSelection = selectedTabIds.size > 0;
    treeContainer.querySelectorAll('.tab-entry[data-tab-id]').forEach(entry => {
      const tabId = Number(entry.dataset.tabId);
      const isSelected = selectedTabIds.has(tabId);
      entry.dataset.selected = String(isSelected);
      if (hasSelection) {
        entry.setAttribute('aria-selected', String(isSelected));
      } else {
        // Remove aria-selected when no multi-select is active
        entry.removeAttribute('aria-selected');
      }
    });

    // Show/hide multi-select toolbar
    let toolbar = document.getElementById('multi-select-toolbar');
    if (selectedTabIds.size > 0) {
      if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.id = 'multi-select-toolbar';
        toolbar.className = 'multi-select-toolbar';
        treeContainer.before(toolbar);
      }
      toolbar.replaceChildren(
        el('span', { className: 'ms-count' }, `${selectedTabIds.size} selected`),
        el('button', { dataset: { action: 'close' } }, 'Close'),
        el('button', { dataset: { action: 'group' } }, 'Group'),
        el('button', { dataset: { action: 'sleep' } }, 'Sleep'),
        el('button', { dataset: { action: 'copy' } }, 'Copy URLs'),
        el('button', { className: 'ms-clear', dataset: { action: 'clear' } }, '\u00d7'),
      );
      toolbar.onclick = (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const action = btn.dataset.action;
        const ids = [...selectedTabIds];
        const currentState = getCurrentState();
        switch (action) {
          case 'close':
            chrome.runtime.sendMessage({ type: MSG.MULTI_CLOSE, payload: { tabIds: ids } }).catch(() => {});
            break;
          case 'group':
            chrome.runtime.sendMessage({ type: MSG.MULTI_GROUP, payload: { tabIds: ids } }).catch(() => {});
            break;
          case 'sleep':
            chrome.runtime.sendMessage({ type: MSG.MULTI_SLEEP, payload: { tabIds: ids } }).catch(() => {});
            break;
          case 'copy': {
            const urls = ids
              .map(id => currentState?.tabs?.[id]?.url)
              .filter(Boolean)
              .join('\n');
            navigator.clipboard.writeText(urls).catch(() => {});
            break;
          }
          case 'clear':
            break; // handled below
        }
        selectedTabIds.clear();
        updateMultiSelectUI();
      };
    } else if (toolbar) {
      toolbar.remove();
    }
  }

  return { updateMultiSelectUI };
}
