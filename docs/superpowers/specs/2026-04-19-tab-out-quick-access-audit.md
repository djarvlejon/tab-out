# Tab Out Quick-access Row — Codex Audit Synthesis

**Date:** 2026-04-20
**Branch:** `feature/sessions` at HEAD `360e7c3`
**Method:** 4 parallel Codex agents (GPT-5.4 xhigh, read-only)
**Feature commits reviewed:** `e160ffd → 360e7c3` (9 total)

| Lane | Job | Verdict |
|---|---|---|
| Data + concurrency | `43d60617` | Block |
| UI / UX | `99babf23` | Not compliant |
| Security + privacy | `25fad244` | Not compliant |
| Traceability + regression | `81b394df` | Do not sign off |

**Consolidated verdict:** The feature delivers all 5 user stories with zero non-goal scope creep and zero regressions to Sessions. But 2 concurrency bugs, 1 security miss, and a handful of UX/error-handling gaps need to close before merge.

---

## Cross-cutting blockers (flagged by 2+ auditors)

### B1. Workspace storage has no CAS (Auditors 1, 4)
**File:** `extension/app.js:4109-4117`
`writeWorkspaceLinks()` is a blind `chrome.storage.local.set` — no expected-token check, no retry loop. Spec (`...design.md:80`) and plan (`...plan.md:7,1158`) explicitly require the same sessions-style `writeToken` CAS pattern. Two Tab Out tabs editing simultaneously → last-write-wins, silent lost updates.

**Additional race (Auditor 1):** `readWorkspaceLinks()` seed path does an unconditional set. If page A seeds defaults after page B has already added a link, page A's seed overwrites page B's newer data back to 7 defaults.

**Fix:** mirror `setSessionsIfUnchanged` — `writeWorkspaceLinksIfUnchanged(expectedToken, items)` + 3-retry loop; gate the first-read seed on the same CAS (expectedToken = null → only seed if key still absent).

### B2. No render-time URL scheme allowlist (Auditors 3, 4)
**File:** `extension/app.js:4091-4097` (read) and `4188-4195` (render)
`readWorkspaceLinks` accepts any v1 payload; `renderWorkspaceChip` writes stored `item.url` straight into `href`. Spec mitigation #2 (`...design.md:449-451`) requires the allowlist at add **and** render. Corrupted or tampered storage → non-http(s) scheme in a clickable extension link.

**Fix:** extend `readWorkspaceLinks` with per-item schema validation (URL regex, id shape, label ≤48 chars, cap ≤16). Reject or sanitize invalid items on read. Also recheck scheme in `renderWorkspaceChip` before assigning `href`.

### B3. `×` remove overlay not hover/focus gated (Auditors 2, 4)
**File:** `extension/style.css:1687-1689`, `extension/app.js:4198-4207`
Spec `...design.md:309`: *"each chip gains an × overlay in the top-right corner (visible on hover; keyboard-focus shows it too)"*. Shipped CSS makes `×` always visible in edit mode. Makes the strip noisier than intended.

**Fix:** move the `display: block` onto `.qa-chip.qa-edit-mode:hover .qa-chip-remove` / `.qa-chip.qa-edit-mode:focus-within .qa-chip-remove` pair.

### B4. `<button>` nested inside `<a>` — invalid interactive nesting (Auditor 2)
**File:** `extension/app.js:4188-4208`
HTML spec disallows interactive descendants inside `<a>`. This was the root cause of the original `stopPropagation` hack (already fixed in `360e7c3`), but the invalid nesting remains.

**Fix:** restructure as a sibling layout: wrap the chip + remove button in a `<div class="qa-chip-wrap">`, with the anchor and the remove button as siblings. Position the remove button absolutely over the top-right corner.

---

## Major findings (one auditor)

### M1. Full URL leaks via Recently Closed tooltip (Auditor 2)
**File:** `extension/app.js:4331-4333`
Visible text is hostname-only (correct), but `title: tab.url` exposes the full URL on hover — which may contain query-string secrets/tokens. Spec's secrets-in-URLs section (`...design.md:456`) explicitly wanted hostname-only display for over-the-shoulder leaks. Hover tooltip is still over-the-shoulder visible.
**Fix:** change title to hostname only, OR remove the tooltip entirely.

### M2. Row-wide `Esc` to exit edit mode missing (Auditors 2, 4)
**File:** `extension/app.js:4251-4257`
Only the add input listens for Escape. Spec says Esc exits edit mode from anywhere in the row.
**Fix:** attach a `keydown` listener on `#quickAccessRow` (not just the input) that exits edit mode on Escape.

### M3. Add-input blur-cancel is conditional (Auditors 2, 4)
**File:** `extension/app.js:4255-4257`
Blur only cancels if input is empty and no error showing. Spec says blur unconditionally cancels (same as Esc).
**Fix:** remove the conditional — always exit on blur.

### M4. Favicon permission hydrated after first paint (Auditor 2)
**File:** `extension/app.js:4365-4370` (init order)
`renderQuickAccessRow()` runs before `ensureFaviconPermission()`, so first paint shows letter-chip fallbacks even when permission was previously granted.
**Fix:** `await ensureFaviconPermission({prompt: false})` before the first `renderQuickAccessRow()` call. Or re-render once the permission resolves.

