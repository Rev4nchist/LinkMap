# LinkMap Innovation Suite — 10 Power Features for the TabMaster

## Context

LinkMap currently has a strong foundation: tree-style tab visualization, 15 themes with Smart Mapper color sync, drag-drop reordering, fuzzy search, keyboard navigation, tab groups, context menus, and focus mode. All built on a clean ShadowState architecture with a background service worker owning the tree and the side panel as a pure renderer.

The next leap is from *tab manager* to *research command center*. These 10 features are designed for hyper organizers, heavy researchers, and TabMasters who live in 50+ tabs and need the browser to work *with* their brain, not against it.

**Research sources:** Tree Style Tab, Sidebery, Arc Browser, Vivaldi, Workona, Toby, OneTab, Session Buddy, Edge AI Tab Organizer (Feb 2026), Opera AI Tab Commands.

---

## The 10 Ideas

### 1. Research Sessions with Time Travel

**Concept:** Auto-snapshot your entire tab tree every N minutes. A timeline scrubber at the bottom of the side panel lets you visually "rewind" to any past state — see what your tree looked like 2 hours ago, yesterday, last week. Not just save/restore like Session Buddy — this is *temporal navigation* through your browsing history as a tree.

**Why it's innovative:** Every session manager saves flat lists. Nobody preserves the *tree structure* over time. For a researcher, the parent-child relationships (how you got from an article to a paper to a dataset) ARE the valuable information. Losing the tree structure is losing the research trail.

**Key mechanics:**
- Auto-snapshot to `chrome.storage.local` every 5 min (configurable), compressed delta format
- Timeline UI: horizontal scrubber or calendar view in a collapsible panel section
- Diff view: highlight tabs added/removed/moved between snapshots
- "Restore branch" — pull a specific subtree from a past snapshot into your current tree
- Requires `unlimitedStorage` permission for snapshot history

**Chrome APIs:** `chrome.storage.local` (with `unlimitedStorage`), `chrome.alarms` (for periodic snapshots)

---

### 2. Air Traffic Control — URL Rules Engine

**Concept:** Define rules that auto-route new tabs into the correct group based on URL patterns. `*github.com* → "Development"`, `*docs.google.com* → "Documents"`, `*arxiv.org* → "Research Papers"`. Tabs sort themselves. Zero manual effort.

**Why it's innovative:** Combines Arc's manual ATC rules with domain-extraction heuristics for zero-config smart defaults. Ships with a built-in category dictionary (50+ domains pre-mapped) so it works *immediately* without any setup, while power users can add custom rules.

**Key mechanics:**
- Rules engine in background.js, evaluated on `tabs.onCreated` and `tabs.onUpdated` (URL change)
- Rule format: `{ pattern: glob/regex, action: 'group', target: 'groupName', color: 'blue' }`
- Built-in heuristics: extract domain → match against category dictionary → auto-create/assign group
- UI: rules editor in settings panel with test-match preview
- Conflict resolution: most specific pattern wins (longer glob > shorter glob)
- Auto-creates Chrome tab groups when rules match (via `chrome.tabs.group()`)

**Chrome APIs:** `chrome.tabs.group()`, `chrome.tabGroups.update()` (already used)

---

### 3. Tab Triage Inbox + Auto-Archive

**Concept:** Every new tab lands in a visual "Inbox" section at the top of the tree. You triage — drag to a group, or leave it. Untriaged tabs auto-archive after N hours (configurable: 1h, 4h, 12h, 24h). Archived tabs move to a searchable "Archive" section — discarded from memory but restorable with one click.

**Why it's innovative:** Applies GTD (Getting Things Done) methodology to tabs. The inbox forces a review habit. Auto-archive prevents hoarding without the anxiety of losing tabs. Includes a OneTab-style "panic button" — one click to archive everything and start fresh. The psychological shift: "I can always get back to this" eliminates tab anxiety.

