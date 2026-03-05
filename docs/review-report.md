# LinkMap Code Review Report

**Date:** 2026-03-04
**Scope:** Full system review — architecture, code quality, performance, security
**Reviewed by:** 3 specialized agents (critic, principal-reviewer, react-perf-reviewer)

---

## 1. Critical Bugs Fixed During Review

Four critical issues were identified and fixed immediately.

### 1.1 Mute Label Logic Inverted
**File:** `sidepanel/modules/context-menu.js:61-63`
**Bug:** Context menu showed "Mute Tab" when the tab was already muted (checked `tab.audible` instead of `tab.muted`).
**Fix:** Changed condition to `tab.muted ? 'Unmute Tab' : 'Mute Tab'`.

### 1.2 Array Sort Mutation
**File:** `background.js:247`
**Bug:** `autoSaves.sort(...)` mutated the original array in-place, corrupting the source list during pruning.
**Fix:** Added spread — `[...autoSaves].sort(...)` — to sort a copy.

### 1.3 Init Broadcast Timing
**File:** `background.js:172-191`
**Bug:** `broadcastState()` was called before workspaces and tabNotes finished loading from storage. Side panel received incomplete initial state.
**Fix:** Moved `broadcastState()` after all async data loads complete.

### 1.4 Settings Validation
**File:** `background.js:1363-1373`
**Bug:** `UPDATE_SETTINGS` handler spread the entire payload into settings without validation, allowing arbitrary property injection from the side panel.
**Fix:** Added property whitelist — only `sleepOnCollapse`, `autoSaveEnabled`, `autoArchiveMinutes` are accepted.

---

## 2. Performance Optimizations

### HIGH Priority

#### 2.1 Full Tree Rebuild on Every State Update
**File:** `sidepanel/modules/tree-renderer.js:150-151`
**Impact:** Every tab event (activate, update, move) triggers a complete DOM rebuild via `replaceChildren()`. For users with 50+ tabs, this means rebuilding 50+ DOM nodes on every keystroke or tab switch.

**Current behavior:**
```javascript
pinnedContainer.replaceChildren(...pinnedElements);
container.replaceChildren(...treeElements);
```

**Recommended fix:** Implement incremental DOM diffing. Options:
1. **Keyed reconciliation** — Compare old and new element lists by `data-tab-id`. Only insert, remove, or reorder changed entries. Reuse existing DOM nodes.
2. **Dirty flagging** — Track which tab IDs changed since last render. Only rebuild those entries and splice them into the existing DOM.
3. **Batch coalescing** — Debounce rapid state updates (e.g., during tab restore) into a single render pass.

**Estimated improvement:** 60-80% reduction in DOM operations for typical state updates (which usually affect 1-2 tabs).

---

#### 2.2 getDuplicateMap() Recomputed on Every Broadcast
**File:** `background.js:96, 912-926`
**Impact:** `getStatePayload()` calls `getDuplicateMap()` which iterates all tabs and normalizes every URL. This runs on every `broadcastState()` — which fires on every tab event.

**Current behavior:**
```javascript
function getStatePayload() {
  return {
    // ...
    duplicates: getDuplicateMap(),  // O(n) on every call
  };
}
```

**Recommended fix:** Cache the duplicate map and invalidate only when tabs are added, removed, or URLs change.
```javascript
let _duplicateMapCache = null;
let _duplicateMapDirty = true;

function invalidateDuplicateMap() { _duplicateMapDirty = true; }

function getDuplicateMap() {
  if (!_duplicateMapDirty && _duplicateMapCache) return _duplicateMapCache;
  // ... existing computation ...
  _duplicateMapCache = result;
  _duplicateMapDirty = false;
  return result;
}
```
Call `invalidateDuplicateMap()` in `onCreated`, `onRemoved`, and `onUpdated` (when URL changes).

