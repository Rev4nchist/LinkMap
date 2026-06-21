# LinkMap Stability & Architecture Review — 2026-06-21

> Deep-dive review of stability, architecture, and correctness for the LinkMap
> Chrome extension. Companion document: **STABILITY-IMPLEMENTATION-GUIDE.md**
> (the sequenced fix plan).

## 1. Executive Summary

LinkMap is in good shape: **369 tests pass**, the architecture (service-worker-owned
Shadow State + dumb side-panel renderer + debounced `chrome.storage.local`) is sound,
and the team has already fought several rounds of the hardest problem — cross-restart
reconciliation. This review went looking for what's left.

**Result: 0 critical, 3 high, 10 medium, 13 low** confirmed defects (26 total), plus
6 candidate issues that adversarial verification ruled out as false positives, plus
11 second-pass gap probes.

The signal is consistent and points at one theme:

- **Every high-severity finding is silent, persistent lineage corruption** in the
  exact subsystem the git history has been fighting — `reconcileWithLiveTabs()` and
  session restore. These don't crash; they quietly attach a saved subtree to the
  wrong tab and then persist it as the new source of truth.
- **One latent crash-loop** (TI-2): a persisted parent/child cycle makes
  `getVisibleTabs()`/`getDescendants()` recurse until the service worker dies — on
  every load, with no self-recovery because the corrupt state reloads from storage.
- **A privacy gap** (SM-1): the favicon fallback sends every visited domain to
  Google's S2 service, contradicting the PRD's "all data stays local" claim.

None of these are "the extension is broken" bugs — they're the long-tail edge cases
that a power user with 100+ tabs across multiple windows hits over weeks, which is
exactly the user this product targets.

## 2. Review Methodology (the procedure)

This review was executed as a multi-agent workflow so coverage was broad and every
claim was independently checked:

1. **Baseline** — ran the full suite (`node --test "tests/*.test.js"`): 369 pass / 0 fail.
   Mapped the architecture from `ARCHITECTURE.md`, the PRD, and a direct read of the
   reconciliation core (`shadow-state.js`).
2. **Fan-out (10 reviewers)** — one specialist per orthogonal dimension, each reading
   its own files and reporting concrete, line-cited findings:
   service-worker lifecycle/races · restart reconciliation · tree invariants ·
   DOM/XSS rendering · persistence/storage · drag & multi-select · Chrome-API error
   handling · feature-module robustness · memory/growth · security/manifest.
3. **Adversarial verification** — every finding was handed to a skeptic agent told to
   *refute* it by reading the actual code path. Findings only survive as "real" if the
   defect is positively confirmed AND can manifest in practice. This killed 6 of 32
   (19%) — including two that overstated impact and one contradicted by Chrome's
   tab-ID uniqueness guarantee.
4. **Completeness critic** — a final pass named 11 under-covered areas for a second
   round (Section 6).

Total: 43 agents, ~30 min wall-clock. The dimensions and verification harness are
reusable — re-run for the next audit.

## 3. Confirmed Findings

Severity reflects the **verifier's adjusted** rating (several were downgraded from the
finder's original after the code was actually read). `→` is the recommended fix.

### HIGH

**RR-1 — Pass-2 URL match ignores `windowId`, swaps subtrees between duplicate-URL tabs across windows**
`shared/shadow-state.js:710-749`
Pass 2 indexes unmatched live tabs by URL across *all* windows, then tiebreaks only on
title+index — `windowId` is never considered (contrast Pass 2b:773, which does gate on
it). When the same URL is open in two windows (pinned dashboard, Gmail, GitHub — common),
the saved node for window A can be remapped onto window B's live tab; `replaceTabId`
then drags the entire saved subtree (children, collapsed, parent pointer) onto the wrong
tab and the update pass persists cross-window lineage. Most acute for duplicate pinned
tabs (same URL, both index 0) where title+index can't disambiguate and the loop falls to
`candidates[0]`.
→ Add `windowId` (mapped through a prelim window map built from Pass-1 matches) as the
primary tiebreaker, OR refuse the match when ≥2 candidates can't be uniquely
disambiguated, letting it fall through to Pass 2b/3.

