# Tab Out — Quick-access row (Workspace + Recently Closed)

**Status:** Design approved — ready for implementation planning
**Date:** 2026-04-19
**Author:** Dmitriy Anderson (with Claude)
**Extends:** `2026-04-18-tab-out-sessions-design.md` (v2) — follows the same codebase conventions established in the Sessions feature

## Summary

Add a **quick-access row** between the header and the open-tabs grid that exposes two always-handy shortcuts:

1. **Workspace** — a configurable row of 7 default Google shortcuts (Gmail, Calendar, Drive, Docs, Sheets, Slides, Gemini), editable in place. Up to 16 total.
2. **Recently closed** — the 5 most-recently-closed tabs (via `chrome.sessions.getRecentlyClosed`). One click restores.

`"sessions"` permission is **optional** and runtime-requested. If declined, the Recently Closed section shows an inline *"Enable"* chip and the rest of the extension continues to work.

## Motivation

Tab Out's current layout is focused on open tabs (main grid) and saved tabs (right sidebar). Users regularly reach for Workspace apps (Gmail, Drive, Calendar) and occasionally want to un-close a tab without opening history. Both behaviors deserve a first-class home one click away, without stealing space from the main grid.

## User stories

- As a user, I can click a row of compact Workspace icons in the header area to open Gmail/Drive/etc. in a new tab.
- As a user, I can edit the Workspace row (add / remove / — reorder is out of scope v1) without leaving the page.
- As a user, I can see the last 5 tabs I closed and click one to restore it at its original position.
- As a user, I can decline the `"sessions"` permission and lose only the Recently Closed section; the rest of Tab Out keeps working.
- As a user with two Tab Out pages open, edits I make to Workspace on page A appear on page B within a second.

## Non-goals (YAGNI v1)