**Estimated improvement:** Eliminates O(n) URL normalization on 90%+ of broadcasts (tab activations, moves, pins don't change URLs).

---

### MEDIUM Priority

#### 2.3 updateFocusRing() Scans All DOM Nodes
**File:** `sidepanel/sidepanel.js:581-594`
**Impact:** Clears `data-focused` from every element matching `[data-focused]`, then queries the entire tree to find the focused tab. Runs on every keyboard navigation event.

**Current behavior:**
```javascript
function updateFocusRing() {
  treeContainer.querySelectorAll('[data-focused]').forEach((el) => {
    delete el.dataset.focused;
  });
  // Then querySelector for the new focused element...
}
```

**Recommended fix:** Cache the previously focused element reference. Clear only that one element instead of scanning the entire tree.
```javascript
let _focusedEl = null;

function updateFocusRing() {
  if (_focusedEl) delete _focusedEl.dataset.focused;
  _focusedEl = focusedTabId != null
    ? treeContainer.querySelector(`[data-tab-id="${focusedTabId}"]`)
    : null;
  if (_focusedEl) {
    _focusedEl.dataset.focused = 'true';
    _focusedEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
```

---

#### 2.4 updateMultiSelectUI() Scans All Tab Entries
**File:** `sidepanel/sidepanel.js:702-708`
**Impact:** Iterates every `.tab-entry` element to update `data-selected`. Called after each selection change.

**Current behavior:**
```javascript
function updateMultiSelectUI() {
  treeContainer.querySelectorAll('.tab-entry[data-tab-id]').forEach(el => {
    const tabId = Number(el.dataset.tabId);
    el.dataset.selected = String(selectedTabIds.has(tabId));
  });
  // ...toolbar rendering...
}
```

**Recommended fix:** Track only the delta — which tab IDs were added/removed from the selection — and update only those DOM elements.

---

#### 2.5 Search Blocks Main Thread
**File:** `sidepanel/modules/search.js:73-106`
**Impact:** `searchTabs()` iterates all tabs synchronously, running `smartSearch()` (fuzzy matching) on both title and URL for each tab. With 200+ tabs and a complex query, this can cause visible jank.

**Current behavior:**
```javascript
for (const [tabId, tab] of Object.entries(tabs)) {
  const titleResult = smartSearch(query, tab.title || '');
  const urlResult = smartSearch(query, tab.url || '');
  // ...scoring...
}
```

**Recommended fix:** For large tab counts (50+), yield to the event loop periodically using chunked processing:
```javascript
async function searchTabsAsync(tabs, query, chunkSize = 50) {
  const entries = Object.entries(tabs);
  const results = [];
  for (let i = 0; i < entries.length; i += chunkSize) {
    const chunk = entries.slice(i, i + chunkSize);
    for (const [tabId, tab] of chunk) {
      // ...existing search logic...
    }
    if (i + chunkSize < entries.length) {
      await new Promise(r => setTimeout(r, 0)); // yield
    }
  }
  return results.sort(/* ... */);
}
```
Note: The existing `debounce` on input already mitigates rapid recomputation. This optimization matters only at 100+ tab scale.

---

### LOW Priority

#### 2.6 Drag-Over Layout Thrashing
**File:** `sidepanel/modules/drag-drop.js:72-104`
**Impact:** `onDragOver` calls `getBoundingClientRect()` on every mouse-move event during a drag. This forces the browser to recalculate layout synchronously.

**Current behavior:** `getBoundingClientRect()` called inside `onDragOver` without throttling (line 87, and in `setDropMode`).

**Recommended fix:** Throttle `onDragOver` to fire at most once per animation frame:
```javascript
let _dragRafId = null;
function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (_dragRafId) return;
  _dragRafId = requestAnimationFrame(() => {
    _dragRafId = null;
    // ...existing drop target logic...
  });
}
```

---

#### 2.7 countDescendants Not Memoized
**File:** `sidepanel/modules/tree-renderer.js:428-441`
**Impact:** Recursively walks all children to count descendants. Called per collapsed parent tab during render. For deeply nested trees, this is redundant work across re-renders when the tree structure hasn't changed.

**Current behavior:**
```javascript
function countDescendants(tab, tabs) {
  let count = 0;
  const walk = (ids) => {
    for (const id of ids) { count++; if (child.children) walk(child.children); }
  };
  if (tab.children) walk(tab.children);
  return count;
}
```

**Recommended fix:** Cache descendant counts by tab ID on the `ShadowState` class. Invalidate when children change (addTab, removeTab, moveTab).

---

#### 2.8 getVisibleTabIds() Queries DOM Repeatedly
**File:** `sidepanel/sidepanel.js:536-539`
**Impact:** Called 4 times during keyboard navigation sequences (`moveFocus`, `focusFirst`, `focusLast`). Each call runs `querySelectorAll` over the entire tree.

**Current behavior:**
```javascript
function getVisibleTabIds() {
  const entries = treeContainer.querySelectorAll('.tab-entry[data-tab-id]');
  return [...entries].map((el) => Number(el.dataset.tabId));
}
```

**Recommended fix:** Cache the result and invalidate on tree re-render. Since keyboard navigation doesn't change the tree, consecutive calls within one event loop tick are redundant.

---

## 3. Defense-in-Depth Security

### HIGH Risk

#### 3.1 session.id Injected Into HTML Without Escaping
**File:** `sidepanel/modules/session-manager.js:182, 188, 193, 295`
**Vector:** `session.id` values from Chrome's sessions API and auto-generated IDs are interpolated directly into HTML attribute values without escaping.

**Current behavior:**
```javascript
return `
  <div class="session-entry" data-session-id="${session.id}">
    <button class="session-restore-btn" data-session-id="${session.id}" ...>
    <button class="session-delete-btn" data-session-id="${session.id}" ...>
  </div>
`;
```

**Risk assessment:** Low exploitation probability (session IDs are typically numeric or UUID-formatted from Chrome APIs), but violates defense-in-depth. If a future code path generates IDs from user input or external data, this becomes an XSS vector.

**Recommended fix:** Wrap all ID interpolations with `escapeHtml()`:
```javascript
data-session-id="${escapeHtml(String(session.id))}"
```

---

#### 3.2 autoGroupRules Not Validated
**File:** `background.js:525-559, 1383`
**Vector:** The `UPDATE_AUTO_GROUP_RULES` handler accepts `payload.rules` directly without schema validation. Rules contain `pattern` (used in URL matching) and `group`/`color` fields.

**Current behavior:**
```javascript
case MSG.UPDATE_AUTO_GROUP_RULES:
  autoGroupRules = payload.rules || [];  // No validation
  saveAutoGroupRules();
```

**Risk assessment:** A compromised or malicious side panel message could inject rules with unexpected types, causing `urlMatchesPattern()` to throw or behave unpredictably. The `pattern` field is used in regex-like matching — malformed patterns could cause ReDoS (Regular Expression Denial of Service).

**Recommended fix:**
```javascript
function validateRule(rule) {
  return (
    rule &&
    typeof rule.pattern === 'string' &&
    rule.pattern.length > 0 &&
    rule.pattern.length < 500 &&
    typeof rule.group === 'string' &&
    rule.group.length > 0 &&
    (!rule.color || typeof rule.color === 'string')
  );
}

case MSG.UPDATE_AUTO_GROUP_RULES: {
  const rules = Array.isArray(payload.rules) ? payload.rules : [];
  autoGroupRules = rules.filter(validateRule);
  saveAutoGroupRules();
  break;
}
```

---

### MEDIUM Risk

#### 3.3 innerHTML Used Alongside Safe el() Helper
**Files:** `sidepanel/sidepanel.js:620, 639, 670, 718, 777` | `sidepanel/modules/command-palette.js:47, 170, 206` | `sidepanel/modules/session-manager.js:60, 146, 170, 305`
**Vector:** The codebase has two rendering patterns — safe `el()` helper (createElement + textContent) in tree-renderer.js, and raw `innerHTML` with template literals in sidepanel.js, session-manager.js, and command-palette.js.

**Risk assessment:** The `innerHTML` usage is partially mitigated by `escapeHtml()` calls on user-visible text. However, the inconsistency increases the chance of future developers forgetting to escape when adding new interpolations.

**Recommended fix:** Adopt the `el()` pattern consistently. For complex HTML structures currently using template literals, consider a small builder helper:
```javascript
function html(strings, ...values) {
  return strings.reduce((acc, str, i) =>
    acc + str + (i < values.length ? escapeHtml(String(values[i])) : ''), '');
}
// Usage: panel.innerHTML = html`<span>${groupName}</span>`;
```
This auto-escapes all interpolated values by default.

---

#### 3.4 Duplicate escapeHtml Implementations
**Files:** `shared/utils.js:220-227` | `sidepanel/modules/command-palette.js:254-258` | `sidepanel/modules/session-manager.js:312-316`

**Issue:** Three separate `escapeHtml` functions exist. The `shared/utils.js` version uses string replacement; the other two use `div.textContent`/`div.innerHTML` DOM trick.

**Risk:** Different implementations may handle edge cases differently (e.g., null/undefined input, non-string types). Maintaining multiple copies increases the chance of one falling out of sync.

**Recommended fix:** Delete the two local copies and import from `shared/utils.js`:
```javascript
import { escapeHtml } from '../../shared/utils.js';
```

---

### LOW Risk

#### 3.5 unlimitedStorage Permission
**File:** `manifest.json:13`
**Issue:** The `unlimitedStorage` permission is declared but may not be necessary. `chrome.storage.local` has a 10MB quota by default, which is sufficient for most tab tree state.

**Risk:** Overly broad permissions reduce user trust and complicate Chrome Web Store review.

**Recommended action:** Audit actual storage usage. If state + sessions + workspaces stay well under 10MB, remove `unlimitedStorage`. If it's needed for large session histories, document why in a comment in manifest.json.

---

## Summary

| Category | Critical (Fixed) | High | Medium | Low |
|----------|:-:|:-:|:-:|:-:|
| Bugs | 4 | — | — | — |
| Performance | — | 2 | 3 | 3 |
| Security | — | 2 | 2 | 1 |

**Recommended implementation order:**
1. Security HIGH items (3.1, 3.2) — low effort, high defensive value
2. Performance HIGH items (2.1, 2.2) — biggest user-facing impact
3. Security MEDIUM items (3.3, 3.4) — consolidation and consistency
4. Performance MEDIUM items (2.3, 2.4, 2.5) — diminishing returns but worthwhile at scale
5. Performance LOW items (2.6, 2.7, 2.8) — micro-optimizations, implement as encountered
