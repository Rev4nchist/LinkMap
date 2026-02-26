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
  COLLAPSE_ALL: 'COLLAPSE_ALL',
  EXPAND_ALL: 'EXPAND_ALL',
  FOCUS_MODE: 'FOCUS_MODE',
  SET_THEME: 'SET_THEME',
  SET_GROUP_COLOR: 'SET_GROUP_COLOR',
  PIN_TAB: 'PIN_TAB',
  DUPLICATE_TAB: 'DUPLICATE_TAB',
  MUTE_TAB: 'MUTE_TAB',
};

// Storage
export const STORAGE_KEY = 'linkmap_state';
export const STORAGE_VERSION = 1;

// Themes — August Suite (10 dark themes)
export const THEMES = [
  'august-default', 'midnight-mars', 'deep-forest', 'oceanic-depth',
  'palenight', 'espresso', 'cyberpunk-dim', 'nord-darker',
  'dracula-soft', 'oled-void',
];
export const DEFAULT_THEME = 'august-default';

// Chrome tab group color name -> hex map
export const CHROME_GROUP_COLORS = {
  grey:   '#5f6368',
  blue:   '#8ab4f8',
  red:    '#f28b82',
  yellow: '#fdd663',
  green:  '#81c995',
  pink:   '#ff8bcb',
  purple: '#c58af9',
  cyan:   '#78d9ec',
  orange: '#fcad70',
};

// Timing
export const SAVE_DEBOUNCE_MS = 500;
export const SEARCH_DEBOUNCE_MS = 150;
export const UI_DEBOUNCE_MS = 100;
