/**
 * Domain-Based Auto-Grouping
 *
 * Rule-based tab grouping: matches tab URLs against patterns
 * and automatically assigns them to Chrome tab groups.
 */

import { AUTO_GROUP_RULES_KEY } from '../shared/constants.js';

/**
 * Validates a single auto-group rule to ensure it has the expected shape and safe values.
 * @param {unknown} rule
 * @returns {boolean}
 */
export function validateRule(rule) {
  return (
    rule !== null &&
    typeof rule === 'object' &&
    typeof rule.pattern === 'string' &&
    rule.pattern.length > 0 &&
    rule.pattern.length < 500 &&
    typeof rule.group === 'string' &&
    rule.group.length > 0 &&
    (!rule.color || typeof rule.color === 'string')
  );
}

/**
 * Matches a URL against a domain pattern.
 * Supports: "github.com", "*.google.com", "github.com/*"
 * @param {string} url
 * @param {string} pattern
 * @returns {boolean}
 */
export function urlMatchesPattern(url, pattern) {
  try {
    const u = new URL(url);
    const hostname = u.hostname;

    // Wildcard subdomain: *.example.com
    if (pattern.startsWith('*.')) {
      const domain = pattern.slice(2);
      return hostname === domain || hostname.endsWith('.' + domain);
    }

    // Exact domain or domain with path wildcard — no subdomain matching
    const patternDomain = pattern.replace(/\/\*$/, '');
    return hostname === patternDomain;
  } catch {
    return false;
  }
}

/**
 * Creates auto-grouping functions bound to mutable rules state.
 * @param {boolean} DEBUG - verbose logging flag
 * @returns {Object} Auto-grouping API
 */
export function createAutoGrouper(DEBUG) {
  /** @type {Array<{pattern: string, group: string, color: string}>} */
  let autoGroupRules = [];

  // Serializes concurrent applyAutoGroupRules calls to prevent duplicate group creation.
  let autoGroupLock = Promise.resolve();

  async function loadAutoGroupRules() {
    try {
      const result = await chrome.storage.local.get(AUTO_GROUP_RULES_KEY);
      autoGroupRules = (result[AUTO_GROUP_RULES_KEY] || []).filter(validateRule);
    } catch (err) {
      console.warn('[LinkMap] loadAutoGroupRules failed:', err);
    }
  }

  async function saveAutoGroupRules() {
    try {
      await chrome.storage.local.set({ [AUTO_GROUP_RULES_KEY]: autoGroupRules });
    } catch (err) {
      console.error('[LinkMap] saveAutoGroupRules failed:', err);
    }
  }

  /**
   * Checks if a tab URL matches any auto-group rule and groups it accordingly.
   * @param {Object} tab - Chrome tab object
   */
  function applyAutoGroupRules(tab) {
    autoGroupLock = autoGroupLock.then(() => _applyAutoGroupRulesImpl(tab)).catch(() => {});
    return autoGroupLock;
  }

  async function _applyAutoGroupRulesImpl(tab) {
    if (!tab.url || autoGroupRules.length === 0) return;
    if (tab.pinned) return;

    for (const rule of autoGroupRules) {
      if (urlMatchesPattern(tab.url, rule.pattern)) {
        try {
          // Find or create the target group
          const existingGroups = await chrome.tabGroups.query({});
          let targetGroup = existingGroups.find(g => g.title === rule.group);

          if (targetGroup) {
            await chrome.tabs.group({ tabIds: [tab.id], groupId: targetGroup.id });
          } else {
            const newGroupId = await chrome.tabs.group({ tabIds: [tab.id] });
            await chrome.tabGroups.update(newGroupId, {
              title: rule.group,
              color: rule.color || 'grey',
            });
          }

          DEBUG && console.log(`[LinkMap] Auto-grouped tab "${tab.title}" into "${rule.group}"`);
        } catch (err) {
          console.error('[LinkMap] Auto-group failed:', err);
        }
        break; // first matching rule wins
      }
    }
  }

  function getRules() { return autoGroupRules; }

  function setRules(rules) {
    autoGroupRules = Array.isArray(rules) ? rules.filter(validateRule) : [];
    saveAutoGroupRules();
  }

  return {
    loadAutoGroupRules,
    saveAutoGroupRules,
    applyAutoGroupRules,
    getRules,
    setRules,
  };
}
