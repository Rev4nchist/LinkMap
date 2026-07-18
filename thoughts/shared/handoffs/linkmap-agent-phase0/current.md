# Handoff: LinkMap Agent — Phase 0 (Codex-powered browser agent) + stability queue

```yaml
outcome: SUCCEEDED
date: 2026-07-18 (session 2)
session_scope: >
  dual-track session. Verified 0058574 live in Chrome. Ran the two architecture-gating
  Phase 0 spikes (both PASS). Fixed + tested stability items A-1, B-3, A-4, B-4.
  Opened, CodeRabbit-triaged, and MERGED PR #8. ROADMAP + docs organized on master.
branch: master (PR #8 merged as 9ce6076; fix/restart-fragility deleted)
pr: https://github.com/Rev4nchist/LinkMap/pull/8  (MERGED 2026-07-18)
head: master @ 2a7c117
plan_file: C:\Users\david.hayes\.claude\plans\deep-skipping-stearns.md  # AUTHORITATIVE agent plan, incl. Risk Mitigations M1-M11
spike_ledger: docs/agent-integration/DESIGN-RESEARCH.md  # source of truth for spike results
prior_session_plan: C:\Users\david.hayes\.claude\plans\we-are-picking-up-sorted-pebble.md  # this session's approved plan
```

## Status snapshot (what's true now)