**RR-2 — Pass-3 positional match attaches saved lineage to an unrelated tab when `bestDist ≤ 3`**
`shared/shadow-state.js:821-840`
Pass 3 matches each remaining saved node to the closest-index live tab in its window
with **no URL/title check at all**, accepting anything within 3 positions. The live tabs
in this pass are exactly the ones that failed URL+title matching (blank/newtab/loading),
so identity is unknown. If a lineage-bearing saved tab died across the restart and an
unrelated tab sits within ±3 slots, Pass 3 transplants the dead tab's children/parentId
onto it — and dead-tab cleanup (842-849) runs *after*, so the mis-attached node now holds
a live ID and survives.
→ Skip positional matching for lineage-bearing saved nodes (`children.length > 0 ||
parentId != null`) — let them fall to dead-removal + orphan-repair. Optionally require a
generic saved URL and tolerance ≤1.

**FM-1 — Session restore rebuilds lineage in a race with `onCreated`; the restored tree can silently flatten**
`background/sessions.js:227-291`
`restoreSession()` never calls `state.addTab()`. Restored tabs enter Shadow State only
via the async `onCreated` listener (which adds them at root, `parentId: null`). Restore
then runs a *synchronous* `moveTab(child.newId, parent, ∞)` loop — but `moveTab` no-ops
if the child or the parent node isn't in the tree yet (`shadow-state.js:149` and the
root fall-through). Chrome resolves `tabs.create` independently of when `onCreated` is
dispatched, so when the race loses, lineage is dropped and every restored tab lands at
root. `commitState()` then persists the flattened tree as the new truth.
→ Make restore the authoritative writer: after each awaited `chrome.tabs.create`,
`state.addTab(newTab.id, {...saved, parentId: null})` (idempotent via the existing
duplicate guard), then run the reparent loop against nodes that are guaranteed to exist.
Add a test that fires `onCreated` on `create()` and asserts rebuilt lineage.

### MEDIUM

**SW-1 — State-mutating message handlers don't await `initDone`; mutations during SW restart are lost or corrupt reconciliation**
`background/message-handlers.js` (all mutating cases)
Only `GET_STATE` and the async-channel cases defer to `initDone`. Every mutating case
(`MOVE_TAB`, `TOGGLE_COLLAPSE`, `SET_THEME`, `RENAME_WINDOW`, …) runs synchronously
against `context.state`. In MV3 the SW is killed at ~30s idle and restarts on the next
event while the panel stays open (it sends `GET_STATE` only once at load). A click during
the init window mutates either the throwaway pre-init state (`background.js:74` replaces
it → lost) or pre-remap saved IDs (→ transient corruption). The codebase's own *tab-event*
handlers already guard this exact race via `pendingEvents`/`drainPendingEvents`; the
message path simply wasn't extended.
→ Gate mutating message types behind init: early-return `initDone.then(() =>
handleMessage(...)); return true;`. Pure-Chrome-API cases (activate/close/pin/mute) pass
through unguarded.

**SW-2 — Seven tab/group events are dropped (not buffered) during the init window**
`background/tab-events.js:148-235`
Only `onCreated/onRemoved/onUpdated` buffer into `pendingEvents`; `onMoved`, `onAttached`,
`onDetached`, `onReplaced`, `onGroupCreated/Updated/Removed` all `if (!ctx.initComplete)
return;` — dropped. Most self-heal on the next event, but a dropped **`onReplaced`** leaves
Shadow State pointing at a dead tab ID (no recovery) and a dropped **`onGroupRemoved`**
leaves a phantom group. The gap widens precisely after a Chrome restart, when these events
fire most.
→ Buffer all seven into `pendingEvents` and extend `drainPendingEvents` with a case per
type (de-dup against current state as the existing cases do). Prioritize `onReplaced` and
`onGroupRemoved` (the non-self-healing ones).

