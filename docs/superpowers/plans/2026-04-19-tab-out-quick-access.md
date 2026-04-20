# Tab Out — Quick-access Row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the quick-access row — configurable Google Workspace shortcuts + 5 recently-closed tabs — between the header and the open-tabs grid, without regressing any existing Tab Out behavior.

**Architecture:** New banner-commented section in `extension/app.js` (~300 lines), a single markup addition in `index.html`, scoped `.qa-*` styles in `style.css`, and `"sessions"` added to `optional_permissions`. Reuses existing conventions: `el()`/`textNode()` DOM helpers, `writeToken` CAS, delegated `[data-action]` click handlers, `faviconEl()`, `showToast({message,…})`, `console.warn('[tab-out] …')`.

**Tech Stack:** Chrome MV3, vanilla JS, no build step, no new dependencies.

**Reference docs:**
- Spec: `docs/superpowers/specs/2026-04-19-tab-out-quick-access-design.md` (canonical)
- Parent Sessions spec: `docs/superpowers/specs/2026-04-18-tab-out-sessions-design.md` (for shared conventions)

**Testing convention:** Tab Out has no automated test harness. Every task ends with `node --check extension/app.js` + a grep/eyeball verification + manual Chrome reload step. Evidence before claiming done.

**Branch:** `feature/sessions` (current HEAD should be `aa85a60` or later). New feature stays on the same branch — it's a small additive feature on top of Sessions.

---

## File Structure

### Files modified

| Path | Changes |
|---|---|
| `extension/app.js` | New banner section `/* ---- QUICK ACCESS ROW ---- */` containing ~300 lines: storage helpers, permission helper, render functions, event handlers, listeners. |
| `extension/index.html` | One new `<div class="quick-access-row">` element between `<header>` and `<div class="dashboard-columns">`. |
| `extension/style.css` | New `.qa-*` rule block (~80 lines). |
| `extension/manifest.json` | Add `"sessions"` to `optional_permissions` array. |

### Internal `app.js` section layout

Insert immediately after the existing `/* ---- PERMISSIONS ---- */` / `/* ---- FAVICON RENDERING ---- */` blocks:

```
/* ---- QUICK ACCESS ROW — workspace + recently closed ---- */
const WORKSPACE_LINKS_KEY, WORKSPACE_SCHEMA_VERSION, WORKSPACE_MAX_ITEMS, WORKSPACE_DEFAULTS
let _lastSelfWorkspaceWriteToken
let _sessionsPermissionGranted
let _workspaceEditMode
let _recentRefreshTimer

newWorkspaceWriteToken()
readWorkspaceLinks()
writeWorkspaceLinks(items)
addWorkspaceLink(url, label?)
removeWorkspaceLink(id)
deriveLabelFromUrl(url)

ensureSessionsPermission({ prompt })

renderQuickAccessRow()
renderWorkspaceSection()
renderWorkspaceChip(item)
renderAddChip()
renderAddLinkInput()
renderRecentlyClosedSection()
renderRecentItem(tab)

scheduleRecentRefresh()
installQuickAccessListeners()  // tabs.onRemoved, permissions.onRemoved
```

The `storage.onChanged` listener in `installStorageSync()` gets one additional branch for `changes.workspaceLinks`.

---

## Task 1: Markup + CSS scaffold + empty render stub

**Files:**
- Modify: `extension/index.html` (after `</header>` closing tag)
- Modify: `extension/style.css` (append new rule block)
- Modify: `extension/app.js` (add render stubs + page-init wire-up)
- Modify: `extension/manifest.json` (extend `optional_permissions`)

- [ ] **Step 1.1: Add the quick-access row markup**

Open `extension/index.html`. Find the `</header>` closing tag. Immediately after it, insert:

```html
  <!-- ================================================================
       QUICK ACCESS ROW — Workspace shortcuts + Recently closed
       Rendered by renderQuickAccessRow() in app.js
       ================================================================ -->
  <div class="quick-access-row" id="quickAccessRow">
    <div class="qa-workspace" id="qaWorkspace"></div>
    <div class="qa-recent" id="qaRecent"></div>
  </div>
```

- [ ] **Step 1.2: Add the scoped CSS**

Open `extension/style.css`. Append at the end:

