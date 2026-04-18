# Tab Out — Sessions (save & reopen open tabs) — v2

**Status:** Revised after Codex adversarial audit. Ready for user review.
**Date:** 2026-04-18 (v2 revision)
**Supersedes:** v1 at commit `b684cdd` (see audit report `2026-04-18-tab-out-sessions-audit.md`)

## Changelog from v1

Every CRITICAL and MAJOR finding from the 5-agent audit is addressed. Key changes:
- **Prerequisite refactor section added** — toast controller, DOM-only rendering of user text, sidebar visibility rework, `chrome.storage.onChanged` listener.
- **XSS-safe rendering is mandated**, not assumed. A `textNode(...)`-based render primitive replaces `innerHTML` string interpolation for all user-controlled data.
- **Entry point moves out of the sidebar alone.** A **"+ Save window"** chip lives in the header, always visible. The sidebar pane is also reachable via the existing pill switcher but is no longer the sole discovery path.
- **Sidebar visibility logic reworked.** The right rail is rendered whenever *either* pane has content, or the user is actively on the Sessions pane. First-run users with an empty state still see the Sessions pane when they click "Save window".
- **Durable Trash replaces in-memory Undo.** A `sessionsTrash` store with 7-day retention holds deleted sessions, overwritten snapshots, and removed tabs. A 10 s toast Undo remains as the fast-path restore.
- **Tab-group reconstruction uses a synthetic `savedGroupKey`** derived from live `groupId` at save time, not title+color.
- **URL scheme allowlist** (`http:`, `https:` only). Other schemes are skipped at save with a summary toast; corrupted schemes at reopen are rejected by schema validation.
- **Incognito is explicitly unsupported.** Manifest stays at default `"spanning"`. All incognito user stories and flows are deleted.
- **`tabGroups` is an optional permission**, requested at runtime the first time a user saves a tab group. Declining leaves groups out of saved sessions.
- **`chrome.storage.onChanged` syncs state across new-tab pages.** Writes use an optimistic-concurrency `rev` counter per session.
- **Schema versioning + per-record quarantine** on read. One malformed session cannot break the whole store.
- **Self-hosted font + Chrome's `_favicon` endpoint.** Removes the existing Google Fonts and Google favicon service fetches that contradicted the "100% local" README.
- **Named + Snapshot kept, "Promote" renamed** to "Save snapshot as named session" with explicit deep-copy semantics.
- **All 6 v1 contradictions resolved** and every magic number has rationale (see Appendix A).

---

## Unilateral design decisions (override any you disagree with)

These are judgment calls I made during the rewrite. Each is flagged inline below; this list is the summary.

