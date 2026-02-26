# Architecture: LinkMap Chrome Extension

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     CHROME BROWSER                           │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │  Background   │◄──►│  Side Panel  │    │   Content     │   │
│  │  Service      │    │  (UI)        │    │   Scripts     │   │
│  │  Worker       │    │              │    │   (future)    │   │
│  └──────┬───────┘    └──────┬───────┘    └──────────────┘   │
│         │                   │                                │
│         │    chrome.runtime.sendMessage / onMessage           │
│         │◄──────────────────┘                                │
│         │                                                    │
│         ▼                                                    │
│  ┌──────────────┐                                           │
│  │  chrome.      │                                           │
│  │  storage.     │                                           │
│  │  local        │                                           │
│  └──────────────┘                                           │
└─────────────────────────────────────────────────────────────┘
```

## Component Architecture

### 1. Background Service Worker (`background.js`)

**Responsibility:** Single source of truth for tab state. Listens to all Chrome tab events, maintains the Shadow State, and broadcasts changes to the side panel.

```
Tab Events (chrome.tabs.on*)
         │
         ▼
┌─────────────────────┐
│   Event Handler     │
│   (background.js)   │
│                     │
│ onCreated ─────────►│──┐
│ onRemoved ─────────►│  │  Update
│ onUpdated ─────────►│  ├──Shadow State
│ onMoved ───────────►│  │
│ onActivated ───────►│──┘
│ onAttached ────────►│      │
│ onDetached ────────►│      ▼
│                     │  Debounced Save
│                     │  (chrome.storage.local)
│                     │      │
│                     │      ▼
│                     │  Notify Side Panel
│                     │  (runtime.sendMessage)
└─────────────────────┘
```

**Key Design Decisions:**
- Shadow State lives in the service worker, NOT the side panel
- Side panel is a dumb renderer — it receives state and renders it
- This prevents state drift between panel open/close cycles
- Service worker may be killed by Chrome; on wake, it reconciles from storage + live tabs

### 2. Side Panel (`sidepanel/`)

**Responsibility:** Render the tab tree, handle user interactions (click, drag, search, theme), and send commands back to the background worker.

```
┌─────────────────────────────────────────────┐
│              Side Panel UI                   │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ Header                                 │  │
│  │  [Search Input]              [Settings]│  │
│  └────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────┐  │
│  │ Pinned Section                         │  │
│  │  Tab 1 | Tab 2                         │  │
│  └────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────┐  │
│  │ Tree View                              │  │
│  │  ▼ Parent Tab              [×]         │  │
│  │    ├─ Child Tab            [×]         │  │
│  │    └─ Child Tab            [×]         │  │
│  │  ▶ Collapsed Parent        [×]         │  │
│  │  Orphan Tab                [×]         │  │
│  └────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────┐  │
│  │ Footer / Status Bar                    │  │
│  │  Theme: [Midnight ▾]     12 tabs       │  │
│  └────────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

**Module Breakdown:**

| Module | File | Purpose |
|--------|------|---------|
| Entry | `sidepanel.html` | HTML shell, loads CSS + JS |
| App | `sidepanel.js` | Main entry, message listener, state management |
| Tree Renderer | `modules/tree-renderer.js` | Converts Shadow State → DOM |
| Search | `modules/search.js` | Fuzzy search + filtered rendering |
| Drag & Drop | `modules/drag-drop.js` | SortableJS or HTML5 DnD integration |
| Theme | `modules/theme.js` | Theme switching + persistence |
| Context Menu | `modules/context-menu.js` | Right-click menu for tab actions |
| Tab Actions | `modules/tab-actions.js` | Click, close, pin, mute handlers |

### 3. Shadow State (Data Layer)

The Shadow State is a plain object managed by the background service worker. It is the **authoritative representation** of the tab tree.

