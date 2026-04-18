# Tab Out Sessions — Final PRD Audit

**Date:** 2026-04-18
**Branch:** `feature/sessions` at HEAD `a0fae1c`
**Method:** 5 parallel Codex agents (GPT-5.4 xhigh, read-only)

| Lane | Agent | Verdict |
|---|---|---|
| Data model + concurrency | `b1a1985f` | Not sign-off ready |
| UI / UX | `abdb3912` | Not sign-off ready |
| Security + privacy | `0169c76e` | Materially safer; 1 bug |
| Save + reopen flows | `42f7d813` | Not PRD-compliant |
| Spec traceability | `8902547a` | Substantially there, partial |

**Consolidated verdict:** Feature is ~90% PRD-complete with no non-goal scope creep and clean security posture, but **5 critical bugs** remain that can surface in normal multi-tab use or specific edge cases, plus ~10 functional gaps worth tightening before merging to `main`.

---

## Critical bugs (ship-blockers)

### C1. Named-session uniqueness race (flagged by Auditors 1 + 4)
**File:** `extension/app.js:459-467, 487-500, 543-546, 2597-2606`
`confirmSaveOverlay()` validates the name **before** the CAS, and `appendSession()` retries blindly on conflict. Two Tab Out tabs saving the same name at the same microsecond can both succeed → duplicate case-insensitive names in storage.
**Fix:** move name-uniqueness check inside the CAS loop — on each retry, re-read sessions and fail the save with the spec's inline error if the name was taken by another tab.

### C2. Atomic write doesn't CAS trash state (Auditors 1 + 4)
**File:** `extension/app.js:427-437, 683-685`
`writeSessionsAndTrashAtomic` only checks `sessions.writeToken`. A concurrent `trashDrop()` (e.g., another tab permanently deletes a record) can be silently clobbered when a delete/remove/snapshot-overwrite writes its own trash payload in parallel.
**Fix:** add a trash generation counter (or stamp the trash object with a writeToken too) and include it in the CAS comparison.

### C3. Tab-group color hard-fails on read (Auditor 3)
**File:** `extension/app.js:348-353` vs spec line 610
`validateSession` rejects the whole session when `groups[key].color` isn't in the enum, sending it to quarantine. The PRD specifies unknown colors **coerce to `'grey'`** at read. One corrupted group color = one lost session recovery.
**Fix:** in the validator, when color is unknown, mutate to `'grey'` in place and accept the session; apply the same coercion in reopen's group-pass.

### C4. Quarantine "copy without move" on CAS failure (Auditor 1)
**File:** `extension/app.js:396-399, 416-425`
`readSessions` writes invalid items to `sessionsQuarantine`, then attempts to rewrite `sessions` without them — but ignores `setSessionsIfUnchanged`'s return value. On conflict, the bad record stays in `sessions.items` AND gets re-added to quarantine on every subsequent read → storage bloat + repeated toasts.
**Fix:** check the return; retry up to 3× on conflict; if all retries fail, roll back the quarantine write so we don't create duplicates.

### C5. `session-tab-remove` doesn't re-render Trash pane (Auditor 2)
**File:** `extension/app.js:3147-3175, 427-437, 1038-1044`
Removing a tab from a session writes to trash, but the handler self-suppresses the `onChanged` echo and never calls `renderTrashPane()`. Result: Trash link stays hidden / count stale until the user navigates elsewhere and back.
**Fix:** call `renderTrashPane()` (and `updateSidebarVisibility()`) after `removeTabFromSession()` returns.

---

## Major gaps / bugs (fix before main)

### M1. First-run Sessions discoverability missing (Auditor 2, Auditor 5 plan drift)
**File:** `extension/app.js:1693-1700, 1702-1704, 2997-3004`
PRD says: header click → switch to Sessions pane + force sidebar visible, and default pane = Sessions when `sessions.length > 0`. Neither is implemented. On first run, the user sees the overlay appear but has no way to see the session card they just saved without manual pill clicks (sidebar may even stay hidden).
**Fix:** in the header chip handler, after save succeeds call `switchSidebarPane('sessions')` and force sidebar visibility. In `initSidebarState()`, default `sidebarPane = 'sessions'` when `sessions.length > 0` and no stored preference exists.

