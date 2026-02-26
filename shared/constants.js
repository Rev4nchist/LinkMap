// Message types: Background <-> Side Panel
export const MSG = {
  // Background -> Side Panel
  STATE_UPDATE: 'STATE_UPDATE',
  TAB_ACTIVATED: 'TAB_ACTIVATED',
  THEME_CHANGED: 'THEME_CHANGED',

  // Side Panel -> Background
  GET_STATE: 'GET_STATE',
  ACTIVATE_TAB: 'ACTIVATE_TAB',
  CLOSE_TAB: 'CLOSE_TAB',
  CLOSE_TABS: 'CLOSE_TABS',
  MOVE_TAB: 'MOVE_TAB',
  TOGGLE_COLLAPSE: 'TOGGLE_COLLAPSE',
  SET_THEME: 'SET_THEME',
  SET_GROUP_COLOR: 'SET_GROUP_COLOR',
  PIN_TAB: 'PIN_TAB',
  DUPLICATE_TAB: 'DUPLICATE_TAB',
  MUTE_TAB: 'MUTE_TAB',
};

// Storage
export const STORAGE_KEY = 'linkmap_state';
export const STORAGE_VERSION = 1;

// Themes
export const THEMES = ['midnight', 'oled', 'dracula', 'nord'];
export const DEFAULT_THEME = 'midnight';

// Timing
export const SAVE_DEBOUNCE_MS = 500;
export const SEARCH_DEBOUNCE_MS = 150;
export const UI_DEBOUNCE_MS = 100;