### M5. URLs stored raw, not normalized (Auditors 1, 3)
**File:** `extension/app.js:4125, 4138`
Duplicate check normalizes (trailing-slash + lowercase), but persistence uses the raw trimmed input. `https://example.com////` and uppercase hosts can slip into storage.
**Fix:** write `normalized` into the stored URL, not `url`.

### M6. Spec'd error toasts missing (Auditors 2, 4)
- `getRecentlyClosed` rejection path (`extension/app.js:4297-4302`) logs only; spec wants a one-time toast per render cycle.
- Add-link quota error falls through to generic message; spec specifies *"Storage full — delete a link first"*.
**Fix:** add toast on catch; wire quota-detection helper into `addWorkspaceLink`'s error surface (similar to the Sessions fix-up pattern).

### M7. Per-item schema validation on read missing (Auditor 1, 3)
**File:** `extension/app.js:4091-4097`
`readWorkspaceLinks` accepts any `items` array with `schemaVersion: 1`. Per-item fields (`id` shape, `url` scheme, `label` length, cap) aren't validated. A corrupted entry slips through.
**Fix:** validate each item; quarantine or drop invalid entries with a toast (mirroring Sessions `validateSession`).

---

## Minor / nits

| # | Issue | File |
|---|---|---|
| m1 | `.quick-access-row` class not `.qa-*` prefixed | `extension/index.html:40`, `style.css:1615` |
| m2 | README.md not updated to mention quick-access row | `README.md:23-35, 60-71` |
| m3 | Stale comment at `index.html:81` ("RIGHT COLUMN: Saved for Later checklist" but now holds Saved + Sessions + Trash) | `extension/index.html:81` |
| m4 | `.qa-add-wrapper` class referenced but has no CSS rule (already flagged by Opus reviewer) | `extension/app.js:4220` |
| m5 | Magic numbers `5`, `25`, `48`, `250` are inline literals, not named constants | `extension/app.js:4294, 4137, 4343` |
| m6 | No smoke-results file committed | Phase 9 user action, not code |

---

## Positive findings — what's working

- **Zero non-goal violations.** Drag-reorder, rename, closed-window restore, sync, non-URL actions, keyboard shortcuts — all correctly NOT shipped.
- **XSS-safe rendering.** Zero `innerHTML` calls with user/page-controlled data in the quick-access block. All labels, URLs, titles, and hostnames rendered via `el()` / `textNode()`.
- **Scheme allowlist at save time** uses existing `ALLOWED_SCHEMES` regex — cleanly reused, no duplication.
- **`target="_blank"` + `rel="noopener"`** on all Workspace anchors.
- **Optional `"sessions"` permission** correctly in `optional_permissions` only; no install-time prompt; enable chip + runtime request + `onRemoved` revocation re-render all wired.
- **No third-party fetches.** Favicons via `_favicon` endpoint; no gstatic / googleapis / Google favicon service.
- **CSP-clean.** No inline handlers, no `eval`, no `new Function`.
- **All 6 existing Sessions storage.onChanged branches preserved** — no regression to Sessions / Trash / Quarantine / Deferred rendering.
- **Defaults exactly match spec** (Gmail / Calendar / Drive / Docs / Sheets / Slides / Gemini).
- **`_normalizeLastAccessed` helper** handles the ms/seconds ambiguity in `chrome.sessions.Tab.lastAccessed` defensively.
- **`permissions.onRemoved` listener** correctly drops `_sessionsPermissionGranted` when user revokes in `chrome://extensions` — no stale cache.
- **Syntax clean.** `node --check extension/app.js` passes at HEAD and at each reviewed commit.
- **Sessions feature intact.** `renderSessionsPane`, save overlay, kebab menu, Trash pane, search — all verified unmodified.

---

## Recommended fix-up grouping

**Group X — Concurrency correctness (one commit)**
- B1: Workspace CAS + retry + seed race
- M5: normalized URL persistence
- M7: per-item validation on read

**Group Y — UI/Security hardening (one commit)**
- B2: render-time scheme allowlist
- B3: `×` overlay hover/focus gating
- B4: restructure chip+remove out of invalid nesting
- M1: Recently Closed tooltip hostname-only
- M2: row-wide Esc
- M3: unconditional blur cancel
- M4: favicon permission order

**Group Z — Polish (one commit)**
- M6: spec'd error toasts
- m1: rename `.quick-access-row` → `.qa-row`
- m2: README mention
- m3: stale index.html comment
- m4: `.qa-add-wrapper` CSS
- m5: extract magic numbers to named constants (optional)

---

## Next steps

The Opus team (implementer + reviewer) is still idle on this team's task list. Two paths:

1. **Hand the fix-up groups back to the Opus implementer** (fresh context, same team, reviewer can audit each group). Consistent with the pattern used for Sessions.
2. **Dispatch a Codex fix-up agent per group** — faster for mechanical fixes, no need to spin up the Opus team again.

Either works. No new spec or plan needed — this document IS the plan.
