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
  MOVE_TO_GROUP: 'MOVE_TO_GROUP',
  TOGGLE_COLLAPSE: 'TOGGLE_COLLAPSE',
  COLLAPSE_ALL: 'COLLAPSE_ALL',
  EXPAND_ALL: 'EXPAND_ALL',
  FOCUS_MODE: 'FOCUS_MODE',
  SET_THEME: 'SET_THEME',
  SET_GROUP_COLOR: 'SET_GROUP_COLOR',
  PIN_TAB: 'PIN_TAB',
  DUPLICATE_TAB: 'DUPLICATE_TAB',
  MUTE_TAB: 'MUTE_TAB',
  SAVE_GROUP: 'SAVE_GROUP',
  MOVE_GROUP: 'MOVE_GROUP',
  RENAME_GROUP: 'RENAME_GROUP',
  TOGGLE_GROUP_COLLAPSE: 'TOGGLE_GROUP_COLLAPSE',
  NEW_TAB_BELOW: 'NEW_TAB_BELOW',
  NEW_TAB_IN_GROUP: 'NEW_TAB_IN_GROUP',
  UNGROUP_TAB: 'UNGROUP_TAB',
  DISCARD_TABS: 'DISCARD_TABS',
  RELOAD_TAB: 'RELOAD_TAB',
  MOVE_TO_NEW_WINDOW: 'MOVE_TO_NEW_WINDOW',
  RENAME_WINDOW: 'RENAME_WINDOW',
  REORDER_PINNED: 'REORDER_PINNED',

  // Duplicate detection
  CLOSE_DUPLICATES: 'CLOSE_DUPLICATES',

  // Settings
  GET_SETTINGS: 'GET_SETTINGS',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',

  // Auto-grouping rules
  GET_AUTO_GROUP_RULES: 'GET_AUTO_GROUP_RULES',
  SET_AUTO_GROUP_RULES: 'SET_AUTO_GROUP_RULES',

  // Cross-device
  GET_OTHER_DEVICES: 'GET_OTHER_DEVICES',

  // Workspaces
  CREATE_WORKSPACE: 'CREATE_WORKSPACE',
  SWITCH_WORKSPACE: 'SWITCH_WORKSPACE',
  DELETE_WORKSPACE: 'DELETE_WORKSPACE',
  RENAME_WORKSPACE: 'RENAME_WORKSPACE',
  UPDATE_WORKSPACE: 'UPDATE_WORKSPACE',
  GET_WORKSPACES: 'GET_WORKSPACES',
  MOVE_TO_WORKSPACE: 'MOVE_TO_WORKSPACE',

  // Tab notes
  SET_TAB_NOTE: 'SET_TAB_NOTE',

  // Multi-select
  MULTI_CLOSE: 'MULTI_CLOSE',
  MULTI_GROUP: 'MULTI_GROUP',
  MULTI_SLEEP: 'MULTI_SLEEP',

  // Bookmarks
  SAVE_TREE_AS_BOOKMARKS: 'SAVE_TREE_AS_BOOKMARKS',
  OPEN_BOOKMARK_FOLDER: 'OPEN_BOOKMARK_FOLDER',

  // Session management
  SAVE_SESSION: 'SAVE_SESSION',
  RESTORE_SESSION: 'RESTORE_SESSION',
  RESTORE_SESSION_WINDOW: 'RESTORE_SESSION_WINDOW',
  DELETE_SESSION: 'DELETE_SESSION',
  GET_SESSIONS: 'GET_SESSIONS',
  UNDO_CLOSE: 'UNDO_CLOSE',
  GET_RECENTLY_CLOSED: 'GET_RECENTLY_CLOSED',

  // Internal signals
  CRASH_RECOVERY: 'CRASH_RECOVERY',
  FOCUS_SEARCH: 'FOCUS_SEARCH',
};

// Storage
export const STORAGE_KEY = 'linkmap_state';
export const STORAGE_VERSION = 1;

// chrome.storage.session marker used to distinguish a genuine cold browser
// restart (tab ids reassigned; storage.session cleared) from a routine
// service-worker suspend/wake (storage.session survives; tab ids still
// valid). See background.js init() and ShadowState#reconcileWithLiveTabs.
export const SW_SESSION_KEY = 'linkmap_sw_session';