**Key mechanics:**
- New ShadowState section: `inbox[]` and `archive[]` alongside `rootIds`
- Inbox visual: highlighted section with "unsorted" label, subtle pulse for new arrivals
- Auto-archive timer tracked per tab in ShadowState: `{ tabId, openedAt, lastInteracted }`
- Archive section: collapsible, searchable, shows favicon + title + archived date
- "Archive All" panic button in toolbar (new icon)
- Restore: click archived tab → `chrome.tabs.create()` with saved URL

**Chrome APIs:** `chrome.tabs.discard()` (already used in context menu), `chrome.alarms` (for periodic sweep)

---

### 4. Link Harvester — The Actual "Link Map"

**Concept:** Click a "harvest" button on any tab to inject a content script that extracts ALL links from the page. Links appear as a navigable sub-tree under that tab, organized by: same-domain links, external links, and resource links. Click any harvested link to open it as a child tab, building a visual web graph. This makes LinkMap a genuine *link map* — a tool for exploring and mapping the web's link structure.

**Why it's innovative:** No tab manager does this. This transforms LinkMap from "tabs in a tree" to "the web as a navigable graph." For researchers, this is the difference between managing what you've already opened and *discovering what's connected to what you're reading*. It's web exploration as a first-class feature.

**Key mechanics:**
- Content script (`content/link-harvester.js`) injected via `chrome.scripting.executeScript()`
- Extracts: `<a href>` links, deduplicates, categorizes (same-domain / external / resource)
- Results sent to background via message, stored as virtual nodes in ShadowState (not real tabs)
- Rendered as expandable sub-tree with different styling (dotted lines, link icon instead of favicon)
- Click to promote: opens as real child tab
- "Harvest depth" option: follow links 1-2 levels deep (crawl mode) — rate-limited

**Chrome APIs:** `chrome.scripting.executeScript()` (needs `scripting` permission + `activeTab` or host permissions)

---

### 5. Tab Genome — Behavioral Auto-Clustering

**Concept:** Each tab accumulates a behavioral "genome" based on: opener chain (lineage), domain family, time spent active, scroll depth, interaction frequency, and co-visitation patterns (which tabs are often active together). Tabs with similar genomes auto-cluster — the system suggests groupings you didn't explicitly create. "These 5 tabs seem related — group them?"

**Why it's innovative:** Goes far beyond URL-pattern matching. Two `stackoverflow.com` tabs about different topics would NOT cluster together, but a Stack Overflow tab and a GitHub tab about the same library WOULD — because they share lineage and co-visitation. This is *behavioral* intelligence, not just string matching.

**Key mechanics:**
- Genome vector per tab in ShadowState: `{ lineage: [parentId chain], domain, activeTime, coVisited: Set<tabId> }`
- Co-visitation tracked: when user switches between tabs A and B within 30s, increment their co-visitation score
- Clustering algorithm: simple cosine similarity on genome vectors, threshold-based suggestions
- UI: subtle "Related" badges on tab entries, or "Suggested Group" prompt in a notification bar
- Opt-in: user confirms or dismisses suggestions, system learns from feedback

**Chrome APIs:** `chrome.tabs.onActivated` (already used — just need to track timing patterns)

---

### 6. Workspace Contexts with Theme Binding

**Concept:** Multiple virtual workspaces within LinkMap, each with its own tab tree, collapsed state, scroll position, AND theme. Switch between "Research" (deep-forest theme, 30 tabs), "Work" (august-default, 15 tabs), and "Personal" (netrunner, 8 tabs) instantly. Tabs don't close — they hide. The entire visual context shifts, providing a strong cognitive boundary between modes.

**Why it's innovative:** Most workspace tools (Workona, Arc Spaces) treat workspaces as separate containers. LinkMap's innovation: workspace-bound themes. The visual shift (colors, accents, mood) creates an instant *cognitive context switch*. Your brain knows which mode you're in before you read a single tab title. This is neuroergonomic design.

**Key mechanics:**
- New ShadowState structure: `workspaces: Map<name, { rootIds, collapsed, groups, theme, scrollTop }>`
- Active workspace pointer: `currentWorkspace: string`
- Workspace switcher: compact tab bar at the very top of the side panel (before search)
- Switch = swap ShadowState sections + apply theme + restore scroll position
- Tabs in inactive workspaces: `chrome.tabs.hide()` if available, otherwise `chrome.tabs.discard()` + visual filter
- Cross-workspace tab move: drag tab to workspace tab in switcher

