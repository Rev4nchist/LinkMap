# Tasks: LinkMap — Vertical Tabs & Link Map Chrome Extension

## Relevant Files

- `manifest.json` — Extension manifest (MV3, permissions, service worker, side panel)
- `background.js` — Service worker: tab event listeners, Shadow State management, messaging
- `shared/shadow-state.js` — ShadowState class: tree data structure, mutations, serialization
- `shared/constants.js` — Message types, storage keys, theme names
- `shared/utils.js` — Debounce, fuzzy match, DOM helpers
- `sidepanel/sidepanel.html` — Side panel HTML shell
- `sidepanel/sidepanel.js` — Side panel entry: message handler, state receiver, render orchestrator
- `sidepanel/modules/tree-renderer.js` — Converts Shadow State to DOM tree with indentation/lines
- `sidepanel/modules/search.js` — Fuzzy search UI and filtering logic
- `sidepanel/modules/drag-drop.js` — Drag & drop via SortableJS or HTML5 DnD
- `sidepanel/modules/theme.js` — Theme switching, CSS variable management
- `sidepanel/modules/context-menu.js` — Right-click context menu
- `sidepanel/modules/tab-actions.js` — Click, close, pin, mute, duplicate handlers
- `sidepanel/styles/base.css` — Reset, layout, scrollbar, typography
- `sidepanel/styles/themes.css` — All 4 theme CSS variable definitions
- `sidepanel/styles/tree.css` — Tree lines, indentation, hover, active states
- `sidepanel/styles/search.css` — Search bar styles
- `sidepanel/styles/context-menu.css` — Context menu styles
- `icons/icon-16.png` — Extension icon 16px
- `icons/icon-32.png` — Extension icon 32px
- `icons/icon-48.png` — Extension icon 48px
- `icons/icon-128.png` — Extension icon 128px
- `vendor/sortable.min.js` — SortableJS library (if not using CDN)

### Notes

- This is a vanilla JS project with ES Modules — no build step, no bundler
- Test via Chrome developer mode: `chrome://extensions` → Load unpacked
- Side panel debugging: right-click the side panel → Inspect

## Instructions for Completing Tasks

**IMPORTANT:** As you complete each task, you must check it off in this markdown file by changing `- [ ]` to `- [x]`. This helps track progress and ensures you don't skip any steps.

Example:
- `- [ ] 1.1 Read file` → `- [x] 1.1 Read file` (after completing)

Update the file after completing each sub-task, not just after completing an entire parent task.

## Tasks

- [ ] 0.0 Create feature branch
  - [ ] 0.1 Create and checkout branch: `git checkout -b feature/linkmap-v1`

- [ ] 1.0 Extension scaffold & manifest
  - [ ] 1.1 Create directory structure: `icons/`, `shared/`, `sidepanel/modules/`, `sidepanel/styles/`, `vendor/`
  - [ ] 1.2 Create `manifest.json` with MV3 config: permissions (`tabs`, `sidePanel`, `storage`, `tabGroups`), service worker (`background.js` type module), side panel (`sidepanel/sidepanel.html`), action button, icons
  - [ ] 1.3 Create placeholder icon PNGs (16, 32, 48, 128) — simple colored square or letter "L"
  - [ ] 1.4 Create `shared/constants.js` — export message types (`STATE_UPDATE`, `TAB_ACTIVATED`, `GET_STATE`, `ACTIVATE_TAB`, `CLOSE_TAB`, `MOVE_TAB`, `TOGGLE_COLLAPSE`, `SET_THEME`, `SET_GROUP_COLOR`, etc.), storage key (`linkmap_state`), theme names array
  - [ ] 1.5 Create `shared/utils.js` — export `debounce(fn, ms)`, `generateId()`, DOM helper `el(tag, attrs, children)`
  - [ ] 1.6 Create minimal `background.js` — imports constants, logs "LinkMap background started", registers `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`
  - [ ] 1.7 Create minimal `sidepanel/sidepanel.html` — HTML5 boilerplate, links CSS files, loads `sidepanel.js` as module, has container divs for header/tree/footer
  - [ ] 1.8 Create minimal `sidepanel/sidepanel.js` — logs "Side panel loaded", sends `GET_STATE` message to background
  - [ ] 1.9 Verify: Load extension in Chrome dev mode, click icon, side panel opens with blank page, console shows log messages from both background and side panel

