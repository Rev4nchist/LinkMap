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
3. **Anchored re-association pass** — new pass after 2b, before the blind Pass 3, running **only when `coldRestart`**: for each already-matched parent, take its still-unmatched lineage children and match each to a live tab. **URL/title corroboration is MANDATORY for every anchored match** — mapped-window membership and positional adjacency to the matched parent are used ONLY to narrow the candidate set, never as sufficient grounds on their own. A candidate with no usable url/title signal (both absent or generic — `chrome://newtab/`, `about:blank`, `'New Tab'`) is **refused**, not grafted, even when it is the unique adjacent tab in the window. Use the existing `pickReconcileCandidate` refuse-ambiguous discipline on top. Only for these corroborated, anchored matches is the RR-2 refusal (`shadow-state.js:~987`) relaxed.
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

## As-shipped hardening (post adversarial review, 2026-07-19)

A cross-model adversarial review (Codex gpt-5.5) of the implemented anchored pass found two wrong-graft paths in the new code and two pre-existing issues. The anchored pass was hardened before merge:

- **Corroboration (Finding #3 mitigation):** an anchored match requires **exact url** OR **(title match + same origin)**. Title-ALONE across origins is refused — the anchored pass runs on Pass-2b's already-ambiguous-title leftovers, where a same-title but unrelated cross-site tab could otherwise be grafted. This makes the anchored pass **strictly stricter than the pre-existing Pass 2b** (which title-matches lineage cross-origin with no origin check). Residual: a same-origin same-title collision is still possible but narrow, and only mis-parents (no data loss).
- **Same-window guard (Finding #2):** a child is only anchored if its saved window equals its parent's saved window. A child dragged to another window keeps its `parentId` while its `windowId` diverges (`onAttached` updates windowId, never parentId); its true live tab is not in the parent's window, so anchoring it there would risk a false graft. Cross-window children fall through to dead-sweep instead.

### Pre-existing follow-ups surfaced by the review (NOT B-1 regressions)

Both live in the broader reconcile title-matching / gate logic that predates B-1 (from B-2 / PR #8); the anchored pass mirrors but does not introduce them. Tracked as focused follow-ups:

- **Same-id collision stranding (Codex #1, ~shadow-state.js Pass-1 gate + dead-sweep):** on cold restart, a saved node whose id coincidentally collides with an unrelated live id is rejected by Pass 1's corroboration but then skipped by every recovery pass AND by dead-sweep (`!liveById.has(id)` is false), so it lingers stale and gets its cosmetic fields overwritten by the unrelated tab while keeping its old lineage. Fix direction: track Pass-1 corroboration-rejects as genuinely unmatched (feed them to Passes 2/2b/anchored/3 and dead-sweep).
- **Pass 2b cross-origin title graft (Codex #3, ~shadow-state.js Pass 2b):** Pass 2b matches a url-changed child to a same-title live tab with no origin check, so it can graft lineage onto a cross-origin same-title tab. The anchored pass now requires same-origin; Pass 2b does not. Fix direction: extend the same-origin corroboration to Pass 2b.

### Resolution + newly-surfaced follow-ups (2026-07-19, branch `fix/reconcile-cold-restart-integrity`)

Both follow-ups above are now FIXED:
- **#6** shipped as **sweep-only**, NOT the original gate-widening. A pre-implementation cross-model pre-mortem (Codex) reproduced that re-mapping Pass-1 rejects introduces NEW cold-restart data loss (a reject matching its true reincarnation collides with / starves another saved node, destroying lineage while `tabIdMap` falsely reports success). Sweep-only removes the wrong-graft with no reject re-map; the true reincarnation re-roots (RR-2b-style refuse-by-default).
- **#7** extends same-origin to Pass 2b, with `sameOrigin` hardened after an as-implemented adversarial review: opaque `chrome://`/`about:`/`data:`/`file:` origins (all stringify to `"null"`) never compare equal, and a url-less saved node falls back to title-only recovery so a lineage-bearing one is not dead-swept.

Newly surfaced by those reviews, **deferred** (pre-existing, distinct from #6/#7):
- **#8 — Pass 1 title-only cross-origin.** On cold restart, Pass 1's own corroboration accepts a same-id, same-title, DIFFERENT-origin live tab via its title branch, silently content-overwriting the saved node while it keeps lineage — the same wrong-graft class as #6/#7, in untouched Pass 1 code. Fix direction: require same-origin (or url-exact) for Pass 1's title corroboration; let title-only fall through to Pass 2b/anchor (which now gate it).
- **#9 — no tombstone set for recycled ids.** `reconcileWithLiveTabs` returns no set of REMOVED ids, so a swept `pass1Rejected` id that an unrelated new tab reuses aliases external id-keyed stores (e.g. `background.js` workspace membership: `state.tabs.has(id)` is true again, but for a different tab). Fix direction: return the removed-id set; callers drop those ids from external stores before the `has(id)` "unchanged" check.

**Resolution (2026-07-19, branch `fix/reconcile-pass1-origin-tombstone`):** #8 and #9 are FIXED.
- **#8** — Pass 1's title branch now requires same-origin, gated ONLY when both the saved and live urls are usable (a url-less node keeps the pre-#8 title-only corroboration — no new data loss, mirroring #7). Warm wake stays byte-identical (corroboration is `coldRestart`-only). Adversarial-review follow-up: `sameOrigin` was generalized so opaque-origin schemes (`chrome:`/`file:`/`data:`) compare scheme+host+path (ignoring fragment) rather than the always-false `origin === "null"` — a fragment-changed `file://`/`chrome://` tab is the same document (kept), while different opaque pages (different host) still don't match. This fixed a real data-loss regression the first #8 pass introduced (and latent in #7's Pass 2b/anchored).
- **#9** — implemented as a **survivor set**, not a removed-id set. `reconcileWithLiveTabs` now returns `sameIdMatched` (saved ids Pass 1 matched to their OWN live id). The workspace consumer keeps an id iff it's remapped (`tabIdMap`) or in `sameIdMatched`, dropping recycled/closed ids. This is robust against ALL removal paths (dead-sweep + mid-pass collision-guard) by construction — simpler and more complete than enumerating removed ids. Still open (separate, larger): tab notes (`ctx.tabNotes`) are id-keyed but never remap through reconcile at all.

## Why deferred, not bundled with B-2

B-1 couples three independently-risky changes — a schema migration touching every persisted node, a new reconcile pass with subtle correctness properties, and rewriting a test that encodes a safety invariant. Bundled, a reconciliation regression can't be cleanly attributed among them — the exact trap that keeps "standing residuals" standing. It deserves its own branch, review, and migration-focused test pass.