```css
/* ================================================================
   QUICK ACCESS ROW
   ================================================================ */

.quick-access-row {
  display: grid;
  grid-template-columns: 1fr minmax(280px, 360px);
  gap: 16px;
  margin-bottom: 24px;
}

.qa-workspace {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 32px;
}

.qa-recent {
  min-height: 32px;
}

.qa-section-label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 500;
  margin-right: 4px;
  flex-shrink: 0;
}

.qa-chip-strip {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}

.qa-chip {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  cursor: pointer;
  opacity: 0.75;
  transition: opacity 0.1s;
  position: relative;
}
.qa-chip:hover { opacity: 1; }

.qa-chip img, .qa-chip .favicon-letter {
  width: 24px !important;
  height: 24px !important;
  line-height: 24px !important;
  font-size: 13px !important;
  border-radius: 6px;
}

.qa-chip-remove {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--red, #d9534f);
  color: white;
  font-size: 10px;
  line-height: 14px;
  text-align: center;
  cursor: pointer;
  border: none;
  padding: 0;
  display: none;
}
.qa-chip.qa-edit-mode .qa-chip-remove { display: block; }

.qa-add {
  width: 24px;
  height: 24px;
  border: 1px dashed var(--border);
  border-radius: 6px;
  color: var(--muted);
  font-size: 14px;
  line-height: 22px;
  text-align: center;
  cursor: pointer;
  background: transparent;
  padding: 0;
}
.qa-add:hover { color: var(--fg); border-color: var(--fg); }
.qa-add:disabled { opacity: 0.4; cursor: not-allowed; }

.qa-add-input {
  background: var(--bg);
  border: 1px solid var(--fg);
  border-radius: 6px;
  padding: 2px 8px;
  font: inherit;
  font-size: 12px;
  width: 220px;
  height: 24px;
  box-sizing: border-box;
}

.qa-add-error {
  color: var(--red, #d9534f);
  font-size: 11px;
  margin-left: 8px;
}

.qa-edit-toggle {
  background: transparent;
  border: none;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  margin-left: 4px;
}
.qa-edit-toggle:hover { color: var(--fg); background: var(--hover); }

.qa-enable {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 999px;
  cursor: pointer;
  margin-left: 8px;
}
.qa-enable:hover { background: var(--hover); }

.qa-empty {
  color: var(--muted);
  font-size: 12px;
  margin-left: 8px;
}

.qa-recent-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
}

.qa-recent-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  background: transparent;
  border: none;
  font: inherit;
  text-align: left;
  width: 100%;
}
.qa-recent-item:hover { background: var(--hover); }

.qa-recent-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.qa-recent-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qa-recent-meta {
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 1.3: Extend manifest optional_permissions**

Open `extension/manifest.json`. Locate the `optional_permissions` array. Add `"sessions"`:

Before:
```json
"optional_permissions": ["favicon", "tabGroups"],
```

After:
```json
"optional_permissions": ["favicon", "tabGroups", "sessions"],
```

- [ ] **Step 1.4: Add stub render function and page-init wire-up to app.js**

In `extension/app.js`, find the existing page-init sequence (search for `initSidebarState`). In the same init function, call a new `renderQuickAccessRow()` stub after `initSidebarState()`:

```js
await initSidebarState();
installStorageSync();
await renderQuickAccessRow();   // ← new
```

Add the stub near the bottom of app.js, but before the DOMContentLoaded wire-up (exact placement is refined in later tasks — this is just so the page doesn't throw):

```js
/* ----------------------------------------------------------------
   QUICK ACCESS ROW — workspace + recently closed
   Full implementation filled in across Tasks 2-8.
   ---------------------------------------------------------------- */

let _workspaceEditMode = false;
let _sessionsPermissionGranted = false;
let _lastSelfWorkspaceWriteToken = null;
let _recentRefreshTimer = null;

async function renderQuickAccessRow() {
  // Stubbed — Tasks 4 and 5 replace this with real implementations.
  const ws = document.getElementById('qaWorkspace');
  const rc = document.getElementById('qaRecent');
  if (ws) ws.replaceChildren();
  if (rc) rc.replaceChildren();
}
```

- [ ] **Step 1.5: Verify**

```bash
cd /Users/dmitriyanderson/tab-out
node --check extension/app.js
```
Expected exit 0.

Then reload the extension in `chrome://extensions` and confirm:
- New tab still renders the dashboard without errors.
- Empty row (invisible) sits between header and grid — DOM inspector shows `<div class="quick-access-row">` present with two empty children.
- Console: no errors.

- [ ] **Step 1.6: Commit**

```bash
cd /Users/dmitriyanderson/tab-out
git add extension/index.html extension/style.css extension/manifest.json extension/app.js
git commit -m "feat(quick-access): scaffold row markup, CSS, and stub"
```

---

## Task 2: Data layer — storage helpers, defaults, CAS

**Files:**
- Modify: `extension/app.js` (replace the stub from Task 1 with the storage layer)

- [ ] **Step 2.1: Insert constants and helpers**

