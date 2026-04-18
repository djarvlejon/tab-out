# Sessions Spec — Codex Adversarial Audit (GPT-5.4 xhigh)

**Date:** 2026-04-18
**Auditors:** 5 parallel Codex agents (read-only, xhigh reasoning)
**Verdict across all 5:** ❌ Not ready to implement.

| # | Agent | Job ID | Verdict |
|---|---|---|---|
| 1 | UX / product design | `d2ed9975` | **Redesign** |
| 2 | Spec rigor | `8f31cf24` | **Not implementation-safe** |
| 3 | Implementation feasibility | `cf1a7bfb` | **Not honest about refactoring cost** |
| 4 | Security & privacy | `9178ee32` | **Reject as-is** |
| 5 | Chrome APIs / MV3 | `df5712aa` | **Not ready** |

Full reports archived below. Synthesis first.

---

## The critical few (cross-cutting blockers)

These were flagged independently by 2+ agents:

### 1. "Existing escape convention" does not exist — persistent XSS surface
**From:** security, feasibility.
The spec claims session names and tab titles will use an "existing text-escape convention" ([spec:342](../specs/2026-04-18-tab-out-sessions-design.md#L342)). The convention doesn't exist. Current renderer at [app.js:936, 948, 977, 1000, 1154, 1461, 1471](../../../extension/app.js) uses raw `innerHTML` string interpolation; only attribute quote characters get escaped. Tab titles are *page-controlled* (sites set `document.title`). Adding user-editable session names on top turns transient page-controlled metadata into **persistent DOM injection**, and click handling trusts any `[data-action]` in the DOM — a malicious title could inject clickable controls that invoke extension actions.

### 2. Sidebar hides when empty → Sessions invisible on first run
**From:** UX, feasibility.
The spec's chosen home for Sessions is the right sidebar, defaulting to Deferred ([spec:129](../specs/2026-04-18-tab-out-sessions-design.md#L129)). But the current sidebar disappears entirely when Deferred is empty ([app.js:922](../../../extension/app.js), [index.html:68](../../../extension/index.html)). A new user with zero deferred items never sees the Sessions pill, never sees the empty state, never gets a prompt to try saving.

### 3. Toast primitive cannot support Undo
**From:** feasibility, spec rigor.
The whole Undo strategy depends on clickable 8 s toasts. Current toast is [pointer-events: none](../../../extension/style.css) text + icon ([app.js:438](../../../extension/app.js), [index.html:120](../../../extension/index.html)). This is not an extension of `showToast()`; it is a toast-component rewrite plus an Undo controller.

### 4. Incognito design is platform-wrong
**From:** Chrome APIs, spec rigor, security.
Spec says save buttons disable via `chrome.extension.inIncognitoContext`. But [manifest.json](../../../extension/manifest.json) has no `"incognito"` key → Chrome default is `"spanning"` → extension pages cannot load in incognito at all. The disabled-button story is dead code. Either add `"incognito": "split"` and do a real `window.incognito` gate on the current window, or delete the incognito user story.

### 5. Tab-group reconstruction by title+color is data-lossy
**From:** Chrome APIs, spec rigor.
Spec keys group restoration on `{title, color}` ([spec:89, 227, 288, 304](../specs/2026-04-18-tab-out-sessions-design.md)). Two distinct original groups with the same label merge into one on restore. Fix: session-local synthetic `savedGroupKey` derived from live `groupId` at save time.

### 6. Taxonomy bloat — named + snapshot + promote
**From:** UX, spec rigor.
Three concepts to solve one user job ("save this window"). "Promote to named" is wrong wording anyway (a copy is created; the snapshot remains). One save flow with optional naming covers the real need.

### 7. 8-second in-memory Undo is the wrong recovery model
**From:** UX, spec rigor.
Refresh, crash, or a second action kills recovery. Undo scope across Quick Save / Delete / Remove-Tab is undefined. Feature whose whole value is preserving work should use durable recovery (e.g., a persistent "Trash" bucket with 7-day retention).

### 8. "100% local / no external fetches" is already false
**From:** security, feasibility.
README promise is broken by:
- Google Fonts load in [index.html:9](../../../extension/index.html).
- Google favicon service calls in [app.js:770, 851, 969](../../../extension/app.js).
Sessions would additionally render page-controlled favicon URLs (possibly attacker-supplied via the saved tab's site). Either self-host both and strip favicon URLs, or rewrite the README.

### 9. Monolith + destructive render model blocks inline stateful UI
**From:** feasibility.
`app.js` is 1482 lines with no module boundaries. Sessions would push it past 2200. Current render is `innerHTML` rebuilds; inline editing/search/expand can't survive it without a real in-memory state object. Prerequisite refactor: real sidebar state boundary (`sidebarState`, `renderSidebar()`, `renderSessionsPane()`), object-based toast controller, and DOM APIs instead of string interpolation.

### 10. Six direct spec contradictions + unjustified magic numbers
**From:** spec rigor.
Self-conflicts at:
- Search scope: user story says "URL hostname", spec section says "hostname + path".
- "Best-effort" groups vs "pinned always restored".
- Rename updates `updatedAt` vs "self-rename is a no-op pass" (test 4).
- Duplicate "never errors" vs `storage.local.set` quota errors exist.
- Promote creates new session vs test says snapshot "remains with identical data".
- Incognito gate uses extension context but spec describes it as window-level.

Magic numbers with no rationale: 8 s Undo, 4 favicons, 50-tab large-session threshold, 100 ms search debounce, 2-session search visibility threshold.

---

## Every-agent high-impact items (one per lane)

Beyond the cross-cutting list:

- **UX:** Single-tab click → whole new window is wrong. Clicking one item in a list should not launch a window.
- **APIs:** `tabGroups` permission triggers a warning ("View and manage your tab groups") that **disables existing installs until users re-accept**. Spec understates the upgrade blast radius. Make it optional.
- **Security:** URL scheme allowlist missing (`data:`, `blob:`, `filesystem:`, `view-source:`, `file://`). Secrets in URLs (auth tokens, signed S3 URLs) persisted silently with no warning, no redaction, no retention limit.
- **Feasibility:** `timeAgo()` returns `5 min ago`, not the mockup's `5m ago`. No `console.log('[tab-out] ...')` convention exists — spec is inventing one.
- **Rigor:** Partial reopen failure (window created, some pins fail) is undefined. Empty-session state (0 tabs remaining) is undefined.

---

## Recommended path forward

The audits don't say "this feature is impossible." They say **the spec as written is not shippable**. Three choices:

### Option A — Descope v1 to the minimum real feature
Ship the smallest thing that delivers value, in order:

1. **Prerequisite refactor** (separate PR, before any Sessions UI):
   - Extract sessions data layer into its own module.
   - Replace `innerHTML` user-text rendering with DOM APIs / `textContent`.
   - Rewrite toast to a controller supporting `{message, actionLabel, onAction, durationMs}`.
   - Rework sidebar visibility so the rail is always present (or Sessions lives elsewhere).
2. **v1 Sessions scope** (single concept, no bloat):
   - One **"Save window"** button (always visible, not hidden in a pill).
   - One session type (named; default auto-name editable at save time).
   - Reopen = additive new window. Single-tab click opens **one tab in the current window**, not a new window.
   - Search is plain filter — no auto-expand, no highlighting.
   - **Durable Trash** (7-day retention) for deleted/overwritten sessions. No in-memory Undo.
   - URL scheme allowlist: `http:`, `https:` only (drop everything else with a tooltip).
   - No `tabGroups` permission; save/reopen group metadata omitted from v1.
   - `chrome.storage.onChanged` listener for multi-page sync.
3. **Defer to v2:** quick-snapshot slot, promote-to-named, tab groups, duplicate action, expand-to-remove-tab. Revisit after v1 has real usage data.

### Option B — Fix the spec in place
Keep the v1 ambitions, but rewrite the spec to resolve every critical/major item: mandated DOM rendering, URL scheme allowlist, synthetic group keys, persistent Trash, incognito story (split or delete), concurrent-write serialization (mutex via storage.onChanged), scheme validation, and all 6 contradictions + 12 ambiguities the rigor agent found. Larger spec, larger initial build, but ships the full design.

### Option C — Kill the feature
If the refactor cost of options A/B is more than the feature is worth to you, Tab Out's existing "Saved for later" is already a weaker form of the same idea. Document the decision, move on.

---

## Full agent reports

Archived separately (can be exported on request). Key points extracted above.
