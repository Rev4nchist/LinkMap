# LinkMap Stability — Implementation Guide

> Sequenced, test-driven fix plan for the findings in **STABILITY-REVIEW-2026-06.md**.
> Ordered to fix the highest-impact, lowest-risk items first and to minimize churn in
> shared files. Each item: **what changes · how · test · risk.**

## Working rules

- **Branch:** do this on a feature branch (`fix/stability-hardening-2026-06`), not
  `master` — mirrors the existing PR workflow (#5–#9).
- **TDD:** for every behavioral fix, add a failing test first (Node built-in runner,
  `tests/*.test.js`), then implement, then `node --test "tests/*.test.js"` green.
- **No build step / vanilla ESM** — keep it that way. No new deps.
- **Keep the suite green at every commit.** Baseline: 369 passing (393 after this PR's fixes).
- **Commit per cluster** so each fix is reviewable and revertable.

## Sequencing rationale

Most reconciliation fixes touch `shared/shadow-state.js`, so they're batched into one
cluster (P0-A) to avoid conflicting edits. Restore, lifecycle, and move/error fixes are
in separate files and can follow independently.

---

## P0 — Crash prevention + silent lineage corruption

### P0-A · Reconciliation correctness (`shared/shadow-state.js`)
Covers **RR-1, RR-2, RR-8, RR-6, RR-4**. Do as one cluster; one file.

1. **Build a preliminary windowId map before Pass 2** from Pass-1 (exact-ID) matches, so
   every later pass can disambiguate by *mapped* window. (Today `prelimWindowIdMap` is
   built after Pass 2b — move/duplicate a Pass-1-only version earlier.)
2. **RR-1:** in Pass 2, prefer candidates whose `windowId` maps to `savedNode.windowId`
   before the title/index tiebreak. If ≥2 candidates remain with no unique
   title+index+window winner, **refuse** the match (`continue`) rather than taking
   `candidates[0]`.
3. **RR-8:** in Pass 2b, map `savedNode.windowId` through the prelim map in the tiebreak
   (mirror Pass 3:822). Add a non-trivial-title / same-origin guard for lineage-bearing
   nodes; don't fall back to `candidates[0]` for ambiguous common-title buckets.
4. **RR-2:** in Pass 3, **skip** any saved node with lineage
   (`node.children.length > 0 || node.parentId != null`) — let it fall to dead-removal +
   orphan-repair. Optionally tighten tolerance to ≤1 and require the saved URL itself to
   be generic (newtab/blank).
5. **RR-6:** within each URL/title bucket with multiple saved+live candidates, replace the
   greedy per-node consume with a stable pairing (score on windowId+|Δindex|+title, assign
   best-score-first; or sort-and-zip by index). Largely falls out of #2.
6. **RR-4:** restrict the window-name fallback (877-893) to *propagated* matched IDs (track
   them in a `Set` populated at the replaceTabId sites) so it no-ops instead of matching on
   an ID collision.

**Tests** (`tests/reconciliation.test.js` / `tests/shadow-state.test.js`), each as a
restart scenario (ids reassigned, windowIds changed):
- Same URL pinned in 2 windows → each subtree stays in its own window (RR-1).
- A lineage-bearing saved tab dies; an unrelated tab sits within ±3 → lineage is NOT
  transplanted; the dead node is removed and children re-rooted (RR-2).
- Two tabs share a title across windows post-restart → no cross-window mis-attach (RR-8).
- Two duplicate-URL saved tabs with shifted indices → correct pairing, not swapped (RR-6).
- A named window whose tabs all died → name dropped, never misattributed (RR-4).

**Risk:** medium — this is the most-patched code. Mitigate by adding tests first and
keeping each sub-change a separate commit; the existing 393 tests are the regression net.

### P0-B · Tree-integrity invariants (`shared/shadow-state.js` + `tree-renderer.js`)
Covers **TI-2, TI-1, TI-3** + gap #2 (panel-side cycle).

- **TI-2:**
  - Add `_validateAndRepair()` called at the end of `fromStorage`: walk `rootIds` with a
    visited `Set`, drop any back-edge (remove from `children`, null the `parentId`), drop
    child IDs not present in `tabs`, rebuild `rootIds` from `parentId === null` nodes.
  - Add a visited `Set` to `getVisibleTabs`, `getDescendants`, and `focusOnBranch` so an
    unexpected cycle degrades gracefully instead of overflowing.
  - Mirror the visited-set guard in `tree-renderer.js countDescendants` (gap #2) so a
    cycle can't hang the panel either.
- **TI-1:** first line of `replaceTabId`: `if (oldId === newId) return;`. On collision,
  prefer a shallow detach+delete of `newId` over `removeTab(newId)`'s reparent; bail if
  `newId` is an ancestor/descendant of `oldId` (reuse the moveTab ancestor walk).
- **TI-3:** `delete this.groupColors[groupId]` in `removeGroup` and in the reconcile
  dead-group loop.

**Tests:** `fromStorage` given a cyclic blob returns a repaired acyclic tree (no throw);
`getVisibleTabs`/`getDescendants` on an injected cycle return finite results;
`replaceTabId(5,5)` is a no-op; `removeGroup` clears its `groupColors` entry.

**Risk:** low — purely additive guards; no behavior change on valid data.

### P0-C · Session restore lineage (`background/sessions.js`)
Covers **FM-1, FM-2**.

- **FM-1:** in `createTabsForRestore` (or a pass before the reparent loop), after each
  awaited `chrome.tabs.create`, call `getState().addTab(newTab.id, { ...savedFields,
  parentId: null })`. Idempotent via the existing duplicate guard, so a later `onCreated`
  no-ops. The reparent loop then runs against nodes guaranteed to exist.
- **FM-2:** after the reparent loop, before `commitState()`:
  `for (const oldId of session.data.collapsed || []) { const n = oldToNewId.get(oldId);
  if (n != null) getState().collapsed.add(n); }`.

**Tests** (`tests/session-manager.test.js`): a chrome mock that fires `onCreated` on
`create()` — assert a restored child ends up under its parent (FM-1) and that a saved
collapsed subtree comes back collapsed (FM-2).

**Risk:** medium — touches the restore path; the FM-1 race is timing-dependent, so the
fix (authoritative seeding) is what the test must pin, not the race.

---

## P1 — Lifecycle races + Chrome/tree consistency

### P1-A · Init guards (`background/message-handlers.js`, `background/tab-events.js`, `background.js`)
Covers **SW-1, SW-2, SW-4, SW-3/RR-7**.

- **SW-1:** in `handleMessage`, for the set of state-mutating message types, early-return
  `initDone.then(() => handleMessage(message, _sender, sendResponse)); return true;`.
  Leave pure-Chrome-API cases (activate/close/pin/mute/reload) unguarded. Verify no
  double-`sendResponse` on deferred async cases.
- **SW-2:** buffer the seven dropped events into `pendingEvents` (typed records) and
  extend `drainPendingEvents` with a case per type, de-dup'd against current state.
  Prioritize `onReplaced` + `onGroupRemoved`.
- **SW-3/RR-7:** change the 2 s retry to a *relationship-only re-attach* onto live
  `context.state` (copy improved `parentId`/`rootIds` lineage for tabs present in both)
  instead of swapping the whole object.
- **SW-4:** add `if (!ctx.initComplete) { ctx.activeTabId = activeInfo.tabId; return; }` to
  `onActivated`; don't let init overwrite a fresher activation.

**Tests:** extend `tests/tab-events-buffer.test.js` with the seven newly-buffered event
types (mirror the existing BUG-5 cases); a mutating message received pre-init is applied
after init, not lost.

**Risk:** medium — concurrency. The existing buffer/drain harness is the proven template.

### P1-B · Move/group consistency + error observability (`background/move-helpers.js`, `background/message-handlers.js`, `background.js`)
Covers **DM-1, CAE-3, CAE-2, CAE-1** + gap #9.

- **DM-1:** after `state.moveTab` in `moveTabAsChild`/`moveTabBeforeAfter` (same-window
  branch), compute the flat (depth-first, pinned-aware, group-contiguous) Chrome index and
  `chrome.tabs.move(tabId, {index})`; also set `node.index`. (Provide a
  `flatChromeIndexFor(tabId)` helper.)
- **CAE-3 / CAE-2:** await the group/pinned move and commit in `.then`; on `.catch`, log
  and reconcile from live state (don't just re-broadcast the drifted tree). At minimum,
  add the missing `console.warn`.
- **CAE-1:** `chrome.tabs.query(...).then(([tab]) => { if (tab) return
  chrome.tabs.remove(tab.id); }).catch(() => {});`
- **Gap #9:** audit all `move-helpers` exports; apply the await-then-commit pattern to any
  sibling that mutates the tree before a fire-and-forget Chrome call.

**Tests:** a same-window drag issues `chrome.tabs.move` with the expected flat index and
updates `node.index`; a rejecting group move logs and doesn't leave the tree drifted.

**Risk:** medium — `flatChromeIndexFor` must respect pinned + group contiguity; get that
helper right and tested before wiring it in.

---

## P2 — Privacy, leaks, polish, gap-fixes

- **SM-1** (`shared/constants.js`, `manifest.json`): drop the Google S2 branch. Either add
  the `favicon` permission + use the on-device `_favicon` route, or return
  `DEFAULT_FAVICON`. Test: `getFaviconUrl` never returns a `google.com` URL.
- **TI-3** already in P0-B.
- **RR-5** (`shadow-state.js` + `background.js`): gate the color-only rescue behind a
  per-color uniqueness check; never write a color-only-rescued title back to Chrome.
- **LG-2** (`sidepanel.js`): in `handleStateUpdate`, intersect `selectedTabIds` and
  `collapsedWindowIds` with the live payload's tab/window IDs.
- **DM-3** (`drag-drop.js`): on dragstart of a selected tab, clear the selection + refresh
  the toolbar (thread `getSelectedTabIds`/`updateMultiSelectUI` into `initDragDrop`).
- **LG-1** (`tree-renderer.js`): *profile first.* Only if 200-tab jank is observed,
  memoize built entries by key and rebuild on changed fields.
- **Gap #1** (`session-manager.js:215`): wrap `data-window-id` in `Number()` /
  `escapeHtml`; audit `settings.js` / `sidepanel.js` innerHTML blocks for unescaped
  state-derived strings.
- **Gap #3** (`sidepanel.js`/`search.js`): re-run the search filter on `STATE_UPDATE` while
  active, or re-validate result rows against live tabs so closed tabs drop out.
- **SM-3** / gap #7: privacy policy + sender-allowlist on destructive ops — productization,
  schedule with Web-Store prep.

---

## Verification checklist (per cluster)

- [ ] Failing test written first, then made green.
- [ ] `node --test "tests/*.test.js"` — full suite green (≥393).
- [ ] No new `console.error` in a manual load-unpacked smoke (reconcile a restart,
      drag/reorder, restore a session, switch theme).
- [ ] Diff is minimal and scoped to the cluster.
- [ ] Commit with a descriptive message; one cluster per commit/PR.

## Suggested commit sequence

1. `test+fix(reconcile): windowId-aware matching, skip positional lineage guess (RR-1/2/8/6/4)`
2. `fix(shadow-state): fromStorage validate/repair + cycle guards + groupColors prune (TI-2/1/3)`
3. `fix(sessions): authoritative addTab on restore + restore collapsed state (FM-1/2)`
4. `fix(sw): gate mutating handlers + buffer dropped events + retry re-attach (SW-1/2/3/4)`
5. `fix(moves): sync same-window drag to Chrome + observe move rejections (DM-1/CAE-1/2/3)`
6. `fix(privacy+polish): local favicons, prune stale sets, escape window-id (SM-1/LG-2/DM-3/gap1)`