In `extension/app.js`, replace the placeholder block from Task 1.4 (the section starting `/* ---- QUICK ACCESS ROW — workspace + recently closed ---- */`) with:

```js
/* ----------------------------------------------------------------
   QUICK ACCESS ROW — workspace + recently closed
   ---------------------------------------------------------------- */

const WORKSPACE_LINKS_KEY = 'workspaceLinks';
const WORKSPACE_SCHEMA_VERSION = 1;
const WORKSPACE_MAX_ITEMS = 16;

const WORKSPACE_DEFAULTS = [
  { url: 'https://mail.google.com/',     label: 'Gmail' },
  { url: 'https://calendar.google.com/', label: 'Calendar' },
  { url: 'https://drive.google.com/',    label: 'Drive' },
  { url: 'https://docs.google.com/',     label: 'Docs' },
  { url: 'https://sheets.google.com/',   label: 'Sheets' },
  { url: 'https://slides.google.com/',   label: 'Slides' },
  { url: 'https://gemini.google.com/',   label: 'Gemini' }
];

let _workspaceEditMode = false;
let _sessionsPermissionGranted = false;
let _lastSelfWorkspaceWriteToken = null;
let _recentRefreshTimer = null;

function newWorkspaceWriteToken() {
  const t = 'wtw_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  _lastSelfWorkspaceWriteToken = t;
  return t;
}

async function readWorkspaceLinks() {
  const { workspaceLinks } = await chrome.storage.local.get(WORKSPACE_LINKS_KEY);
  if (workspaceLinks
      && workspaceLinks.schemaVersion === WORKSPACE_SCHEMA_VERSION
      && Array.isArray(workspaceLinks.items)) {
    return workspaceLinks;
  }
  // Seed defaults on first read.
  const items = WORKSPACE_DEFAULTS.map(d => ({
    id: 'ws_' + ulid(),
    url: d.url,
    label: d.label
  }));
  const writeToken = newWorkspaceWriteToken();
  const seeded = { schemaVersion: WORKSPACE_SCHEMA_VERSION, items, writeToken };
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

function normalizeWorkspaceUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

async function addWorkspaceLink(rawUrl, rawLabel) {
  const url = String(rawUrl || '').trim();
  if (!ALLOWED_SCHEMES.test(url)) throw new Error('invalid-scheme');

  const { items } = await readWorkspaceLinks();
  if (items.length >= WORKSPACE_MAX_ITEMS) throw new Error('cap-reached');

  const normalized = normalizeWorkspaceUrl(url).toLowerCase();
  if (items.some(i => normalizeWorkspaceUrl(i.url).toLowerCase() === normalized)) {
    throw new Error('duplicate-url');
  }

  const label = (rawLabel && String(rawLabel).trim()) || deriveLabelFromUrl(url);
  const trimmedLabel = label.slice(0, 48);
  const next = { id: 'ws_' + ulid(), url, label: trimmedLabel };
  await writeWorkspaceLinks([...items, next]);
  return next;
}

async function removeWorkspaceLink(id) {
  const { items } = await readWorkspaceLinks();
  await writeWorkspaceLinks(items.filter(i => i.id !== id));
}

function deriveLabelFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (!host) return 'Link';
    return (host.charAt(0).toUpperCase() + host.slice(1)).slice(0, 48);
  } catch {
    return 'Link';
  }
}
```

- [ ] **Step 2.2: Verify**

```bash
node --check extension/app.js
```
Expected exit 0.

Then reload the extension. In DevTools console on the new-tab page:

```js
const ws = await readWorkspaceLinks();
console.log(ws);
// Expected: { schemaVersion: 1, items: [{id:'ws_…', url:'https://mail.google.com/', label:'Gmail'}, ...7 entries total], writeToken: 'wtw_…' }
console.log(ws.items.length);  // 7
```

Then:

```js
await addWorkspaceLink('https://notion.so/');
const ws2 = await readWorkspaceLinks();
console.log(ws2.items.length);  // 8
console.log(ws2.items[7].label);  // 'Notion.so' (derived) — or similar capitalization

// Duplicate
try { await addWorkspaceLink('https://notion.so'); }
catch (e) { console.log('expected:', e.message); }  // 'duplicate-url'

// Invalid
try { await addWorkspaceLink('ftp://foo.com'); }
catch (e) { console.log('expected:', e.message); }  // 'invalid-scheme'

// Cap
for (let i = 0; i < 20; i++) {
  try { await addWorkspaceLink('https://example' + i + '.com'); } catch (e) {
    console.log('stopped at iteration', i, e.message);
    break;
  }
}
// Expected to stop at 8 (cap 16 minus 8 already added = 8 more, so iteration 8 throws 'cap-reached')

// Cleanup
await chrome.storage.local.remove('workspaceLinks');
```

