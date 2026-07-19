# Handoff: Pre-existing reconcile follow-ups (#6 / #7)

```yaml
goal: Fix the two pre-existing cold-restart reconcile data-integrity bugs surfaced by B-1's adversarial review.
scope: shared/shadow-state.js reconcileWithLiveTabs (Pass 1 gate + dead-sweep for #6; Pass 2b title-match for #7). Data-integrity, cold-restart.
branch: master @ 1a18da2 (create a fresh feature branch, e.g. fix/reconcile-cold-restart-integrity)
tests: node --test from repo root (Node built-in, no package.json). Baseline 509 green.
priority: #6 (Codex #1) HIGH — wrong-graft + lost lineage. #7 (Codex #3) MEDIUM — cross-origin wrong-graft.
tasks: TaskGet #6 (same-id collision) and #7 (Pass 2b cross-origin) for the filed one-liners.
source_review: docs/design/b1-durable-lineage-key.md "As-shipped hardening" section; codex-adversary output was on PR #10's diff.
provenance: BOTH predate B-1 (from B-2 / PR #8). B-1's anchored pass mirrors but did not introduce them; B-1 already guards its OWN path against #7 (exact-url OR title+same-origin) — this work extends the same discipline to Pass 1/2b.
```

## KICKOFF PROMPT (paste to start the session)

> Fix the two pre-existing cold-restart reconcile data-integrity bugs in LinkMap (`shared/shadow-state.js`, `reconcileWithLiveTabs`), documented in `thoughts/shared/handoffs/reconcile-followups/current.md`. Start on a fresh feature branch off `master`. Work TDD (write a failing regression test that reproduces each bug FIRST — use a `_dbg.mjs` harness at repo root to trace which reconcile pass actually fires before trusting any test; Pass 1/2/2b greedily intercept cases). Fix #6 (same-id collision stranding) then #7 (Pass 2b cross-origin graft). Keep all 509 existing tests green. After both fixes, run a cross-model `codex-adversary` review on the diff before pushing. Then push, open a PR against master, wait for CodeRabbit, address valid findings, and merge when clean. These are data-integrity fixes — default to REFUSE-by-default over any risky graft, exactly as B-1's anchored pass does.

---

## #6 — Cold-restart same-id collision strands a saved node (Codex #1, HIGH, conf 0.97)

**Verified mechanism (traced on master @ 1a18da2):**
- **Pass 1** (`shared/shadow-state.js:933-951`): on `coldRestart`, a saved id where `liveById.has(id)` is true but corroboration fails (`:936-944`) sets `accept=false` → the node is NOT added to `matchedLiveIds`.
- **Pass 2 / 2b / anchored / Pass 3** (`:956`, `:1004`, `:1087`, `:1140`): every one gates on `!matchedLiveIds.has(id) && !liveById.has(id)`. Since `liveById.has(id)` is TRUE (an unrelated live tab reused that raw id), the stranded node is excluded from ALL recovery passes.
- **Dead-sweep** (`:1171-1174`): `deadIds` collects only `!liveById.has(id)` → the stranded node is NOT swept either.
- **Update loop (b)** (`:1229-1232+`): `existingNode = this.tabs.get(tab.id)` finds the stale stranded node for the unrelated live tab's id; `updateTab` overwrites its cosmetic fields (title/url/etc. — `MUTABLE_PROPS` only, never `parentId`/`children`) while it keeps its OLD lineage position.

**Failure scenario:** Saved parent 1 has saved child 42. On cold restart Chrome reissues low ids; live tab 42 is now an UNRELATED tab, and the true reincarnation of child 42 comes up as live id 102. Pass 1 rejects 42 (no url/title match). All later passes + dead-sweep skip it (`liveById.has(42)` true). The update loop overwrites node 42's content with the unrelated tab's data while parent 1's `children` still lists 42 → the unrelated tab is grafted into the saved tree as parent 1's child, and tab 102 (the real child) is added as a NEW ROOT — lineage lost. `_validateAndRepair` can't catch this (it only checks structural integrity, never content plausibility).

