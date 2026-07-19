# B-1 — Durable Lineage Key (DEFERRED design)

Architect design, 2026-07-18. B-1 was deferred to its own focused session (too big to safely one-shot alongside B-2). The **restart-detection primitive it depends on shipped in B-2** (`ac4f580`) — `chrome.storage.session` `SW_SESSION_KEY` marker → `{ coldRestart }` flag threaded into `reconcileWithLiveTabs`. This doc is the implementation spec for the deferred B-1 session.

## The honest constraint (set expectations before building)

Chrome exposes **no per-tab identity that survives a cold restart**: `tabId` is reassigned; `openerTabId` is captured live at `onCreated` but is NOT repopulated for tabs returning via `chrome.tabs.query()` after a cold restart; `chrome.storage.session` (any tabId→key map) is wiped on restart. So a LinkMap-assigned key **cannot re-attach itself to the live tab** after restart — the live tab carries none of our data. **Cross-restart lineage recovery is therefore fundamentally heuristic** (url + title + index + window + tree shape). B-1 will recover subtrees whose **parent survived** (anchored) and will still, correctly, flatten unanchored ones. "Durable lineage key" improves the parent-survives case; it does not make lineage bulletproof.

## What `lmId` buys (and what it doesn't)

- **Does:** decouple lineage from the ephemeral `tabId` within a session, give a stable serialization handle, provide a clean anchor for a corroborated re-association pass and for tests.
- **Does NOT:** create identity on the live-tab side after cold restart. `lmId` alone does not solve B-1.

## Recommended design: anchored top-down lineage pass, backed by `lmId`

Add a pass that only ever grafts a lineage-bearing child **under an already-matched parent** — bounding blast radius to trusted anchors. Mirrors the existing session-restore precedent (`background/sessions.js:253-300`, children reparented after parents via `oldToNewId`).

1. **`lmId` field** — assign a stable LinkMap id at node creation (`createNode` `shared/shadow-state.js:30`, `onCreated` `background/tab-events.js:36`, `addTab` restore seeding). Monotonic counter persisted as `nextLmId` (or `crypto.randomUUID()`). Preserve through `replaceTabId` (`shadow-state.js:446` — keeps the node object; just don't overwrite `lmId`). Persist in `toSerializable` (`:682`); back-fill on `fromStorage` (`:704`).
2. **STORAGE_VERSION 1→2 migration** (`shared/constants.js:88`) in `fromStorage`: any node lacking `lmId` gets one during load; seed `nextLmId` above the max. This is the schema change and **the main risk surface** — touches every persisted node; `_validateAndRepair` (`:756`) must still pass.
3. **Anchored re-association pass** — new pass after 2b, before the blind Pass 3, running **only when `coldRestart`**: for each already-matched parent, take its still-unmatched lineage children and match each to a live tab that is (a) in the parent's mapped window, (b) positionally adjacent to the matched parent, (c) corroborated by url or title where available. Use the existing `pickReconcileCandidate` refuse-ambiguous discipline. Only for these anchored matches is the RR-2 refusal (`shadow-state.js:~987`) relaxed.
4. **Unanchored lineage still flattens** — if a subtree's root also died (no anchor) and the child has generic/duplicate/SPA url, it stays unmatchable → dead-sweep + orphan-repair (the exact safe behavior RR-2 protects today). Real, acceptable limitation.

## RR-2 test rewrite (`tests/shadow-state.test.js:1265-1285`, flatten assertion `:1281`)

Split into two:
- **RR-2a (new capability):** parent survives + child corroborated → assert child re-attaches to the matched parent.
- **RR-2b (safety preserved):** dead parent, no anchor, unrelated nearby tab → keep the current `:1281` assertion (orphan re-roots, unrelated tab does NOT adopt it).

## Test strategy

- Migration: load a v1 fixture lacking `lmId` → every node gets a unique `lmId`, `nextLmId` seeded, `_validateAndRepair` passes.
- `replaceTabId` preserves `lmId`.
- Anchored pass never grafts under an unmatched parent (property test on a dead-anchor fixture).
- Cold vs warm simulated via the `{ coldRestart }` option seam (already exists post-B-2) — no `chrome.storage.session` mock needed at the reconcile layer.

## Why deferred, not bundled with B-2

B-1 couples three independently-risky changes — a schema migration touching every persisted node, a new reconcile pass with subtle correctness properties, and rewriting a test that encodes a safety invariant. Bundled, a reconciliation regression can't be cleanly attributed among them — the exact trap that keeps "standing residuals" standing. It deserves its own branch, review, and migration-focused test pass.