- [ ] **Step 2.3: Commit**

```bash
git add extension/app.js
git commit -m "feat(quick-access): storage layer with seed, add/remove, cap, scheme allowlist"
```

---

## Task 3: `sessions` permission helper

**Files:**
- Modify: `extension/app.js` (add helper near other `ensure*Permission` helpers)

- [ ] **Step 3.1: Add the helper**

In `extension/app.js`, search for `function ensureTabGroupsPermission`. Immediately after that function, add:

```js
async function ensureSessionsPermission({ prompt = false } = {}) {
  const currentlyGranted = await chrome.permissions.contains({ permissions: ['sessions'] });
  if (currentlyGranted) {
    _sessionsPermissionGranted = true;
    return true;
  }
  if (prompt) {
    const requested = await chrome.permissions.request({ permissions: ['sessions'] });
    _sessionsPermissionGranted = !!requested;
    return _sessionsPermissionGranted;
  }
  _sessionsPermissionGranted = false;
  return false;
}
```

- [ ] **Step 3.2: Verify**

```bash
node --check extension/app.js
```
Expected exit 0.

Reload. In DevTools:

```js
await ensureSessionsPermission();        // false on first call
await ensureSessionsPermission({ prompt: true });
// Chrome prompt appears — accept.
// Returns true.
await ensureSessionsPermission();        // true (no prompt now)
```

You can revoke the permission via `chrome://extensions/?id=<your-extension-id>` if you want to re-test from scratch.

- [ ] **Step 3.3: Commit**

```bash
git add extension/app.js
git commit -m "feat(quick-access): optional sessions permission helper"
```

---

## Task 4: Render Workspace section (read-only, no edit mode yet)

**Files:**
- Modify: `extension/app.js` (expand the stub from Task 1 into a real renderer for Workspace only)

- [ ] **Step 4.1: Replace the `renderQuickAccessRow` stub and add `renderWorkspaceSection`**

In `extension/app.js`, find the stub `async function renderQuickAccessRow() { … }` and replace with:

```js
async function renderQuickAccessRow() {
  await renderWorkspaceSection();
  await renderRecentlyClosedSection();
}

async function renderWorkspaceSection() {
  const container = document.getElementById('qaWorkspace');
  if (!container) return;

  const { items } = await readWorkspaceLinks();

  const chips = items.map(renderWorkspaceChip);
  if (_workspaceEditMode) chips.push(renderAddChip(items.length));

  const toggle = el('button', {
    class: 'qa-edit-toggle',
    'data-action': 'qa-toggle-edit',
    title: _workspaceEditMode ? 'Done' : 'Edit'
  }, _workspaceEditMode ? '✓' : '✎');

  container.replaceChildren(
    el('div', { class: 'qa-section-label' }, 'Workspace'),
    el('div', { class: 'qa-chip-strip' }, chips),
    toggle
  );
}

function renderWorkspaceChip(item) {
  const chip = el('a', {
    class: 'qa-chip' + (_workspaceEditMode ? ' qa-edit-mode' : ''),
    href: item.url,
    target: '_blank',
    rel: 'noopener',
    title: item.label,
    'data-link-id': item.id
  }, [faviconEl(item.url, 24)]);

  if (_workspaceEditMode) {
    const removeBtn = el('button', {
      class: 'qa-chip-remove',
      'data-action': 'qa-remove-link',
      'data-link-id': item.id,
      title: 'Remove ' + item.label
    }, '×');
    // Prevent the anchor click from firing when the × is clicked.
    removeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // The delegated handler will pick up the data-action.
    }, { once: false });
    chip.appendChild(removeBtn);
  }

  return chip;
}

function renderAddChip(currentCount) {
  const btn = el('button', {
    class: 'qa-add',
    'data-action': 'qa-add-link-start',
    disabled: currentCount >= WORKSPACE_MAX_ITEMS,
    title: currentCount >= WORKSPACE_MAX_ITEMS ? 'Remove a link first' : 'Add link'
  }, '+');
  return btn;
}

// Recently-closed gets its real implementation in Task 5;
// for now a permanent no-op so Task 4 can stand alone.
async function renderRecentlyClosedSection() {
  const container = document.getElementById('qaRecent');
  if (!container) return;
  container.replaceChildren();
}
```

- [ ] **Step 4.2: Verify**

```bash
node --check extension/app.js
```
Expected exit 0.

