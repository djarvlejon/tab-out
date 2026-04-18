# Tab Out — Sessions (save & reopen open tabs)

**Status:** Design approved — ready for implementation planning
**Date:** 2026-04-18
**Author:** Dmitriy Anderson (with Claude)

## Summary

Add the ability to save the currently open tabs in a Chrome window as a **session** and reopen that session later in a new window. Two save modes: **named sessions** (user-titled, kept indefinitely) and a **quick snapshot** (single overwritable slot). Reopen is always additive — session tabs open in a **new window**, leaving the current window untouched. Users can search across their saved sessions and remove individual tabs from a saved session.

This feature sits in Tab Out's right sidebar alongside the existing "Saved for later" checklist, reachable via a new pill-style tab switcher.

Sync across devices is explicitly **out of scope** to preserve Tab Out's "100% local, no server, no account" promise.

## Motivation

The existing "Saved for later" feature saves individual tabs one at a time for reading later. It does not support capturing a whole workspace — e.g. "everything I have open right now for the pricing research project" — as a reopenable unit. Sessions fill that gap.

## User stories

- As a user, I can click **Save current tabs**, give the session a name, and later reopen all those tabs in a new window with one click.
- As a user, I can click **Quick save** to overwrite a single snapshot slot without naming anything, and reopen it later — useful for "park my current state, go do something else, come back."
- As a user, I can search across my saved sessions by name, tab title, or URL hostname.
- As a user, I can expand a saved session, click any tab to open just that one, or remove a tab from the session if I no longer want it.
- As a user, I can rename, duplicate, or delete saved sessions.
- As a user in Incognito mode, I do not accidentally save my private browsing into persistent storage.

## Non-goals (YAGNI)

- Multi-window capture (current window only).
- Session import/export as JSON.
- Editing a saved tab's title or URL (only removal is supported).
- Reordering tabs within a saved session.
- Moving tabs between sessions.
- Syncing sessions across devices (quota constraints + violates the "100% local" promise).

## Architecture overview

