# Code Review — Remaining Phases

Phases 1-3 (partial) shipped 2026-03-13. This doc tracks what remains.

## Completed

| Phase | Items | Status |
|-------|-------|--------|
| 1 — Bug Fixes | B1-B8 | Done |
| 2 — Error Handling | E1-E3 | Done |
| 3 — Refactoring (partial) | R4 (extractDomain dedup), R5 (search.js import fix), R7 (magic numbers) | Done |

---

## Phase 3 (Remaining) — Large Extractions & Dedup

### R1. Extract `restoreSession()` — 144 lines, complexity ~10
- **File:** `background.js:364-508`
- **Extract to:** 3 named functions:
  - `createWindowsForRestore(sessionWindows)` — window creation loop
  - `createTabsForRestore(window, tabMapping)` — tab creation + ID mapping
  - `rebuildGroupsForRestore(groups, tabMapping)` — group reassignment
- **Why:** Single largest function in the codebase, hard to reason about failure modes

### R2. Extract `init()` retry loop
- **File:** `background.js:231-262`
- **Extract to:** `retryMissingGroupTitles(groups)` — named function instead of nested closure
- **Why:** Nested closures inside `init()` make the function harder to follow

### R3. Extract from `sidepanel.js` (917 lines)
Three modules to extract:

| Extract | Lines | Target File |
|---------|-------|-------------|
| Keyboard navigation | 539-689 (~150 lines) | `modules/keyboard-nav.js` |
| Settings panel | 695-791 (~80 lines) | `modules/settings.js` |
| Multi-select toolbar | 797-853 (~55 lines) | `modules/multi-select.js` |

- Each module exports an `init(deps)` function that receives dependencies (state, render, etc.)
- `sidepanel.js` imports and calls `init()` at startup
- Update `sidepanel.html` script tags if needed (currently uses ES modules via `type="module"`)

### R4 (remaining). Deduplicate `positionMenu()`
- **Duplicated in:** `context-menu.js:310` and `workspace-ui.js:235`
- **Move to:** `shared/utils.js` as `positionMenu(menuEl, anchorRect, container)`
- **Note:** Implementations may differ slightly — compare before merging

### R5 (remaining). Dead code — `theme.js`
- **File:** `sidepanel/modules/theme.js` (42 lines)
- **Status:** Completely unused — `sidepanel.js` applies themes inline
- **Decision needed:** Delete it, or refactor `sidepanel.js` to use it
- **Recommendation:** Delete. The inline approach is simpler and already works.

---

## Phase 4 — DX Improvements

### R6. Replace `prompt()` calls (5 instances)
Browser `prompt()` is ugly and blocks the thread. Replace with styled inline inputs.

| Location | Context | Replacement |
|----------|---------|-------------|
| `context-menu.js:76` | Add Note | Inline text input in context menu |
| `context-menu.js:195` | Rename Group | Inline text input in context menu |
| `session-manager.js:98` | Save Session | Input field in session panel |
| `workspace-ui.js:170` | Rename Workspace | Inline text input in workspace menu |
| `command-palette.js:117` | Save Session | Input field in palette |

**Approach:**
- Create a shared `inlinePrompt(anchorEl, placeholder, onSubmit)` utility
- Renders a small text input, focuses it, commits on Enter, cancels on Escape
- Style with existing CSS variables for theme consistency

### R8. `MSG.RENAME_WORKSPACE` used for color changes
- **File:** `workspace-ui.js:210`
- The `RENAME_WORKSPACE` handler in `background.js` already accepts both `name` and `color` in payload
- Options:
  - (A) Add `MSG.UPDATE_WORKSPACE` as an alias/replacement — cleaner semantics
  - (B) Add a comment documenting the dual-purpose nature — minimal churn
- **Recommendation:** (A) — add `UPDATE_WORKSPACE` to MSG, update `workspace-ui.js` to use it, keep `RENAME_WORKSPACE` for actual renames

### CSS Maintenance (Tier 6)

| Item | File | Fix |
|------|------|-----|
| `[data-depth="6"]` rule separated from siblings | `tree.css:106-110` | Move next to depth 0-5 rules |
| Spacing values not formulaic | `tree.css` | Replace `28px, 44px, 60px...` with `calc(12px + N * 16px)` |
| `.window-rename-input` styles inline in JS | `sidepanel.js` | Move to `tree.css` |
| `.tab-chevron-spacer` width hardcoded inline | `tree-renderer.js` | Move to `tree.css` |
| Overlapping input focus styles | `session.css` + `base.css` | Consolidate to one location |

---

## Phase 5 — Accessibility

### A1. ARIA tree roles
```
#tree-container          → role="tree"
.tab-entry               → role="treeitem"
.tab-chevron             → aria-expanded="true/false"
active tab               → aria-current="page"
selected tabs            → aria-selected="true/false"
```
- **File:** `tree-renderer.js` — add attributes in `buildTabElement()` and `buildGroupHeader()`

### A2. Context menu roles
```
#context-menu            → role="menu"
.context-menu-item       → role="menuitem"
```
- **File:** `context-menu.js` — add in `menuItem()` helper

### A3. Keyboard focus — screen reader support
- **Current:** `focusedTabId` sets `data-focused` CSS class but never calls `.focus()`
- **Fix:** After setting `data-focused`, call `element.focus()` or use `tabindex="-1"` + `element.focus()`
- **File:** `sidepanel.js` keyboard nav section (lines 539-689)

### A4. Search result announcements
- Add an `aria-live="polite"` region near the search input
- After search completes, update it with result count: "5 tabs found" / "No results"
- **File:** `search.js`

---

## Phase 6 — Test Coverage

| Module | Lines | Priority | What to Test |
|--------|-------|----------|--------------|
| `workspace-ui.js` | 242 | High | `getActiveWorkspaceTabIds()` — verify correct tab filtering, empty workspace, workspace switching |
| `color-distance.js` | 110 | Medium | CIE76 distance calc, `nearestChromeGroupColor()` against known hex values |
| `context-menu.js` | 330 | Medium | Rename-commit guard logic, menu item generation for different node types |
| `command-palette.js` | 256 | Low | `closeAllDuplicates` — verify it closes correct tabs, doesn't close originals |

### Pre-existing test failures to fix
Two tests in `shadow-state.test.js` fail:
1. `initializes with default theme "midnight"` — expects `midnight`, actual is `august-default` (constant changed)
2. `rebuilds rootIds ordered by index` — expects `[20, 30, 10]`, gets `[10, 20, 30]` (sort order assumption wrong)

---

## Execution Notes

- Each phase can be done independently as a single commit
- Run `node --test tests/*.test.js` after each phase
- Manual smoke test in Chrome after each phase: pin/unpin, drag, search, sessions, context menu, keyboard nav
- Phase 3 R3 (sidepanel extraction) is the largest single task — consider splitting into 3 commits (one per module)
- Phase 5 (accessibility) can be done incrementally — A1 alone is the highest impact
