# LinkMap - Project Instructions

## Overview
Chrome Extension: Vertical Tabs & Link Map with tree-style visualization and deep theming engine. Side-panel UX.

## Stack
- Chrome Extension (Manifest V3)
- Vanilla JavaScript (ES Modules) — no framework, no build step
- CSS Custom Properties for theming
- Side Panel API

## Project Structure
```
manifest.json           # Extension manifest (MV3)
background.js           # Service worker — Shadow State, tab events
shared/
  shadow-state.js       # ShadowState class (tree data structure)
  constants.js          # Message types, storage keys
  utils.js              # Debounce, fuzzy match, helpers
sidepanel/
  sidepanel.html        # Side panel HTML shell
  sidepanel.js          # Entry — messaging, render orchestration
  modules/
    tree-renderer.js    # Shadow State → DOM tree
    search.js           # Fuzzy search + filtered rendering
    drag-drop.js        # SortableJS or HTML5 DnD
    theme.js            # Theme switching + persistence
    context-menu.js     # Right-click menu
    tab-actions.js      # Click, close, pin, mute
  styles/
    base.css            # Reset, layout, scrollbar
    themes.css          # 4 dark theme variable sets
    tree.css            # Tree lines, indentation
    search.css          # Search bar
    context-menu.css    # Context menu
icons/                  # Extension icons (16, 32, 48, 128)
vendor/                 # SortableJS (if not CDN)
```

## Grep Patterns
- Use single identifiers: `newTabBelow`, `commitTreeChange`, `MSG.NEW_TAB`
- Avoid multi-word OR patterns like `New Tab Below|newTabBelow|addTab` — the smart-search-router hook classifies 3+ word phrases as semantic queries and blocks them
- When searching for a concept, run multiple simple greps in parallel instead of one complex pattern

## Dev Workflow
- No build step — load as unpacked extension in `chrome://extensions`
- Debug side panel: right-click → Inspect
- Debug background: click "Service Worker" link in extensions page

## Key Decisions
- Manifest V3 (required for Chrome Web Store)
- Side Panel API for tab management UI
- Vanilla JS with ES Modules — lightweight, no bundler
- CSS custom properties for hot-swappable theming
- Shadow State pattern — background service worker owns the tree, side panel is a dumb renderer
- `chrome.storage.local` for persistence with debounced writes
