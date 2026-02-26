/**
 * search.js — Fuzzy search UI for the side panel.
 *
 * Flattens the tree into a filtered list of matching tabs with highlighted
 * characters. Clearing or pressing Escape restores the normal tree view.
 */

import { fuzzyMatch, el, debounce } from '../../shared/utils.js';
import { SEARCH_DEBOUNCE_MS } from '../../shared/constants.js';

/**
 * Initialize search functionality.
 * @param {HTMLInputElement} inputEl - the search input
 * @param {HTMLElement} treeContainer - the main tree container
 * @param {Function} getState - returns current state object
 * @param {Function} restoreTree - call to re-render normal tree view
 * @returns {{ isActive: () => boolean, clear: () => void }}
 */
export function initSearch(inputEl, treeContainer, getState, restoreTree) {
  let isSearching = false;

  const doSearch = debounce((query) => {
    if (!query.trim()) {
      exitSearch();
      return;
    }

    const state = getState();
    if (!state) return;

    isSearching = true;
    const results = searchTabs(state.tabs, query);
    renderSearchResults(results, treeContainer);
  }, SEARCH_DEBOUNCE_MS);

  inputEl.addEventListener('input', (e) => {
    doSearch(e.target.value);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      inputEl.value = '';
      exitSearch();
      inputEl.blur();
    }
  });

  function exitSearch() {
    if (!isSearching) return;
    isSearching = false;
    treeContainer.className = '';
    restoreTree();
  }

  return {
    isActive: () => isSearching,
    clear: () => {
      inputEl.value = '';
      exitSearch();
    }
  };
}

/**
 * Search all tabs by title and URL using fuzzy matching.
 * Returns sorted array of { tab, tabId, titleMatch, urlMatch, bestScore }.
 * @param {Object} tabs - map of tabId -> tab objects
 * @param {string} query - search query
 * @returns {Array}
 */
export function searchTabs(tabs, query) {
  const results = [];

  for (const [tabId, tab] of Object.entries(tabs)) {
    const titleResult = fuzzyMatch(query, tab.title || '');
    const urlResult = fuzzyMatch(query, tab.url || '');

    if (titleResult.match || urlResult.match) {
      results.push({
        tab,
        tabId: Number(tabId),
        titleMatch: titleResult,
        urlMatch: urlResult,
        bestScore: Math.max(titleResult.score, urlResult.score)
      });
    }
  }

  results.sort((a, b) => b.bestScore - a.bestScore);
  return results;
}

/**
 * Render search results as a flat list.
 * @param {Array} results - from searchTabs()
 * @param {HTMLElement} container - the tree container to replace content in
 */
export function renderSearchResults(results, container) {
  if (results.length === 0) {
    container.replaceChildren(
      el('div', { className: 'search-empty' }, 'No matching tabs')
    );
    return;
  }

  container.className = 'search-results';

  const elements = results.map(({ tab, tabId, titleMatch, urlMatch }) => {
    const favicon = el('img', {
      className: 'tab-favicon',
      src: tab.favIconUrl || '',
      width: '16',
      height: '16',
      alt: ''
    });
    // Fallback for broken favicons
    favicon.onerror = () => { favicon.style.visibility = 'hidden'; };

    const titleEl = titleMatch.match
      ? highlightText(tab.title || 'Untitled', titleMatch.indices)
      : el('span', { className: 'tab-title' }, tab.title || 'Untitled');
    titleEl.className = 'tab-title';

    const urlEl = urlMatch.match
      ? highlightText(tab.url || '', urlMatch.indices)
      : el('span', { className: 'tab-url' }, tab.url || '');
    urlEl.className = 'tab-url search-url-visible';

    const closeBtn = el('button', { className: 'tab-close', title: 'Close tab' }, '\u00d7');

    const entry = el('div', {
      className: 'tab-entry',
      dataset: { tabId: String(tabId) }
    }, favicon, titleEl, urlEl, closeBtn);

    return entry;
  });

  container.replaceChildren(...elements);
}

/**
 * Create a span with matched characters highlighted.
 * @param {string} text - full text to display
 * @param {number[]} indices - character indices to highlight
 * @returns {HTMLElement}
 */
export function highlightText(text, indices) {
  const span = document.createElement('span');
  const indexSet = new Set(indices);

  let current = '';
  let inMatch = false;

  for (let i = 0; i < text.length; i++) {
    const isMatch = indexSet.has(i);
    if (isMatch !== inMatch) {
      if (current) {
        span.appendChild(
          inMatch
            ? el('span', { className: 'search-match' }, current)
            : document.createTextNode(current)
        );
      }
      current = '';
      inMatch = isMatch;
    }
    current += text[i];
  }
  if (current) {
    span.appendChild(
      inMatch
        ? el('span', { className: 'search-match' }, current)
        : document.createTextNode(current)
    );
  }

  return span;
}