Reload. Confirm:
- The Workspace row renders between the header and the grid with 7 chips (Gmail, Calendar, Drive, Docs, Sheets, Slides, Gemini) — favicons or letter-chip fallback.
- A ✎ pencil sits to the right of the chips.
- Hovering a chip shows the native browser tooltip (label).
- Clicking a chip opens the target in a new tab.
- Clicking the pencil does nothing yet (Task 6 wires edit mode).

- [ ] **Step 4.3: Commit**

```bash
git add extension/app.js
git commit -m "feat(quick-access): render workspace chips (read-only)"
```

---

## Task 5: Render Recently Closed section (with Enable chip)

**Files:**
- Modify: `extension/app.js` (replace the no-op Recently Closed renderer with the real one)

- [ ] **Step 5.1: Replace `renderRecentlyClosedSection` and add helpers**

Replace the no-op body from Task 4.1 with:

```js
async function renderRecentlyClosedSection() {
  const container = document.getElementById('qaRecent');
  if (!container) return;

  const granted = await ensureSessionsPermission({ prompt: false });
  if (!granted) {
    container.replaceChildren(
      el('div', { class: 'qa-section-label' }, 'Recently closed'),
      el('button', { class: 'qa-enable', 'data-action': 'qa-enable-sessions' }, 'Enable')
    );
    return;
  }

  let tabs = [];
  try {
    const entries = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
    tabs = entries.filter(e => e.tab).slice(0, 5).map(e => e.tab);
  } catch (err) {
    console.warn('[tab-out] getRecentlyClosed failed', err);
    container.replaceChildren(
      el('div', { class: 'qa-section-label' }, 'Recently closed'),
      el('div', { class: 'qa-empty' }, "Couldn't load recently closed")
    );
    return;
  }

  if (tabs.length === 0) {
    container.replaceChildren(
      el('div', { class: 'qa-section-label' }, 'Recently closed'),
      el('div', { class: 'qa-empty' }, 'Nothing recently closed')
    );
    return;
  }

  container.replaceChildren(
    el('div', { class: 'qa-section-label' }, 'Recently closed'),
    el('div', { class: 'qa-recent-list' }, tabs.map(renderRecentItem))
  );
}

function renderRecentItem(tab) {
  let hostname = '';
  try { hostname = new URL(tab.url).hostname.replace(/^www\./, ''); } catch {}
  const title = (tab.title && tab.title.trim()) || hostname || 'Untitled';
  const lastAccessedIso = tab.lastAccessed
    ? new Date(tab.lastAccessed * 1000).toISOString()  // Chrome returns seconds since epoch for sessions API
    : new Date().toISOString();
  const ago = timeAgo(lastAccessedIso);

  return el('button', {
    class: 'qa-recent-item',
    'data-action': 'qa-restore-closed',
    'data-session-id': String(tab.sessionId || ''),
    title: tab.url
  }, [
    faviconEl(tab.url, 16),
    el('div', { class: 'qa-recent-text' }, [
      el('div', { class: 'qa-recent-title' }, title),
      el('div', { class: 'qa-recent-meta' }, hostname + ' · ' + ago)
    ])
  ]);
}
```

Note: `chrome.sessions.Tab.lastAccessed` is documented as "The time at which the tab was closed, represented in milliseconds since the epoch". Chrome docs are ambiguous on units across API versions. Defensive handling: if the number is suspiciously small (< 1e12), treat as seconds and multiply by 1000. Update `lastAccessedIso` calc:

Replace:
```js
const lastAccessedIso = tab.lastAccessed
  ? new Date(tab.lastAccessed * 1000).toISOString()
  : new Date().toISOString();
```

With:
```js
function _normalizeLastAccessed(raw) {
  if (!raw || typeof raw !== 'number') return Date.now();
  return raw < 1e12 ? raw * 1000 : raw;
}
const lastAccessedMs = _normalizeLastAccessed(tab.lastAccessed);
const lastAccessedIso = new Date(lastAccessedMs).toISOString();
```

Add `_normalizeLastAccessed` as a sibling helper.

- [ ] **Step 5.2: Verify**

```bash
node --check extension/app.js
```
Expected exit 0.

Reload. Confirm:
- Recently Closed section shows *"Recently closed"* label + *"Enable"* chip (permission not yet granted).
- Click Enable → Chrome prompt → accept.
- Reload the page — section should now show either *"Nothing recently closed"* or a list of up to 5 items depending on whether you've closed any tabs.

Test with data:
1. Open 6 random tabs.
2. Close 5 of them.
3. Come back to Tab Out new-tab (reload if needed).
4. Recently Closed shows the 5 most recently closed; each has a favicon + title + hostname + timeAgo.
5. Hover an item — native tooltip shows full URL.
6. Clicking an item does nothing yet (restore wired in Task 8).