```javascript
// shadow-state.js — imported by background.js

export class ShadowState {
  constructor() {
    this.tabs = new Map();       // tabId → TabNode
    this.rootIds = [];           // ordered root-level tabIds
    this.collapsed = new Set();  // collapsed tabIds
    this.groupColors = {};       // groupId → hex color string
    this.theme = 'midnight';     // active theme name
  }

  // Core mutations
  addTab(tabId, node) { ... }
  removeTab(tabId) { ... }
  moveTab(tabId, newParentId, index) { ... }
  updateTab(tabId, changes) { ... }
  toggleCollapse(tabId) { ... }

  // Queries
  getChildren(tabId) { ... }
  getDescendants(tabId) { ... }  // recursive
  getRoots() { ... }
  toSerializable() { ... }       // for storage

  // Reconciliation
  static fromStorage(saved) { ... }
  reconcileWithLiveTabs(liveTabs) { ... }
}
```

**TabNode shape:**
```javascript
{
  tabId: number,
  parentId: number | null,
  children: number[],          // ordered child tabIds
  collapsed: boolean,
  title: string,
  url: string,
  favIconUrl: string,
  pinned: boolean,
  audible: boolean,
  status: 'loading' | 'complete',
  groupId: number,             // -1 if ungrouped
  index: number,               // Chrome's tab index
  windowId: number
}
```

### 4. Messaging Protocol

Communication between background ↔ side panel uses `chrome.runtime.sendMessage` / `onMessage`.

**Background → Side Panel (state updates):**
```javascript
{ type: 'STATE_UPDATE', payload: { tabs: [...], rootIds: [...], ... } }
{ type: 'TAB_ACTIVATED', payload: { tabId: number } }
{ type: 'THEME_CHANGED', payload: { theme: string } }
```

**Side Panel → Background (commands):**
```javascript
{ type: 'ACTIVATE_TAB', payload: { tabId: number } }
{ type: 'CLOSE_TAB', payload: { tabId: number } }
{ type: 'CLOSE_TABS', payload: { tabIds: number[] } }
{ type: 'MOVE_TAB', payload: { tabId, newParentId, index } }
{ type: 'TOGGLE_COLLAPSE', payload: { tabId: number } }
{ type: 'SET_THEME', payload: { theme: string } }
{ type: 'SET_GROUP_COLOR', payload: { groupId, color } }
{ type: 'PIN_TAB', payload: { tabId, pinned } }
{ type: 'DUPLICATE_TAB', payload: { tabId } }
{ type: 'MUTE_TAB', payload: { tabId, muted } }
{ type: 'GET_STATE' }          // initial load request
```

### 5. Persistence Strategy

```
                  Mutation occurs
                       │
                       ▼
              ┌─────────────┐
              │  Update      │
              │  Shadow      │
              │  State       │
              └──────┬──────┘
                     │
                     ▼
              ┌─────────────┐
              │  Debounce    │
              │  (500ms)     │
              └──────┬──────┘
                     │
                     ▼
              ┌─────────────┐
              │  Serialize   │
              │  & Save to   │
              │  chrome.     │
              │  storage.    │
              │  local       │
              └─────────────┘
```

**Storage Key:** `linkmap_state`

**Stored Data:**
```json
{
  "version": 1,
  "savedAt": "2026-02-25T12:00:00Z",
  "tabs": { ... },
  "rootIds": [...],
  "collapsed": [...],
  "groupColors": { ... },
  "theme": "midnight"
}
```

**Reconciliation on Startup:**
1. `chrome.storage.local.get('linkmap_state')` → saved
2. `chrome.tabs.query({})` → liveTabs
3. For each saved tab: if `liveTabs` has it → update metadata, keep tree position
4. For each saved tab: if NOT in `liveTabs` → remove from state
5. For each live tab: if NOT in saved → add at root level
6. Rebuild `rootIds` from parentId graph
7. Broadcast full state to side panel

## File Structure

```
linkmap/
├── manifest.json                  # Extension manifest (MV3)
├── background.js                  # Service worker entry
├── sidepanel/
│   ├── sidepanel.html             # Side panel HTML shell
│   ├── sidepanel.js               # Main entry + message handler
│   ├── modules/
│   │   ├── tree-renderer.js       # DOM rendering of tab tree
│   │   ├── search.js              # Fuzzy search logic + UI
│   │   ├── drag-drop.js           # Drag & drop (SortableJS or HTML5)
│   │   ├── theme.js               # Theme switching
│   │   ├── context-menu.js        # Right-click context menu
│   │   └── tab-actions.js         # Click, close, pin, mute
│   └── styles/
│       ├── base.css               # Reset, layout, scrollbar
│       ├── themes.css             # All theme CSS variable sets
│       ├── tree.css               # Tree-specific styles (lines, indent)
│       ├── search.css             # Search bar styles
│       └── context-menu.css       # Context menu styles
├── shared/
│   ├── shadow-state.js            # ShadowState class
│   ├── constants.js               # Message types, storage keys
│   └── utils.js                   # Debounce, fuzzy match, helpers
├── icons/
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   └── icon-128.png
└── vendor/
    └── sortable.min.js            # SortableJS (if not using CDN)
```

