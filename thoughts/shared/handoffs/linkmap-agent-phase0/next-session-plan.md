# Next-Session Plan — LinkMap (Track: A then B hybrid)

```yaml
authored: 2026-07-18 (planning session)
decided_by: Dave — "A then B (hybrid)": close the stability queue, then run cheap agent spikes if time remains
# NOTE: pre_execution_snapshot describes the state BEFORE this session's work.
# For the CURRENT branch/status see "EXECUTION STATUS" below (branch
# fix/stability-queue @ ac4f580, 500 tests) — do NOT branch from the snapshot fields.
pre_execution_snapshot:
  basis: 11-agent verification workflow (wf_746966a8-462) — every open item RE-VERIFIED against master @ 8da7578
         (not the stale branch 743af87 the audit ran on). All 11 confirmed STILL OPEN; file:line re-anchored.
  head: master @ 8da7578, tree clean (only knowledge-tree.json churn)
  tests: node --test from repo root; 474/474 green baseline
current_status: see EXECUTION STATUS section — branch fix/stability-queue, 10/11 done, 500 green, PR #9 open
authoritative_agent_plan: C:\Users\david.hayes\.claude\plans\deep-skipping-stearns.md (elephant-2 gate: agent Phase 1 waits on this queue)
spike_ledger: docs/agent-integration/DESIGN-RESEARCH.md
```

## EXECUTION STATUS (session 3, 2026-07-18→19) — 11/11 DONE, MERGED

Stability queue **CLOSED**. `master` @ `5767d74`, **509/509 green** (474 → 509, +35 tests). Two PRs merged.

| Wave | Items | Commit | Status |
|------|-------|--------|--------|
| A | CR-move2group-unpin, CR-recovery-save, CR-move-pinned, CR-context-persist, CR-favicon-map | `467fcf8` | ✅ PR #9 merged (`f5352aa`) |
| B | A-2, F8, F7, A-7 | `2ee343c`, `17734ab` | ✅ PR #9 merged |
| C | B-2/F9 (+ restart-detection primitive) | `ac4f580` | ✅ PR #9 merged |
| C | **B-1** durable lineage key + anchored re-association | `e595398`, `ed14bbd` | ✅ **PR #10 merged** (`5767d74`) — Codex-adversarial-hardened |