**Fix direction:** the `!liveById.has(id)` proxy for "still present as itself" is wrong on cold restart. Track Pass-1 corroboration-rejects explicitly (e.g. a `pass1Rejected` Set of saved ids that had `liveById.has(id)` but failed corroboration), then treat them as genuinely unmatched:
- In the Pass 2 / 2b / anchored / Pass 3 gates, use `(!liveById.has(id) || pass1Rejected.has(id))` so a rejected node CAN re-match its true reincarnation by url/title.
- In dead-sweep (`:1171-1174`), likewise sweep a still-unmatched rejected node so a stranded node is removed rather than content-overwritten. (After a successful re-match its key becomes the live id via `replaceTabId`, so it's naturally not dead.)
- Watch: the unrelated live tab (id 42) is a genuinely new tab and SHOULD be added as a root by the update loop — that's correct once the stale node is either re-matched away or swept.

**Test seam:** `tests/shadow-state.test.js` — add a cold-restart coincidental-raw-id-collision case: saved parent+child where the child's saved id equals an unrelated live tab's id, and the child's true tab appears under a different id. Assert (a) the unrelated tab is NOT grafted under the parent, (b) the true child re-attaches OR is cleanly re-rooted, (c) no stale node lingers. Trace with `_dbg.mjs` first — confirm which pass currently mishandles it.

## #7 — Pass 2b grafts lineage cross-origin on title alone (Codex #3, MEDIUM, conf 0.90)

**Verified mechanism:** Pass 2b (`shared/shadow-state.js:1001-1050`) matches a url-changed tab to a live tab by TITLE with **no origin check**. So a url-changed child can be grafted onto a same-title but cross-origin (unrelated) live tab. Confirmed live during B-1 work: a child saved as `docs.example/report-draft` (title "Report") was matched by Pass 2b to `evil.example/report` purely because the title matched.

**Why it matters / relation to B-1:** B-1's anchored pass was hardened to require **exact-url OR (title + same-origin)** (`:1055-1075` — `isAnchorCorroborated`, `sameOrigin`). Pass 2b — which fires FIRST and handles the same title-recovery case — was intentionally left unchanged to keep the B-1 PR scoped. This task closes that gap.

**Fix direction:** extend the same-origin discipline to Pass 2b's title-match path — require the saved node's url and the candidate live tab's url to share an origin before a title-only match grafts lineage (reuse a `sameOrigin(a,b)` helper: `try { new URL(a).origin === new URL(b).origin } catch { return false }`). Preserve the existing window-aware / refuse-ambiguous behavior (RR-1/RR-8). Note: a same-title, same-origin, different-path change (the legit SPA/redirect case) MUST still match — only cross-origin title matches should be refused.

**Test seam:** `tests/shadow-state.test.js` (Pass 2b / RR-8 blocks, ~`:1459`). Add: a url-changed child whose title matches a live tab on a DIFFERENT origin → NOT grafted; and a same-origin different-path change → still matches (regression that the fix doesn't over-refuse legit SPA recovery).

---

## Shared instructions / resources

- **Debug harness technique (load-bearing):** create `_dbg.mjs` at repo root (import `./shared/shadow-state.js`, build a `ShadowState`, call `reconcileWithLiveTabs`, print `stats` — which includes `pass1/pass2/pass2b/passAnchor/pass3/deadRemoved` — and the resulting tree), run `node _dbg.mjs`, then `rm _dbg.mjs`. Passes 2/2b greedily intercept most same-title/same-url cases, so a test you *think* exercises one pass often fires a different one. ALWAYS confirm which pass fires before trusting a regression test. (This is exactly what re-scoped the B-1 risk analysis.)
- **Verification:** `node --test` from repo root after each fix (baseline 509, +N new tests). Then a `codex-adversary` review on the committed diff before pushing (it caught two wrong-grafts in B-1 that self-review missed — see memory `feedback_adversarial_review_catches_wrong_grafts`). Independently re-verify each adversary finding against the code.
- **Orchestration lessons (memory):** worktree-isolated workflow agents branch from **master, not your feature branch** — cherry-pick deltas, don't copy shared files (`feedback_workflow_worktree_branches_from_master`). For a single hot file (shadow-state.js is edited by both #6 and #7), a single agent directly on the branch avoids the merge dance.
- **Windows/git:** use the PowerShell tool for git/`gh` (`git -C <repo>`), not the Bash tool (hangs on network). PRs via `gh api` / `gh pr create` with all flags. Remote is `origin` = `Rev4nchist/LinkMap`; PRs target `master`.
- **Key files:** `shared/shadow-state.js` (reconcileWithLiveTabs), `tests/shadow-state.test.js`, `docs/design/b1-durable-lineage-key.md` (design context + follow-up descriptions).
- **Sequencing:** do #6 first (higher severity, more invasive — touches the gate proxy + dead-sweep), verify green, then #7 (localized to Pass 2b). Consider whether to ship as one PR (both are cold-restart reconcile integrity) or two. One PR is fine given they're closely related and both small.

## Risk notes
- #6's gate change touches the CORE reconcile matching used by every restart — re-run the full suite and pay attention to the existing RR-1/RR-2a/RR-2b/RR-8/B-2 cold-restart tests (they lock in the current correct behavior; your change must keep them green).
- Both are data-integrity: a wrong fix could corrupt the tree. Refuse-by-default. Prefer "sweep/re-root the ambiguous node" over "guess a graft."
- `_validateAndRepair` is a structural safety net only — it will NOT catch a content-level wrong-graft, so tests must assert actual lineage, not just structural validity.
