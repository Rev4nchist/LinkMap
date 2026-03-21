/**
 * search.js — Fuzzy search UI for the side panel.
 *
 * Flattens the tree into a filtered list of matching tabs with highlighted
 * characters. Clearing or pressing Escape restores the normal tree view.
 */

import { smartSearch, el, debounce } from '../../shared/utils.js';
import { SEARCH_DEBOUNCE_MS } from '../../shared/constants.js';
import { DEFAULT_FAVICON, getFaviconUrl } from '../../shared/constants.js';

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

  // Aria-live region for screen reader announcements
  const liveRegion = document.createElement('div');
  liveRegion.setAttribute('aria-live', 'polite');
  liveRegion.setAttribute('aria-atomic', 'true');
  liveRegion.className = 'sr-only';
  if (inputEl.parentElement) {
    inputEl.parentElement.appendChild(liveRegion);
  }

  const doSearch = debounce((query) => {
    if (!query.trim()) {
      exitSearch();
      liveRegion.textContent = '';
      return;
    }

    const state = getState();
    if (!state) return;

    isSearching = true;
    const results = searchTabs(state.tabs, query);
    renderSearchResults(results, treeContainer);

    // Announce results to screen readers
    liveRegion.textContent = results.length === 0
      ? 'No matching tabs'
      : `${results.length} tab${results.length === 1 ? '' : 's'} found`;
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
    treeContainer.classList.remove('search-results');
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
 * Search all tabs by title and URL using tiered smart search.
 * URL matches are weighted lower than title matches to keep results relevant.
 * Returns sorted array of { tab, tabId, titleMatch, urlMatch, bestScore }.
 * @param {Object} tabs - map of tabId -> tab objects
 * @param {string} query - search query
 * @returns {Array}
 */
export function searchTabs(tabs, query) {
  const results = [];

  for (const [tabId, tab] of Object.entries(tabs)) {
    const titleResult = smartSearch(query, tab.title || '');
    const urlResult = smartSearch(query, tab.url || '');

    // URL results weighted lower; domain-level matches (prefix/word-boundary) stay higher
    let adjustedUrlScore = urlResult.score * 0.6;
    if (urlResult.tier === 'prefix' || urlResult.tier === 'word-boundary') {
      adjustedUrlScore = urlResult.score * 0.8;
    }

    const bestScore = Math.max(titleResult.score, adjustedUrlScore);

    if (titleResult.match || urlResult.match) {
      results.push({
        tab,
        tabId: Number(tabId),
        titleMatch: titleResult,
        urlMatch: urlResult,
        bestScore,
      });
    }
  }

  // Sort by score descending, then by title length ascending (shorter = more relevant)
  results.sort((a, b) => {
    if (b.bestScore !== a.bestScore) return b.bestScore - a.bestScore;
    return (a.tab.title || '').length - (b.tab.title || '').length;
  });

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
      src: getFaviconUrl(tab),
      width: '16',
      height: '16',
      alt: ''
    });
    // Fallback for broken favicons
    favicon.onerror = () => { favicon.src = DEFAULT_FAVICON; favicon.onerror = null; };

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
      draggable: 'true',
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
