# PRD: LinkMap — Vertical Tabs & Link Map Chrome Extension

## 1. Introduction / Overview

LinkMap is a Chrome Extension that replaces the browser's default horizontal tab strip with a **side-panel vertical tab list** augmented by a **tree-style "Link Map"** visualization. It tracks tab lineage (parent → child relationships) and renders them as a collapsible hierarchy. A deep **CSS-variable theming engine** ships with four premium dark themes and per-group color overrides.

**Problem:** Power users with 20-100+ tabs lose context in Chrome's flat tab bar. Tabs opened from a search result or article have no visible relationship to the page that spawned them. Existing "tree-style tab" extensions are either abandoned, bloated, or ugly.

**Solution:** A lightweight, Manifest V3 side-panel extension that automatically builds a visual tree of tab relationships, persists it across restarts, and looks premium out of the box.

## 2. Goals

| # | Goal | Measurable Outcome |
|---|------|--------------------|
| G1 | Automatic tab lineage tracking | Every tab opened via link click is correctly nested under its parent |
| G2 | Persistent tree state | Tree survives browser restart with ≤1s load time |
| G3 | Premium dark themes | 4 preset themes, hot-swappable with zero flash |
| G4 | Fuzzy search | Results appear within 200ms of keystroke |
| G5 | Drag & drop reordering | Users can reparent tabs and reorder within a level |
| G6 | Lightweight | < 500KB total extension size, no build step required |

## 3. User Stories

| ID | As a... | I want to... | So that... |
|----|---------|-------------|------------|
| US-1 | Power user | See tabs as a tree in the side panel | I understand which tabs came from where |
| US-2 | Researcher | Collapse a parent tab's children | I can focus on one research thread without closing tabs |
| US-3 | User | Have my tree persist after restart | I don't lose my organizational structure |
| US-4 | User | Search tabs by title or URL | I can find a buried tab instantly |
| US-5 | User | Drag a tab under another tab | I can manually organize my tree |
| US-6 | User | Choose from premium dark themes | The extension matches my editor/desktop aesthetic |
| US-7 | User | Color-code tab groups | I can visually distinguish project contexts |
| US-8 | User | Click a tab in the panel to switch to it | Navigating is faster than the default tab strip |

## 4. Functional Requirements

### FR-1: Tab Tree (Link Map)

| # | Requirement |
|---|------------|
| FR-1.1 | Track `openerTabId` on `chrome.tabs.onCreated` to establish parent-child relationships |
| FR-1.2 | Maintain a **Shadow State** object that mirrors Chrome's flat tab list as a tree structure |
| FR-1.3 | Render tabs as an indented hierarchical list in the side panel |
| FR-1.4 | Tabs with no `openerTabId` are placed at root level |
| FR-1.5 | When a parent tab is closed, promote its children to the parent's level (reparent to grandparent, or root) |
| FR-1.6 | Collapse/expand toggle per parent node — hides children in the UI without closing them |
| FR-1.7 | Visual indicators: expand/collapse chevron, nesting depth lines, active tab highlight |
| FR-1.8 | Favicon display next to each tab title |
| FR-1.9 | Close button (×) on hover for each tab |
| FR-1.10 | Middle-click on a tab closes it |

### FR-2: Persistence

| # | Requirement |
|---|------------|
| FR-2.1 | Save tree state to `chrome.storage.local` on every mutation (debounced, 500ms) |
| FR-2.2 | On extension load, reconstruct tree from saved state + reconcile with actual `chrome.tabs.query()` |
| FR-2.3 | Handle orphaned entries (saved tabs that no longer exist) — remove them |
| FR-2.4 | Handle new tabs not in saved state — add at root level |
| FR-2.5 | Store collapsed state per node |

### FR-3: Theming Engine