1. **Incognito: unsupported.** Simpler than adding `"incognito": "split"` and the window-level checks that would require. If you want Incognito support, we add it later as its own spec.
2. **Entry point: header chip + sidebar pane.** Grid loses no horizontal space when both panes are empty. Once sessions exist, the sidebar is always visible (matches Deferred's current pattern).
3. **Recovery: persistent Trash (7-day retention, 50-item cap, lazy purge) + 10 s toast Undo.** Trash is the durable truth; Undo is fast-path UX.
4. **Favicons: Chrome's `_favicon` endpoint via optional `"favicon"` permission.** Requested at runtime on first save. Declining → letter-chip only. No third-party favicon fetches.
5. **Fonts: self-hosted WOFF2** files copied into `extension/fonts/` and referenced via `@font-face`. Removes the Google Fonts call in `index.html`.
6. **`tabGroups`: optional permission, runtime-requested** on first save where tab groups are detected. Avoids the "permission warning disables install on update" blast radius.

---

## Summary

Add the ability to save the currently open tabs in a Chrome window as a **session** and reopen that session later in a new window. Two save modes: **named sessions** (user-titled, kept indefinitely) and a **quick snapshot** (single overwritable slot, kept indefinitely, with prior versions recoverable from Trash). Reopen is always additive — session tabs open in a **new window**, leaving the current window untouched. Users can search across their saved sessions and remove individual tabs from a saved session. A 7-day Trash catches destructive actions.

Sync across devices is explicitly **out of scope** to preserve Tab Out's "local-only" promise.

## Motivation

The existing "Saved for later" feature saves individual tabs one at a time for reading later. It does not support capturing a whole workspace (e.g. "everything I have open right now for the pricing research project") as a reopenable unit. Sessions fill that gap.

## User stories

- As a user, I can click **+ Save window** in the header, give the session a name, and later reopen all those tabs in a new window with one click.
- As a user, I can click **Quick save** to overwrite a single snapshot slot without naming anything, and reopen it later — my previous snapshot still recoverable from Trash for 7 days.
- As a user, I can search across my saved sessions by session name, tab title, or tab URL (hostname + path).
- As a user, I can expand a saved session, click any tab to open just that one in the current window, or remove a tab from the session if I no longer want it.
- As a user, I can rename, duplicate, delete, or save-as-named any session. Deletions land in Trash; I can restore them for 7 days.
- As a user, when I delete a tab, close a session, or overwrite the snapshot by accident, a 10 s Undo toast lets me recover immediately; after that the Trash pane is my recovery path.

## Non-goals (YAGNI v1)

- Multi-window capture (current window only).
- Session import/export as JSON.
- Editing a saved tab's title or URL (only removal is supported).
- Reordering tabs within a saved session.
- Moving tabs between sessions.
- Syncing sessions across devices.
- Incognito support. *Rationale: extension pages do not load in Incognito under the default `"spanning"` manifest mode. Adding `"incognito": "split"` would require a separate window-level gating flow and is not justified for v1.*
- Favorite/pin sort override. *Rationale: v1 assumes <20 sessions per user is the typical ceiling; `updatedAt` desc is adequate until usage shows otherwise.*

## Architecture overview

```
┌──────────── New-tab page (index.html) ───────────────────────────────────────┐
│  header                                                                       │
│    Greeting · Date            [+ Save window]   ← always-visible chip        │
│                                                                               │
│  ┌── Open tabs grid ──────────┐    ┌── Right sidebar ──────────────────┐    │
│  │   domain/mission cards     │    │  [ Saved for later (3) ]          │    │
│  │                            │    │  [ Sessions (5) ]    Trash (2)    │    │
│  │                            │    │  ─────────────────────────────    │    │
│  │                            │    │  (active pane content)            │    │
│  └────────────────────────────┘    └───────────────────────────────────┘    │
│                                                                               │
│  footer                                                                       │
└───────────────────────────────────────────────────────────────────────────────┘
```

All code lives in the existing extension files, but with **explicit internal module boundaries** introduced as part of the prerequisite refactor:

- `extension/app.js` — split internally by banner-commented sections:
  - *Storage layer* — `getSessions`, `saveSession`, `renameSession`, `duplicateSession`, `deleteSession`, `removeTabFromSession`, `getTrash`, `trashPurge`, `restoreFromTrash`, `dropFromTrash`.
  - *Sidebar state* — `sidebarState`, `renderSidebar`, `renderDeferredPane`, `renderSessionsPane`, `renderTrashPane`.
  - *Toast controller* — object-API `showToast({message, actionLabel?, onAction?, durationMs?})` with queueing.
  - *DOM helpers* — `el(tag, attrs, children)`, `textNode(str)`, `escapeAttr(str)` used for *all* user-controlled rendering.
- `extension/index.html` — adds the header chip, the pill switcher markup, and a self-host `<link rel="stylesheet" href="fonts/fonts.css">` replacing Google Fonts.
- `extension/style.css` — adds styles for the header chip, session cards, expand/collapse, search input, Trash pane. No `pointer-events: none` on toasts that expose an action.
- `extension/fonts/` — new folder. `DMSans.woff2`, `Newsreader.woff2`, and a generated `fonts.css` file. See Licensing below.
- `extension/background.js` — no changes required.
- `extension/manifest.json` — add `"favicon"` to `optional_permissions`, add `"tabGroups"` to `optional_permissions`. No changes to `permissions`.

No new JS files. No external dependencies.

## Prerequisite refactor

These changes are **required before any Sessions UI code lands**. They are scoped to the minimum that unlocks Sessions without breaking existing features.

### R1. Sidebar visibility rework

Current: `#deferredColumn` has `display:none` by default; it becomes visible only when Deferred has items.
Revised: rename the element id to `#sidebarColumn` (keep the class `.deferred-column` for CSS backwards-compat; add `.sidebar-column` as a co-class). Visibility rule:

- Show sidebar if **any** is true:
  - Deferred has active or archived items.
  - `sessions.length > 0`.
  - `sessionsTrash.length > 0`.
  - User navigated to the Sessions pane explicitly (header chip click or pill click).
- Within the sidebar, pills always render when visible. Deferred pill defaults to active when Deferred has items AND Sessions is empty; Sessions pill defaults to active otherwise.

### R2. Toast controller rewrite

Current: `showToast(text)` with `pointer-events: none` text+icon.
Revised: `showToast({ message, actionLabel?, onAction?, durationMs = 4000 })`.

- When `actionLabel` is present, the toast renders a `<button>` child with `pointer-events: auto`. The toast container keeps `pointer-events: none`; the button overrides inside.
- Multiple calls queue (single visible; next fires after current dismisses).
- Clicking the action dismisses the toast and calls `onAction()`.
- `durationMs` is the auto-dismiss timer; actionable toasts default to 10000 (10 s) for Undo.
- All existing `showToast('...')` call sites migrated to `showToast({ message: '...' })`.

### R3. DOM-only rendering for user-controlled data

Current: `innerHTML` string interpolation with ad-hoc `replace(/"/g, '&quot;')` in attributes.
Revised: introduce `el(tag, attrs, children)` and `textNode(str)` helpers. **All** rendering of session names, tab titles, tab URLs, group titles, deferred tab titles, and deferred tab URLs goes through these helpers, which call `document.createElement`, set attributes via `setAttribute`, and append text via `textContent` / `appendChild(document.createTextNode(...))`. String HTML templates may still be used for purely static markup (layout frames, icons) but **never** for user-controlled strings.

Migration scope: `renderDeferredList()`, `renderArchiveList()`, and the tab-chip builders in the main grid are migrated in the same PR. This is a real scope expansion but eliminates the XSS surface that the audit flagged — and it's a precondition to safely rendering user-editable session names.

### R4. Multi-page sync via `chrome.storage.onChanged`

Current: no listener. Two new-tab pages can silently diverge.
Revised: install a `chrome.storage.onChanged` listener in `app.js` at startup. When keys `sessions`, `sessionsTrash`, or `deferred` change, re-render the affected pane (targeted, not full-page). Prevent feedback loops by tagging self-initiated writes with a generated `writeToken` stored alongside the data; ignore `onChanged` events whose value matches the latest self-token.

### R5. Self-hosted fonts

Download `DMSans-variable.woff2` and `Newsreader-variable.woff2` from Google Fonts (both licensed SIL OFL 1.1 — redistributable). Place in `extension/fonts/`. Generate `extension/fonts/fonts.css` with `@font-face` declarations pointing to relative paths. Replace the `<link>` in `index.html`.

### R6. `_favicon` endpoint for local favicons

Favicons render via Chrome's built-in `_favicon` URL scheme (see Chrome docs: "Fetching favicons"). Requires the `"favicon"` permission. Added as **optional**, requested at runtime on first session render that would use a favicon. If the user declines, letter-chip fallback is used universally. Existing Google favicon service calls in `renderDeferredList` are also migrated so the whole extension stops making third-party requests.

---

## Data model

Two new keys in `chrome.storage.local` (siblings to existing `deferred`):

```js
// Versioned store; enables future migrations.
sessions = {
  schemaVersion: 1,
  items: [
    {
      id: "sess_01HX…",                       // ULID (lexicographically sortable by creation time)
      rev: 3,                                   // optimistic-concurrency counter; increments on every write
      name: "Pricing research",                 // fixed "Snapshot" for the snapshot slot
      kind: "named" | "snapshot",
      savedAt: "2026-04-18T14:32:00.000Z",
      updatedAt: "2026-04-18T14:32:00.000Z",
      summary: {
        tabCount: 12,
        uniqueDomains: 6,
        topDomains: [
          { hostname: "github.com", count: 5 },
          { hostname: "google.com", count: 3 },
          { hostname: "youtube.com", count: 2 },
          { hostname: "linkedin.com", count: 2 }
        ]                                       // up to 4, sorted by count desc, ties broken by hostname asc
      },
      tabs: [
        {
          url:          "https://github.com/foo/bar/pull/42",
          title:        "Add session save · foo/bar#42",
          favIconUrl:   "",                     // always empty string; rendering uses _favicon endpoint
          pinned:       false,
          index:        3,                      // original position in the source window (pre-pin-normalization)
          savedGroupKey: "grp_0"                // synthetic session-local key; null if ungrouped
        }
      ],
      groups: {                                 // session-local group metadata, keyed by savedGroupKey
        "grp_0": { title: "Research", color: "blue" }
      }
    }
  ],
  writeToken: "wt_01HX…"                        // rotated on every write to dedupe storage.onChanged echoes
}

sessionsTrash = {
  schemaVersion: 1,
  items: [
    {
      trashId: "tr_01HX…",
      trashedAt: "2026-04-18T14:40:00.000Z",
      reason: "deleted" | "snapshot-overwritten" | "tab-removed",
      session: { /* full frozen copy of the session */ },
      removedTab: { /* only when reason === "tab-removed"; the single tab record */ }
    }
  ]
  // no writeToken; Trash reads are read-only outside of restore/purge
}
```

### Schema rules

- `sessions.items` ordering at rest is *not* display order. Display order is computed at render time: snapshot first (if present), then named sessions by `(updatedAt desc, id desc)` — `id` breaks ties deterministically (ULID prefix contains creation time).
- Session names are unique across `kind: "named"` sessions. Comparison is case-insensitive and trims leading/trailing whitespace. The snapshot's fixed `"Snapshot"` label is not part of the uniqueness namespace.
- `summary.topDomains` stores `{hostname, count}` pairs, sorted by count desc, ties broken by hostname ascending (alphabetical, case-insensitive).
- `favIconUrl` is always stored as empty string in v2. Rendering uses `chrome.runtime.getURL('_favicon?pageUrl=' + encodeURIComponent(tab.url) + '&size=32')` with the `"favicon"` permission.
- `savedGroupKey` is session-local. At save time, each unique `tab.groupId` (>= 0) is mapped to a string `"grp_0"`, `"grp_1"`, … in the order the groups are first encountered during the tabs iteration. `null` means the tab was ungrouped.
- `groups` is an object keyed by `savedGroupKey` holding `{title, color}`. Validated on read against Chrome's color enum; unknown colors fall back to `"grey"`.
- Migration: first read initializes both stores with `schemaVersion: 1` and `items: []` if absent. On future schema bumps, a `migrate(fromVersion, toVersion, data)` function runs before render. v1 data has no migration path (no prior shipped version).

### Storage footprint

~400 B per tab after the favicon URL drop. 100 sessions × 50 tabs ≈ 2 MB. Trash doubles that in the worst case (every session in Trash simultaneously), bringing us to ~4 MB — still well under the default 10 MB `chrome.storage.local` budget. Quota-exceeded handling described under Error handling.

### Optimistic concurrency

Every write to `sessions` follows read-modify-write with a `rev` check:

```
async function updateSession(id, mutator) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { items, writeToken } = await readSessions()
    const index = items.findIndex(s => s.id === id)
    if (index === -1) throw new Error('gone')
    const oldRev = items[index].rev
    const next = mutator(structuredClone(items[index]))
    next.rev = oldRev + 1
    next.updatedAt = new Date().toISOString()
    items[index] = next
    const ok = await setSessionsIfUnchanged(writeToken, items)  // conditional write via re-read check
    if (ok) return
    // another page won; retry
  }
  throw new Error('write conflict')
}
```

`setSessionsIfUnchanged` performs a re-read inside the same microtask and aborts if `writeToken` changed. Not a true atomic CAS (Chrome storage has none), but closes the race for realistic user timing.

### Schema validation on read

Before any render, `readSessions()` validates each item against an inline schema. Items failing validation are removed from the rendered list and moved to `sessionsQuarantine` in storage. A single diagnostic toast fires once per session: *"Skipped 1 invalid session — check Trash → Quarantine."* Quarantined items are shown in an expandable "Quarantine" section under Trash with "Restore" (attempts to coerce to valid) and "Delete permanently" actions. This prevents one malformed record from breaking search and render.

---

## UI

### Header entry point

A `.header-actions` container is added to `<header>` on the right side of the greeting/date block. Contains one primary chip:

```
[ + Save window ]
```

- Rendered at all times (including first-run, even when no sessions exist).
- Clicking opens the **Save overlay**: an inline panel under the header with an auto-filled name input (`Session · <locale date, time>`), Save/Cancel buttons, and a secondary `Quick save (overwrite snapshot)` link. The overlay captures the current tab set at the moment the chip is clicked (not at Save-click), so the user can type the name without worrying about window changes mid-naming.
- Keyboard: Enter saves, Esc cancels.

### Sidebar pill switcher

At the top of the sidebar (when visible — see R1), two pills and a Trash link:

```
┌────────────────────────────────────────┐
│ [ Saved for later (3) ] [ Sessions (5) ] Trash (2) │
└────────────────────────────────────────┘
```

- Pill styling uses a new `.pill` class (not a reuse of existing `.section-count`, which is plain muted text in current code). Active pill is filled; inactive is outlined.
- `Trash (N)` is a muted link, right-aligned. Clicking opens the Trash pane (a third pane selectable alongside Deferred and Sessions). Count is zero-hidden.
- Pill choice persists in `chrome.storage.local.sidebarPane = "deferred" | "sessions" | "trash"`.

### Sessions pane

```
┌──────────────────────────────────────┐
│  Sort: Recent ▾                       │   ← Sort menu; v1 value is "Recent" only
│  ┌────────────────────────────────┐  │
│  │  🔍 Search sessions…           │  │   ← always visible when sessions.length ≥ 1
│  └────────────────────────────────┘  │
│                                       │
│  ─── Snapshot ───                     │   ← divider hidden when no snapshot
│  ┌─ 📸 Snapshot             ⋯ ▸ ─┐   │
│  │ 12 tabs · 6 sites · 5 min ago   │   │
│  │ [●][●][●][●]                    │   │   ← favicon row (top 4)
│  └────────────────────────────────┘   │
│                                       │
│  ─── Named ──────                     │   ← divider hidden when no named sessions
│  ┌─ Pricing research         ⋯ ▸ ─┐   │
│  │ 8 tabs · 4 sites · 2 hrs ago     │   │
│  │ [●][●][●][●]                    │   │
│  └────────────────────────────────┘   │
└──────────────────────────────────────┘
```

- Timestamps use the existing `timeAgo()` output format (`5 min ago`, `2 hrs ago`, `yesterday`) — not the `5m` / `2h` shorthand the v1 mockup invented. `timeAgo()` is reused as-is.
- Favicon row: 4 × 16 px circles, 2 px overlap. Icon source is the `_favicon` endpoint; letter-chip fallback if permission denied or rendering fails.
- Search input is visible when `sessions.length >= 1` (v1 said ≥2; v2 simplifies — if you have any session, you can search it).

### Session card

- **Click anywhere on the card body** except the kebab and chevron → **reopens the whole session in a new window** (Reopen flow below).
- **Chevron (▸)** toggles an inline tab list. Expansion is visual state only; not persisted.
- **Kebab (⋯)** menu per card:
  - *Reopen* (duplicates body click; included for discoverability).
  - *Rename* (disabled on snapshot) — inline edit with uniqueness check.
  - *Save as named session* (snapshot only) — opens the Save overlay with the snapshot's tabs pre-filled.
  - *Duplicate* — see Duplicate flow.
  - *Delete* — sends the session to Trash (Trash flow). Confirmation is a 10 s "Deleted · Undo" toast, not an inline confirm dialog.

### Expanded tab list

```
┌─ Pricing research                 ⋯ ▾ ┐
│ 8 tabs · 4 sites · 2 hrs ago            │
│ [●][●][●][●]                            │
├────────────────────────────────────────┤
│ ● Add session save · foo/bar#42    ✕  │   ← click row opens tab in current window's active tab
│ ● Pricing model — Notion            ✕  │
│ ● Competitor analysis — Sheets      ✕  │
│ …                                      │
└────────────────────────────────────────┘
```

- **Click on a tab row** (not on ✕) → opens the tab's URL in the **current window** via `chrome.tabs.create({ url, windowId: currentWindowId, active: true })`. This is the v1-reversal the UX agent flagged: single-tab click was a new window in v1, which is wrong UX for a list-click.
- **✕ button** → moves that one tab to Trash (reason `"tab-removed"`). Confirmation is a 10 s "Tab removed · Undo" toast.
- If `tabs.length` reaches 0 after a removal, the card shows the **Empty session** state:
  ```
  ┌─ Pricing research                 ⋯ ▾ ┐
  │ 0 tabs (all removed)                    │
  │ [ Restore from Trash ] [ Delete ]       │
  └────────────────────────────────────────┘
  ```
  Empty sessions remain in the list; sort position is preserved by `updatedAt`. Search matches them only on `name`.

### Search

- Client-side substring match, case-insensitive, 150 ms debounce (*rationale: 150 ms is the upper end of the "perceived instant" window at ~100–200 ms; 100 ms felt jittery in testing of the existing `archiveSearch` input*).
- Matches on: `session.name`, each `tab.title`, and each `tab.url`'s `hostname + pathname` (not scheme, not query, not fragment). Resolved contradiction: the v1 user story said "URL hostname" and the section-body said "hostname + path"; v2 picks **hostname + path** and updates both places.
- A matched session is kept in the list; non-matches are hidden. Matched tabs are highlighted with a subtle background tint inside already-expanded cards. **Search does not auto-expand cards** (v2 change — removes the layout-thrash UX the agent flagged).
- Counter below the input reads `"{N} session{s} match"` — count is *sessions*, not tabs; disambiguated from v1.
- Clearing the input restores the full list. Manually-expanded cards remain expanded; their state is untouched.
- Search state is not persisted.

### Trash pane

```
┌──────────────────────────────────────┐
│  Trash · 7-day retention             │
│  ┌────────────────────────────────┐ │
│  │ 📸 Snapshot (overwritten)       │ │
│  │ 12 tabs · overwritten 5 min ago │ │
│  │ [ Restore ] [ Delete permanently ]│ │
│  └────────────────────────────────┘ │
│  ┌────────────────────────────────┐ │
│  │ 🗑 Pricing research (deleted)   │ │
│  │ 8 tabs · deleted 2 hrs ago       │ │
│  │ [ Restore ] [ Delete permanently ]│ │
│  └────────────────────────────────┘ │
│  ─── Removed tabs ───                 │
│  ┌────────────────────────────────┐ │
│  │ Add session save · foo/bar#42   │ │
│  │ from "Pricing research" · 3h ago│ │
│  │ [ Restore ] [ Delete permanently ]│ │
│  └────────────────────────────────┘ │
└──────────────────────────────────────┘
```

- Items > 7 days old are lazy-purged on any Trash read.
- Hard cap of 50 items; on overflow, oldest is evicted.
- Restore semantics:
  - *Session deleted* → session re-inserted into `sessions.items` with a fresh `updatedAt`; name conflict auto-suffixes `(restored)`, then `(restored 2)`, etc.
  - *Snapshot overwritten* → replaces the current snapshot and sends the current snapshot to Trash.
  - *Tab removed* → tab spliced back into the parent session at its original `index` (or appended if index is past bounds). If parent session no longer exists (deleted then Trash-purged), the restore creates a new named session called `"{old name} (recovered)"`.

### First-run discoverability

- With zero sessions and zero deferred, the sidebar is hidden (existing behavior preserved for users who don't use Saved for later).
- The header **+ Save window** chip is always visible — that's the primary discovery path.
- On first click, the overlay appears above the (still-empty) sidebar. After Save, the sidebar renders with the new session visible and the Sessions pane active.

---

## Save flow

```
User clicks [ + Save window ] (or kebab → Save as named session on snapshot)
         ↓
capture tabs NOW:
  chrome.tabs.query({currentWindow: true})
         ↓
apply URL-scheme allowlist (http: and https: only)
  drop chrome://, chrome-extension://, file://, data:, blob:, filesystem:,
       view-source:, devtools://, and the Tab Out new-tab page itself
         ↓
if 0 tabs remain → toast "Nothing to save (unsupported URL schemes)" and abort
         ↓
detect if any tab has groupId >= 0:
  if yes AND "tabGroups" permission not granted:
    chrome.permissions.request({permissions: ["tabGroups"]})
      granted → proceed to group read
      declined → proceed without groups (tab.savedGroupKey = null)
         ↓
collect unique tab.groupId values; for each, call chrome.tabGroups.get(groupId)
assign synthetic keys "grp_0", "grp_1", ... in first-seen order
         ↓
if favicons will be rendered AND "favicon" permission not granted:
  chrome.permissions.request({permissions: ["favicon"]})
    granted → save proceeds; render uses _favicon endpoint
    declined → save proceeds; render uses letter-chip fallback
         ↓
build tab records:
  { url, title (fallback: hostname; if hostname fails, "Untitled"),
    favIconUrl: "", pinned, index, savedGroupKey }
         ↓
compute summary (tabCount, uniqueDomains, topDomains)
         ↓
display inline name input:
  default: "Session · Apr 18, 2:32pm"
  if collision with existing named session → auto-append "(2)", "(3)", ...
  user can edit; Save button disabled while collision persists
         ↓
on Save (named) → create { id: ulid(), rev: 0, kind: "named", ... }
on Quick save   → read existing snapshot; if present, deep-copy to Trash
                  with reason "snapshot-overwritten";
                  write new snapshot with id "__snap__", rev = oldRev + 1 (or 0)
         ↓
commit via optimistic-concurrency updateSession / createSession
         ↓
toast:
  "Saved · {N} tabs{, M skipped}"                  (named)
  "Snapshot saved · {N} tabs   [Undo]"             (quick; Undo restores prior snapshot)
re-render Sessions pane
```

### Auto-default name

`new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })` prefixed with `"Session · "`. If that exact name already exists, append `(2)`, `(3)`, … until unique. Never errors; never warns.

### Name validation

- Trimmed before storage and comparison.
- Empty or whitespace-only → falls back to the auto-default on Save.
- Unique per case-insensitive comparison across `kind: "named"` sessions.
- Max length 120 characters (truncated silently on paste to prevent storage bloat).

---

## Reopen flow

```
User clicks a session card body OR kebab → Reopen
         ↓
read session via readSessions() (applies schema validation)
         ↓
if session.tabs.length === 0 → toast "Session is empty" and abort
         ↓
re-apply URL-scheme allowlist (defensive; skips corrupted schemes from old data)
if any dropped → toast "Reopening {N}/{M} tabs ({M-N} had invalid URLs)"
         ↓
chrome.windows.create({
  url: validTabs.map(t => t.url),
  focused: true,
  state: "normal"
})
         ↓
on resolution, chrome returns the new window with tab ids
re-query the window via chrome.windows.get(newWindowId, {populate: true})
    to get authoritative tab array (positional mapping is not a documented contract)
         ↓
map saved tabs to created tabs by positional index
         ↓
pin-pass:
  for each saved tab with pinned === true:
    try: chrome.tabs.update(newTabId, {pinned: true})
    catch: increment pinFailCount
         ↓
group-pass (only if "tabGroups" permission granted AND session.groups is non-empty):
  for each unique savedGroupKey in this session:
    collect newTabIds for tabs with that savedGroupKey
    try: groupId = await chrome.tabs.group({tabIds, createProperties: {windowId: newWindowId}})
         await chrome.tabGroups.update(groupId, { title, color })
    catch: increment groupFailCount
         ↓
toast:
  "Opened {N} tabs in new window"                   (normal)
  "Opened {N} tabs, {M} skipped, {P} pins failed"   (when anything failed)
  "Opening {N} tabs — this may take a moment"       (when N > 75; rationale in Appendix A)
```

### Single-tab reopen from expanded list

Separate flow (new in v2, resolving the v1 UX miss):

```
User clicks a tab row inside an expanded session card
         ↓
apply URL-scheme allowlist to that single tab
  if invalid → toast "Cannot open — invalid URL scheme"
         ↓
chrome.tabs.create({ url, windowId: <current window>, active: true })
         ↓
toast "Opened tab"
```

Single-tab reopen does **not** create a new window, **does not** preserve pin/group metadata, **does not** modify the source session.

### Partial reopen failure (resolved ambiguity)

- `chrome.windows.create` throwing is a terminal failure; toast *"Couldn't open session — Chrome blocked the window"* and log.
- `chrome.tabs.update(..., {pinned})` failing is counted but non-fatal; tab opens unpinned. Toast summary includes `"{P} pins failed"` when P > 0.
- `chrome.tabs.group` failing is counted but non-fatal; tabs open ungrouped. Toast summary includes `"{P} groups failed"` when P > 0.
- No retry. No rollback. Reopen is best-effort after the window is created.

---

## Tab removal from a saved session

- User clicks ✕ in an expanded card.
- Immediate action: splice the tab from `session.tabs`, recompute `summary`, increment `rev`, bump `updatedAt`, push the removed tab to Trash (reason `"tab-removed"`, with parent session id in the record).
- Toast: *"Tab removed · Undo"* (10 s).
- Undo pops the tab record from Trash and re-inserts into the session at its original `index` (or appended if bounds shifted).
- If `session.tabs.length === 0` after removal, the card flips to the Empty session state. The session remains in the list with its name and `updatedAt` sort position.

---

## Rename / Duplicate / Delete / Save-as-named

### Rename

- Inline edit on the card title. Uniqueness check against all *other* named sessions (self-rename is explicitly valid and **does not bump `updatedAt`** — resolved contradiction from v1).
- On save, update `name`, increment `rev`.

### Duplicate

- Creates a new `kind: "named"` session with:
  - Fresh `id` (ULID).
  - `rev: 0`.
  - `savedAt = updatedAt = now`.
  - Deep clone of `tabs` and `groups` (new object identity; removing a tab from the duplicate does not affect the original).
  - Recomputed `summary`.
  - Name: `"{original} (copy)"` → `"{original} (copy 2)"` → `"{original} (copy 3)"` … until unique. If the original already ends in `(copy)`, the duplicate becomes `"{original} (copy 2)"` directly, skipping the redundant `(copy) (copy)` form.
- Placed in the list at the top (newest `updatedAt`).
- Collisions on name are auto-resolved by suffix; storage quota errors are the **only** way Duplicate can fail — caught and surfaced via the quota-exceeded toast (resolved contradiction from v1).

### Delete

- Moves the session to Trash with reason `"deleted"`, then removes from `sessions.items`.
- Toast: *"Deleted · Undo"* (10 s). Undo lifts the session back out of Trash; if a session with the same name has been created in the meantime, auto-suffix `(restored)`.
- After 7 days, Trash purge removes it permanently.

### Save snapshot as named session (was "Promote to named" in v1)

- Kebab action only on snapshot cards.
- Opens the Save overlay with the snapshot's tabs pre-filled (deep-cloned; the snapshot slot is unchanged).
- Works exactly like a fresh Save from scratch, but skips the `chrome.tabs.query` step and uses the snapshot's stored tab array.
- Saves as `kind: "named"` with fresh `id`, `rev: 0`, `savedAt = now`.

---

## Error handling

| Condition | Response |
|---|---|
| Tabs API returns 0 savable tabs after scheme filtering | Toast *"Nothing to save (unsupported URL schemes)"*; no storage write |
| URL scheme filtering skipped M of N tabs | Toast includes *"{M} skipped"* with a tooltip explaining why |
| Incognito window | Feature is not available at all (extension page does not load); no handling required |
| `chrome.storage.local.set` rejects (quota) | Caught at the `await`; toast *"Storage full — empty the Trash or delete old sessions"*; in-memory state untouched; pending write NOT retried |
| `chrome.permissions.request` declined for `tabGroups` | Session saves without groups; silent unless it's the first time, in which case one-time toast *"Groups won't be saved without permission — grant it from the kebab menu anytime"* |
| `chrome.permissions.request` declined for `favicon` | Favicons fall back to letter chips universally; no toast (letter chips are acceptable default) |
| `chrome.tabGroups.get` rejects per-group | Tab's `savedGroupKey` set to `null`; group is not written to `session.groups` |
| `chrome.windows.create` rejects | Toast *"Couldn't open session — Chrome blocked the window"*; log error |
| `chrome.tabs.update({pinned:true})` rejects | Counted in `pinFailCount`; toast reflects it |
| `chrome.tabs.group` rejects | Counted in `groupFailCount`; toast reflects it |
| Schema validation fails on a session | Item moved to `sessionsQuarantine`; one-time toast per render cycle directing to Trash → Quarantine |
| Write conflict (concurrent pages) after 3 retries | Toast *"Another Tab Out tab changed this session — reload to see the latest"*; the failing write is discarded |
| `storage.onChanged` fires on `sessions` | Re-render Sessions pane; skip if the change's serialized `writeToken` matches our last-written token |
| `storage.onChanged` fires on `sessionsTrash` | Re-render Trash pane count badge and pane body if open |
| Favicon URL fails to load (permission granted but image 404s) | `<img>` `onerror` handler (in JS, not inline HTML — MV3 CSP compliant) replaces the img with the letter-chip element |
| User collides on save/rename | Inline error below input; Save disabled; Enter is no-op while disabled |

All console output uses the existing format convention: `console.warn('[tab-out] ...', ...)`, `console.error('[tab-out] ...', ...)`. No new logging channel invented.

---

## Security & privacy

### Threat model

- **Page-controlled tab metadata is untrusted.** Sites set `document.title` and favicon URLs. Those values get stored and rendered persistently.
- **User-entered session names are untrusted input** to our renderer, even though the user is the typing party (pasting arbitrary HTML/JS should not harm the extension).
- **`chrome.storage.local` is not accessible to regular web pages** given the current manifest (no content scripts, no `externally_connectable`). It is accessible to extension pages. v1's concern about content-script access does not apply today; if it ever does, apply `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`.
- **URLs may contain secrets** (auth tokens, signed URLs). Stored persistently in `chrome.storage.local`. On-disk in the browser profile.

### Mitigations (mandatory in implementation)

1. **No `innerHTML` for user-controlled text.** All session names, tab titles, URLs, group titles, deferred tab titles, and deferred tab URLs render via `textNode(...)` into DOM nodes created with `document.createElement`. Attribute values use `setAttribute` (no string interpolation).
2. **URL scheme allowlist** at save, reopen, and render. Only `http:` and `https:` pass. `data:`, `blob:`, `filesystem:`, `view-source:`, `javascript:`, `file:` are dropped at save, skipped at reopen, and (if present in corrupted legacy data) rejected at schema validation.
3. **Tab-group color validated against allowlist**: `grey | blue | red | yellow | green | pink | purple | cyan | orange`. Unknown → `grey`.
4. **Favicon URLs never stored**. Always rendered via `chrome.runtime.getURL('_favicon?pageUrl=...')` + `"favicon"` permission. No third-party favicon service calls.
5. **Fonts self-hosted**. No Google Fonts loads from `index.html`.
6. **Schema validation on read**, per-record quarantine. Single malformed session cannot crash the feature.
7. **Secrets-in-URLs disclosure**. First-time save triggers a one-time dismissible banner in the Sessions pane: *"Tab Out saves full URLs including query parameters. If a tab contains a password-reset link or other sensitive URL, remove the tab from the session before saving. Your data stays on this device."* User can dismiss permanently.
8. **Inline event handlers removed**. Existing inline `onerror` attribute in `extension/index.html:130` (the config.local.js script tag) is replaced with a JS-attached `error` listener to comply with MV3's default CSP. All new img-error handlers attached in JS, never in HTML attributes.

### Privacy guarantees (realistic)

- After v2: **zero third-party fetches** from the extension's new-tab page. Fonts local, favicons via Chrome's built-in endpoint, sessions in `chrome.storage.local` only.
- No network calls made by `background.js` (unchanged).
- No telemetry, no analytics, no remote config. This matches the README's promise.
- Sync to other devices: **not implemented.** `chrome.storage.sync` is not used.

### README update required

As part of this change, update README.md to replace *"No external API calls"* with *"No external API calls — all assets are local; favicons use Chrome's built-in endpoint."* and remove the outdated "your data never leaves your machine" line in favor of *"Your sessions are stored locally in your Chrome profile. Nothing is synced or uploaded."* The new wording is truthful after the v2 refactor; the old wording was not truthful before or after.

---

## Testing (manual smoke matrix)

Tab Out has no automated test harness; testing is manual. Run this matrix before any merge.

### Save & reopen
1. Save a named session with 5 tabs (mix of regular + pinned) → reopen → verify count, order, pinned flags.
2. Quick save → Quick save again → Trash shows the first snapshot as "overwritten"; clicking Restore from Trash brings it back and sends the current snapshot to Trash.
3. Save with `chrome://` tabs in the window → toast shows `"N saved, M skipped"`.
4. Save with tab groups, decline `tabGroups` permission → session saves without groups; accepting later via kebab reuses the same session or requires resave (v2: requires resave — documented).
5. Save with tab groups, accept permission → reopen → group title and color restored, even if two original groups had the same title+color (synthetic key test).

### Names & uniqueness
6. Save two sessions with the same name → inline error; save button disabled.
7. Rename a session to match another → same inline error.
8. Rename a session to its own current name → no-op, `updatedAt` unchanged.
9. Duplicate a session twice → names become `X (copy)`, `X (copy 2)`.
10. Duplicate `X (copy)` → becomes `X (copy 2)` (skips redundant suffix).

### Trash & undo
11. Delete a session → Undo within 10 s → session returns with identical data.
12. Delete a session → wait 11 s → session is in Trash pane with Restore / Delete permanently buttons.
13. Delete from Trash pane → session is gone permanently; no recovery.
14. Fill Trash with 51 items → oldest is auto-evicted on next write.
15. Trash item > 7 days old → lazy-purged on next Trash read.

### Tab editing
16. Expand a session → click a tab row → opens in current window (not a new window — v2 fix).
17. Remove a tab from a session → Undo within 10 s restores it.
18. Remove all tabs from a session → Empty session state appears with Delete button; session still in list.

### Search
19. Search by session name → list narrows, matched cards stay visible, cards remain collapsed (v2: no auto-expand).
20. Search by tab title within an expanded card → matched tab highlighted, others un-highlighted.
21. Search by URL hostname+path → match. Search by URL query → no match (search scope).
22. Clear search → list restores; manually-expanded cards remain expanded.

### Concurrency
23. Open two Tab Out new-tab pages; delete a session in page A → page B re-renders within ~1 second via `storage.onChanged` without manual reload.
24. Rename the same session simultaneously in two tabs → one wins, the other shows the write-conflict toast on the third retry.

### Error paths
25. Fill `chrome.storage.local` near the 10 MB quota via DevTools → attempt save → quota toast fires; state untouched.
26. Corrupt one session via DevTools (invalid `kind`) → reload → item moves to Quarantine; rest of list renders.
27. Save with a URL containing a password-reset-style token → first-time banner appears; dismiss; never shows again.

### Platform
28. Open a new tab in Incognito → Tab Out does not load (default `"spanning"`); no feature exposure.
29. Reload the extension → sessions persist; Trash persists; write token rotates.
30. Under extreme load (save 200 tabs) → toast shows `"Opening 200 tabs — this may take a moment"`; all tabs open; Chrome may warn.

---

## Backward compatibility

- Existing `deferred` store is untouched. The render of the Deferred pane moves to the new DOM-only helpers (`textNode`, `el`), matching the Sessions pane rendering. Output is visually identical.
- Existing toast call sites migrate from `showToast('msg')` to `showToast({message: 'msg'})`. Automated grep-and-replace covers all call sites.
- Manifest adds `favicon` and `tabGroups` to **`optional_permissions`** only. This does **not** trigger a permission warning or disable existing installs. Users approve them at runtime on first use.
- First render of the revised extension silently initializes empty `sessions` and `sessionsTrash` stores if absent.
- Existing CSS selectors keyed on `.deferred-column` continue to work (the class is retained on the renamed element).

---

## Appendix A — Resolved magic-number rationale

| Value | Where | Rationale |
|---|---|---|
| **10 s** Undo toast | Delete, Remove tab, Quick save | Matches the mental model of "I just did that and want to undo" without blocking the next interaction. The audit flagged 8 s as arbitrary; 10 s is still the right ballpark but rounder and long enough to absorb a brief distraction. Durable Trash covers the >10 s case. |
| **7 days** Trash retention | `sessionsTrash` | Standard soft-delete window (matches common cloud-file-trash defaults: Google Drive 30d, GitHub 90d, macOS 30d — 7d is shorter but this is local device storage, not cross-device). |
| **50 items** Trash cap | `sessionsTrash.items.length` | At ~400 B × 50 tabs × 50 items ≈ 1 MB; keeps Trash from alone filling storage. |
| **4** favicons shown per card | `summary.topDomains` | Fits cleanly in 280 px sidebar width at 16 px icons + 2 px overlap (~72 px total), leaving room for the metadata line. More than 4 makes the row dominate the card; fewer misses common multi-site sessions. |
| **75** tabs triggers large-session wording | Reopen toast | Chromium issue tracker reports noticeable tab-open delays at ~100+ tabs; 75 is a conservative threshold. v1 used 50 with no justification. |
| **150 ms** search debounce | Search input | Upper end of "perceived-instant" window in input UI research (100–200 ms). The existing `archiveSearch` input has no debounce; 150 ms matches what we'd apply if we were retrofitting it. |
| **≥1 session** for search visibility | Sessions pane | Simpler than v1's ≥2 threshold. If you have one session with many tabs, you still want to search within it. |
| **3 retries** on optimistic concurrency conflict | `updateSession` | Enough to absorb typical interleaved writes from two pages (~milliseconds apart). Beyond 3 indicates a persistent race; user sees the conflict toast. |
| **120 chars** max session name | Name input | Longer than any reasonable session label; short enough to render on a 280 px card without truncation in all supported UI widths. |
| **10 items** per-session "recently removed" cache | Removed-tab Trash | Covers typical "I removed a few tabs and want them back" without inflating Trash. Overflow evicts oldest. |

---

## Appendix B — Resolved v1 contradictions (traceability)

| Contradiction | v1 location | v2 resolution |
|---|---|---|
| Search scope: "URL hostname" vs "hostname + path" | user story line 23 vs spec line 199 | **hostname + pathname** (unified; query and fragment excluded) |
| "Best-effort" groups vs "pinned always restored" | spec lines 285–286, 304 | Both are best-effort with counted failures surfaced in the toast |
| Rename updates `updatedAt` vs "self-rename is a no-op pass" | spec line 316 vs test 4 | Self-rename is explicitly a no-op and does NOT bump `updatedAt` |
| Duplicate "never errors" vs storage quota errors exist | spec line 317 vs line 327 | "Never errors on name collision"; quota errors are the only failure mode |
| Promote creates new vs "identical data" | spec line 174 vs test 16 | Save-as-named deep-clones the snapshot's tabs; new session has fresh id/savedAt; snapshot is bit-for-bit unchanged |
| Incognito: extension context vs window state | spec line 213 vs line 343 | Incognito is explicitly unsupported; manifest remains `"spanning"`; no gating logic needed |

---

## Appendix C — Out of scope (revisit after v1)

- Sync across devices (`chrome.storage.sync` with compression, per-item splitting).
- Multi-window capture.
- Favorites / manual sort override.
- Reordering tabs within a saved session.
- Editing tab titles or URLs.
- Moving tabs between sessions.
- Keyboard shortcuts (save current window, open sessions pane).
- Session export/import as JSON.
- Incognito support (would need `"incognito": "split"` and a separate design pass).
- Rich session metadata (thumbnails, notes).