**RR-8 — Pass-2b title match has no URL guard and uses raw (stale) `windowId`, mis-attaching lineage across windows**
`shared/shadow-state.js:758-783`
Pass 2b matches purely by exact title, tiebreaking on **raw `savedNode.windowId`** — which
is stale after a restart, so the precise gate never fires and the loop falls to
`candidates[0]`. Common shared titles ("Inbox", "Dashboard", product names) then transplant
a saved subtree onto an unrelated live tab.
→ Map `savedNode.windowId` through the prelim window map (as Pass 3 already does), and
require a same-origin / non-trivial-title check before accepting a lineage-bearing match;
don't fall back to `candidates[0]` for ambiguous common-title buckets.

**TI-2 — `fromStorage` does no structural validation; a persisted cycle infinite-loops the render path and crashes the SW**
`shared/shadow-state.js:625-661, 461-477, 576-592` (and `focusOnBranch:239-252`)
`fromStorage` loads `tabs`/`rootIds` verbatim with no acyclicity/consistency check.
`getVisibleTabs` (every render) and `getDescendants` recurse with **no visited set**. A
persisted cycle (`1→2→1`) throws `Maximum call stack size exceeded` on every load and
never self-recovers (corrupt state reloads each SW restart). No current in-memory path
*creates* a cycle (moveTab guards it), so the realistic trigger is a torn storage write or
a future reconcile regression — but the consequence is severe and permanent.
→ Add a validate/repair pass in `fromStorage` (walk `rootIds` with a visited Set, break
back-edges, drop dangling child IDs, rebuild `rootIds` from `parentId === null` nodes), and
defense-in-depth visited-set guards in `getVisibleTabs`/`getDescendants`/`focusOnBranch`.

**RR-4 — All-tabs-failed window-name fallback maps an old window via an ID collision**
`shared/shadow-state.js:877-893`
When every tab of a named window fails to match, the fallback scans for a live tab whose
`savedTabWindowIds[liveTab.id] === oldWid` — but by construction that can only be true via
a numeric ID collision (Chrome reuses small-integer IDs), not real evidence. The window's
*name* gets attached to the wrong window (or dropped). Corrupts a label only, not lineage.
→ Restrict the fallback to *propagated* matched IDs (track them in a Set), so the loop
becomes a no-op when it would currently rely on a collision; the name is honestly dropped
rather than misattributed. (Ties into the RR gap on deleting stale saved IDs.)

**RR-5 — Group-title rescue "color-only" tier pastes a saved title onto an unrelated same-color group — and pushes it to Chrome**
`shared/shadow-state.js:980-999, 1029-1035` + `background.js:131-138`
Chrome has ~8 group colors, so the last-resort color-only rescue collides easily: a
different grey group with an empty title (Chrome sometimes returns groups before titles
load) gets labeled with the wrong saved title — and `background.js` then writes it back to
the real browser group via `chrome.tabGroups.update`. The precise (color+window+count)
tiers are fragile across restart (count and windowId both drift), so the lossy color-only
tier fires more than intended.
→ Gate color-only behind a uniqueness check (apply only when exactly one orphan and one
empty live group of that color exist), and never write a color-only-rescued title back to
Chrome — restrict the write-back to the precise tiers.

**DM-1 — Same-window drag reorder/reparent updates the tree but never moves the real Chrome tab**
`background/move-helpers.js:92-104, 110-137`
The most common drag (same-window reorder/reparent) mutates the Shadow State tree but
issues **no `chrome.tabs.move()`** — contrast `REORDER_PINNED` (message-handlers.js:662),
which does. The sidebar and Chrome's flat strip drift apart permanently. Lineage itself
survives restart (rootIds order is preserved by ID), but a dragged tab carries a **stale
`node.index`** (moveTab never updates it), which feeds Pass-3 positional reconciliation
inconsistent data.
→ After `state.moveTab`, compute the flat (depth-first, pinned-aware, group-contiguous)
Chrome index and call `chrome.tabs.move(tabId, {index})`; also update `node.index`. Mirror
the `REORDER_PINNED` pattern. (If tree/strip divergence is *intended*, document it — but
the pinned path syncing strongly implies the non-pinned path was meant to too.)