- **Both architecture-gating spikes PASS** (recorded in `docs/agent-integration/DESIGN-RESEARCH.md`):
  - **Spike 1 (#24135):** `codex exec` on `codex-cli 0.144.1` calls MCP tools WITHOUT the banned `--dangerously-bypass-approvals-and-sandbox`, under both default and `approval_policy="never"`. **#24135 does not reproduce.** The M4 no-go branch and the node-pty fallback (Spike 3) are NOT needed. `codex exec` is a viable brain transport.
  - **Spike 2 (panel WS):** the LinkMap side panel opens `ws://127.0.0.1:8181` with ZERO manifest changes; the loopback server authenticated a genuine `Origin: chrome-extension://cdapceilohcmfobgakfppmpnbnbaioen` (isChromeExt true). The panel-owned-socket + Origin-auth design holds.
- **Stability A-1, B-3, A-4, B-4 all fixed + tested** (`52b150a`, `d7daa06`), suite **474/474 green**. A-1 = native rename/recolor write-through; B-3 = MULTI_GROUP descendants; A-4 = quarantine windowId normalization; B-4 = cross-window group membership repair. A-4/B-4 were CodeRabbit-corroborated.
- **0058574 (L-1 position hold + L-2 nested header) verified live in Chrome by Dave.**
- **PR #8 MERGED** into `master` (merge commit `9ce6076`); branch deleted. ROADMAP + handoffs + audit docs organized and pushed (`master @ 2a7c117`). Working tree clean; session churn now gitignored.

## The decision fork for next session (pick first)

The two gating spikes passed, so the agent track is *un-blocked* but NOT *unlocked* — per the plan's **elephant-2**, the Phase 1 build waits until the stability HIGH queue is closed or consciously deferred. Choose:

- **(A) Close the stability queue** (recommended default) — finish A-4/A-2, B-2/F9, F8, F7, B-1 so tab organization is fully trustworthy, THEN start agent Phase 1. Keeps the extension's core promise first.
- **(B) Continue the cheap spikes** (4-9) — de-risk the rest of the agent architecture (Neon, Notion, keyring, page-action fidelity, tokens/task) while stability waits. Spikes are cheap and non-invasive.
- **(C) Start planning the agent Phase 1 spine** — only if Dave consciously defers the stability queue.

Recommend surfacing this fork to Dave explicitly rather than assuming.

## Next actions (start here — PR #8 is already merged to master)

**First move: resolve the decision fork above with Dave.** Then, by track:
1. **Track A (stability):** work the audit's recommended order from `.claudedocs/group-stability-audit-2026-07-18.md`. Next item = **A-2** (re-key color-override on the titled-restore path — the A-4 fix already normalizes the quarantine so the material is there), then **B-2/F9** (validate Pass-1 tabId matches — URL/title sanity or session-nonce), **F8** (workspace tabIds remap), **F7** (persisted crash flag), **B-1** (durable lineage key — bigger design work). Also fold in CodeRabbit's remaining PR #8 items (see CodeRabbit section): move-helpers cross-window pinned-descendant, context.js persist-observability + retry-chain, negativeKeySeq (A-7), and the `moveTabToGroup` swallow-and-commit sibling of B-4.
2. **Track B (spikes):** run Spikes 4-9 from the plan table; Spike 4 also verifies M5 (>2-min approval-latency survival). Record each in `docs/agent-integration/DESIGN-RESEARCH.md`. Reusable rigs were in the session scratchpad (`echo-mcp.mjs`, `ws-probe-server.mjs`) — relocate to a permanent harness dir first (see Hard-won knowledge).

## Open LinkMap stability queue (competing priority — from the audit)

Still open, recommended fix order (**A-1, B-3, A-4, B-4 now DONE**): **A-2** color-override lost on titled restore (adjacent to the A-4 fix — the normalized quarantine now carries colorOverride; verify the titled-restore path re-keys it); **B-2/F9** Pass-1 raw tabId trust (`shadow-state.js:857-863`); **F8** workspace tabIds never remapped; **F7** crash banner unreachable / persisted flag; **B-1** durable parent-child lineage key (design work). Full evidence + file:line: `.claudedocs/group-stability-audit-2026-07-18.md`.

## Remaining Phase 0 spikes (not yet run)

4 = codex→LinkMap MCP round trip + **M5 >2-min approval-latency survival**; 5 = Neon suspend/reconnect with `pg`; 6 = Notion 2025-09-03 upsert; 7 = @napi-rs/keyring round trip; 8 = tokens-per-task cost; 9 = **M11** page-action fidelity on 3 real SPAs (decides chrome.scripting vs chrome.debugger for Phase 3). Table in the plan file.

## Hard-won knowledge (this session)

- **Codex MCP injection without touching global config:** `codex exec -c 'mcp_servers.NAME.command="node"' -c 'mcp_servers.NAME.args=["C:/fwd/slash/path.mjs"]'` — `-c` parses values as TOML and MERGES with existing servers. Use forward slashes in paths (TOML string escapes bite backslashes). Always `--disable multi_agent` + `env -u OPENAI_API_KEY -u CODEX_API_KEY` + `-o cleanfile` + prompt from a file via `- < file`.
- **Spike rig is reusable:** `scratchpad/echo-mcp.mjs` (stdio MCP echo server, zero deps) and `scratchpad/ws-probe-server.mjs` (loopback ws, logs Origin to a file) — copy into a permanent test-harness location for Spike 4 and Phase 1 auth negative-tests. NOTE they live in the SESSION scratchpad (ephemeral) — re-create or relocate before relying on them.
- **Port 8181 was spike-only.** Phase 1 must allocate a real 8xxx port from the CCv3 registry and record it in `project-registry.json` (M9c).
- **LinkMap extension id = `cdapceilohcmfobgakfppmpnbnbaioen`** — the exact value the daemon's Origin check pins.
- **MV3 CSP:** extension-page default CSP does NOT restrict `connect-src`, so a loopback WS from the panel needs no manifest change (confirmed).
- **Codex startup noise** (skill-YAML errors, other MCP servers' auth failures) is cosmetic; parse the `-o` clean file, not stderr.
- **Tests:** `node --test` from repo root (Node built-in runner, no package.json). 470 baseline green @ c0eae09. Test seams: `createMessageHandler` (init-gate.test.js `makeHandler`) for message-handler unit tests with a real ShadowState; `createTabEventHandlers` + `createMockContext`/`createMockState` (tab-events-buffer.test.js) with `mock.fn()` for commit-path assertions.
- **Post-plan gate:** a plan approval blocks direct code edits (plan-to-ralph-enforcer). For hands-on spike/surgical work, clear it by deleting `$TEMP/claude-plan-approved-*.json` (done this session) — documented bypass, not /ralph.
- **Windows git:** push/PR via the PowerShell tool (`git -C <repo>`), not the Bash tool (hangs on network). PRs via `gh api` or `gh pr create` with all flags (never bare — interactive hangs).

## CodeRabbit (PR #8) — 11 actionable, triaged

**Clean pass on this session's work: ZERO findings on the A-1/B-3 diff.** All 11 are on pre-existing branch code (the cumulative restart-fragility effort), and are CodeRabbit *claims* to verify-then-fix (not confirmed). Notably CodeRabbit **independently corroborated three items already in our audit queue** — treat that as confidence-boosting cross-validation, and address them there rather than as separate PR churn.

**Corroborates the existing stability queue:**
- ✅ **DONE (`d7daa06`)** `shared/shadow-state.js:1231-1239` [Major] — quarantine windowId normalization. **= audit A-4.**
- ✅ **DONE (`d7daa06`)** `background/move-helpers.js:136-146` [Major] — `syncGroupAfterWindowMove` repairs membership from `chrome.tabs.get`. **= audit B-4.**
- `shared/shadow-state.js:1180` [Major] — `negativeKeySeq` resets to -1 each call → synthetic-key collision overwrite. **= audit A-7.** (still open)
- `background/context.js:202-210` [Minor] — retry chain aborts on ONE transient `tabGroups.query()` failure; advance `retryCount` + reschedule. **≈ audit F13.** (still open)

**New, worth verifying + folding into the queue:**
- `background/move-helpers.js:91-104,159,200` [Major] — cross-window move leaves a pinned descendant in the old window while still parented in the destination; use separate movable vs groupable id sets. (New pinned/subtree nuance.)
- `background/context.js:60-71` + `background.js:180-183` + `background/sessions.js:478-488` [Major] — the immediate-persist helper resolves even on FAILED writes and isn't awaited at init; make success/failure observable + await before init completes. (Durability — relates to F7 / the M2 write-ahead direction.)
- `background/message-handlers.js:392-408` [Major] — MOVE_TO_GROUP: `context.state` not updated after unpin before `collectGroupableTabIds` → may exclude the just-unpinned tab. (Same helper family as B-3, DIFFERENT handler; quick look warranted.)
- `background.js:134-140` [Minor] — recovery restores state then leaves it to the debounce; use `saveStateImmediate()` after the retry-state swap. (F7-adjacent.)
- `sidepanel/modules/tree-renderer.js:551-559` [Minor] — failed-favicon marker tied to DOM lifetime; use a `tabId`-keyed map. (Favicon polish, relates to 743af87.)

**Dismiss (auto-generated churn, not worth hand-fixing — regenerated by hooks):**
- `ROADMAP.md:5,9,63` + `knowledge-tree.json` — markdown bold/link nits (`**grey circles*`, `[fix](groups)`, duplicate bullet).

**Merge recommendation:** none of the 11 are regressions introduced by this PR — the A-1/B-3 diff is clean and the spike doc is inert. The Major items are pre-existing and map onto the planned queue. Reasonable either to (a) merge PR #8 now and burn them down via the stability queue, or (b) hold PR #8 and knock out the top overlap (A-4 + B-4, both corroborated) first. Dave's call — surfaced to him at session end.

## Blockers

None. PR #8 is the only in-flight item; merge it after CodeRabbit + Dave approval.