- Drag-to-reorder Workspace chips. (Add/remove is enough for v1. Revisit if users ask.)
- Rename an existing link in place. (Remove + re-add covers the need.)
- Closed-*window* restoration. (Tabs only — spec'd below. Windows bundle many tabs and a one-click restore is surprising.)
- Syncing Workspace links across devices. (Preserves "local by default" promise, consistent with Sessions.)
- Non-Google shortcuts in the default set. (User can add any `http(s)` URL.)
- Keyboard shortcuts (hotkeys to trigger Workspace links).

## Architecture overview

All code lives in the existing extension files. No new files needed. One new banner-sectioned block in `app.js`:

```
/* ---- QUICK ACCESS ROW — workspace + recently closed ---- */
```

- `extension/app.js` — add storage helpers, permission helper, render function, edit-mode state machine, event handlers, onChanged sync, onRemoved listener.
- `extension/index.html` — add one new `<div class="quick-access-row">` between `<header>` and `<div class="dashboard-columns">`.
- `extension/style.css` — add `.quick-access-row`, `.qa-workspace`, `.qa-recent`, `.qa-chip`, `.qa-chip-edit`, `.qa-add`, `.qa-recent-item`, `.qa-edit-toggle`.
- `extension/manifest.json` — add `"sessions"` to `optional_permissions`.

No new dependencies. No new files.

## Data model

New key in `chrome.storage.local`:

```js
workspaceLinks = {
  schemaVersion: 1,
  items: [
    { id: "ws_01HX…", url: "https://mail.google.com/", label: "Gmail" },
    { id: "ws_01HX…", url: "https://calendar.google.com/", label: "Calendar" },
    { id: "ws_01HX…", url: "https://drive.google.com/", label: "Drive" },
    { id: "ws_01HX…", url: "https://docs.google.com/", label: "Docs" },
    { id: "ws_01HX…", url: "https://sheets.google.com/", label: "Sheets" },
    { id: "ws_01HX…", url: "https://slides.google.com/", label: "Slides" },
    { id: "ws_01HX…", url: "https://gemini.google.com/", label: "Gemini" }
  ],
  writeToken: "wt_01HX…"
}
```

### Schema rules

- `id` is a ULID prefixed `ws_`.
- `url` must match `/^https?:\/\//i` (same `ALLOWED_SCHEMES` regex used by Sessions). Stored as the full normalized URL.
- `label` is a string, 1–48 chars after trim. Defaults are fixed English labels; user-added entries derive label from `new URL(url).hostname.replace(/^www\./, '')` with first character capitalized, then truncated to 48 chars.
- `items.length` capped at 16. Storage-layer enforcement: `addWorkspaceLink` rejects past the cap.
- Seeded with the 7 defaults on first read if key is absent.
- `writeToken` rotates on every write; used for the same optimistic-concurrency retry pattern as `sessions`.
- Uniqueness: case-insensitive URL comparison (after trimming trailing slash). `addWorkspaceLink` rejects duplicates with an inline error.

### Migration

First read (`readWorkspaceLinks()`) initializes the store with schemaVersion 1 + the 7 defaults if the key is absent. Persists to storage so subsequent reads don't re-seed (matches the first-read-persistence fix from the Sessions final-audit cleanup).

### Recently closed

Not persisted. Fetched live:

```js
const entries = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
const recentTabs = entries.filter(e => e.tab).slice(0, 5);
```

Each entry `e.tab` has shape `{ sessionId, url, title, favIconUrl, lastAccessed }`. We render `title` + hostname + relative time.

Refresh triggers:
- Page load.
- `chrome.tabs.onRemoved` event (debounced 250 ms).
- `chrome.storage.onChanged` echo from another Tab Out page is NOT a trigger (recently-closed is read-only and lives in Chrome's session store).

## UI

### Layout (horizontal split)

```
┌────────────────────────────────── Quick access row ─────────────────────────────────┐
│                                                                                       │
│  Workspace                                          Recently closed                   │
│  ┌────────────────────────────────────┐ ✎           ┌────────────────────────────┐  │
│  │ [G] [C] [D] [D] [S] [S] [G]        │             │ ● Google Drive — files.go…  │  │
│  └────────────────────────────────────┘             │   drive.google.com · 2 min  │  │
│                                                     │ ● GitHub — PRs              │  │
│                                                     │   github.com · 4 min        │  │
│                                                     │ ● Notion — Kanban           │  │
│                                                     │   notion.so · 8 min         │  │
│                                                     │ ● Slack — #eng              │  │
│                                                     │   slack.com · 11 min        │  │
│                                                     │ ● Spotify                   │  │
│                                                     │   open.spotify.com · 14 min │  │
│                                                     └────────────────────────────┘  │
│                                                                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

CSS grid at the top level: two columns (`grid-template-columns: 1fr minmax(280px, 360px);`), ~16px gap. Workspace column flexes; Recently Closed column is fixed-width to match the sidebar below it.

Row visibility: **always rendered** (header chip + the row are the primary discovery surface for new features). Row does not collapse when either section is empty — empty states are rendered inline.

### Workspace chip

```
┌─────┐
│  🟥 │   ← 24×24 favicon via _favicon endpoint
└─────┘
```

- 24×24 `<a>` element, `href=item.url`, `target="_blank"`, `rel="noopener"`.
- `title` attribute = `item.label` (native browser tooltip on hover).
- Chip uses `faviconEl(item.url, 24)` — same helper as session cards. Letter-chip fallback if `"favicon"` permission not granted.
- 6px horizontal gap between chips.
- Cursor: pointer on hover; subtle hover state (opacity 0.7 → 1.0 with 100 ms transition).

### Edit mode

- ✎ pencil button (14px) at the right end of the Workspace chip strip.
- Click → toggles `workspaceEditMode = true`:
  - Each chip gains an `×` overlay in the top-right corner (visible on hover; keyboard-focus shows it too).
  - A `+ Add` chip appears at the end (same 24×24 footprint, `+` glyph centered, dashed border).
  - Pencil flips to ✓ (Done). Click ✓ to exit edit mode.
- Keyboard: `Esc` exits edit mode from anywhere in the row.
- Edit mode is session-local (not persisted across reloads).

### Add-link flow

- Click `+ Add` in edit mode → the chip is replaced with an inline `<input type="url" class="qa-add-input">`. Input is auto-focused, placeholder: `https://example.com`.
- On `Enter`:
  - `trimmed = input.value.trim()`; if empty, exit to `+` state without saving.
  - Scheme check: `/^https?:\/\//i`. Fail → inline red error text below input *"Use http:// or https://"*, input stays open.
  - Duplicate check: case-insensitive URL compare (after trimming trailing slash). Fail → *"Already in the list"*, input stays open.
  - Cap check: `items.length >= 16`. Fail → *"Remove a link first"*, input stays open.
  - Success: derive label, persist via `addWorkspaceLink`, re-render.
- On `Esc`: revert to `+` chip, no save.
- On `blur` without Enter: treat as Esc.

### Remove flow

- In edit mode, click × overlay on a chip → remove from `items`, persist, re-render.
- No confirmation. Re-adding a removed default is user's responsibility (paste the URL again).

### Recently closed item

```
● Google Drive — files
  drive.google.com · 2 min ago
```

- Left column: 16×16 favicon via `faviconEl(tab.url, 16)`.
- Right column (flex-grow):
  - Line 1: `title` (truncated with ellipsis); fallback to hostname if title empty.
  - Line 2: `hostname` (strip `www.`) + ` · ` + `timeAgo(lastAccessedMs)` (reuse existing helper; input is ms-since-epoch from Chrome, convert to ISO before `timeAgo`).
- Click anywhere → `chrome.sessions.restore(sessionId)`. No confirmation (restore is non-destructive).
- Hover: muted background tint; cursor pointer.

### Empty / permission states for Recently closed

| State | Header | Body |
|---|---|---|
| Permission not granted | `Recently closed` | `<button class="qa-enable">Enable</button>` — one-click runtime request |
| Granted, 0 entries | `Recently closed` | muted text *"Nothing recently closed"* |
| Granted, 1–5 entries | `Recently closed` | list of up to 5 items |
| API error (rare) | `Recently closed` | muted text *"Couldn't load recently closed"* (toast also fires once) |

### Edit mode for Workspace interacts with Recently Closed

Independent — editing Workspace does not affect Recently Closed. Recently Closed has no edit mode.

## Permission flow

Add to `extension/manifest.json`:

```json
"optional_permissions": ["favicon", "tabGroups", "sessions"]
```

New helper mirrors `ensureFaviconPermission`:

```js
async function ensureSessionsPermission({ prompt = false } = {}) {
  const currentlyGranted = await chrome.permissions.contains({ permissions: ["sessions"] });
  if (currentlyGranted) { _sessionsPermissionGranted = true; return true; }
  if (!prompt) { _sessionsPermissionGranted = false; return false; }
  const granted = await chrome.permissions.request({ permissions: ["sessions"] });
  _sessionsPermissionGranted = !!granted;
  return _sessionsPermissionGranted;
}
```

- Page init: `{ prompt: false }` — just reads current state.
- Enable-chip click: `{ prompt: true }` — triggers the Chrome prompt. Re-renders on resolution regardless of outcome.
- `chrome.permissions.onRemoved` listener: if user revokes in `chrome://extensions`, update internal flag and re-render.

## Storage layer

```js
/* ---- QUICK ACCESS — storage ---- */

const WORKSPACE_LINKS_KEY = "workspaceLinks";
const WORKSPACE_SCHEMA_VERSION = 1;
const WORKSPACE_MAX_ITEMS = 16;

const WORKSPACE_DEFAULTS = [
  { url: "https://mail.google.com/",     label: "Gmail" },
  { url: "https://calendar.google.com/", label: "Calendar" },
  { url: "https://drive.google.com/",    label: "Drive" },
  { url: "https://docs.google.com/",     label: "Docs" },
  { url: "https://sheets.google.com/",   label: "Sheets" },
  { url: "https://slides.google.com/",   label: "Slides" },
  { url: "https://gemini.google.com/",   label: "Gemini" }
];

async function readWorkspaceLinks() {
  const { workspaceLinks } = await chrome.storage.local.get(WORKSPACE_LINKS_KEY);
  if (workspaceLinks && workspaceLinks.schemaVersion === WORKSPACE_SCHEMA_VERSION && Array.isArray(workspaceLinks.items)) {
    return workspaceLinks;
  }
  // Seed defaults on first read.
  const seeded = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    items: WORKSPACE_DEFAULTS.map(d => ({ id: "ws_" + ulid(), url: d.url, label: d.label })),
    writeToken: null
  };
  const writeToken = newWorkspaceWriteToken();
  seeded.writeToken = writeToken;
  await chrome.storage.local.set({ [WORKSPACE_LINKS_KEY]: seeded });
  return seeded;
}

async function writeWorkspaceLinks(items) {
  const writeToken = newWorkspaceWriteToken();
  await chrome.storage.local.set({
    [WORKSPACE_LINKS_KEY]: {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      items,
      writeToken
    }
  });
}

async function addWorkspaceLink(url, label) {
  // Scheme allowlist
  if (!ALLOWED_SCHEMES.test(url)) throw new Error("invalid-scheme");
  const normalized = url.replace(/\/+$/, "");
  const { items } = await readWorkspaceLinks();
  if (items.length >= WORKSPACE_MAX_ITEMS) throw new Error("cap-reached");
  const lc = normalized.toLowerCase();
  if (items.some(i => i.url.replace(/\/+$/, "").toLowerCase() === lc)) {
    throw new Error("duplicate-url");
  }
  const derived = label || deriveLabelFromUrl(url);
  const next = { id: "ws_" + ulid(), url, label: derived };
  await writeWorkspaceLinks([...items, next]);
  return next;
}

async function removeWorkspaceLink(id) {
  const { items } = await readWorkspaceLinks();
  await writeWorkspaceLinks(items.filter(i => i.id !== id));
}

function deriveLabelFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return (host.charAt(0).toUpperCase() + host.slice(1)).slice(0, 48);
  } catch {
    return "Link";
  }
}
```

Write-token mechanism mirrors the existing `newWriteToken` pattern for sessions; `newWorkspaceWriteToken` sets `_lastSelfWorkspaceWriteToken` for `storage.onChanged` echo suppression.

## `chrome.storage.onChanged` integration

Extend the existing listener:

```js
if (changes.workspaceLinks) {
  const nv = changes.workspaceLinks.newValue;
  if (_lastSelfWorkspaceWriteToken && nv && nv.writeToken === _lastSelfWorkspaceWriteToken) return;
  renderWorkspaceSection();
}
```

## Render functions

```js
async function renderQuickAccessRow() {
  await renderWorkspaceSection();
  await renderRecentlyClosedSection();
}

async function renderWorkspaceSection() {
  const container = document.getElementById("qaWorkspace");
  if (!container) return;
  const { items } = await readWorkspaceLinks();
  container.replaceChildren(
    el("div", { class: "qa-section-label" }, "Workspace"),
    el("div", { class: "qa-chip-strip" }, [
      ...items.map(it => renderWorkspaceChip(it)),
      _workspaceEditMode ? renderAddChip() : null
    ]),
    el("button", {
      class: "qa-edit-toggle",
      "data-action": "qa-toggle-edit",
      title: _workspaceEditMode ? "Done" : "Edit"
    }, _workspaceEditMode ? "✓" : "✎")
  );
}

async function renderRecentlyClosedSection() {
  const container = document.getElementById("qaRecent");
  if (!container) return;
  const granted = await ensureSessionsPermission({ prompt: false });
  if (!granted) {
    container.replaceChildren(
      el("div", { class: "qa-section-label" }, "Recently closed"),
      el("button", { class: "qa-enable", "data-action": "qa-enable-sessions" }, "Enable")
    );
    return;
  }
  try {
    const entries = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
    const tabs = entries.filter(e => e.tab).slice(0, 5).map(e => e.tab);
    container.replaceChildren(
      el("div", { class: "qa-section-label" }, "Recently closed"),
      tabs.length === 0
        ? el("div", { class: "qa-empty" }, "Nothing recently closed")
        : el("div", { class: "qa-recent-list" }, tabs.map(renderRecentItem))
    );
  } catch (err) {
    console.warn("[tab-out] getRecentlyClosed failed", err);
    container.replaceChildren(
      el("div", { class: "qa-section-label" }, "Recently closed"),
      el("div", { class: "qa-empty" }, "Couldn't load recently closed")
    );
  }
}
```

All rendering goes through `el()`/`textNode()` — no `innerHTML` with user- or page-controlled strings.

## Event handlers

Add to the existing delegated click listener:

```js
if (action === "qa-toggle-edit") {
  e.preventDefault();
  _workspaceEditMode = !_workspaceEditMode;
  renderWorkspaceSection();
  return;
}
if (action === "qa-remove-link") {
  e.preventDefault();
  const id = target.dataset.linkId;
  try { await removeWorkspaceLink(id); } catch (err) { console.warn("[tab-out] remove link failed", err); }
  renderWorkspaceSection();
  return;
}
if (action === "qa-add-link-start") {
  e.preventDefault();
  renderAddLinkInput();
  return;
}
if (action === "qa-enable-sessions") {
  e.preventDefault();
  await ensureSessionsPermission({ prompt: true });
  renderRecentlyClosedSection();
  return;
}
if (action === "qa-restore-closed") {
  e.preventDefault();
  const sessionId = target.dataset.sessionId;
  try {
    await chrome.sessions.restore(sessionId);
  } catch (err) {
    showToast({ message: "Couldn't reopen tab — it may be too old." });
    console.warn("[tab-out] sessions.restore failed", err);
  }
  return;
}
```

Add-input Enter/Esc are handled by direct listeners on the input element (not delegated).

## `chrome.tabs.onRemoved` listener

```js
let _recentRefreshTimer = null;
function scheduleRecentRefresh() {
  clearTimeout(_recentRefreshTimer);
  _recentRefreshTimer = setTimeout(renderRecentlyClosedSection, 250);
}

chrome.tabs.onRemoved.addListener(scheduleRecentRefresh);
```

Installed alongside `installStorageSync()` at page init. 250 ms debounce absorbs bursts from close-all-in-group actions.

## Error handling

| Condition | Response |
|---|---|
| Add-input: invalid scheme | Inline red error *"Use http:// or https://"* |
| Add-input: duplicate URL | Inline red error *"Already in the list"* |
| Add-input: cap reached | Inline red error *"Remove a link first"*; also disables + chip while at cap |
| `addWorkspaceLink` storage write rejects (quota) | Toast *"Storage full — delete a link first."* |
| `removeWorkspaceLink` storage write rejects | Toast *"Couldn't remove — try reloading."* |
| `chrome.sessions.restore` rejects | Toast *"Couldn't reopen tab — it may be too old."* |
| `chrome.sessions.getRecentlyClosed` rejects | Section shows *"Couldn't load recently closed"*; toast fires once per render |
| `chrome.permissions.request` denied for `"sessions"` | No toast — Enable chip stays visible |
| `chrome.permissions.onRemoved` fires | Re-render Recently Closed section (back to Enable chip) |
| `storage.onChanged` fires on `workspaceLinks` | Re-render Workspace section; skip self-echo via `writeToken` |

All new console output uses `console.warn('[tab-out] ...')` per project convention.

## Security & privacy

- URL scheme allowlist on add and render (defensive).
- DOM-only rendering (`el`/`textNode`) for all user- and page-controlled strings: user-typed labels, derived hostnames, Chrome-provided tab titles, URLs.
- `target="_blank"` + `rel="noopener"` on all Workspace chip `<a>` tags.
- `chrome.sessions` permission is optional; declining doesn't affect the rest of the extension.
- No external network calls beyond favicons (already covered by `_favicon` endpoint with `"favicon"` permission).
- Secrets-in-URLs: Recently Closed may show URLs that contain query-string tokens. The URL is rendered only as hostname (not the full path+query), reducing accidental over-the-shoulder leaks. The full URL is still stored by Chrome's session service — that's Chrome's responsibility, not ours.

## Testing (manual smoke)

1. Reload the extension. Confirm the quick-access row renders between the header and the main grid. Default 7 Workspace chips visible, Recently Closed shows the Enable chip.
2. Click a Workspace chip → opens the target site in a new tab, original tab untouched.
3. Click ✎ → edit mode engages: × overlays on hover, `+ Add` chip appended.
4. Click + Add → input replaces the chip. Paste `https://notion.so/`, press Enter. New Notion chip appears.
5. Try to add the same URL again → inline duplicate error; input stays open.
6. Try to add `ftp://foo.com` → inline scheme error.
7. Add chips until you hit 16 → + disables with tooltip.
8. Click × on a default (Drive) → Drive chip disappears; persists across reload.
9. Click ✓ → edit mode exits.
10. Open a second Tab Out page; add a link on page A → page B updates within ~1 s.
11. Click Enable in Recently Closed → Chrome permission prompt; accept. Recently Closed list renders (or *"Nothing recently closed"* if you haven't closed tabs).
12. Open a few tabs, close them, return to Tab Out → within 250 ms, Recently Closed shows them (auto-refresh via `tabs.onRemoved`).
13. Click a Recently Closed item → the tab reopens at its original window/position.
14. Revoke `"sessions"` permission in `chrome://extensions` → Tab Out section switches back to Enable chip on next render.
15. Close >5 tabs → only the latest 5 appear in Recently Closed.
16. Decline the permission prompt → no toast, Enable chip stays, rest of extension works.

## Backward compatibility

- New key `workspaceLinks` in `chrome.storage.local`. Existing keys (`sessions`, `sessionsTrash`, `deferred`, `sidebarPane`) untouched.
- `"sessions"` is added to `optional_permissions` only — no permission warning on upgrade, no install disabling.
- First-time read seeds defaults automatically. No migration from a non-existent prior version.
- CSS additions are scoped under `.quick-access-row` and `.qa-*` prefix — no collisions with existing `.session-*`, `.deferred-*`, `.mission-*`, `.chip`, `.pill` classes.

## Appendix — magic numbers

| Value | Where | Rationale |
|---|---|---|
| 5 | Recently Closed display cap | User-chosen; "top 5 recent" is easy to scan in a single sidebar-width column |
| 25 | `getRecentlyClosed({maxResults: 25})` | Fetch more than we show so the filter-to-`.tab` step has headroom; Chrome's default cap is 25 |
| 7 | default Workspace chips | Gmail + Calendar + Drive + Docs + Sheets + Slides + Gemini — covers the daily Google loop |
| 16 | Workspace cap | Fits ~16 × 24px chips + gaps comfortably in the Workspace column at typical viewport widths (>1000 px); beyond 16 the row wraps ugly |
| 48 | max label length | Longer than any derived hostname; prevents storage bloat on user input |
| 24 | chip icon size (px) | Larger than the 16 px favicons used in session cards; compensates for being further from eye on a single row; still compact |
| 16 | Recently Closed favicon size (px) | Smaller vertical list, standard favicon size |
| 250 ms | `tabs.onRemoved` debounce | Absorbs close-all-in-group bursts without feeling laggy |

## Out of scope for v2

- Drag-to-reorder
- In-place rename
- Closed-window restore
- `chrome.storage.sync`
- Keyboard shortcuts
- Non-URL quick actions (e.g. "New Doc", "New Spreadsheet" deep links)
