/**
 * Duplicate Tab Detection
 *
 * URL normalization and duplicate detection logic.
 * Operates on the shared state object passed via factory function.
 */

/**
 * Normalizes a URL for duplicate comparison.
 * Strips trailing slashes, fragments, and common tracking params.
 * @param {string} url
 * @returns {string}
 */
export function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    // Skip internal Chrome pages
    if (u.protocol === 'chrome:' || u.protocol === 'chrome-extension:' || u.protocol === 'about:') {
      return '';
    }
    // Remove tracking params
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid', 'gclid'];
    for (const p of trackingParams) u.searchParams.delete(p);
    u.searchParams.sort();
    // Remove fragment
    u.hash = '';
    // Remove trailing slash
    let path = u.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return `${u.origin}${path}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * Creates duplicate detection functions bound to a state getter.
 * @param {Function} getState - getter returning current ShadowState instance with .tabs Map
 * @returns {Object} Duplicate detection API
 */
export function createDuplicateDetector(getState) {
  let _duplicateMapCache = null;
  let _duplicateMapDirty = true;

  function invalidateDuplicateMap() { _duplicateMapDirty = true; }

  /**
   * Finds duplicate tab IDs for a given URL (tabs sharing the same normalized URL).
   * @param {string} url
   * @returns {number[]} Array of tab IDs that share this URL
   */
  function findDuplicateTabIds(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return [];

    const matches = [];
    for (const [tabId, node] of getState().tabs) {
      if (normalizeUrl(node.url) === normalized) {
        matches.push(tabId);
      }
    }
    return matches;
  }

  /**
   * Computes the full duplicate map: normalized URL -> [tabId, ...].
   * Only includes URLs with 2+ tabs.
   * @returns {Object<string, number[]>}
   */
  function getDuplicateMap() {
    if (!_duplicateMapDirty && _duplicateMapCache) return _duplicateMapCache;
    const urlMap = {};
    for (const [tabId, node] of getState().tabs) {
      const norm = normalizeUrl(node.url);
      if (!norm) continue;
      if (!urlMap[norm]) urlMap[norm] = [];
      urlMap[norm].push(tabId);
    }
    // Filter to only duplicates
    const result = {};
    for (const [url, ids] of Object.entries(urlMap)) {
      if (ids.length > 1) result[url] = ids;
    }
    _duplicateMapCache = result;
    _duplicateMapDirty = false;
    return result;
  }

  return { invalidateDuplicateMap, findDuplicateTabIds, getDuplicateMap };
}