**Chrome APIs:** `chrome.storage.local`, potentially `chrome.tabs.discard()` for inactive workspace tabs

---

### 7. Command Palette with Composable Filters

**Concept:** `Ctrl+Shift+P` opens a command palette overlaying the side panel. Fuzzy-search tabs, run actions, chain filters. Type `close github.com >1h` to close all GitHub tabs older than 1 hour. Type `move arxiv → Research` to move all arXiv tabs to a group. The palette understands composable grammar: `[action] [filter] [target]`.

**Why it's innovative:** Most command palettes are just search boxes. This one understands *composable operations* — filter + action + target. It's the keyboard-driven equivalent of "select all matching → bulk action." For a TabMaster with 80 tabs, this replaces dozens of individual clicks with a single typed command.

**Key mechanics:**
- Overlay UI: absolute-positioned input over tree container with results list
- Command grammar: `[verb] [noun/pattern] [modifier]`
  - Verbs: `close`, `group`, `move`, `pin`, `mute`, `archive`, `focus`, `sort`
  - Nouns: tab title fuzzy match, URL pattern, group name, `all`, `duplicates`
  - Modifiers: `>1h` (age), `>5` (count), domain filters
- Autocomplete suggestions as you type
- History: recent commands saved for repeat execution
- Global shortcut via `chrome.commands` — works even when panel not focused

**Chrome APIs:** `chrome.commands` (for global Ctrl+Shift+P binding)

---

### 8. Collapsed Branch Preview — Rich Hover Tooltips

**Concept:** Hover over any collapsed branch or group header to see a rich tooltip showing a miniature preview: favicons of all children in a grid, tab titles in a compact list, total count, and combined "last active" time. Click any favicon in the tooltip to activate that tab without expanding the branch.

**Why it's innovative:** Collapsed branches are currently black boxes — you must expand to see what's inside, which disrupts your visual layout. This makes collapsed branches *useful* without opening them. The clickable favicon grid means you can navigate a 50-tab tree with everything collapsed. Inspired by TST v4.2.8's tooltip but taken further with interactive favicons and metadata.

**Key mechanics:**
- Tooltip triggered on `mouseenter` with 300ms delay, dismissed on `mouseleave`
- DOM: absolute-positioned tooltip panel near the hovered element
- Content: favicon grid (4-column), compact title list (max 10, "and N more"), total descendant count
- Click handler on tooltip favicons: `ACTIVATE_TAB` message
- Respects group collapse (shows group members) AND tree collapse (shows subtree)
- Animation: fade-in 150ms, positioned above/below based on viewport space

**Chrome APIs:** None new — pure UI feature using existing state data

---

### 9. Tab Health Dashboard + Smart Cleanup

**Concept:** A slide-out dashboard panel showing the health of your tab ecosystem: memory usage estimates, tab age distribution (histogram), stale tabs (untouched >24h), duplicate tabs (same URL), heaviest tabs, and crash-risk tabs (high memory). One-click cleanup actions: "Close 12 stale tabs" / "Merge 3 duplicates" / "Hibernate 8 inactive tabs." A "Tab Score" gives your overall ecosystem a health grade (A-F).

**Why it's innovative:** No tab manager provides *analytics* about your tab habits. This turns tab management from reactive ("I have too many tabs") to proactive ("my tab health score is C — here's why and how to fix it"). The gamification aspect (improving your score) drives behavior change. Duplicate detection alone would save researchers who constantly re-open the same reference pages.

**Key mechanics:**
- Dashboard: new panel section (like settings panel), toggled from toolbar
- Metrics tracked in ShadowState per tab: `openedAt`, `lastActivatedAt`, `activeDuration`
- Duplicate detection: URL normalization (strip tracking params, fragments) + exact match
- Stale detection: tabs with `lastActivatedAt` > configurable threshold
- Health score algorithm: weighted function of (total tabs, stale %, duplicate %, age spread)
- Cleanup actions: bulk `CLOSE_TABS`, `chrome.tabs.discard()` for hibernate
- Badge on toolbar icon shows health grade