- [ ] 2.0 Shadow State data layer
  - [ ] 2.1 Create `shared/shadow-state.js` — implement `ShadowState` class with `tabs` Map, `rootIds` array, `collapsed` Set, `groupColors` object, `theme` string
  - [ ] 2.2 Implement `addTab(tabId, node)` — adds to Map, updates parent's children array or pushes to rootIds
  - [ ] 2.3 Implement `removeTab(tabId)` — reparents children to grandparent (or root), removes from parent's children array, removes from rootIds if applicable
  - [ ] 2.4 Implement `moveTab(tabId, newParentId, index)` — removes from old parent, adds to new parent at index, updates rootIds
  - [ ] 2.5 Implement `updateTab(tabId, changes)` — merges partial updates (title, url, favicon, status, etc.)
  - [ ] 2.6 Implement `toggleCollapse(tabId)` — toggles collapsed Set membership
  - [ ] 2.7 Implement query methods: `getChildren(tabId)`, `getDescendants(tabId)` (recursive), `getRoots()`, `getTab(tabId)`
  - [ ] 2.8 Implement `toSerializable()` — converts Map/Set to plain objects for `chrome.storage.local`
  - [ ] 2.9 Implement `static fromStorage(data)` — reconstructs ShadowState from serialized data
  - [ ] 2.10 Implement `reconcileWithLiveTabs(liveTabs)` — removes dead tabs, adds new tabs at root, updates metadata from live data
  - [ ] 2.11 Verify: Import ShadowState in background.js, create instance, add/remove/move tabs in console, confirm tree integrity

- [ ] 3.0 Background service worker — tab event handling
  - [ ] 3.1 Initialize ShadowState instance on service worker start
  - [ ] 3.2 Implement startup reconciliation: load from `chrome.storage.local` → query live tabs → `reconcileWithLiveTabs()`
  - [ ] 3.3 Handle `chrome.tabs.onCreated` — create TabNode from tab info, use `openerTabId` as parentId (or null), add to state
  - [ ] 3.4 Handle `chrome.tabs.onRemoved` — call `removeTab()`, which reparents children
  - [ ] 3.5 Handle `chrome.tabs.onUpdated` — update title, url, favIconUrl, status, audible, pinned via `updateTab()`
  - [ ] 3.6 Handle `chrome.tabs.onMoved` — update tab index in state
  - [ ] 3.7 Handle `chrome.tabs.onActivated` — track active tabId, broadcast `TAB_ACTIVATED`
  - [ ] 3.8 Handle `chrome.tabs.onAttached` / `onDetached` — handle tab moving between windows (v1: remove if detached to another window)
  - [ ] 3.9 Implement debounced save — after every state mutation, debounce 500ms, then `chrome.storage.local.set({ linkmap_state: state.toSerializable() })`
  - [ ] 3.10 Implement message handler (`chrome.runtime.onMessage`) — respond to `GET_STATE` with full serialized state, handle `ACTIVATE_TAB`, `CLOSE_TAB`, `MOVE_TAB`, `TOGGLE_COLLAPSE`, `SET_THEME`, `SET_GROUP_COLOR`, `PIN_TAB`, `DUPLICATE_TAB`, `MUTE_TAB`
  - [ ] 3.11 Implement state broadcast — after mutations, send `STATE_UPDATE` to side panel via `chrome.runtime.sendMessage()` (wrap in try/catch since panel may be closed)
  - [ ] 3.12 Verify: Open extension, open/close/navigate tabs, check that background console shows correct state updates. Restart browser, verify tree restores.

- [ ] 4.0 Side panel — tree rendering
  - [ ] 4.1 Create `sidepanel/modules/tree-renderer.js` — export `renderTree(state, container)` function
  - [ ] 4.2 Implement recursive tree DOM builder — for each root tab, create tab element, recursively render children with increasing indent level
  - [ ] 4.3 Tab element structure: favicon img, title text, URL (truncated, muted), close button, collapse chevron (if has children)
  - [ ] 4.4 Visual tree lines — CSS `border-left` on children containers, `::before` pseudo-element for branch connectors (├─ and └─)
  - [ ] 4.5 Active tab highlight — add `data-active` attribute, style with `--bg-active` variable
  - [ ] 4.6 Loading state — show spinner icon when `tab.status === 'loading'`
  - [ ] 4.7 Audible indicator — show speaker icon when `tab.audible === true`
  - [ ] 4.8 Pinned tabs section — render pinned tabs in a separate container above the tree
  - [ ] 4.9 Wire up message listener in `sidepanel.js` — on `STATE_UPDATE`, call `renderTree()` with new state
  - [ ] 4.10 Wire up `GET_STATE` response — initial render on side panel open
  - [ ] 4.11 Implement collapse/expand — click chevron sends `TOGGLE_COLLAPSE` to background, re-render hides children of collapsed nodes
  - [ ] 4.12 Verify: Open side panel, tabs appear in tree structure, new tabs nest correctly under parents, collapse/expand works, active tab highlighted