// Themes — August Suite (10) + Cyberpunk Suite (5)
export const THEMES = [
  'august-default', 'midnight-mars', 'deep-forest', 'oceanic-depth',
  'palenight', 'espresso', 'cyberpunk-dim', 'nord-darker',
  'dracula-soft', 'oled-void',
  'arasaka-executive', 'netrunner', 'synthwave-sunset',
  'toxic-district', 'cyberpsychosis',
];
export const DEFAULT_THEME = 'august-default';

// Theme accent colors — used by the Smart Mapper for group color sync
export const THEME_ACCENTS = {
  'august-default':    '#c084fc',
  'midnight-mars':     '#f87171',
  'deep-forest':       '#34d399',
  'oceanic-depth':     '#38bdf8',
  'palenight':         '#c792ea',
  'espresso':          '#d97706',
  'cyberpunk-dim':     '#f472b6',
  'nord-darker':       '#88c0d0',
  'dracula-soft':      '#bd93f9',
  'oled-void':         '#ffffff',
  'arasaka-executive': '#ffd700',
  'netrunner':         '#00f3ff',
  'synthwave-sunset':  '#ff00ff',
  'toxic-district':    '#39ff14',
  'cyberpsychosis':    '#ff00ff',
};

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

// Sentinel value for tabs not in any group
export const UNGROUPED_GROUP_ID = -1;

// Default favicon for tabs with missing or empty favIconUrl
export const DEFAULT_FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
  '<circle cx="8" cy="8" r="6" fill="#666"/>' +
  '</svg>'
);

/**
 * Returns the best favicon URL for a tab.
 *
 * When tab.favIconUrl is empty, falls back to Chrome's ON-DEVICE favicon cache
 * via the extension's /_favicon/ route (requires the "favicon" permission).
 * This replaced a Google S2 favicon fallback that sent every visited domain to
 * google.com on render — a privacy leak contradicting the local-only promise
 * (SM-1). No network egress now; DEFAULT_FAVICON is the ultimate fallback.
 *
 * @param {Object} tab - TabNode with favIconUrl and url properties
 * @returns {string}
 */
export function getFaviconUrl(tab) {
  if (tab.favIconUrl) return tab.favIconUrl;
  let protocol;
  try {
    protocol = new URL(tab.url).protocol;
  } catch {
    return DEFAULT_FAVICON;
  }
  if (protocol === 'http:' || protocol === 'https:' || protocol === 'file:') {
    try {
      return chrome.runtime.getURL(
        `/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`
      );
    } catch { /* chrome.runtime unavailable — fall through to default */ }
  }
  return DEFAULT_FAVICON;
}

// Saved groups storage key
export const SAVED_GROUPS_KEY = 'linkmap_saved_groups';

// Session storage
export const SESSIONS_KEY = 'linkmap_sessions';
export const AUTO_SAVE_INTERVAL_MINUTES = 5;
export const AUTO_ARCHIVE_CHECK_INTERVAL_MINUTES = 5;
export const MAX_AUTO_SAVES = 10;

// Auto-grouping rules storage
export const AUTO_GROUP_RULES_KEY = 'linkmap_auto_group_rules';

// Workspaces storage
export const WORKSPACES_KEY = 'linkmap_workspaces';

// Tab notes storage
export const TAB_NOTES_KEY = 'linkmap_tab_notes';

// Settings storage
export const SETTINGS_KEY = 'linkmap_settings';

// Timing
export const SAVE_DEBOUNCE_MS = 500;
export const SEARCH_DEBOUNCE_MS = 150;
export const UI_DEBOUNCE_MS = 100;
export const SUPPRESS_COLLAPSE_MS = 200;
export const SUPPRESS_TITLE_MS = 300;
export const CONTEXT_MENU_DELAY_MS = 150;
export const SESSION_REFRESH_DELAY_MS = 300;
export const RETRY_GROUP_TITLE_DELAYS = [2000, 4000, 8000];

// Orphaned-group quarantine (survives progressive session restore instead of
// hard-deleting groups whose live counterpart hasn't appeared yet).
export const ORPHANED_GROUP_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const ORPHANED_GROUP_CAP = 40;
