/**
 * Smart Mapper — Theme to Chrome Group Color Sync
 *
 * When a theme is activated, updates all Chrome tab groups to the nearest
 * Chrome color enum matching the theme's accent color.
 */

import { THEME_ACCENTS } from '../shared/constants.js';
import { nearestChromeGroupColor } from '../shared/color-distance.js';

/**
 * Syncs Chrome tab group colors to match the active theme's accent.
 * @param {string} themeName
 */
export async function syncGroupColorsToTheme(themeName) {
  const accentHex = THEME_ACCENTS[themeName];
  if (!accentHex) return;

  const chromeColor = nearestChromeGroupColor(accentHex);

  try {
    const groups = await chrome.tabGroups.query({});
    for (const group of groups) {
      if (group.color !== chromeColor) {
        chrome.tabGroups.update(group.id, { color: chromeColor }).catch(() => {});
      }
    }
  } catch (_e) {
    // No groups or API not available.
  }
}