```
┌─────────────────────────────────── New-tab page (index.html) ───────────────────────────┐
│                                                                                          │
│  header (existing)                                                                       │
│                                                                                          │
│  ┌── Open tabs grid (existing) ──┐    ┌── Right sidebar ───────────────────────────┐   │
│  │                                 │    │  [Saved for later (3)] [Sessions (5)]    │   │
│  │  domain/mission cards           │    │  ─────────────────────────────────────   │   │
│  │                                 │    │  (active tab's content)                  │   │
│  │                                 │    │                                           │   │
│  └─────────────────────────────────┘    └───────────────────────────────────────────┘   │
│                                                                                          │
│  footer (existing)                                                                       │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

All code lives in the existing extension files:

- `extension/app.js` — add session storage helpers, render logic, event handlers.
- `extension/index.html` — add the tab switcher markup and Sessions-tab containers inside the existing `.deferred-column` (rename conceptually to "sidebar column"; keep the id for backward compatibility).
- `extension/style.css` — add styles for the tab switcher, session cards, expand/collapse, search input.
- `extension/background.js` — no changes required (all storage reads/writes happen from the new-tab page).
- `extension/manifest.json` — add `"tabGroups"` permission to the `permissions` array (needed to read saved tab group titles/colors).

No new files. No external dependencies.

## Data model

New key in `chrome.storage.local` (sibling to existing `deferred`):

```js
sessions: [
  {
    id: "sess_01HX…",                           // ULID; snapshot slot uses the constant "__snap__"
    name: "Pricing research",                   // user-given for named; fixed "Snapshot" for the snapshot slot
    kind: "named" | "snapshot",                 // exactly one "snapshot" entry max; many "named"
    savedAt: "2026-04-18T14:32:00.000Z",        // ISO 8601
    updatedAt: "2026-04-18T14:32:00.000Z",      // bumped on rename, snapshot overwrite, or tab removal
    summary: {
      tabCount: 12,
      uniqueDomains: 6,
      topDomains: ["github.com", "google.com", "youtube.com", "linkedin.com"]  // up to 4, by tab count desc
    },
    tabs: [
      {
        url:        "https://github.com/foo/bar/pull/42",
        title:      "Add session save · foo/bar#42",
        favIconUrl: "https://github.githubassets.com/.../favicon.ico",  // may be empty string
        pinned:     false,
        index:      3,                          // original position in the source window
        group: {                                // null if tab was not in a Chrome tab group
          title: "Research",
          color: "blue"
        }
      }
    ]
  }
]
```

### Schema rules

- `sessions` is ordered for display: the snapshot (if present) is always first; named sessions follow, sorted by `updatedAt` desc.
- Session **names are unique** across `kind:"named"` sessions. Comparison is case-insensitive and trims leading/trailing whitespace. The snapshot's fixed `"Snapshot"` label is not part of the uniqueness namespace.
- `summary` is pre-computed at save time so card rendering never has to walk the full `tabs` array.
- Favicon URL is stored, not favicon data. Chrome refetches on reopen; cards display the URL directly with a letter-chip fallback when empty or broken.
- `group.color` matches Chrome's tab-group color enum: `grey | blue | red | yellow | green | pink | purple | cyan | orange`.
- No `windowId` field today; reserved for a future multi-window extension.
- Migration: first read initializes `sessions` to `[]` if absent. No existing data to migrate. The existing `deferred` key is untouched.

### Storage footprint

~500 B per tab. 100 sessions × 50 tabs ≈ 2.5 MB, well under the default 10 MB `chrome.storage.local` budget. Worst-case user (500 sessions × 100 tabs) would hit the ceiling; handled by the quota-exceeded toast described under Error handling.

## UI

### Sidebar tab switcher

At the top of the existing right sidebar, replace the single `<h2>Saved for later</h2>` heading with a two-pill switcher:

```
┌──────────────────────────────────────┐
│  [Saved for later (3)] [Sessions (5)]│   ← active pill = filled background
│  ────────────────────────────────────│
│  (active tab's content below)        │
└──────────────────────────────────────┘
```

- Pills match the existing `section-count` chip style (DM Sans, muted background, filled on active).
- Counts reflect active items only — for Saved for later, non-archived deferred tabs; for Sessions, all sessions including the snapshot.
- Tab state persists across page reloads in `chrome.storage.local` under `sidebarTab: "deferred" | "sessions"`. Default: `"deferred"` (existing behavior).
- When switching tabs, the other tab's content is hidden via `display:none` (simple, no animation required for v1).

### Sessions tab content

```
┌──────────────────────────────────────┐
│  ┌────────────────────────────────┐  │
│  │  + Save current tabs           │  │   ← primary full-width button
│  └────────────────────────────────┘  │
│  Quick save (overwrite snapshot)     │   ← secondary link-style button, small
│                                       │
│  ┌────────────────────────────────┐  │
│  │  🔍 Search sessions…           │  │   ← search input (visible when ≥2 sessions)
│  └────────────────────────────────┘  │
│                                       │
│  ─── Snapshot (pinned on top) ───    │
│  ┌─ 📸 Snapshot             ⋯ ▸ ─┐   │   ← ▸ = expand chevron
│  │ 12 tabs · 6 sites · 5m ago     │   │
│  │ [●][●][●][●]                   │   │   ← favicon strip (top 4 domains)
│  └────────────────────────────────┘   │
│                                       │
│  ─── Named ──────────────────────    │
│  ┌─ Pricing research         ⋯ ▸ ─┐   │
│  │ 8 tabs · 4 sites · 2h ago       │   │
│  │ [●][●][●][●]                    │   │
│  └────────────────────────────────┘   │
│  ┌─ Work Monday              ⋯ ▸ ─┐   │
│  │ 24 tabs · 11 sites · yesterday  │   │
│  │ [●][●][●][●]                    │   │
│  └────────────────────────────────┘   │
└──────────────────────────────────────┘
```

### Save interactions

- **Click "Save current tabs"** → inline name field slides in above the session list. Default value: `Session · <locale date, time>` (e.g., `Session · Apr 18, 2:32pm`). Save button (disabled when the name collides with an existing session, case-insensitive) and Cancel link. Enter saves; Esc cancels. On collision, an inline error appears below the input: *"A session named 'X' already exists."*
- **Click "Quick save"** → writes/overwrites the snapshot slot immediately. Toast *"Snapshot saved — 12 tabs"* with an Undo link. Undo is in-memory only, valid for 8 s; restores the previous snapshot (or removes the slot if there was none).

### Session card

- **Click the card body** (outside the kebab and chevron) → reopens the session (see Reopen flow below).
- **Kebab (⋯) menu** per card:
  - *Reopen* (same as clicking the body).
  - *Rename* (disabled for snapshot) — inline edit with the same uniqueness check as Save.
  - *Promote to named* (snapshot only) — opens the name input, writes a new `kind:"named"` session with the snapshot's tabs, leaves the snapshot slot intact.
  - *Duplicate* — creates a copy with name `X (copy)` (or `X (copy 2)`, `(copy 3)`, … until unique).
  - *Delete* — inline confirmation; deletion shows an 8 s in-memory Undo toast.
- **Chevron (▸)** → expands the card inline to reveal the tab list:

```
┌─ Pricing research                 ⋯ ▾ ┐
│ 8 tabs · 4 sites · 2h ago              │
│ [●][●][●][●]                           │
├────────────────────────────────────────┤
│ ● Add session save · foo/bar#42    ✕  │   ← click title opens tab in new window;
│ ● Pricing model — Notion            ✕  │     ✕ removes tab from session
│ ● Competitor analysis — Sheets      ✕  │
│ …                                      │
└────────────────────────────────────────┘
```

- Expanded state is visual only; it is not persisted. Collapsed by default.

### Search

- Input appears at the top of the Sessions tab when there are ≥2 sessions (no point searching one). Placeholder: *"Search sessions…"*.
- On input change (debounced ~100 ms), the session list filters client-side. A session matches if any of these contain the search term (case-insensitive substring):
  - `session.name`
  - any `tab.title`
  - any `tab.url` (hostname + path, not the scheme)
- When a session matches on a tab, the session card is auto-expanded and matching tabs are highlighted with a subtle background tint.
- An *"X matches"* count appears below the input. Clearing the input restores the full list and collapses auto-expanded cards.
- Search state is not persisted across reloads.

### Empty state

When `sessions` is empty: *"No sessions yet. Save your current tabs to come back to them later."*

## Save flow

```
User clicks "Save current tabs"  OR  "Quick save"
         ↓
if chrome.extension.inIncognitoContext → abort (button should have been disabled)
         ↓
chrome.tabs.query({currentWindow: true})
         ↓
filter out:
  - urls starting with chrome://, chrome-extension://
  - the Tab Out new-tab page itself (identified by URL matching chrome.runtime.getURL('index.html'))
         ↓
if 0 tabs remain → toast "Nothing to save" and abort
         ↓
for each tab, build tab record:
  { url, title (fallback: new URL(url).hostname), favIconUrl: tab.favIconUrl || '',
    pinned: tab.pinned, index: tab.index, group: null }
         ↓
collect unique tab.groupId values (≠ -1); for each, call chrome.tabGroups.get(groupId)
(if chrome.tabGroups is undefined, skip — groups stay null)
         ↓
attach group { title, color } to each tab record whose groupId matches
         ↓
compute summary:
  - tabCount = tabs.length
  - uniqueDomains = new Set(tabs.map(hostname)).size
  - topDomains = top 4 hostnames by tab count (desc)
         ↓
BRANCH:
  "Save current tabs" → open inline name input with auto-default.
                        on Enter with unique name:
                          session = { id: ulid(), name, kind: "named",
                                      savedAt: now, updatedAt: now, summary, tabs }
                          prepend to sessions[] after the snapshot
  "Quick save"        → read existing sessions, find kind === "snapshot"
                        cache previous snapshot (if any) in memory for Undo
                        write new snapshot:
                          { id: "__snap__", name: "Snapshot", kind: "snapshot",
                            savedAt: now, updatedAt: now, summary, tabs }
                        ensure it sits at index 0
         ↓
chrome.storage.local.set({ sessions })
         ↓
toast:
  "Saved · 12 tabs"                          (named save)
  "Snapshot saved — 12 tabs   [Undo]"        (quick save)
re-render Sessions tab
```

### Auto-default name

`new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })` prefixed with `"Session · "`. If that exact name already exists (same minute), append `(2)`, `(3)`, … until unique.

### Name validation

- Empty or whitespace-only → falls back to the auto-default.
- Trimmed before storage and comparison.
- Unique per case-insensitive comparison.

## Reopen flow

```
User clicks a session card  OR  kebab → Reopen  OR  clicks a single tab inside the expanded list
         ↓
