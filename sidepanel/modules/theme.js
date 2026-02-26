import { THEMES, DEFAULT_THEME } from '../../shared/constants.js';

/**
 * Apply a theme to the document.
 * @param {string} themeName - One of THEMES array values
 */
export function applyTheme(themeName) {
  if (!THEMES.includes(themeName)) {
    console.warn(`[LinkMap] Unknown theme "${themeName}", falling back to ${DEFAULT_THEME}`);
    themeName = DEFAULT_THEME;
  }
  document.documentElement.dataset.theme = themeName;
}

/**
 * Get the currently applied theme name.
 * @returns {string}
 */
export function getCurrentTheme() {
  return document.documentElement.dataset.theme || DEFAULT_THEME;
}

/**
 * Get list of available themes.
 * @returns {string[]}
 */
export function getThemeList() {
  return [...THEMES];
}

/**
 * Initialize theme from state and sync the select element.
 * @param {string} themeName
 * @param {HTMLSelectElement|null} selectElement
 */
export function initTheme(themeName, selectElement) {
  applyTheme(themeName || DEFAULT_THEME);
  if (selectElement) {
    selectElement.value = getCurrentTheme();
  }
}