**CAE-3 — `MOVE_GROUP` mutates state before a fire-and-forget `chrome.tabGroups.move` whose rejection is swallowed**
`background/message-handlers.js:309-318`
`state.moveGroup` + `commitState()` (save + broadcast) run unconditionally; the actual
group move is `.catch(() => {})`. If it rejects (stale groupId after restart, emptied
group, out-of-range index), the persisted/broadcast group order disagrees with Chrome's
real order with **no log** — and no event corrects it (group handlers don't touch
`rootIds`). Sibling `RENAME_GROUP` already logs its failure.
→ At minimum log the rejection (match `RENAME_GROUP`). For a true fix, await the move and
commit in `.then`, reconciling from live groups in `.catch` (a bare re-broadcast re-sends
the already-drifted state — it does not resync).

**PS-1 — `onSuspend` flush is fire-and-forget async**
`background/sessions.js:451-456`
`onSuspend` issues an un-awaited `storage.local.set` + `saveSession()` then logs success
synchronously. MV3 doesn't await `onSuspend`, so the worker can terminate before the write
commits. The durable per-mutation `saveState` path (500ms debounce) bounds the loss to the
sub-debounce tail, so this is a backstop weakness, not a primary-data risk.
→ Route structural mutations through the already-exported-but-unused `saveStateImmediate()`
so persistence doesn't depend on `onSuspend`; fix the misleading sync success log.

**SM-1 — Favicon fallback leaks every visited domain to Google's S2 service**
`shared/constants.js:148-157` (called unconditionally from `tree-renderer.js:255,367`)
When a tab lacks a native `favIconUrl` (discarded/unloaded/new/error tabs — common),
`getFaviconUrl` returns `https://www.google.com/s2/favicons?domain=<hostname>`, so the
browser GETs google.com with the user's tab hostname on render. This discloses the set of
visited domains to a third party — contradicting the PRD's "all data stays local" and
creating a Web-Store data-disclosure issue. The extension declares no remote data use.
→ Resolve favicons on-device via the MV3 `favicon` permission and
`chrome-extension://<id>/_favicon/?pageUrl=...&size=32`, OR simply fall back to the local
`DEFAULT_FAVICON`. The existing `img.onerror → DEFAULT_FAVICON` makes dropping the remote
branch graceful.

### LOW

**SW-3 / RR-7 — Deferred 2 s re-reconciliation swaps `context.state` wholesale, discarding interim lineage**
`background.js:93-125` — On a poor first reconcile (<70% relationships) a 2 s retry rebuilds
from the original `savedData` snapshot and replaces `context.state`. The fresh
`tabs.query` recovers Chrome-owned state, but parent/child lineage established by live
`onCreated` (and any panel re-parent) during the 2 s window is re-rooted/lost.
→ Apply the retry as a *relationship-only re-attach* onto the live state instead of a
wholesale object swap.

**SW-4 — `onActivated` has no init guard (cosmetic active-tab highlight race)**
`background/tab-events.js:156-169` — Verifier downgraded to cosmetic/self-healing; the
"stale ID after remap" harm doesn't actually occur (live IDs are remap targets, not
victims). → Add the standard `if (!ctx.initComplete)` guard as minor polish.

**RR-6 — Pass-2/2b greedy matching: first saved node wins regardless of fit**
`shared/shadow-state.js:720-748, 766-782` — When ≥2 saved and ≥2 live tabs share a URL with
no exact title+index match, Map-iteration order decides the pairing, cross-assigning
lineage. → Compute a stable best-pairing per bucket (score on windowId+index+title, or
sort-and-zip). Largely subsumed by the RR-1 windowId fix.

**TI-1 — `replaceTabId` collision guard can structurally restructure the tree**
`shared/shadow-state.js:384-425` — On an ID collision the guard calls `removeTab(newId)`
(a full reparent+delete). Chrome's tab-ID uniqueness makes the "destroys a live unrelated
tab" path unreachable today (→ needs_context), but the missing `oldId === newId` and
ancestor/descendant guards are cheap hardening. → Add `if (oldId === newId) return;` and
prefer a shallow delete over reparenting on collision.

**TI-3 — `groupColors` entries are never pruned — unbounded persisted leak**
`shared/shadow-state.js:269-271, 372-374, 1002-1005` — `setGroupColor` writes keys that no
path deletes; group IDs change every restart, so the object grows forever and is serialized
each save. → `delete this.groupColors[groupId]` in `removeGroup` and the reconcile
dead-group loop.