- [ ] **Step 5.3: Commit**

```bash
git add extension/app.js
git commit -m "feat(quick-access): recently closed section with enable chip"
```

---

## Task 6: Edit mode + add/remove handlers

**Files:**
- Modify: `extension/app.js` (extend the delegated click handler + add inline-input renderer)

- [ ] **Step 6.1: Add `renderAddLinkInput`**

Above `renderAddChip` in the Quick Access section, add:

```js
function renderAddLinkInput(currentCount) {
  const input = el('input', {
    type: 'url',
    class: 'qa-add-input',
    placeholder: 'https://example.com'
  });
  const errorEl = el('span', { class: 'qa-add-error', style: { display: 'none' } });

  const wrapper = el('span', { class: 'qa-add-wrapper' }, [input, errorEl]);

  function commit() {
    const url = input.value.trim();
    if (!url) { exit(); return; }
    errorEl.style.display = 'none';
    addWorkspaceLink(url)
      .then(() => {
        _workspaceEditMode = true;   // stay in edit mode
        renderWorkspaceSection();
      })
      .catch(err => {
        const msg = err && err.message;
        let text = "Couldn't add link.";
        if (msg === 'invalid-scheme') text = 'Use http:// or https://';
        else if (msg === 'duplicate-url') text = 'Already in the list';
        else if (msg === 'cap-reached') text = 'Remove a link first';
        else if (String(err).toLowerCase().includes('quota')) text = 'Storage full — delete a link first.';
        errorEl.textContent = text;
        errorEl.style.display = 'inline';
        input.focus();
        input.select();
      });
  }

  function exit() {
    _addInputOpen = false;
    renderWorkspaceSection();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); exit(); }
  });
  input.addEventListener('blur', () => {
    // Only exit if the input is empty AND no error is visible (blur during typing shouldn't nuke the state).
    if (!input.value.trim() && errorEl.style.display !== 'inline') exit();
  });

  // Focus on next tick (after this node is attached to DOM).
  setTimeout(() => { input.focus(); }, 0);

  return wrapper;
}
```

- [ ] **Step 6.2: Track `_addInputOpen` state and plumb it through `renderWorkspaceSection`**

Add at the top of the Quick Access section alongside the other `let` declarations:

```js
let _addInputOpen = false;
```

Modify `renderWorkspaceSection` so that when `_addInputOpen` is true, the `renderAddChip(items.length)` call is replaced by `renderAddLinkInput(items.length)`:

```js
async function renderWorkspaceSection() {
  const container = document.getElementById('qaWorkspace');
  if (!container) return;

  const { items } = await readWorkspaceLinks();

  const chips = items.map(renderWorkspaceChip);
  if (_workspaceEditMode) {
    chips.push(_addInputOpen ? renderAddLinkInput(items.length) : renderAddChip(items.length));
  }

  const toggle = el('button', {
    class: 'qa-edit-toggle',
    'data-action': 'qa-toggle-edit',
    title: _workspaceEditMode ? 'Done' : 'Edit'
  }, _workspaceEditMode ? '✓' : '✎');

  container.replaceChildren(
    el('div', { class: 'qa-section-label' }, 'Workspace'),
    el('div', { class: 'qa-chip-strip' }, chips),
    toggle
  );
}
```

- [ ] **Step 6.3: Wire click handlers into the delegated listener**

Find the delegated click handler in `app.js` (search for the section with `action === 'session-kebab'` or similar). Add these four new branches inside the same handler:

```js
if (action === 'qa-toggle-edit') {
  e.preventDefault();
  _workspaceEditMode = !_workspaceEditMode;
  if (!_workspaceEditMode) _addInputOpen = false;
  renderWorkspaceSection();
  return;
}
if (action === 'qa-remove-link') {
  e.preventDefault();
  e.stopPropagation();
  const id = target.dataset.linkId;
  try {
    await removeWorkspaceLink(id);
  } catch (err) {
    if (String(err).toLowerCase().includes('quota')) {
      showToast({ message: 'Storage full — delete a link first.' });
    } else {
      showToast({ message: "Couldn't remove — try reloading." });
      console.warn('[tab-out] removeWorkspaceLink failed', err);
    }
  }
  renderWorkspaceSection();
  return;
}
if (action === 'qa-add-link-start') {
  e.preventDefault();
  _addInputOpen = true;
  renderWorkspaceSection();
  return;
}
if (action === 'qa-enable-sessions') {
  e.preventDefault();
  await ensureSessionsPermission({ prompt: true });
  renderRecentlyClosedSection();
  return;
}
```

