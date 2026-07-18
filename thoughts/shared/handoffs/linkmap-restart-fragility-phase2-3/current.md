# Handoff: LinkMap Tab-Group Restart-Fragility — Phase 2 + 3

**Plan:** `C:\Users\david.hayes\.claude\plans\did-grok-contribute-anything-binary-gadget.md` (as amended by "Premortem Amendments" A4-A8)
**Outcome:** IN PROGRESS

## Checkpoints
<!-- Resumable state for kraken agent -->
**Task:** Implement Phase 2 (background.js + background/context.js + background/tab-events.js init & retry) and Phase 3 (background/message-handlers.js gating widen, A8) per the plan, as amended.
**Started:** 2026-07-12T00:00:00Z
**Last Updated:** 2026-07-12T00:00:00Z

### Phase Status
- Phase 1 (Tests Written): VALIDATED (12 new tests, confirmed RED before implementation)
- Phase 2 (Implementation): VALIDATED (all tests green — 423/423, up from 411 baseline)
- Phase 3 (Refactoring): VALIDATED (extracted reconcileRetryGroups() as a clean, testable unit; no separate pass needed)
- Phase 4 (Documentation): VALIDATED (this handoff + kraken output report)

### Validation State
```json
{
  "test_count": 423,
  "tests_passing": 423,
  "tests_failing": 0,
  "baseline_test_count": 411,
  "new_tests_added": 12,
  "files_modified": [
    "background.js",
    "background/context.js",
    "background/tab-events.js",
    "background/message-handlers.js",
    "shared/utils.js",
    "tests/background.test.js",
    "tests/init-gate.test.js"
  ],
  "last_test_command": "node --test",
  "last_test_exit_code": 0
}
```

### Resume Context
- Current focus: designing tests for RR-10, A4, SW-5, A6, A5, 2d, and A8 gating; then implementing background.js/context.js/tab-events.js/message-handlers.js/shared/utils.js.
- Next action: write test additions to tests/background.test.js and tests/init-gate.test.js, confirm RED, then implement.
- Blockers: None.

## Design decisions (for resume continuity)
- debounce() in shared/utils.js gets a `.cancel()` method (non-breaking) — used by context.js saveStateImmediate to cancel a pending debounced saveState (A6).
- background.js init(): retryGroups query + retryState.reconcileWithLiveGroups(...) moved to run BEFORE `context.state = retryState` swap (was after); A4 merge runs after retryState's own group reconcile but before the swap. 2a: pass outer-closure `savedGroupTabCounts` (pre-any-reconcile snapshot) directly instead of recomputing from retryState.tabs post-reconcile.
- context.js retryMissingGroupTitles(): adds module-scoped (per createContext() closure) sweepInFlight/sweepRerunRequested single-flight guard (A5a), and calls state.rescueUntitledLiveGroup(g) in the untitled-live-group branch (2d), pushing the rescued title to chrome.tabGroups.update.
- tab-events.js onGroupCreated: post-init, if group untitled and context.state.orphanedGroups.size > 0, call context.retryMissingGroupTitles() (2e).
- message-handlers.js: add MOVE_TO_GROUP/UNGROUP_TAB/MULTI_GROUP/GET_SETTINGS/GET_WORKSPACES/GET_AUTO_GROUP_RULES to INIT_GATED_TYPES; new INIT_GATED_ASYNC set (only handlers that call sendResponse); gate branch returns INIT_GATED_ASYNC.has(type) instead of undefined (A8).

## Verification evidence
`node --test` (run from `C:\Users\david.hayes\Projects\LinkMap`) -> `tests 423, pass 423, fail 0, cancelled 0, skipped 0, todo 0`.

## Significant finding (out of scope, flagged for follow-up)
The 2s retry's "swap in if it improved reconciliation" condition
(`retryStats.survivingRelationships > stats.survivingRelationships`) is
mathematically unreachable via any tab-lineage-LOSS scenario, because
`background.js`'s retry rebuilds `retryState` from the SAME `savedData`
object reference the main reconcile already ran against — `ShadowState.fromStorage`
does not deep-clone node objects, and `removeTab`/`replaceTabId`/
`_validateAndRepair`'s parentId-authoritative walk all mutate shared node
objects (children arrays, parentId, tabId) in place. Any relationship the
main pass loses is therefore ALREADY destroyed in `savedData` by the time
the retry rebuilds from it — the retry can never show MORE surviving
relationships than the main pass did. This was empirically verified (a
repro script matched hand-analysis) and is why RR-10/A4 are tested via the
extracted `reconcileRetryGroups()` unit directly rather than a full
end-to-end retry trigger. Root fix would be deep-cloning in `ShadowState.fromStorage`
or having the retry re-fetch storage instead of reusing the closure's
`savedData` — not attempted here, outside Phase 2/3's declared scope.

## What's done (Phase 2 + 3)
- 2a: retry's group reconcile passes the pre-reconcile `savedGroupTabCounts`
  snapshot verbatim (no post-reconcile recompute).
- A4: new exported `reconcileRetryGroups()` in `background/context.js` runs
  retryState's own group reconcile then merges live-state group
  title/color/collapsed, groupColors overrides, orphanedGroups (union, live
  wins), and windowNames into retryState before the swap.
- 2c/A7: `chrome.windows.getCurrent()` + active-tab query wrapped in an
  inner try/catch (benign failure, doesn't abort init). Outer catch always
  restores `context.state` from `savedData` when present, never saves.
  `initComplete`/drain/sweep/broadcast moved into a `finally` block (R6).
- A6: `saveStateImmediate()` (already existed from Phase 1 scaffolding) now
  cancels a pending debounced `saveState` via a new `debounce().cancel()`
  capability in `shared/utils.js`. Init's end-of-function save now uses it.
- 2d: `retryMissingGroupTitles()` sweep tries `state.rescueUntitledLiveGroup(g)`
  when a live group is untitled and Chrome also reports no title, pushing a
  rescued title via `chrome.tabGroups.update`.
- A5a: `retryMissingGroupTitles()` single-flights (in-flight flag + queued
  rerun) so a 2e re-trigger during an active sweep doesn't run concurrently.
- 2e: `tab-events.js` `onGroupCreated` re-arms the sweep when a live group
  arrives untitled and quarantine is non-empty (covers late restores beyond
  the 14s sweep window).
- A8: `message-handlers.js` `INIT_GATED_TYPES` widened with `MOVE_TO_GROUP`,
  `UNGROUP_TAB`, `MULTI_GROUP`, `GET_SETTINGS`, `GET_WORKSPACES`,
  `GET_AUTO_GROUP_RULES`; new `INIT_GATED_ASYNC` set controls which gated
  types keep the response channel open when deferred pre-init.

## What's NOT done (future phases per plan)
- Phase 4: drag-drop/membership sync (A9).
- Phase 5: persistence write-through (A10) — `commitStateNow()` not yet
  created; call-site swaps not started.
