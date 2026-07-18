# Handoff: LinkMap Tab-Group Restart-Fragility — Phase 1

**Plan:** `C:\Users\david.hayes\.claude\plans\did-grok-contribute-anything-binary-gadget.md`
**Outcome:** SUCCEEDED (Phase 1 only)

## Checkpoints
<!-- Resumable state for kraken agent -->
**Task:** Implement Phase 1 (shared/shadow-state.js foundation) as amended by Premortem Amendments A1/A2/A3, per the plan above.
**Started:** 2026-07-12T13:00:00Z
**Last Updated:** 2026-07-12T13:14:22Z

### Phase Status
- Phase 1 (Tests Written): ✓ VALIDATED (15 new tests, confirmed RED before implementation — 14 failures on `node --test tests/shadow-state.test.js`)
- Phase 2 (Implementation): ✓ VALIDATED (all tests green)
- Phase 3 (Refactoring): ✓ VALIDATED (no separate refactor pass needed — implementation written clean on first pass; re-ran full suite post-implementation)
- Phase 4 (Documentation): ✓ VALIDATED (output report + this handoff written)

### Validation State
```json
{
  "test_count": 411,
  "tests_passing": 411,
  "tests_failing": 0,
  "baseline_test_count": 396,
  "new_tests_added": 15,
  "files_modified": [
    "shared/constants.js",
    "shared/shadow-state.js",
    "background/tab-events.js",
    "tests/shadow-state.test.js"
  ],
  "last_test_command": "node --test",
  "last_test_exit_code": 0
}
```

### Resume Context
- Current focus: Phase 1 complete. Plan's Phase 2 (background.js + background/context.js init & retry, amendments A4-A8) is NOT started.
- Next action: If continuing the plan, implement Phase 2 (2a-2f) next, per "Ordering: Phase 0 (premortem) -> 1 -> 2 -> 3 -> {4, 5}". Phase 1 alone already stops permanent destruction of orphaned groups (per plan note).
- Blockers: None. No commit was made — changes are staged only in the working tree per task instructions.

## What's done
- `updateGroup()` persists `windowId` (R3b); `background/tab-events.js` `onGroupUpdated` passes `windowId: group.windowId` through.
- `reconcileWithLiveGroups` no longer hard-deletes orphaned titled groups — quarantines them in `this.orphanedGroups` (24h TTL, 40-entry cap, `console.warn` on eviction).
- Gated resurrection (A1): same-id live group only resurrected when title empty + color matches + windowId maps (or is unmapped).
- Fresh-per-call windowId re-mapping (A2) via `_matchOrphanedGroup`.
- New public `rescueUntitledLiveGroup(liveGroup, now)` for later use by Phase 2's `retryMissingGroupTitles` sweep (not wired up yet — that wiring is Phase 2d/2e, out of scope for this task).
- `orphanedGroups` round-trips through `toSerializable`/`fromStorage`; confirmed NOT exposed via `background/context.js` `getStatePayload()`.

## What's NOT done (future phases per plan)
- Phase 2: `background.js` + `background/context.js` init/retry fixes (2a-2f incl. A4 retry-swap merge, A6 immediate save on init, A7 init-catch restore).
- Phase 3: `background/message-handlers.js` INIT_GATED_TYPES widening (A8).
- Phase 4: drag-drop/membership sync (A9).
- Phase 5: persistence write-through (A10).
- `rescueUntitledLiveGroup` exists but is not yet called from `retryMissingGroupTitles` — that wiring is Phase 2d.

## Verification evidence
`node --test` (run from `C:\Users\david.hayes\Projects\LinkMap`) → `tests 411, pass 411, fail 0, cancelled 0, skipped 0, todo 0`.