- [ ] **Step 6.4: Verify**

```bash
node --check extension/app.js
```
Expected exit 0.

Reload. Test sequence:

1. Click ✎ → pencil flips to ✓; hovering a chip shows a small red × in the top-right corner.
2. Click the × on a default chip (e.g., Drive) → chip disappears; persists after a full reload.
3. Click the `+` chip at the end → text input appears.
4. Paste `https://notion.so/`, press Enter → Notion chip appears with its favicon (or letter chip if permission declined).
5. Click `+` again, paste `https://notion.so/`, Enter → inline red error *"Already in the list"*; input stays open. Esc clears.
6. Click `+`, paste `ftp://foo.com`, Enter → inline red error *"Use http:// or https://"*.
7. Click ✓ → edit mode exits; pencil returns; × overlays disappear.

- [ ] **Step 6.5: Commit**

```bash
git add extension/app.js
git commit -m "feat(quick-access): edit mode with inline add + remove"
```

---

## Task 7: `chrome.storage.onChanged` + `permissions.onRemoved` + `tabs.onRemoved`

**Files:**
- Modify: `extension/app.js` (extend listeners)

- [ ] **Step 7.1: Extend the `storage.onChanged` listener**

Find `function installStorageSync()` in `app.js`. Inside the handler, add a `workspaceLinks` branch alongside the existing `sessions` / `sessionsTrash` / `deferred` branches:

```js
if (changes.workspaceLinks) {
  const nv = changes.workspaceLinks.newValue;
  if (_lastSelfWorkspaceWriteToken && nv && nv.writeToken === _lastSelfWorkspaceWriteToken) return;
  renderWorkspaceSection();
}
```

Place this alongside the other `if (changes.…)` blocks; do not wrap it in an outer else.

- [ ] **Step 7.2: Add `installQuickAccessListeners` helper**

Below the render functions (end of the Quick Access section), add:

```js
function scheduleRecentRefresh() {
  clearTimeout(_recentRefreshTimer);
  _recentRefreshTimer = setTimeout(() => renderRecentlyClosedSection(), 250);
}

function installQuickAccessListeners() {
  if (chrome.tabs && chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener(scheduleRecentRefresh);
  }
  if (chrome.permissions && chrome.permissions.onRemoved) {
    chrome.permissions.onRemoved.addListener((perms) => {
      if (perms && Array.isArray(perms.permissions) && perms.permissions.includes('sessions')) {
        _sessionsPermissionGranted = false;
        renderRecentlyClosedSection();
      }
    });
  }
}
```

- [ ] **Step 7.3: Wire it into page-init**

Find the page-init sequence (where `installStorageSync()` is called). Immediately after `installStorageSync()`, add:

```js
installQuickAccessListeners();
```

- [ ] **Step 7.4: Verify**

```bash
node --check extension/app.js
```
Expected exit 0.

Reload and test:

**Multi-page workspace sync:**
1. Open two Tab Out new-tab pages (page A, page B).
2. In page A, click ✎ → remove a Workspace chip → click ✓.
3. Switch to page B (no reload) → the chip has disappeared within ~1 second.

**Recently Closed auto-refresh:**
1. Ensure `sessions` permission granted.
2. Watch the Tab Out page in one window; close a tab in another window.
3. Within ~250 ms, Recently Closed updates to include the just-closed tab.

**Permission revoke:**
1. Open `chrome://extensions/?id=<your-id>`, untick Sessions permission.
2. Tab Out's Recently Closed section switches back to the Enable chip automatically (no reload needed).

- [ ] **Step 7.5: Commit**

```bash
git add extension/app.js
git commit -m "feat(quick-access): onChanged, onRemoved, permissions.onRemoved listeners"
```

---

## Task 8: Recently-closed restore click

**Files:**
- Modify: `extension/app.js` (one more delegated action handler)

- [ ] **Step 8.1: Add the restore handler**

In the same delegated click handler where Task 6 added the four quick-access actions, add one more branch:

```js
if (action === 'qa-restore-closed') {
  e.preventDefault();
  const sessionId = target.dataset.sessionId;
  if (!sessionId) return;
  try {
    await chrome.sessions.restore(sessionId);
  } catch (err) {
    showToast({ message: "Couldn't reopen tab — it may be too old." });
    console.warn('[tab-out] sessions.restore failed', err);
  }
  return;
}
```

`target` here is the element resolved by `e.target.closest('[data-action]')` in the existing delegated listener. Confirm by reading the handler setup — if the existing pattern uses a different variable name (e.g. `actionEl`), use that instead.