## Manifest

```json
{
  "manifest_version": 3,
  "name": "LinkMap",
  "version": "0.1.0",
  "description": "Vertical tabs with tree-style link mapping and premium dark themes",
  "permissions": [
    "tabs",
    "sidePanel",
    "storage",
    "tabGroups"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "side_panel": {
    "default_path": "sidepanel/sidepanel.html"
  },
  "action": {
    "default_title": "Toggle LinkMap",
    "default_icon": {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    }
  },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

## Data Flow Diagrams

### Tab Creation Flow
```
User clicks link in Page A
         │
         ▼
chrome.tabs.onCreated fires
  { id: 125, openerTabId: 101 }
         │
         ▼
background.js handler:
  1. Create TabNode { tabId: 125, parentId: 101 }
  2. Push 125 to tabs[101].children
  3. shadowState.addTab(125, node)
  4. Debounced save to storage
  5. Send STATE_UPDATE to side panel
         │
         ▼
Side panel re-renders tree
  Tab 101
    └─ Tab 125 (new)
```

### Tab Closure Flow
```
User closes Tab 101 (has children: [125, 126])
         │
         ▼
chrome.tabs.onRemoved fires { tabId: 101 }
         │
         ▼
background.js handler:
  1. Get children of 101: [125, 126]
  2. Reparent each child to 101's parentId (grandparent or null/root)
  3. Remove 101 from shadowState
  4. Update rootIds if children promoted to root
  5. Debounced save
  6. Send STATE_UPDATE
         │
         ▼
Side panel re-renders:
  Tab 125 (was child, now at parent's level)
  Tab 126 (was child, now at parent's level)
```

### Search Flow
```
User types "goo" in search box
         │
         ▼
sidepanel.js:
  1. debounce(150ms)
  2. fuzzyMatch("goo", allTabs)
  3. Filter to matching tabs
  4. Flatten tree → list of matches
  5. Highlight matched chars in title/URL
  6. Render flat list (hide tree structure)
         │
User clears search / presses Escape
         │
         ▼
  Restore full tree rendering
```

## Performance Considerations

| Concern | Strategy |
|---------|----------|
| Large tab counts (100+) | DOM recycling in v2; basic `overflow: auto` scroll for v1 |
| Frequent tab updates | Debounce state saves (500ms) and UI updates (100ms) |
| Service worker killed | On wake: reconcile from storage + live tabs |
| Side panel closed/reopened | Request full state from background on connect |
| Favicon loading | Use `img` with fallback to generic tab icon |
| Search performance | Simple fuzzy match is O(n) — fine for <500 tabs |

## Security Model

| Risk | Mitigation |
|------|-----------|
| XSS via tab titles | Use `textContent`, never `innerHTML` for user data |
| URL leakage | All data stays in `chrome.storage.local`, never transmitted |
| CSP | Manifest V3 enforces strict CSP; inline scripts forbidden |
| Permissions | Minimal: `tabs`, `sidePanel`, `storage`, `tabGroups` — no `<all_urls>` |

## Extension Lifecycle

```
Install/Update
     │
     ▼
Service Worker starts
     │
     ▼
Load state from storage ──► (empty on first install)
     │
     ▼
Query all existing tabs
     │
     ▼
Build initial Shadow State
     │
     ▼
Register tab event listeners
     │
     ▼
Ready (side panel can connect at any time)

     ─── Runtime ───

User clicks extension icon
     │
     ▼
Side panel opens
     │
     ▼
sidepanel.js sends GET_STATE
     │
     ▼
Background responds with full state
     │
     ▼
Side panel renders tree
     │
     ▼
Ongoing: background pushes STATE_UPDATE on changes
```
