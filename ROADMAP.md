# Project Roadmap

## Current Focus
**Tab-group stability queue CLOSED — 11/11 (2026-07-18→19, session 3).** `master` @ `5767d74`, **509 tests green**, +35 new across two merged PRs. PR #9 = Waves A/B/C (10 items: 5 CodeRabbit correctness fixes, A-2/F8/F7/A-7, B-2/F9 cold-restart primitive). PR #10 = B-1 durable lineage key + cold-restart anchored re-association (the last item). Every fix TDD'd, independently full-suite-gated, and PR-reviewed (PR #10 also went through a cross-model Codex adversarial review that caught two wrong-graft paths, hardened before merge). The elephant-2 gate is now cleared.

**Two pre-existing reconcile issues** surfaced by B-1's adversarial review (NOT regressions — they predate B-1) are filed as follow-ups: cold-restart same-id collision stranding (Codex #1) and Pass 2b cross-origin title graft (Codex #3). See `docs/design/b1-durable-lineage-key.md`.

Next direction — **LinkMap Agent — Codex-Powered Browser Agent (Plan v1)**: stability queue closed → elephant-2 cleared → agent track unlocked. Both architecture-gating spikes already **PASS** (`docs/agent-integration/DESIGN-RESEARCH.md`): Spike 1 — #24135 does NOT reproduce on codex 0.144.1; Spike 2 — panel-owned loopback WebSocket authenticates a real `chrome-extension://<id>` Origin with zero manifest changes.
- Next fork: (A) agent Phase 0 spikes 4-9 (Track B), (B) start agent Phase 1 spine, (C) the two pre-existing reconcile follow-ups (#1/#3), or (D) theming engine. See `thoughts/shared/handoffs/linkmap-agent-phase0/next-session-plan.md`.
- Started: 2026-07-18

## Completed
- [x] **PR #10 merged** — B-1 durable lineage key + cold-restart anchored re-association (stability queue 11/11); Codex adversarial review + hardening; 509 tests (2026-07-19) `5767d74`
- [x] **PR #9 merged** — stability queue 10/11: Waves A (5 CodeRabbit fixes) + B (A-2/F8/F7/A-7) + C (B-2/F9 cold-restart primitive); 500 tests (2026-07-18) `f5352aa`
- [x] **PR #8 merged** — restart-fragility hardening (L-1/L-2, A-1/B-3/A-4/B-4) + Phase 0 agent spikes 1-2 (2026-07-18) `9ce6076`
- [x] fix(groups): normalize quarantine windowId (A-4); repair cross-window group membership (B-4) (2026-07-18) `d7daa06`
- [x] docs(agent): record Phase 0 Spike 1 (#24135) and Spike 2 (panel WS) results (2026-07-18) `c0eae09`
- [x] fix(groups): write-through native rename/recolor (A-1); group descendants in MULTI_GROUP (B-3) (2026-07-18) `52b150a`
- [x] fix(favicons): preserve across restart, harden fallbacks, support file URLs (2026-07-13) `743af87`
- [x] [fix](groups) survive forced restart with quarantine and write-through persistence (2026-07-13) `cb7ecfe`
- [x] Tree-style visualization — stability hardening + bug-hunt (reconciliation correctness, crash prevention, SW lifecycle races); 43-agent review, PR #7 merged, 396 tests (2026-06-22) `902b6cd`
- [x] [fix] window name lost for secondary window after Chrome restart (#9) (2026-03-24) `5fe1084`
- [x] [fix] sticky pinned tabs show only current window's pins (#8) (2026-03-23) `9ce9399`
- [x] [fix] use removeAttribute instead of delete on NamedNodeMap (2026-03-23) `937269e`
- [x] [feat] sticky pinned tabs in multi-window mode (#8) (2026-03-23) `8a21f87`
- [x] [fix] preserve branch relationships across Chrome restart (#7) (2026-03-23) `b3210d0`
- [x] Vertical tabs panel (2026-03-23)
- [x] Core extension scaffold (2026-03-23)
- [x] Task list breakdown (2026-03-23)
- [x] PRD creation (2026-03-23)
- [x] PRD: LinkMap — Vertical Tabs & Link Map Chrome Extension [prd-linkmap.md] (2026-03-23)
- [x] Fix: Branch (Parent-Child) Relationships Lost After Chrome Restart (2026-03-23)
- [x] [feat] keyed DOM reconciliation, Add New Tab button, group context menu, dragover throttling (2026-03-05) `e79fc10`
- [x] [feat] add tab groups, 5 killer features, August Suite themes, and robustness fixes (2026-02-26) `61779b6`
- [x] [fix] resolve async message channel warning, improve Close Tabs Below for nested tabs, fix search favicon fallback (2026-02-26) `0602ff5`
- [x] [fix] resolve init race condition — GET_STATE now waits for initialization (2026-02-26) `0bd1b64`
- [x] Project Setup & Planning (2026-02-26)
- [x] [feat] add drag and drop reordering and reparenting with visual indicators (2026-02-26) `63cdfc1`
- [x] [feat] add tab group color customization with settings panel (2026-02-26) `7a3a7db`
- [x] [feat] add fuzzy search with highlighting and flat result list (2026-02-26) `6fa634b`
- [x] [feat] add tab actions module and custom context menu (2026-02-26) `08d7bc3`
- [x] [feat] implement side panel tree rendering with event delegation (2026-02-26) `56fd389`
- [x] [feat] add theme management module (2026-02-26) `3e154a7`
- [x] [feat] implement background service worker with tab events, persistence, and messaging (2026-02-26) `2f17ead`
- [x] [feat] implement ShadowState class with tree mutations, serialization, and reconciliation (2026-02-26) `243bb95`
- [x] [feat] extension scaffold with manifest, shared utils, side panel shell, and theme CSS (2026-02-26) `00aca5b`
- [x] Project initialization (2026-02-25)

## Planned
- [ ] Pre-existing reconcile follow-ups from B-1 adversarial review: cold-restart same-id collision stranding (Codex #1, high), Pass 2b cross-origin title graft (Codex #3, medium) — see `docs/design/b1-durable-lineage-key.md`
- [ ] Agent Phase 0 spikes 4-9: Neon reconnect, Notion 2025-09-03 upsert, keyring, tokens-per-task, page-action fidelity (medium priority; agent track)
- [ ] Agent Phase 1 — read-only "ask my browser" spine (elephant-2 gate now cleared)
- [ ] B-1 follow-up enhancement: title-based recovery with a safe disambiguation design (anchored pass currently requires exact-url OR title+same-origin) (low)
- [ ] Theming engine (medium priority)

## Recent Planning Sessions
### 2026-07-18: Planning Session
### 2026-07-12: Favicon Fixes + Forced-Restart Verification (LinkMap)
**Key Decisions:**
- Blank favicons: for claude.ai / platform.claude.com (pinned + tree entries) and **grey circles** for `file://` local HTML pages and `chrome://` pages. Root-caused by scout exploration (verified with file:line):
- F2 (to confirm live):: Chromium's `_favicon/` route returns a blank 200 (not an error) on cache miss — `onerror` never fires, image renders as empty pixels. Likely for per-thread claude.ai URLs with no saved icon.
- F3:: `buildPinnedTab` attaches no `onerror` at all (`sidepanel/modules/tree-renderer.js:366-381`); pinned tiles rebuild through this path on every state update.
- Manifest already has the `"favicon"` permission (`manifest.json:16`). Existing coverage: `tests/favicon.test.js` tests only `getFaviconUrl` passthrough/route/default — nothing on preservation or onerror wiring.
- The real group-loss trigger is forced browser termination: (computer restart) — extension reload was a weak test. The implemented quarantine is designed for exactly this (persisted rescue material, 24h TTL, sweep re-arm), but it has only been verified via unit tests + a soft reload. Needs a real forced-kill verification.

### 2026-03-23: Fix: Branch (Parent-Child) Relationships Lost After Chrome Restart
**Key Decisions:**
- The problem: Multiple bugs in the reconciliation cause matching to fail catastrophically after restart, resulting in ALL saved tabs being marked "dead" and removed — destroying all branch relationships.
- After restart, window IDs change — Pass 3 matches NOTHING
- Tabs created between `chrome.tabs.query()` and `initComplete = true` are silently dropped
- Add counter variables at top: `pass1Count`, `pass2Count`, `pass2bCount`, `pass3Count`
- Line 854: `url: tab.url,` → `url: tab.url || tab.pendingUrl || '',` (update pass stores URL into state)
- File: `shared/shadow-state.js` — `reconcileWithLiveTabs()`
- Increment in each pass's matching loop
- Log summary at end: saved count, live count, matches per pass, dead removed, orphans repaired
- Return stats alongside windowIdMap (or just log — keep return value compatible)