- [ ] **Step 8.2: Verify**

```bash
node --check extension/app.js
```
Expected exit 0.

Reload and test:
1. Close 2–3 tabs with distinguishable content.
2. Return to Tab Out, confirm they appear in Recently Closed.
3. Click one → the tab reopens at its original window/position.
4. Verify no Tab Out page was replaced — your current window stays intact, the restore happens in-place.

- [ ] **Step 8.3: Commit**

```bash
git add extension/app.js
git commit -m "feat(quick-access): restore recently-closed tab on click"
```

---

## Task 9: Smoke-test matrix

**Files:** none modified; this is verification only.

- [ ] **Step 9.1: Run the full smoke matrix**

Work through these 16 checks. Record pass/fail in a scratch note if you like:

1. **Layout:** reload extension; quick-access row renders between header and main grid, two columns.
2. **Default chips:** Workspace column shows 7 chips (Gmail, Calendar, Drive, Docs, Sheets, Slides, Gemini); tooltips on hover show labels.
3. **Open in new tab:** click Gmail chip → `mail.google.com` opens in a new tab, original tab untouched.
4. **Edit toggle:** click ✎ → pencil flips to ✓; × overlays appear on chips; `+ Add` chip appears at end.
5. **Remove default:** click × on Drive → disappears; reload → stays gone.
6. **Add custom:** click `+`, paste `https://notion.so/`, Enter → Notion chip appears with favicon. Reload → still there.
7. **Duplicate guard:** click `+`, paste `https://notion.so/` again, Enter → inline *"Already in the list"* error.
8. **Scheme guard:** click `+`, paste `ftp://foo.com`, Enter → inline *"Use http:// or https://"* error.
9. **Cap:** add chips until you hit 16 total. The 17th add attempt either fails with *"Remove a link first"* or the `+` chip appears disabled.
10. **Exit edit:** click ✓ → edit mode exits; pencil returns; × overlays hidden.
11. **Enable recently closed:** Sessions permission not yet granted. Click **Enable** → Chrome prompt → accept. Recently Closed renders.
12. **Empty state:** with no recently-closed tabs in Chrome's session store, section shows *"Nothing recently closed"*.
13. **Populate:** open 6 random tabs in any window, close 5 → Tab Out auto-refreshes within ~250ms to show 5 items. Only 5 show even if more were closed.
14. **Restore:** click one recently-closed item → tab reopens at its original position. Tab Out page unchanged.
15. **Revoke permission:** in `chrome://extensions`, untick Sessions permission → Tab Out's Recently Closed switches back to Enable chip automatically.
16. **Multi-page sync:** open two Tab Out pages. Edit Workspace on page A → page B updates within ~1 second.

Any failure → file an issue, do NOT merge to `main`.

- [ ] **Step 9.2: Commit a smoke-results stub (optional)**

```bash
cat > docs/superpowers/specs/2026-04-19-quick-access-smoke-results.md <<'EOF'
# Quick Access Smoke Results — 2026-04-19

| # | Test | Result | Notes |
|---|---|---|---|
| 1 | Layout renders | PASS | |
| 2 | Default 7 chips | PASS | |
| … | … | … | |
EOF
git add -f docs/superpowers/specs/2026-04-19-quick-access-smoke-results.md
git commit -m "test: quick-access row smoke matrix results"
```

---

## Coverage check

| Spec section | Implementing task(s) |
|---|---|
| Layout (row between header/grid) | Task 1 |
| Data model + defaults + seed + cap | Task 2 |
| `workspaceLinks` CAS + `writeToken` | Task 2 |
| URL scheme allowlist + duplicate check | Task 2 |
| `ensureSessionsPermission` (optional) | Task 3 |
| Workspace chip rendering (favicon, tooltip, anchor) | Task 4 |
| Edit toggle (✎ ↔ ✓) | Task 4 + Task 6 |
| Remove-chip (× overlay) | Task 6 |
| Add-link inline input + validation | Task 6 |
| Recently Closed enable chip | Task 5 |
| Recently Closed list (5 items) | Task 5 |
| Recently Closed empty/error states | Task 5 |
| `chrome.storage.onChanged` on `workspaceLinks` | Task 7 |
| `chrome.tabs.onRemoved` debounced refresh | Task 7 |
| `chrome.permissions.onRemoved` listener | Task 7 |
| `chrome.sessions.restore` on click | Task 8 |
| Error handling (toasts) | Tasks 6, 8 |
| Security (DOM-only, allowlist, rel=noopener) | Tasks 2, 4, 5, 6, 8 |
| Manual smoke matrix | Task 9 |

Every spec section has at least one implementing task.
