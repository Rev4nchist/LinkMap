/**
 * Visit Frequency (chrome.history)
 *
 * Cached visit count lookups and frequency tier computation.
 */

/** Cache of visit counts per URL to avoid repeated history lookups */
const visitCountCache = new Map();

/**
 * Gets visit frequency for a URL from chrome.history.
 * Results are cached to avoid excessive API calls.
 * @param {string} url
 * @returns {Promise<number>}
 */
export async function getVisitCount(url) {
  if (!url) return 0;
  const cached = visitCountCache.get(url);
  if (cached && Date.now() - cached.time < 300000) return cached.count;

  try {
    const visits = await chrome.history.getVisits({ url });
    const count = visits.length;
    // Cap cache at 500 entries — evict oldest when exceeded
    if (visitCountCache.size >= 500) {
      const oldest = visitCountCache.keys().next().value;
      visitCountCache.delete(oldest);
    }
    visitCountCache.set(url, { count, time: Date.now() });
    return count;
  } catch {
    return 0;
  }
}

/**
 * Computes visit frequency tiers for all open tabs.
 * Returns a map of tabId -> { count, tier } where tier is 'hot', 'warm', 'normal'.
 * @param {Object} state - ShadowState instance with .tabs Map
 * @returns {Promise<Object>}
 */
export async function computeVisitFrequencies(state) {
  const result = {};
  const promises = [];

  for (const [tabId, node] of state.tabs) {
    if (!node.url) continue;
    promises.push(
      getVisitCount(node.url).then(count => {
        let tier = 'normal';
        if (count >= 20) tier = 'hot';
        else if (count >= 5) tier = 'warm';
        result[tabId] = { count, tier };
      })
    );
  }

  await Promise.all(promises);
  return result;
}
