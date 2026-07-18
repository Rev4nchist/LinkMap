# Handoff: LinkMap Restart-Fragility + Favicon Fixes

```yaml
outcome: PARTIAL_PLUS
date: 2026-07-12
session_scope: tri-model code review → restart-cluster fix (implemented+verified) → favicon plan (premortemed, ready to implement)
branch: master (dirty — restart-cluster work UNCOMMITTED; first action is the checkpoint commit)
plan_file: C:\Users\david.hayes\.claude\plans\did-grok-contribute-anything-binary-gadget.md  # AUTHORITATIVE, incl. Codex amendments C1-C6
```

## Goal

1. Commit the completed restart-fragility cluster fix (Phase A).
2. Implement the favicon fixes (Phase B, as amended by C1-C3).
3. Live-verify `_favicon` behavior + visuals (Phase C, as amended by C4).
4. Run the forced-kill verification protocol (Phase D, as amended by C5) — THE user-priority test: groups vanish on computer-restart (forced Chrome termination), not on soft reload.

## Done (verified)

- Tri-model code review (5 Claude finders + sleuth + Codex + Grok, 36 confirmed findings): report `.claudedocs/code-review-tri-model-2026-07-11.md`.
- Restart-fragility cluster R1-R7 implemented across 3 kraken waves per the earlier plan (superseded in the plan file, recoverable from git history of the plan or the report): persisted `orphanedGroups` quarantine in ShadowState (24h TTL, cap 40, gated resurrection, per-reconcile windowId re-mapping), init `finally` liveness + savedData restore on catch, immediate saves (debounce-cancelling) at group-structural sites, widened INIT_GATED_TYPES + INIT_GATED_ASYNC response-channel fix, drag-out ungroup + `collectGroupableTabIds` subtree semantics + cross-window move-then-group, MULTI_GROUP pinned filter, onSuspend through immediate serializer.
- Suite: 396 baseline → **449/449 green** (orchestrator-verified 3×, `node --test`, no package.json — Node built-in runner).
- Favicon bug root-caused (scout report facts embedded in plan Context): F1 reconcile clobber `shadow-state.js:1051` (primary), F3 pinned no-onerror, F4 onerror self-null + patch loses it, F5 non-http schemes never try `_favicon`; F2 blank-200 cache-miss hypothesis pending live check. Manifest already has `favicon` permission.
- Codex premortem on the favicon plan folded in as amendments C1-C6 (oscillation guard, URL-match preservation gate, scheme allowlist, pixel-level verification, kill-test evidence requirements + profile pinning, commit hygiene).

## Next (in order)

1. **Phase A** — `git checkout -b fix/restart-fragility`; commit source+tests (`fix(groups): ...`), then hook-churn (`chore: ...`) back-to-back (C6). `.claude/logs/`, `thoughts/` etc. are untracked operational dirs — leave them out.
2. **Phase B** — favicon fixes via kraken (plan-to-ralph enforcer blocks direct edits post-plan; delegated agents are the sanctioned path). Honor C1 (failedSrc memo), C2 (URL-match gate on preservation), C3 (allowlist http/https/file). Tests per plan. Full `node --test` green (449 + new). Commit.
3. **Phase C** — reload unpacked extension; pixel-verify `_favicon` responses (C4 — canvas decode, not status); screenshot side panel; only add origin-fallback if proven needed.
4. **Phase D** — forced-kill matrix per C5. Warn the user IMMEDIATELY before each `taskkill /F /IM chrome.exe` (all Chrome windows close — user pre-consented to the automated test but wants the heads-up). Capture chrome.exe args first; require orphanedGroups non-empty→drained evidence; inconclusive ≠ pass.

## Key knowledge (hard-won this session)

- Tests: `node --test` from repo root; summary via `--test-reporter` or grep `^ℹ`. Baseline MUST stay green; conventions: real ShadowState + RR-x describes (shadow-state.test.js), `createChromeMock()` + cache-busted dynamic import + `mock.timers` (background.test.js), hand-built context factories (init-gate.test.js).
- Full-file Reads of big sources are TLDR-hook-gated — use offset/limit.
- Bash tool can hang on git/network when GitHub is slow — PowerShell tool fallback (`git -C <repo>`).
- Grok CLI cold-starts 2-3 min; codex-adversary can exit 143 on the Bash timeout with a COMPLETE `-o` file — verify before assuming failure (bump timeout for plan-mode reviews).
- Two open follow-ups (documented, out of scope): (1) the pre-existing 2s retry's "swap if improved" condition is provably dead code — `fromStorage()` doesn't deep-clone, first reconcile mutates the shared savedData nodes (kraken repro); (2) latent test-isolation gap in background.test.js (stale 500ms debounce leaks across sibling tests); (3) tab-tree lineage across crash-bubble restore is a known residual (groups covered by quarantine, lineage is not).
- Memory file updated: `~/.claude/projects/C--Users-david-hayes-Projects-LinkMap/memory/project_tri-model-review-2026-07-11.md`.

## Blockers

None. Phase D needs the user present (kill test closes their browser).
