# LinkMap — Proposed Next Feature Set (2026-06)

> Grounded in the git history, the realized feature set, the stability review,
> and how this project has actually been built. Companion to
> STABILITY-REVIEW-2026-06.md.

## 1. Where the project actually is

Reading the git history and the module inventory, LinkMap has quietly executed
**most of its own `innovation-suite.md`** since that doc was written. What's
shipped:

| Original "innovation" idea | Status | Evidence |
|---|---|---|
| #2 Air Traffic Control (auto-routing) | ✅ shipped | `background/auto-group.js` (domain rules → groups) |
| #6 Workspace Contexts | ✅ shipped | `workspace-ui.js`, `ctx.workspaces`, switch/move |
| #7 Command Palette | ✅ shipped | `command-palette.js` (Ctrl+Shift+P) |
| #1 / #3 Sessions + Auto-Archive | ✅ core shipped | `sessions.js`: save/restore, auto-save alarm, `archiveStaleTabs`, undo-close, crash recovery, cross-device |
| #9 Tab Health (duplicates, freq) | ◑ partial | `duplicates.js`, `visit-frequency.js` (no dashboard/score yet) |
| #5 Tab Genome (signals) | ◑ partial | `smart-mapper.js`, visit-frequency (no clustering *suggestions*) |
| — Multi-select, keyboard-nav, bookmarks, sticky multi-window pins, 15 themes | ✅ shipped | respective modules + recent commits #6–#9 |

**The project has won "tab command center."** It's a mature, feature-dense tab
manager with a clean ShadowState architecture and (now) a hardened reconciliation
core and 393 tests.

Two things are conspicuously **not** built — and they're the two that were rated
"Very High" uniqueness:

- **#4 Link Harvester** — the feature that makes the name *"Link Map"* literal.
- **#10 Research Mode / Citations** — the feature that turns a tab manager into a
  research assistant.

Both need a content-script surface (`scripting` + `activeTab`), which the
extension does not yet have. That's the frontier.

## 2. How we've worked (so proposals fit)

The git history and this session show a consistent style worth designing around:

- **Incremental, PR-sized commits** (#2–#9), each one focused feature or fix.
- **Vanilla JS, ES modules, no build step** — additions must stay buildless.
- **Strong test culture** — 369→393 tests; features ship with tests.
- **ShadowState discipline** — SW owns the tree, panel renders. New data lives in
  ShadowState or `ctx`, serialized through `toSerializable`/`fromStorage`.
- **Stability-first lately** — the last ~10 commits before this review were all
  restart/reconciliation hardening. Reliability is clearly a priority.
- **Premium feel** — themes, polish, "killer features" framing.

Implication: the best next features are ones that (a) extend the existing
ShadowState cleanly, (b) ship in 1–3 sessions as a reviewable slice, and (c) lean
into the differentiation the name promises.

## 3. Proposed next set (prioritized)

Effort: **S** = 1–2 sessions, **M** = 3–5, **L** = 5+. Each lists the *first
slice* to de-risk and the *architectural fit*.

### P0 — Build the differentiators (make the name true)

**F1 · Link Harvester (the literal Link Map)** — *Effort M · Uniqueness very high*
Inject a content script on demand to extract a page's outbound links, render them
as a *virtual* subtree under the tab (dotted lines, link icon, not real tabs).
Click to promote a link into a real child tab — building the web graph you're
exploring.
- **Fit:** virtual nodes are a new ShadowState node *kind* (`kind: 'link'`),
  rendered by `tree-renderer` with distinct styling; they never enter the
  reconciliation passes (guard on `kind`). No restart-lineage risk.
- **First slice:** add `scripting` + `activeTab`, a one-shot harvest of same-domain
  `<a href>` links for the active tab, rendered read-only under it. Defer
  crawl-depth and promotion to follow-ups.
- **Why now:** it's the single biggest "only LinkMap does this" lever, and the
  name has been writing a check the product hasn't cashed.

**F2 · Research Mode / Citation Collector** — *Effort M · Uniqueness very high*
Toggle Research Mode → right-click selected text on any page → "Save to Research"
captures quote + URL + title + timestamp into a "Research Notes" panel section.
Export as Markdown / BibTeX / shareable HTML.
- **Fit:** notes live under a new storage key (`linkmap_research_notes`), not in the
  tree — zero interaction with the reconciliation core. Reuses the existing panel
  section pattern (settings/session panels).
- **First slice:** capture-to-section + Markdown export. Defer BibTeX, tagging, and
  per-tab citation linking.
- **Why:** researchers' tabs *are* their working bibliography. This captures the
  knowledge, not just the containers — the value-prop jump from "manager" to
  "assistant."

### P1 — Compounding wins on what's already built

**F3 · Collapsed Branch Preview (rich hover)** — *Effort S · pure UI, no perms*
Hover a collapsed branch/group → tooltip with a favicon grid + compact title list
+ descendant count; click a favicon to activate without expanding.
- **Fit:** pure renderer feature over existing `getDescendants`; the cycle guards
  we just added make deep/odd trees safe to walk for the preview.
- **Why first of the P1s:** smallest effort, immediate "premium" polish, makes the
  big collapsed trees this product encourages actually navigable.

**F4 · Tab Health Dashboard + score** — *Effort M · builds on duplicates/visit-freq*
A slide-out panel: tab-age histogram, stale tabs, duplicate clusters, a health
grade (A–F) on the toolbar badge, and one-click cleanup ("close 12 stale",
"merge 3 dupes", "hibernate 8").
- **Fit:** the data already exists (`duplicates.js`, `visit-frequency.js`,
  `chrome.action.setBadgeText`). This is mostly surfacing + bulk-action wiring.
- **Why:** turns the existing signals into behavior change; gamifies the cleanup
  the product is built to enable.

**F5 · Genome-based group *suggestions*** — *Effort M · finishes #5*
Use the lineage + co-visitation + visit-frequency signals already collected to
*suggest* groupings ("these 5 tabs seem related — group them?"), opt-in, learning
from accept/dismiss.
- **Fit:** a suggestion layer over existing signals; suggestions are advisory and
  never mutate the tree without confirmation, so they can't corrupt lineage.

### P2 — Bigger bets / productization

**F6 · Time-Travel scrubber** — *Effort L · finishes #1*
A timeline scrubber over periodic tree snapshots (delta-compressed) — rewind the
*tree structure* (the research trail), diff snapshots, restore a subtree from the
past. Sessions are discrete today; this is temporal navigation.
- **Fit:** snapshots reuse `toSerializable`; the new `_validateAndRepair` gate
  means restoring an old/odd snapshot can't crash-loop the SW — the stability work
  de-risks this feature directly.

**F7 · Web Store readiness track** — *Effort S–M · unblocks actually shipping*
From the review's SM-1/SM-3 findings: ship a privacy policy, make history-based
visit-frequency opt-in (or compute from local tab activity to drop the `history`
permission), and document the bookmarks write scope. The favicon egress is already
fixed (local `_favicon`).
- **Why:** the product is feature-complete enough to publish; these are the gates
  between "developer-mode" and "Chrome Web Store."

## 4. New ideas beyond the original suite (2026 context)

- **F8 · "Tree health" indicator (reliability as a feature).** The stability work
  added `_validateAndRepair` and reconciliation hardening. Surface it: a tiny
  status that shows "tree healthy" or "auto-repaired N issues after restart,"
  turning the invisible robustness into visible trust. Cheap, on-brand for a
  stability-focused project.
- **F9 · Natural-language command palette.** The palette grammar (`[verb] [filter]
  [target]`) is built. Add an optional NL front-end ("close everything from
  yesterday except GitHub") that compiles to the existing grammar. Keep any
  model use optional and privacy-respecting (consistent with the SM-1 stance).
- **F10 · Per-tab notes are built (`ctx.tabNotes`) — surface them as a research
  layer.** Small step from notes to the citation collector (F2); could be the
  bridge slice.

## 5. Recommendation

Build in this order:

1. **F3 Collapsed Branch Preview** (1–2 sessions) — quick, high-polish, proves the
   "premium navigability" thesis on the big trees the product creates.
2. **F1 Link Harvester, first slice** (2–3 sessions) — make the name literal; this
   is the strongest differentiator and the virtual-node model is a clean,
   low-risk ShadowState extension.
3. **F2 Research Mode, first slice** (2–3 sessions) — the value-prop leap to
   "research assistant," fully decoupled from the tree/reconciliation core.

Then F4 (dashboard) and F7 (Web Store readiness) to convert the now-deep feature
set into a shippable product.

**Why this order:** it leads with one quick polish win, then the two unbuilt
"very high uniqueness" features that the architecture is now stable enough to
support — and each is structured so its risky surface (content scripts, virtual
nodes, snapshots) stays *out* of the reconciliation core we just spent this review
hardening.

---
*Proposed 2026-06-21, after the stability review + fix pass (9 commits, 393 tests).
Effort estimates are in this project's session-sized increments.*