**Two pre-existing reconcile follow-ups** (surfaced by B-1's adversarial review, NOT regressions — see `docs/design/b1-durable-lineage-key.md`): Codex #1 cold-restart same-id collision stranding; Codex #3 Pass 2b cross-origin title graft.

**Orchestration lessons (see project memory):** (1) worktree-isolated workflow agents branch from **master, not the current feature branch** — cherry-pick deltas, don't copy shared files. (2) For a single-cluster wave touching files earlier waves changed, run one agent DIRECTLY on the branch (no worktree). (3) **Always run a cross-model adversarial review on risky/durable changes** — Codex caught two wrong-graft paths in B-1 that self-review missed; harden before merge, and distinguish new findings from pre-existing ones.

**Remaining next-fork:** (A) Track B agent spikes 4-9 (rigs `echo-mcp.mjs`/`ws-probe-server.mjs` need recreating — ephemeral scratchpad wiped); (B) agent Phase 1 spine (elephant-2 cleared); (C) the two pre-existing reconcile follow-ups (#1/#3); (D) theming engine.

## Verified queue (all OPEN on master, re-anchored — snapshot before execution)

| # | Item | File:line (master) | Size | Risk | Notes |
|---|------|--------------------|------|------|-------|
| 1 | CR-move2group-unpin | `background/message-handlers.js:405` | tiny <10 | low | add `context.state.updateTab(payload.tabId,{pinned:false})` before `collectGroupableTabIds` (A10a fixed groupId this way, never pinned) |
| 2 | CR-recovery-save | `background.js:140` | tiny <10 | low | swap debounced `saveState()` → `commitStateNow()` after retry-state swap (already imported) |
| 3 | CR-move-pinned | `background/move-helpers.js:91,185,227` | small | med | add `collectMovableTabIds` (pinned INCLUDED) for `chrome.tabs.move()` calls; keep `collectGroupableTabIds` for group/ungroup. Coordinate w/ B-4 territory (same file 146-173) |
| 4 | CR-context-persist | `background/context.js:67,207` + `background.js:183` | small | low | 3 sub-defects: make `saveStateImmediate` resolve `{success,error}` (never reject — fire-and-forget callers); `await` it at background.js:183; retry-chain must `retryCount++`+re-`attempt()` not `finish()` on one `tabGroups.query` reject |
| 5 | CR-favicon-map | `sidepanel/modules/tree-renderer.js:549` | small | low | generalize existing `failedPinnedFaviconSrcs` Map (pinned path already fixed) into a shared tabId-keyed map used by `buildTabEntry`/`patchElement` too |
| 6 | A-2 | `shared/shadow-state.js:1220-1238` | small | low | titled-restore loses custom hex: add a title-matched rescue tier inside the `if (!group.title)` branch, reusing the colorOverride re-key at :1234/:1332. (watch A-3 same-title-collision surface) |
| 7 | F8 | `shared/shadow-state.js:828/908/949/993` + `background.js:191` + `workspace-ui.js:49,116` | medium | med | `reconcileWithLiveTabs` already has every old→new tabId pair at `replaceTabId` sites; accumulate a `tabIdMap` into its return, then remap `ctx.workspaces[].tabIds` in init() + `saveWorkspaces()`. Fixes empty/wrong workspaces every restart |
| 8 | F7 | `background/sessions.js:409` + `sidepanel.js:104-112,137` | medium | low | one-shot `sendMessage` is dropped (panel not open at SW init). Persist a recovery flag to `chrome.storage.local`; have sidepanel pull/clear on its own init. Secondary: 10-slot auto-save rotation can age out the recovery snapshot (~50 min) |
| 9 | A-7-negKeySeq | `shared/shadow-state.js:1158` + `background/context.js:280` | medium | med | `negativeKeySeq` resets to -1 per call while `orphanedGroups` is persisted → collision overwrite across restarts AND across the `retryState` union. Needs a globally-unique key allocator shared by both call sites |
| 10 | B-2/F9 | `shared/shadow-state.js:866` | large (design) | med | Pass-1 raw tabId trust grafts unrelated tabs + poisons windowId vote map. Real fix needs a **browser-restart-detection signal** (e.g. `chrome.storage.session` marker) threaded init→reconcile — does not exist today |
| 11 | B-1 | `shared/shadow-state.js:977-1000` | large (design) | high | Pass-3 refuses lineage nodes (RR-2 guard :981) → generic/dup/SPA trees flatten to root after restart. Needs a **durable per-node lineage key** survivable across restart (Chrome exposes none). Test `shadow-state.test.js:1231` currently locks in the safe-flatten behavior — a real fix rewrites it |

## Execution order (serialize same-file edits; parallelize disjoint)

Two files are hot (`shared/shadow-state.js` → items 6,7,9,10,11; `background.js` → 2,4,7). Edits to the same file MUST serialize (index.lock + context-carryover risk per proactive-delegation rule). Waves below cluster by file so each wave owns a coherent surface.

**Wave A — CodeRabbit correctness quick-wins (items 1-5).** Mostly disjoint files (message-handlers, background, move-helpers, context, tree-renderer). Highest confidence, lowest risk, closes the PR #8 CodeRabbit burndown. Land + commit first. Each has a named test seam; add the test in the same wave (TDD).
- Note: item 2 (background.js:140) and item 4 (background.js:183) both touch background.js — batch into ONE agent.
- Note: item 3 shares `move-helpers.js` with B-4 — verify B-4 tests stay green.

**Wave B — Stability medium fixes (items 6,7,8,9).**
- 6 (A-2) and 9 (A-7) both edit `shared/shadow-state.js` → serialize (same agent or sequential).
- 7 (F8) edits shadow-state return + background.js + workspace-ui → gate after 6/9 land (shadow-state churn).
- 8 (F7) edits sessions.js + sidepanel.js → disjoint from the shadow-state cluster, can run parallel to it.

**Wave C — Large design items (items 10,11) — DESIGN-FIRST, do not cowboy.**
- Both are "genuine design-level change, not a patch." They share the cross-restart-identity theme; B-2/F9 needs restart-detection, B-1 needs a durable lineage key.
- **Recommend: one `architect` pass producing a short design doc** for (a) the restart-detection primitive (`chrome.storage.session` marker threaded init→reconcile) and (b) the durable lineage key, then decide scope with Dave. The primitive in (a) also sharpens B-2/F9's Pass-1 guard. Realistically these may not fully land this session — that's fine; the queue is "closed" for elephant-2 purposes once 1-9 land and 10/11 have an agreed design + decision.

**Then Track B (spikes 4-9) if time remains** — run from the plan table, record each in `docs/agent-integration/DESIGN-RESEARCH.md`. Spike 4 also verifies M5 (>2-min approval-latency). First relocate the reusable rigs (`echo-mcp.mjs`, `ws-probe-server.mjs`) out of the ephemeral session scratchpad into a permanent harness dir (they are GONE — recreate). Phase 1 must allocate a real 8xxx port from the CCv3 registry (not spike-only 8181).

## Verification discipline (per RULES.md)
- After each wave: `node --test` from repo root, confirm 474+ green (new tests raise the count). Do NOT trust an agent's self-reported pass — orchestrator re-runs.
- Windows: git/push via PowerShell tool (`git -C <repo>`), not Bash (hangs on network).
- Post-plan code-edit gate (plan-to-ralph-enforcer): clear via `/ralph` or delete `$TEMP/claude-plan-approved-*.json` for hands-on work.

## Full evidence
- Verification workflow result: `tasks/w3630avdr.output` (this session) + journal `subagents/workflows/wf_746966a8-462/journal.jsonl`
- Original audit (stale line numbers, kept for narrative): `.claudedocs/group-stability-audit-2026-07-18.md`
- Prior handoff: `thoughts/shared/handoffs/linkmap-agent-phase0/current.md`