### M2. Enter key unreliable in save overlay (Auditor 2)
**File:** `extension/app.js:2555-2559`, `extension/index.html:143-146`
`Enter` is bound only on the name input. With Cancel or Quick save focused, Enter follows native button behavior — activating whatever button has focus, not the Save button.
**Fix:** bind the `keydown` handler on the overlay root (not just input), and explicitly route Enter to Save when Save is enabled.

### M3. Write-conflict toast missing from delete/remove/save flows (Auditors 1, 5)
**File:** `extension/app.js:520-538, 589-601, 777-812, 2620-2621, 2663-2664`
Only `updateSession` fires the PRD-mandated *"Another Tab Out tab changed this session — reload to see the latest"*. Other flows (delete, remove tab, named save, quick save) fall back to generic *"Couldn't..."* toasts, which is less actionable.
**Fix:** throw a distinguishable `'write-conflict'` error from each write path and catch it uniformly with the PRD message.

### M4. Reopen toast lies about success count (Auditor 4)
**File:** `extension/app.js:2340-2396`
Toast says "Opened N tabs" using `valid.length`, but if `chrome.windows.get({populate: true})` returns fewer tabs, some saved tabs never made it. Tail-mismatch is silently ignored.
**Fix:** use the authoritative post-requery length for the opened count; surface the delta as `"{N} opened, {M} not created"`.

### M5. `groupFailCount` mixes units (Auditor 4)
**File:** `extension/app.js:2365-2386`
Missing created tabs bump the counter per-tab; `chrome.tabs.group()` failures bump per-group-operation. `"X groups failed"` could mean 3 tabs from one group or 3 whole groups — ambiguous.
**Fix:** split into `groupsNotRestored` (unique groups that failed) and `tabsNotGrouped` (individual tabs counted separately).

### M6. Reopen invalid-URL toast missing (Auditor 4)
**File:** `extension/app.js:2315-2316, 2392-2396`
PRD says partial-invalid should get a distinct toast *before* `windows.create`. Current code only appends `"N skipped"` to the final success toast, losing the before/after distinction.
**Fix:** when `dropped > 0` and `valid.length > 0`, fire a pre-open warn toast; drop the "skipped" suffix from the final success toast.

### M7. `saveAsNamedSession` helper is dead code (Auditor 5)
**File:** `extension/app.js:604-626` (helper), `3052-3067` (actual path)
The snapshot's "Save as named session" kebab action goes through `openSaveOverlay` directly instead of calling the tested helper. Two code paths for the same user action.
**Fix:** route the kebab action through `saveAsNamedSession` or delete the unused helper.

### M8. `favicon` permission prompt never fires at runtime (Auditor 3, Auditor 5 plan drift)
**File:** `extension/app.js:3551`
Only a `{prompt: false}` call at init. Users who reject at install-time will never see a prompt — letter-chip fallback forever.
**Fix:** add `{prompt: true}` call-site at first session render that would use favicons, per PRD R6.

### M9. Quota toast non-specific in quick-save + duplicate (Auditor 5)
**File:** `extension/app.js:2662-2664, 3085-3087`
Named save path shows spec-mandated *"Storage full — empty the Trash or delete old sessions"*. Quick save + duplicate fall through to generic *"Couldn't..."*.
**Fix:** move the quota detection into the write helper so all callers get the same message.

### M10. Rename collision uses toast, not inline error (Auditor 5)
**File:** `extension/app.js:2067-2074`
Save overlay has inline error; rename shows a toast. Inconsistent UX.
**Fix:** render the collision message beside the rename input until resolved.

---

## Minor / polish

