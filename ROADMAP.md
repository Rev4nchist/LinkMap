# Project Roadmap

## Current Focus

**Tree-style visualization**
- Started: 2026-03-23



## Completed
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
- [ ] Theming engine (medium priority)

## Recent Planning Sessions
### 2026-03-23: Fix: Branch (Parent-Child) Relationships Lost After Chrome Restart
**Key Decisions:**
- The problem: Multiple bugs in the reconciliation cause matching to fail catastrophically after restart, resulting in ALL saved tabs being marked "dead" and removed — destroying all branch relationships.
- After restart, window IDs change — Pass 3 matches NOTHING
- Tabs created between `chrome.tabs.query()` and `initComplete = true` are silently dropped
- Add counter variables at top: `pass1Count`, `pass2Count`, `pass2bCount`, `pass3Count`
- Line 854: `url: tab.url,` → `url: tab.url || tab.pendingUrl || '',` (update pass stores URL into state)

**Implementation:**
- File: `shared/shadow-state.js` — `reconcileWithLiveTabs()`
- Add counter variables at top: `pass1Count`, `pass2Count`, `pass2bCount`, `pass3Count`
- Increment in each pass's matching loop
- Log summary at end: saved count, live count, matches per pass, dead removed, orphans repaired
- Return stats alongside windowIdMap (or just log — keep return value compatible)

**Files:** shared/shadow-state.js, background/tab-events.js, background.js, tests/shadow-state.test.js

**Verification:** Run existing tests: `npx vitest run` — ensure no regressions