read session (or single tab) from current sessions[]
         ↓
if session.tabs.length === 0 → toast "Session is empty" and abort
         ↓
chrome.windows.create({
  url: tabs.map(t => t.url),     // single-element array if opening one tab
  focused: true,
  state: "normal"
})
         ↓
Chrome returns the new window with tab ids in positional order
         ↓
for each saved tab where pinned === true:
  chrome.tabs.update(newTabId, { pinned: true })
         ↓
reconstruct tab groups (if chrome.tabGroups is available):
  group saved tabs by group.title+color (treat null as ungrouped)
  for each non-null group:
    chrome.tabs.group({ tabIds, createProperties: { windowId: newWindow.id } })
    chrome.tabGroups.update(groupId, { title, color })
  (errors here are logged but do not fail the reopen)
         ↓
toast:
  "Opened 12 tabs in new window"         (normal)
  "Opening 120 tabs — this may take a moment"  (when tabCount > 50)
```

Semantics confirmed:
- **Additive** — current window untouched; session opens in a new window.
- **No deduplication** — if github.com is already open, reopening the session opens it again.
- **Order preserved** — Chrome opens `url: [...]` positionally.
- **Pinned and groups** — best-effort; pinned always restored; groups restored when the API is available.

## Tab removal from a saved session

- User clicks ✕ next to a tab in an expanded session card.
- Inline confirmation: *"Remove this tab from the session?"* with Remove / Cancel.
- On confirm, the tab is spliced from `session.tabs`, `summary` recomputed, `updatedAt` bumped, `chrome.storage.local.set({ sessions })` called.
- Toast *"Tab removed — Undo"* (8 s in-memory).
- If `tabs.length === 0` after removal, the card shows an "Empty session" state with a prominent "Delete session" button (no auto-delete — user's choice).

## Rename / Duplicate / Delete

- **Rename** — kebab → Rename; inline edit. Uniqueness check identical to Save (skipping the session being renamed). On save, update `name` and `updatedAt`.
- **Duplicate** — kebab → Duplicate; create `{ id: ulid(), name: "X (copy)" | "X (copy N)", kind: "named", ... }`. Names suffix-incremented until unique. Never errors.
- **Delete** — kebab → Delete; inline confirmation; remove from `sessions[]`; 8 s in-memory Undo.
- **Promote to named** (snapshot only) — kebab → Promote; opens the same inline name input flow as Save. Creates a new `kind:"named"` session with a copy of the snapshot's tabs. The snapshot remains intact.

## Error handling

| Condition | Response |
|---|---|
| Tabs API returns 0 savable tabs | Toast *"Nothing to save"*, no storage write |
| User in Incognito | Save / Quick save buttons disabled with tooltip *"Sessions aren't saved from Incognito"* |
| `chrome.storage.local.set` throws (quota) | Catch; toast *"Storage full — delete old sessions to save new ones"*; in-memory state untouched |
| `chrome.tabGroups` undefined | Skip group reads (save) and group reconstruction (reopen) silently; log once to console |
| `chrome.windows.create` fails | Toast *"Couldn't open session — Chrome blocked the window"*; log error |
| Favicon URL empty or fails to render | CSS `onerror` hides `<img>`; letter-chip fallback (first char of hostname on a muted circle) is always rendered underneath |
| Session URL 404s at reopen | Chrome's own error page renders in the tab; not our concern |
| Two Quick saves within 8 s | Second overwrite invalidates the first Undo; new Undo toast shown for the second |
| Browser reload between action and Undo | Undo toast is in-memory and lost; storage state is the persisted truth |
| Collision at Save / Rename | Inline error *"A session named 'X' already exists."*; save button disabled until resolved |

All new flows log via the existing `console.log('[tab-out] ...')` convention so the logs stay greppable.

## Security / privacy

- No new permissions beyond `"tabGroups"`. The existing `"tabs"`, `"activeTab"`, and `"storage"` permissions already cover reads and writes.
- All storage is `chrome.storage.local`; no `storage.sync`, no external fetches, no new CORS surface.
- No user input is rendered as HTML — session names and tab titles go through the existing text-escape convention used for the deferred list.
- Incognito windows are explicitly excluded from capture.

## Testing (manual)

Tab Out has no test harness; testing follows the existing manual convention. Smoke matrix to run before merging:

1. Save a named session with 5 tabs (mix of regular + pinned) → reopen → verify count, order, pinned flags.
2. Save two sessions with the same name → second attempt shows inline error; save button stays disabled until resolved.
3. Quick save → Quick save again within 8 s → confirm Undo now targets the latest overwrite.
4. Rename a session to another session's name → inline error; renaming to its own name is a no-op pass.
5. Duplicate a session twice → names become `X (copy)` then `X (copy 2)`.
6. Save from an Incognito window → Save and Quick save buttons are disabled with tooltip.
7. Tabs in a Chrome tab group with a color → reopen restores the group title and color.
8. Delete a session → Undo within 8 s → session returns with identical data.
9. Save with only `chrome://` tabs → *"Nothing to save"* toast; no session created.
10. Reload the extension after saving → sessions persist.
11. Expand a session → click a tab title → opens in a new window; original session untouched.
12. Expand a session → remove a tab → session count drops, `updatedAt` bumped, Undo restores.
13. Search matches a tab title inside a session → session auto-expands with matching tab highlighted.
14. Search with no matches → card list empty, counter reads *"0 matches"*; clearing restores all.
15. Save 60 tabs → reopen → toast shows the large-session wording; all tabs open.
16. Promote a snapshot to named → named session appears, snapshot slot still present with identical data.
17. Fill `chrome.storage.local` close to the 10 MB quota (via devtools), attempt Save → quota toast appears, state untouched.

## Backward compatibility

- New `sessions` key in `chrome.storage.local`. Existing `deferred` key is untouched.
- Sidebar tab switcher defaults to the existing "Saved for later" view on first load, so the baseline experience is unchanged for current users.
- `manifest.json` adds one permission (`tabGroups`), which triggers a single permission re-prompt on extension reload — acceptable and aligned with Chrome norms.

## Open questions

None at design sign-off. Any deferred items are listed in Non-goals and can be lifted into follow-up specs if user feedback calls for them.

## Future extensions (not in this spec)

- Multi-window capture and restore (add `windowId` to tab records; reopen creates N windows).
- Session import/export as JSON (file-picker based, zero server involvement).
- Reordering tabs within a saved session (drag-and-drop).
- Editing a tab's title or URL in place.
- Moving tabs between sessions.
- Optional `chrome.storage.sync` with LZ compression, per-item splitting, and a 50-session cap (requires relaxing the "100% local" stance in the README).
