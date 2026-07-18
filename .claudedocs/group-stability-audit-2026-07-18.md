# LinkMap Group-Stability Audit — 2026-07-18

36-agent workflow (3 tracers + 33 adversarial verifiers) over branch `fix/restart-fragility` (HEAD 743af87), answering: **will a named group ('personalportal') and drag-grouped tabs survive all restarts/restores?** Plus two live bugs reproduced by the user this session, root-caused inline.

## Verdict

Massively better than the pre-fix state — 10 of the 25 tri-model restart findings are verified FIXED by cb7ecfe (quarantine + write-through), and the primary "groups vanish on restart" loss path is closed. But **not yet fully trustworthy**: 2 high-severity persistence gaps hit the exact 'personalportal' scenario, 2 high-severity gaps hit drag-built trees, and two live UX bugs (bottom-migration, missing group header) make organization *appear* broken even when persisted.

## Live bugs reproduced this session (root-caused, verified inline)

### L-1 [HIGH] Groups migrate to the bottom of the sidebar
`enforceGroupContiguity()` (`shared/shadow-state.js:585-615`) buckets UNGROUPED as if it were a group: the first ungrouped root pulls **all** ungrouped roots to its position (:606-610), so any group below at least one ungrouped tab sinks under the entire ungrouped block. Runs at `shadow-state.js:1084` inside `reconcileWithLiveTabs` → fires on **every MV3 service-worker wake** (~every idle cycle), not just restarts. `MOVE_GROUP` itself is correct (`message-handlers.js:355-386`). Workflow corroboration: B-6 (rated low there only because the renderer wasn't checked; renderer check confirms rootIds render interleaved → fully user-visible).
**Fix shape (~10 lines):** emit ungrouped roots in place; coalesce only real groups at first-occurrence. Check `tests/shadow-state.test.js:747-843` for encoded buggy expectations.

### L-2 [HIGH] Chrome-created group renders with no title bar when its tabs are nested children
Group header is emitted only when a **root** tab carries the groupId (`tree-renderer.js:143-156`); `renderSubtree` (:206-220) has no header logic and `windowGroupCounts` (:131-139) counts roots only. Tabs opened from links live as shadow children → grouping them in Chrome's strip yields tabs with groupId but no root carrier → no header, no collapse/rename/color affordance, wrong counts (user's "MCP" group screenshot).
**Fix direction (design choice):** emit header at first rendered tab carrying the groupId (root or descendant), or hoist grouped tabs to roots under their header (Chrome group membership is strip-level truth).

## Fixed (verified against current tree)

| ID | Was |
|----|-----|
| F2 | init failure left initComplete=false forever → `finally` always flips + drains + restores snapshot |
| F3/F15 | groupColors lost on restart → quarantine carries colorOverride, re-keyed on rescue; SET_GROUP_COLOR write-through |
| F4 | cross-window drop dropped group membership → `syncGroupAfterWindowMove` |
| F5 | drag-out never ungrouped → targetGroupId always sent; UNGROUPED triggers `chrome.tabs.ungroup` |
| F6 | parent+children grouped only parent → `collectGroupableTabIds` at every call site |
| F10 | retry computed group counts post-reconcile → pre-reconcile snapshot passed through |
| F11 | MOVE_TO_GROUP missing from init gate → gated, channel kept open |
| F23 | updateGroup dropped windowId → persisted, rescue keys well-formed |

Core mechanism: titled orphans quarantine (24h TTL, cap 40, 3-tier rescue: color:window:count → color:window → unique color) + `commitStateNow()` write-through on all group-structural mutations.

## Confirmed open — Scenario A (named group 'personalportal')

| ID | Sev | Issue |
|----|-----|-------|
| A-1 | HIGH | **Native tab-strip rename persists only via 500ms debounce** (`tab-events.js:259`); forced kill inside the window loses the name, and empty-title groups never enter quarantine → unrecoverable. (Panel-side rename is write-through and safe.) |
| A-4 | HIGH | **Sweep rescue never receives windowIdMap** → progressive restore with ≥2 same-color quarantined groups rescues NEITHER title, ever (colorOnlyCount>1 refusal, `shadow-state.js:1276`); titles silently expire at 24h TTL. |
| A-2 | MED | Custom hex color evaporates on every **normal** restart (Chrome restores title under new id → group never enters rescue path → colorOverride sits unused in quarantine). |
| A-3 | MED | Stale quarantine title can mis-attach onto a deliberately-unnamed new same-color group (renames it in Chrome too), up to 24h. |
| A-5/A-6 | MED | Sweep window bounded ~14s; unmapped windows make resurrection gate vacuously permissive after forced kill. |
| A-7/A-9/A-10 | LOW | Negative-key collision; stale count tier; suppress-burst rename drop. |

## Confirmed open — Scenario B (drag-grouped tabs / tree nesting)

| ID | Sev | Issue |
|----|-----|-------|
| B-1 | HIGH | **Parent-child nesting has no durable key** — Pass 3 refuses lineage nodes; duplicates/SPAs/generic pages flatten to root after restart. The standing residual. |
| B-2 | HIGH | **Pass-1 raw tabId trust** (`shadow-state.js:857-863`) — cross-session id collision grafts an unrelated tab into the organized tree AND poisons the windowId vote map (comment at :833 claiming otherwise is false). = F9. |
| B-3 | MED | MULTI_GROUP (multi-select → Group) still groups only selected ids, no descendants → panel/Chrome divergence, restart ejects children. |
| B-4 | MED | Cross-window regroup failure after window move is log-only, no repair. |
| B-5/B-7 | LOW | Sub-500ms nesting loss on hard kill (nesting is the one datum with no Chrome backup); shadow-side groupId compare race. |

## Confirmed open — general (from the 25-finding matrix)

- **F7 [HIGH]** crash-recovery banner still structurally unreachable at restart (one-shot sendMessage, no receiver, no persisted flag); 10-slot auto-save rotation eats the recovery snapshot (~50 min).
- **F8 [HIGH]** workspace tabIds never remapped across restart → workspaces empty/wrong every restart.
- **F12/F14 [MED]** auto-grouper: no groupId guard on onCreated (yanks restored tabs out of user groups); title match across all windows (teleports tabs between windows).
- **F13 [MED]** retry gate still lineage-only — flat groups get no tab-level retry (quarantine is their only net).
- F16–F18, F24, F25 [MED/LOW] pinned-reorder off-by-one, GET_STATE version race, session-list refresh race, init-window opener lineage loss, stale multi-select set.
- F19–F22 partially-fixed residuals rated low/deliberate (sub-500ms debounce tail on non-structural moves).

## Recommended fix order (for the "confidently organize" goal)

1. **L-1 contiguity bottom-migration** — small, verified, fires constantly, destroys perceived ordering.
2. **L-2 group header for nested grouped tabs** — makes Chrome-created groups manageable in the panel.
3. **A-1** — write-through on onGroupUpdated title/color changes (make native renames as safe as panel renames).
4. **B-3** — MULTI_GROUP descendants via `collectGroupableTabIds` (one-line-ish parity fix).
5. **A-4 + A-2** — pass windowIdMap into the sweep; run color-override re-key on the titled-restore path.
6. **B-2/F9** — validate Pass-1 matches (URL/title sanity or session-nonce to distinguish SW-wake from browser restart).
7. **F8** workspaces remap, **F7** persisted crash flag + pull path, **B-1** durable lineage key (bigger design work).

Full evidence: workflow output `wid2r9l9w.output` (scratchpad tasks dir); journal at `.claude/projects/.../subagents/workflows/wf_259cb84a-5a8/journal.jsonl`.