| # | Issue | Evidence |
|---|---|---|
| m1 | Trash has no active pill state | `extension/index.html:81-83`; Trash is a link, not a pill |
| m2 | Sessions sort affordance absent (PRD mockup shows "Sort: Recent ▾") | `extension/app.js:1747-1795` |
| m3 | Save overlay is full-screen modal, not inline under-header panel | `extension/index.html:137-149`, `extension/style.css:652-720` |
| m4 | `favIconUrl` not scrubbed on read (render ignores it, so no active risk) | `extension/app.js:323-360, 575, 622, 705` |
| m5 | Large-session threshold `> 75` vs PRD wording ambiguity | `extension/app.js:2323-2324` |
| m6 | Storage-layer 120-char name enforcement missing (UI only) | `extension/index.html:141`, `extension/app.js:2047` |
| m7 | First-read init returns defaults but doesn't persist to storage | `extension/app.js:379-382, 636-639` |
| m8 | Stale README line at `README.md:71` | older wording not caught by Phase 7 edits |
| m9 | `tabGroups` decline toast promises kebab path that doesn't exist | `extension/app.js:2442-2458` |
| m10 | Legacy `showToast('text')` calls still present (back-compat wrapper handles) | `extension/app.js:3245, 3307, 3342, 3416, 3455, 3475` |
| m11 | `sessionsQuarantine` store is unversioned | `extension/app.js:405-413` |
| m12 | Quarantine-restore handler doesn't catch storage/append failures | `extension/app.js:2296-2302, 3226-3231` |
| m13 | Phase 8 smoke-results file absent | user action pending |

---

## Positive findings — what's working

- **XSS-safe rendering throughout.** Every user-controlled string (session names, tab titles, URLs, group titles, deferred titles, archive titles) renders via `el()` / `textNode()`. Remaining `innerHTML` sites are static SVG/empty-state/numeric markup only. Auditor 3 PASS.
- **URL scheme allowlist** enforced at save, read, reopen, single-tab open — 4 layers. Auditor 3 PASS.
- **Fonts self-hosted, no third-party fetches.** `rg` confirms zero `fonts.googleapis.com`, `gstatic.com`, `google.com/s2/favicons`, external `favicon.ico`. Auditor 3 PASS.
- **CSP-clean.** No inline handlers, no `eval`, no `new Function`, no string-based `setTimeout`. Auditor 3 PASS.
- **Incognito cleanly unsupported.** No manifest key, no gating logic leftovers. Auditor 3 PASS.
- **Permissions correctly optional.** `favicon` + `tabGroups` in `optional_permissions` — no upgrade-blocker prompt. Auditor 3 PASS.
- **Schema validation on read** with quarantine fallback (modulo bugs C3, C4 above). Auditor 1, 3 PASS.
- **Atomic sessions+trash writes** for destructive flows (except the CAS-trash gap in C2). Auditor 1.
- **Single-tab opens in CURRENT window** (v2 reversal of v1 new-window bug). Auditors 2, 4 PASS.
- **All 6 resolved v1 contradictions landed in code** (search scope, best-effort groups, self-rename no-op, duplicate suffix, save-as-named deep clone, incognito dropped). Auditor 5 contradictions table.
- **Zero non-goal violations.** Multi-window, JSON I/O, tab edit, reorder, move, sync, incognito — all correctly **not** shipped. Auditor 5.
- **7-day trash retention, 50-item cap, self-write suppression** all implemented per spec. Auditor 1.

---

## Recommended fix-up scope

Three grouped commits would close the critical set:

- **Group X (concurrency correctness)** — C1 (uniqueness in CAS loop) + C2 (trash CAS) + C4 (quarantine retry) + M3 (uniform write-conflict toast)
- **Group Y (render/UX correctness)** — C3 (group color coerce) + C5 (renderTrashPane after tab-remove) + M1 (first-run discoverability) + M2 (Enter key on overlay) + M4 (reopen count) + M5 (group failure units) + M6 (invalid-URL toast) + M10 (rename inline error)
- **Group Z (spec drift cleanup)** — M7 (saveAsNamedSession routing) + M8 (favicon runtime prompt) + M9 (quota message uniform) + m7 (first-read persistence) + m8 (README stale line) + m9 (tabGroups decline toast text)

Minors `m1–m13` can wait for follow-ups or be folded into group Z as bundle-of-polish.

---

## Files modified across the audit

None — all audit agents ran read-only.

## Commits since v2 spec went into code

45 on `feature/sessions`, HEAD `a0fae1c`.