- [ ] 5.0 Tab actions & interactions
  - [ ] 5.1 Create `sidepanel/modules/tab-actions.js` — export click handlers
  - [ ] 5.2 Click tab → send `ACTIVATE_TAB` → Chrome switches to that tab
  - [ ] 5.3 Click close button → send `CLOSE_TAB` → tab closes, tree updates
  - [ ] 5.4 Middle-click tab → same as close
  - [ ] 5.5 Create `sidepanel/modules/context-menu.js` — custom right-click menu
  - [ ] 5.6 Context menu options: Close, Close Other Tabs, Close Tabs to Right, Duplicate, Pin/Unpin, Mute/Unmute
  - [ ] 5.7 Style context menu with theme variables, position near cursor, dismiss on click outside
  - [ ] 5.8 Verify: All tab actions work correctly, context menu appears and functions

- [ ] 6.0 Theming engine
  - [ ] 6.1 Create `sidepanel/styles/themes.css` — define CSS custom properties for all 4 themes using `[data-theme="name"]` selectors (Midnight, OLED, Dracula, Nord)
  - [ ] 6.2 Create `sidepanel/styles/base.css` — reset, box-sizing, body uses `var(--bg-primary)`, text uses `var(--text-primary)`, scrollbar uses vars
  - [ ] 6.3 Create `sidepanel/modules/theme.js` — export `setTheme(name)`, `getCurrentTheme()`, `getThemeList()`
  - [ ] 6.4 `setTheme()` implementation: set `data-theme` attribute on `document.documentElement`, send `SET_THEME` to background for persistence
  - [ ] 6.5 Theme selector UI — dropdown or segmented control in the side panel footer/settings area
  - [ ] 6.6 On panel load, apply saved theme from state before first render (prevent flash)
  - [ ] 6.7 Verify: Switch between all 4 themes, colors change instantly, preference survives panel close/reopen and browser restart

- [ ] 7.0 Search
  - [ ] 7.1 Create `sidepanel/modules/search.js` — export `initSearch(container, onResults, onClear)`
  - [ ] 7.2 Implement fuzzy match function in `shared/utils.js` — match characters in order (not necessarily adjacent), return score and match indices
  - [ ] 7.3 Search input in header — styled with theme variables, placeholder "Search tabs..."
  - [ ] 7.4 On input (debounced 150ms), filter all tabs by fuzzy match against title + URL
  - [ ] 7.5 Render results as flat list (not tree) with match characters highlighted (bold or colored)
  - [ ] 7.6 Click result → `ACTIVATE_TAB`, clear search, restore tree
  - [ ] 7.7 Escape key or clear button → restore tree view
  - [ ] 7.8 Verify: Type partial tab title, matching tabs appear, non-matches hidden, click switches to tab, escape restores tree

- [ ] 8.0 Drag & drop
  - [ ] 8.1 Create `sidepanel/modules/drag-drop.js` — export `initDragDrop(container, onReorder, onReparent)`
  - [ ] 8.2 Choose approach: SortableJS (download to `vendor/` or CDN link) or native HTML5 DnD
  - [ ] 8.3 Implement reorder — drag tab to new position within same level, show insertion line indicator
  - [ ] 8.4 Implement reparent — drag tab onto another tab (hover 500ms or drop on target), show highlight indicator, nest as child
  - [ ] 8.5 On drop: send `MOVE_TAB` message to background with `{ tabId, newParentId, index }`
  - [ ] 8.6 Background handles `MOVE_TAB` — update ShadowState, save, broadcast
  - [ ] 8.7 Verify: Drag tab to reorder, drag tab onto another to nest it, tree updates correctly, persists after restart

- [ ] 9.0 Tab group color customization
  - [ ] 9.1 Detect tab groups via `tab.groupId` — render group header/divider in tree
  - [ ] 9.2 Settings UI: color picker input for each active group
  - [ ] 9.3 Save group colors via `SET_GROUP_COLOR` → stored in ShadowState → persisted
  - [ ] 9.4 Apply group colors as CSS variables or inline styles on group headers and tab backgrounds
  - [ ] 9.5 Verify: Create tab group in Chrome, color appears in side panel, custom color overrides default

- [ ] 10.0 Polish & final verification
  - [ ] 10.1 Ensure all styles are consistent across themes (no hardcoded colors)
  - [ ] 10.2 Test with 50+ tabs — ensure reasonable performance (no jank on scroll)
  - [ ] 10.3 Test browser restart — tree restores correctly
  - [ ] 10.4 Test rapid tab open/close — no race conditions or orphaned state
  - [ ] 10.5 Test edge cases: closing parent with children, closing all tabs, pinning/unpinning, muting
  - [ ] 10.6 Clean up console.log statements, add meaningful error handling
  - [ ] 10.7 Verify extension size < 500KB
  - [ ] 10.8 Final manual walkthrough of all features