| # | Requirement |
|---|------------|
| FR-3.1 | All colors defined as CSS custom properties on `:root` |
| FR-3.2 | Theme switching is instantaneous — swap a `data-theme` attribute on `<html>` |
| FR-3.3 | Preset themes: **Midnight** (deep blue/black), **OLED** (pure #000), **Dracula** (purple/grey), **Nord** (arctic blue/grey) |
| FR-3.4 | Theme preference saved to `chrome.storage.local` |
| FR-3.5 | Default theme: Midnight |
| FR-3.6 | Settings panel accessible from a gear icon in the side panel header |

### FR-4: Tab Group Styling

| # | Requirement |
|---|------------|
| FR-4.1 | UI to assign custom HEX colors to tab groups |
| FR-4.2 | Color picker component (simple input or popup palette) |
| FR-4.3 | Group color overrides Chrome's default group colors in the sidebar display |
| FR-4.4 | Group colors persist via `chrome.storage.local` |

### FR-5: Search

| # | Requirement |
|---|------------|
| FR-5.1 | Search input at the top of the side panel |
| FR-5.2 | Fuzzy matching against tab title and URL |
| FR-5.3 | While searching, flatten the tree into a filtered list of matches |
| FR-5.4 | Highlight matched text in results |
| FR-5.5 | Pressing Escape or clearing input restores the tree view |
| FR-5.6 | Keyboard shortcut to focus search (e.g., Ctrl+F within the panel) |

### FR-6: Drag & Drop

| # | Requirement |
|---|------------|
| FR-6.1 | Drag tabs to reorder within the same level |
| FR-6.2 | Drag a tab onto another tab to reparent it (make it a child) |
| FR-6.3 | Visual drop indicators (line for reorder, highlight for reparent) |
| FR-6.4 | Update Shadow State and persistence after every drop |
| FR-6.5 | Use SortableJS (via CDN) or native HTML5 Drag and Drop API |

### FR-7: Standard Tab Actions

| # | Requirement |
|---|------------|
| FR-7.1 | Click a tab entry → `chrome.tabs.update(tabId, { active: true })` |
| FR-7.2 | Close button → `chrome.tabs.remove(tabId)` |
| FR-7.3 | Right-click context menu: Close, Close Others, Close to Right, Duplicate, Pin/Unpin, Mute |
| FR-7.4 | Show pinned tabs in a separate section at the top |
| FR-7.5 | Show audible indicator for tabs playing audio |
| FR-7.6 | Show loading spinner for tabs that are loading |

## 5. Non-Goals (Out of Scope)

- **Tab Suspender / Memory Management** — not managing memory, just visualizing
- **Cross-device Sync** — no sync between machines (local-only in v1)
- **Multiple Windows** — v1 targets single-window; multi-window is a future enhancement
- **Popup Mode** — side panel only, no browser action popup
- **React/Framework** — vanilla JS only, no build step
- **Chrome Web Store Publishing** — not in v1 scope (developer mode loading)

## 6. Data Structure: Tab Tree Node

```json
{
  "tabId": 124,
  "parentId": 101,
  "children": [125, 126],
  "collapsed": false,
  "title": "Google Search",
  "url": "https://google.com/search?q=...",
  "favIconUrl": "https://google.com/favicon.ico",
  "pinned": false,
  "audible": false,
  "status": "complete",
  "groupId": -1,
  "index": 3,
  "windowId": 1
}
```

### Shadow State

The **Shadow State** is the single source of truth for the tree structure. It is a `Map<number, TabNode>` keyed by `tabId`.

```javascript
// Shadow State structure
const shadowState = {
  tabs: new Map(),       // tabId → TabNode
  rootIds: [],           // tabIds with no parent (top-level)
  collapsed: new Set(),  // tabIds that are collapsed
  groupColors: {},       // groupId → hex color
  theme: 'midnight',     // active theme name
};
```

**Reconciliation Protocol (on startup):**
1. Load saved state from `chrome.storage.local`
2. Query `chrome.tabs.query({})` for actual tabs
3. Remove entries from saved state where tab no longer exists
4. Add new tabs (not in saved state) at root level
5. Update title, url, favicon, status from live tab data
6. Rebuild `rootIds` array from parentId relationships

## 7. Technical Constraints

| Constraint | Detail |
|-----------|--------|
| Manifest Version | V3 only |
| UI Surface | Side Panel API (`chrome.sidePanel`) |
| Language | Vanilla JavaScript (ES Modules) |
| Build System | None — no Webpack, no bundler |
| External Dependencies | SortableJS via CDN (optional), or native HTML5 DnD |
| Storage | `chrome.storage.local` only |
| Permissions | `tabs`, `sidePanel`, `storage`, `tabGroups` |

## 8. Design Considerations

### Layout

```
┌──────────────────────────────┐
│ [🔍 Search...          ] [⚙] │  ← Header
├──────────────────────────────┤
│ 📌 Pinned Tabs               │  ← Pinned section
│   Tab 1                      │
│   Tab 2                      │
├──────────────────────────────┤
│ ▼ Tab A                    × │  ← Root tab (expanded)
│   ├─ Tab B                 × │  ← Child
│   │  └─ Tab C              × │  ← Grandchild
│   └─ Tab D                 × │  ← Child
│ ▶ Tab E                    × │  ← Root tab (collapsed)
│ Tab F                      × │  ← Root tab (no children)
├──────────────────────────────┤
│ Theme: Midnight    [v]       │  ← Footer/Settings
└──────────────────────────────┘
```

### CSS Variable Naming Convention

```css
--bg-primary          /* Main background */
--bg-secondary        /* Hover / alternate rows */
--bg-active           /* Active tab highlight */
--text-primary        /* Main text */
--text-secondary      /* URLs, metadata */
--text-muted          /* Disabled / placeholder */
--accent              /* Links, active indicators */
--border              /* Separators, tree lines */
--scrollbar-thumb     /* Scrollbar */
--scrollbar-track     /* Scrollbar background */
--close-hover         /* Close button hover bg */
--search-bg           /* Search input background */
--search-border       /* Search input border */
```

### Theme Definitions

**Midnight (Default)**
```css
[data-theme="midnight"] {
  --bg-primary: #1a1b2e;
  --bg-secondary: #232440;
  --bg-active: #2a2b4a;
  --text-primary: #e0e0f0;
  --text-secondary: #8888aa;
  --text-muted: #555577;
  --accent: #6c8cff;
  --border: #2d2e4a;
}
```

**OLED**
```css
[data-theme="oled"] {
  --bg-primary: #000000;
  --bg-secondary: #0a0a0a;
  --bg-active: #1a1a1a;
  --text-primary: #ffffff;
  --text-secondary: #888888;
  --text-muted: #444444;
  --accent: #00aaff;
  --border: #222222;
}
```

**Dracula**
```css
[data-theme="dracula"] {
  --bg-primary: #282a36;
  --bg-secondary: #2d2f3d;
  --bg-active: #44475a;
  --text-primary: #f8f8f2;
  --text-secondary: #bd93f9;
  --text-muted: #6272a4;
  --accent: #ff79c6;
  --border: #44475a;
}
```

**Nord**
```css
[data-theme="nord"] {
  --bg-primary: #2e3440;
  --bg-secondary: #3b4252;
  --bg-active: #434c5e;
  --text-primary: #eceff4;
  --text-secondary: #81a1c1;
  --text-muted: #4c566a;
  --accent: #88c0d0;
  --border: #3b4252;
}
```

## 9. Success Metrics

| Metric | Target |
|--------|--------|
| Tree renders correctly on load | 100% of tabs displayed in correct hierarchy |
| Persistence survives restart | Tree structure identical after restart (within 1s) |
| Theme switch latency | < 50ms (CSS variable swap) |
| Search responsiveness | Results within 200ms of keystroke |
| Extension size | < 500KB total |
| No errors in console | Zero uncaught exceptions in normal use |

## 10. Open Questions

| # | Question | Default if Unresolved |
|---|----------|-----------------------|
| Q1 | Should we support multiple windows in v1? | No — single window only |
| Q2 | Should SortableJS be bundled or loaded via CDN? | CDN for simplicity (no build step) |
| Q3 | Should we add keyboard navigation (arrow keys) in the tree? | Defer to v2 |
| Q4 | Should right-click context menu use Chrome's `chrome.contextMenus` or a custom HTML menu? | Custom HTML menu for full styling control |
| Q5 | What happens when the user has 200+ tabs? | Virtual scrolling deferred to v2; basic scroll for now |