**Chrome APIs:** `chrome.action.setBadgeText()` (zero new permissions needed)

---

### 10. Research Mode — Citation Collector + Annotation Layer

**Concept:** Toggle "Research Mode" in the toolbar. While active: (a) right-click any text on a page → "Save to Research" captures the quote, URL, page title, and timestamp; (b) tabs in research mode get a subtle border/badge; (c) collected citations appear in a dedicated "Research Notes" section in the side panel; (d) export all citations as Markdown, BibTeX, or a shareable HTML page.

**Why it's innovative:** This transforms LinkMap from a tab manager into a *research assistant*. The key insight: researchers' tabs ARE their working bibliography. By capturing citations alongside the tab tree, LinkMap bridges the gap between "browsing" and "research output." No other tab manager captures *content* from pages — they only manage the containers. This captures the knowledge inside.

**Key mechanics:**
- Content script (Research Mode): adds context menu item via `chrome.contextMenus` (browser-level, not panel)
- Selection capture: `window.getSelection().toString()` + `document.title` + `location.href` + `Date.now()`
- Storage: `chrome.storage.local` key `linkmap_research_notes` — array of citation objects
- UI: collapsible "Research Notes" section in side panel, showing cards with quote + source
- Export: generate Markdown/HTML from stored citations, copy to clipboard or download
- Link to tab: each citation links back to the source tab (if still open) or URL (if closed)
- Tag system: add tags to citations for categorization

**Chrome APIs:** `chrome.contextMenus` (browser-level right-click), `chrome.scripting.executeScript()` for selection capture

---

## Innovation Matrix

| # | Feature | Effort | Impact | Uniqueness | Dependencies |
|---|---------|--------|--------|------------|--------------|
| 1 | Time Travel Sessions | L | H | Very High | `unlimitedStorage`, `alarms` |
| 2 | Air Traffic Control | M | H | High | URL rules engine |
| 3 | Tab Triage + Auto-Archive | M | H | High | `alarms`, inbox UI |
| 4 | Link Harvester | M | Very High | Very High | `scripting`, content script |
| 5 | Tab Genome Clustering | L | M | Very High | Activation tracking |
| 6 | Workspace Contexts | L | Very High | High | Major ShadowState refactor |
| 7 | Command Palette | M | H | High | `commands`, grammar parser |
| 8 | Collapsed Branch Preview | S | M | Medium | Tooltip UI only |
| 9 | Tab Health Dashboard | M | H | High | Metrics tracking |
| 10 | Research Mode / Citations | M | Very High | Very High | `contextMenus`, `scripting` |

**Effort:** S = 1-2 sessions, M = 3-5 sessions, L = 5+ sessions

## Recommended Build Order (if building multiple)

**Phase 1 — Quick wins, big impact:**
- #8 Collapsed Branch Preview (pure UI, no new permissions, immediate polish)
- #9 Tab Health Dashboard (analytics unlock behavior change)

**Phase 2 — Core power features:**
- #2 Air Traffic Control (biggest daily-use automation win)
- #3 Tab Triage + Auto-Archive (prevents the root problem: hoarding)
- #7 Command Palette (TabMaster's keyboard is their weapon)

**Phase 3 — Research revolution:**
- #10 Research Mode / Citations (transforms the value proposition)
- #4 Link Harvester (makes the "Link Map" name literal)

**Phase 4 — Deep intelligence:**
- #6 Workspace Contexts (major architecture, major payoff)
- #1 Time Travel Sessions (most ambitious persistence feature)
- #5 Tab Genome Clustering (behavioral intelligence layer)

## New Permissions Required

| Permission | Needed By | Purpose |
|------------|-----------|---------|
| `commands` | #7 | Global keyboard shortcut |
| `scripting` | #4, #10 | Content script injection |
| `activeTab` | #4, #10 | Access active tab content |
| `contextMenus` | #10 | Browser-level right-click menu |
| `alarms` | #1, #3 | Periodic scheduled tasks |
| `unlimitedStorage` | #1 | Session snapshot history |