**CAE-1 — `close-current-tab` command: unhandled promise rejection**
`background.js:236-240` — The lone tab-mutating call without `.catch()`; rejects on a racing
close/no focused window. → `…then(([tab]) => { if (tab) return chrome.tabs.remove(tab.id); }).catch(() => {});`

**CAE-2 — `REORDER_PINNED` fire-and-forget move, rejection swallowed**
`background/message-handlers.js:662-666` — State committed before the move resolves; on
rejection the pinned order drifts silently. → Log the rejection; for a real fix
await-then-commit (mirror `moveTabToGroup`).

**DM-3 — Drag ignores the active multi-selection; stale selection persists**
`sidepanel/modules/drag-drop.js:55-82, 191-230` — Multi-drag is unimplemented (so no
scramble bug), but dragging one of N selected tabs moves only that one and leaves a stale
"N selected" toolbar. → Minimal: on dragstart of a selected tab, clear the selection +
refresh the toolbar. (Full batch-move is a feature, defer.)

**FM-2 — Restore silently discards the saved `collapsed` state**
`background/sessions.js:254-291` — `collapsed` is serialized but never re-applied on restore;
every restored subtree comes back expanded. → After the reparent loop, map
`session.data.collapsed` old IDs through `oldToNewId` into `state.collapsed`.

**LG-1 — Full tree element array rebuilt in JS on every `STATE_UPDATE`**
`sidepanel/modules/tree-renderer.js` — Every visible tab's DOM is reconstructed each render
purely to diff against the live DOM (which the keyed reconciler reuses). Transient GC/CPU
pressure at 200+ expanded tabs during page-load churn; not a leak. → Memoize built entries
by key, rebuilding only when source fields changed; or coarsen the broadcast debounce for
status churn. Profile-gated — optimize only if jank is observed.

**LG-2 — `selectedTabIds` / `collapsedWindowIds` never pruned against live state**
`sidepanel/sidepanel.js:50-51, 271-276, 320-352` — Stale IDs linger when tabs/windows close
externally; bounded by clicks-between-clears (not truly unbounded) but can inflate the
"N selected" badge. → In `handleStateUpdate`, intersect both Sets with the payload's live
tab/window IDs.

**SM-3 — Broad privacy-sensitive permissions (`history`, `bookmarks`) with no in-product disclosure**
`manifest.json:6-16` — All permissions are exercised (not over-permissioning), but
`history`/`bookmarks` are high-sensitivity for a tab organizer and there's no privacy
policy. Productization/Web-Store concern, not a runtime defect (→ needs_context).
→ Ship a privacy policy before Web-Store submission; consider making history-based
visit-frequency opt-in (or compute it from local tab activity to drop the `history`
permission).

## 4. What We Ruled Out (false positives)

Adversarial verification killed these — recorded so they aren't re-investigated:

| Claim | Why it's not a defect |
|---|---|
| `onSuspend` "defeats the persistence guarantee" (sw-lifecycle & feature-modules framings) | The durable guarantee is the per-mutation debounced `saveState`, not `onSuspend`. Worst case loses ~500 ms of tail. (The *narrow* version survives as PS-1.) |
| Stale `savedTabWindowIds` keys corrupt the windowId vote | The set of lingering stale saved IDs and the set of `liveTab.id` values are provably disjoint within a reconcile call — the collision channel can't fire. |
| `addTab`/`replaceTabId` can introduce a cycle | Every real call path feeds already-safe inputs; the only corrupt-data vector is `fromStorage`, which bypasses `addTab` (that's TI-2, not this). |
| Cross-window move `{index:-1}` vs tree index "disagree" | `node.index` is Chrome's flat position, deliberately separate from tree order; storing end-of-window index actually *matches* post-restart live index. Cosmetic strip-vs-tree only. |
| `onMessage` doesn't validate sender | No `externally_connectable`, no content scripts, no `onMessageExternal` — only the extension's own panel can reach it. (Defense-in-depth note retained as a gap.) |

## 5. Architecture Assessment

The core design is correct and worth preserving:

- **Single source of truth in the SW** is the right call — it survives panel open/close
  cycles cleanly. The recurring pain isn't the pattern, it's the **reconciliation
  heuristics** that bridge Chrome's ID churn across restarts.
- **The 4-pass matcher is the architectural risk center.** Five of the 13
  reconciliation findings live there. It has grown into a sequence of greedy,
  independently-tuned passes (id → url → title → positional) where each pass added a
  guard the previous one lacked (Pass 2b gained windowId, Pass 3 gained the prelim map),
  but the guards were never back-ported. The fixes in Section 3 converge it toward a
  consistent contract: **always disambiguate by mapped windowId; never positionally
  guess a lineage-bearing node; never accept an ambiguous match.**
- **Missing invariant enforcement.** `fromStorage` trusts persisted data completely
  (TI-2). For a structure whose corruption is catastrophic and permanent, a
  validate/repair gate on load is the highest-leverage architectural hardening.
- **Two-writer seams** (restore vs `onCreated`; the 2 s retry vs live events) recur
  because background subsystems mutate `context.state` concurrently without a guard. A
  small "restore/reconcile in progress" discipline would close a whole class.
- **Error observability** is the quiet weakness: several `chrome.*` mutations are
  fire-and-forget with empty `.catch()`, so when Chrome and the tree drift there's no
  diagnostic — which is exactly why the restart bugs were historically hard to find.

## 6. Second-Pass Gap Probes

The completeness critic flagged these under-covered areas. Several look like genuine
bugs and are folded into the implementation guide as **investigate-then-fix** items:

1. **`data-window-id` unescaped attribute** — `session-manager.js:215` interpolates the
   raw window key into HTML with no `escapeHtml`/`Number()` (contrast line 214). Low risk
   today (numeric keys) but a real injection seam if a session-import feature ever lands.
2. **Panel-side cycle crash** — `tree-renderer.js countDescendants` (663-683) recurses with
   no visited set; a persisted cycle hangs the *side panel* too, not just the SW. Same
   root cause as TI-2.
3. **Search ↔ renderer staleness** — `renderNow()` early-returns while search is active, so
   `STATE_UPDATE` is dropped; closing a tab during search leaves a stale, clickable result
   row pointing at a dead tabId.
4. **`reconcileChildren` correctness** — `patchElement` detects subtree change only via
   direct child-count; a nested change with identical count may leave stale DOM. Verify
   recursion depth and the `querySelector('.tab-title')` first-match risk.
5. **Auto-group concurrency** — `auto-group.js` query→create isn't atomic and isn't
   init-guarded; two matching tabs in one tick can create duplicate same-titled groups.
6. **Session-restore two-writer race** (broader than FM-1) — live `onCreated/onAttached`
   mutate `context.state` for the same tabs `restoreSession` is mapping.
7. **Message sender authorization** — no `sender.id` allowlist on destructive ops; only
   reachable by other installed extensions (no web vector), so low, but worth a gate.
8. **Keyboard-nav / multi-select index integrity** — do these cache a numeric index / DOM
   ref that goes stale after a reconcile reorder, targeting the wrong tab?
9. **`move-helpers` full coverage** — classify every mover for the DM-1/CAE-3 class
   (tree mutated but Chrome not moved, or rejection swallowed).
10. **`fromStorage` type-coercion** — string vs number key seam between
    `Object.fromEntries` (stringifies) and live numeric IDs; a mismatch silently drops
    lineage on restore.

## 7. Recommended Remediation Order

See **STABILITY-IMPLEMENTATION-GUIDE.md** for concrete changes + test requirements.

- **P0 (crash + silent lineage corruption):** TI-2, RR-1, RR-2, RR-8, FM-1
- **P1 (races + Chrome/tree consistency):** SW-1, SW-2, DM-1, CAE-3, CAE-2, SW-3, TI-1, FM-2
- **P2 (privacy, leaks, polish, gap-fixes):** SM-1, TI-3, RR-4, RR-5, RR-6, CAE-1, LG-2,
  DM-3, SW-4, LG-1, + gap probes 1–4

---
*Generated by a 43-agent adversarial review workflow (`linkmap-stability-review`),
2026-06-21. Re-runnable for the next audit cycle.*
