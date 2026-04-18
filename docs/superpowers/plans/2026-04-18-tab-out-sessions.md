# Tab Out — Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Sessions feature (save & reopen current tabs, with snapshot slot, search, per-tab editing, persistent Trash) without breaking existing Tab Out features, and leave the extension materially safer than before.

**Architecture:** Phase 0 is a prerequisite refactor of rendering (DOM-only helpers, ban `innerHTML` for user-controlled text), toast (object API with clickable actions), sidebar visibility, storage-change listener, self-hosted fonts, and `_favicon` endpoint. Phases 1-6 build the Sessions feature on that foundation. Phase 7 is security hardening & README. Phase 8 is the manual smoke-matrix pass.

**Tech Stack:** Chrome MV3 extension. Vanilla JS (no build step, no framework). Storage via `chrome.storage.local`. Tabs/windows via `chrome.tabs`, `chrome.windows`, `chrome.tabGroups` (optional). No new dependencies.

**Reference docs:**
- Spec: `docs/superpowers/specs/2026-04-18-tab-out-sessions-design.md`
- Audit: `docs/superpowers/specs/2026-04-18-tab-out-sessions-audit.md`

**Testing convention:** Tab Out has no automated test harness. Every task ends with a manual verification step (reload the extension + do a specific action + observe a specific result). Evidence before completion claims.

**Branch:** Work on `feature/sessions`. Commit after each task. Do not amend. Each phase can ship as its own PR if desired.

**Conventions the plan follows (already established in the codebase):**
- Section banner comments (e.g. `/* ---- SAVED FOR LATER ---- */`) separate logical blocks in `app.js`.
- Event handling is delegation-based via `data-action` attributes on a single click listener.
- Logging uses `console.warn('[tab-out] …')` or `console.error('[tab-out] …')`.
- All new files respect the no-build-step rule — plain JS, CSS, HTML.

---

## File Structure

### Files created

| Path | Responsibility |
|---|---|
| `extension/fonts/fonts.css` | `@font-face` declarations for self-hosted fonts |
| `extension/fonts/DMSans.woff2` | DM Sans font binary |
| `extension/fonts/Newsreader.woff2` | Newsreader font binary |

### Files modified

| Path | Changes |
|---|---|
| `extension/app.js` | DOM helpers, toast controller, sessions data layer, sessions UI, trash UI, search, save flow, reopen flow, storage.onChanged listener, favicon rendering, scheme allowlist |
| `extension/index.html` | Header chip, pill switcher markup, self-hosted fonts `<link>`, inline `onerror` removed |
| `extension/style.css` | Pill switcher, session card, expand/collapse, search input, trash, header chip, toast action button |
| `extension/manifest.json` | `optional_permissions: ["favicon", "tabGroups"]` |
| `README.md` | Privacy wording corrected |

### Internal `app.js` structure after refactor

Banner-delimited sections (no new files — preserves the project's single-file convention):

```
/* ---- DOM helpers ---- */         el, textNode, escapeAttr
/* ---- Toast controller ---- */    showToast({message, actionLabel, onAction, durationMs})
/* ---- Storage: common ---- */     readSessions, setSessionsIfUnchanged, readTrash, writeTrash
/* ---- Storage: sessions ---- */   createSession, updateSession, renameSession, duplicateSession,
                                    deleteSession, saveAsNamedSession, removeTabFromSession
/* ---- Storage: trash ---- */      trashAdd, trashRestore, trashDrop, trashLazyPurge
/* ---- Storage: validation ---- */ validateSession, quarantineSession
/* ---- Sidebar state ---- */       sidebarState, renderSidebar, renderDeferredPane, renderSessionsPane, renderTrashPane
/* ---- Sessions: save ---- */      captureCurrentWindow, openSaveOverlay, saveSession
/* ---- Sessions: reopen ---- */    reopenSession, reopenSingleTab
/* ---- Sessions: search ---- */    sessionMatchesQuery, tabMatchesQuery
/* ---- Permissions ---- */         ensureFaviconPermission, ensureTabGroupsPermission
/* ---- Favicon rendering ---- */   faviconEl(url, size)
```

---

## Phase 0 — Prerequisite refactor

Every subsequent phase assumes Phase 0 is complete. Do not merge Phase 1+ into `main` without Phase 0.

### Task 0.1: Self-host fonts

**Files:**
- Create: `extension/fonts/fonts.css`
- Create: `extension/fonts/DMSans.woff2`
- Create: `extension/fonts/Newsreader.woff2`
- Modify: `extension/index.html` (replace Google Fonts link)

- [ ] **Step 1: Download font files**

Both Google Fonts are licensed SIL OFL 1.1 (redistributable).

```bash
cd extension
mkdir -p fonts
curl -L -o fonts/DMSans.woff2 "https://fonts.gstatic.com/s/dmsans/v15/rP2Yp2ywxg089UriI5-g7vlQNmu9.woff2"
curl -L -o fonts/Newsreader.woff2 "https://fonts.gstatic.com/s/newsreader/v20/cY9qfjOCX1hbuyalUrK49dLac06G1ZGsZBtoBCzBDXXD9JVF438w_pZ6.woff2"
```

Confirm sizes:

```bash
ls -la fonts/
```
Expected: two `.woff2` files, each 20–200 KB.

- [ ] **Step 2: Create `fonts/fonts.css`**

```css
@font-face {
  font-family: 'DM Sans';
  font-style: normal;
  font-weight: 300 600;
  font-display: swap;
  src: url('DMSans.woff2') format('woff2');
}

@font-face {
  font-family: 'Newsreader';
  font-style: normal;
  font-weight: 300 500;
  font-display: swap;
  src: url('Newsreader.woff2') format('woff2');
}
```

- [ ] **Step 3: Replace Google Fonts `<link>` in `index.html`**

Find in `extension/index.html`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;0,6..72,500;1,6..72,300;1,6..72,400&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
```

Replace with:

```html
<link rel="stylesheet" href="fonts/fonts.css">
```

- [ ] **Step 4: Verify in browser**

Reload the extension at `chrome://extensions`. Open a new tab. Open DevTools → Network. Reload.

Expected:
- No requests to `fonts.googleapis.com` or `fonts.gstatic.com`.
- Two successful requests to `chrome-extension://…/fonts/DMSans.woff2` and `Newsreader.woff2`.
- Typography looks unchanged (Newsreader serif headings, DM Sans body).

- [ ] **Step 5: Commit**

```bash
git add extension/fonts/ extension/index.html
git commit -m "refactor: self-host Google Fonts to remove third-party requests"
```

---

### Task 0.2: DOM helpers (`el`, `textNode`)

**Files:**
- Modify: `extension/app.js` (add new section near the top, after existing utility functions around line 432)

- [ ] **Step 1: Add the DOM helpers section**

Locate the `showToast` function in `extension/app.js` (search for `function showToast(`). Insert this new section **before** it:

```js
/* ----------------------------------------------------------------
   DOM HELPERS — use these for ALL user-controlled text.
   Rule: never pass user-controlled strings into innerHTML.
   el() creates elements with attrs + children; textNode() wraps strings.
   ---------------------------------------------------------------- */

/**
 * el(tag, attrs, children)
 * Create an HTMLElement with attributes and children.
 * - attrs: object. Keys starting with "on" are attached as event listeners.
 *         Keys "class" / "className" set className. "style" expects an object
 *         of camelCase properties.
 * - children: string | Node | array of (string | Node).
 *   Strings are wrapped in a text node; arrays are appended in order.
 */
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key in attrs) {
      const v = attrs[key];
      if (v == null || v === false) continue;
      if (key === 'class' || key === 'className') { node.className = v; continue; }
      if (key === 'style' && typeof v === 'object') {
        for (const s in v) node.style[s] = v[s];
        continue;
      }
      if (key.startsWith('on') && typeof v === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), v);
        continue;
      }
      if (v === true) { node.setAttribute(key, ''); continue; }
      node.setAttribute(key, v);
    }
  }
  if (children != null) {
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child == null || child === false) continue;
      node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
  return node;
}

/**
 * textNode(str) — convenience wrapper for a text node.
 */
function textNode(str) {
  return document.createTextNode(str == null ? '' : String(str));
}
```

- [ ] **Step 2: Verify no regressions**

Reload the extension. Open a new tab. Confirm:
- Dashboard renders as before.
- No console errors.

- [ ] **Step 3: Smoke-test the helpers in DevTools console**

In the new-tab page's DevTools console:

```js
el('div', {class: 'test', title: 'hi'}, 'hello').outerHTML
// → '<div class="test" title="hi">hello</div>'

el('span', {}, textNode('<script>alert(1)</script>')).outerHTML
// → '<span>&lt;script&gt;alert(1)&lt;/script&gt;</span>'  ← safely escaped
```

- [ ] **Step 4: Commit**

```bash
git add extension/app.js
git commit -m "refactor: add DOM helpers (el, textNode) for XSS-safe rendering"
```

---

### Task 0.3: Migrate Deferred pane rendering to DOM helpers

**Files:**
- Modify: `extension/app.js` (`renderDeferredItem`, `renderArchiveItem`, and their callers around line 923 and 1466)

**Context:** These two functions currently use `innerHTML` template literals and interpolate page-controlled tab titles directly. That is the pre-existing XSS surface the audit flagged. This task eliminates it and establishes the pattern every subsequent render will follow.

- [ ] **Step 1: Locate the functions**

Search in `extension/app.js` for:
- `function renderDeferredItem(item)` — currently returns an HTML string.
- `function renderArchiveItem(item)` — same.

- [ ] **Step 2: Rewrite `renderDeferredItem` to return a DOM node**

Replace the entire function body with:

```js
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const ago = timeAgo(item.savedAt);

  const checkbox = el('input', {
    type: 'checkbox',
    class: 'deferred-checkbox',
    'data-action': 'check-deferred',
    'data-deferred-id': item.id
  });

  const favicon = faviconEl(item.url, 14);   // defined in Task 0.9

  const titleLink = el('a', {
    href: item.url,
    target: '_blank',
    rel: 'noopener',
    class: 'deferred-title',
    title: item.title || item.url
  }, [favicon, textNode(' ' + (item.title || item.url))]);

  const dismissBtn = el('button', {
    class: 'deferred-dismiss',
    'data-action': 'dismiss-deferred',
    'data-deferred-id': item.id,
    title: 'Dismiss'
  });
  dismissBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>';
  // SVG markup has no user-controlled content — inline innerHTML is safe.

  return el('div', {
    class: 'deferred-item',
    'data-deferred-id': item.id
  }, [
    checkbox,
    el('div', { class: 'deferred-info' }, [
      titleLink,
      el('div', { class: 'deferred-meta' }, [
        el('span', {}, domain),
        el('span', {}, ago)
      ])
    ]),
    dismissBtn
  ]);
}
```

- [ ] **Step 3: Rewrite `renderArchiveItem` the same way**

```js
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return el('div', { class: 'archive-item' }, [
    el('a', {
      href: item.url,
      target: '_blank',
      rel: 'noopener',
      class: 'archive-item-title',
      title: item.title || item.url
    }, item.title || item.url),
    el('span', { class: 'archive-item-date' }, ago)
  ]);
}
```

- [ ] **Step 4: Update the callers to append DOM nodes instead of setting innerHTML**

The function in this repo is `renderDeferredColumn` (grep `function renderDeferredColumn`). Inside it, find:

```js
list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
```

Replace with:

```js
list.replaceChildren(...active.map(item => renderDeferredItem(item)));
```

Then find:

```js
archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
```

Replace with:

```js
archiveList.replaceChildren(...archived.map(item => renderArchiveItem(item)));
```

- [ ] **Step 5: Verify**

Reload the extension. Save a tab for later (bookmark icon on any open-tab card). Confirm:
- The saved item appears in the sidebar.
- The item's title is plain text (try saving a tab whose title you set via DevTools to `<img src=x onerror=alert(1)>` — after reload it should render as literal text, NOT trigger an alert).

Test malicious title:

1. In DevTools console, on any regular tab: `document.title = '<img src=x onerror=alert(1)>'`.
2. Save that tab via Tab Out.
3. Reload the new-tab page.
4. The deferred sidebar should show the literal text `<img src=x onerror=alert(1)>` — NOT trigger an alert, NOT render a broken image.

- [ ] **Step 6: Commit**

```bash
git add extension/app.js
git commit -m "refactor: render Deferred pane via DOM helpers (XSS fix)"
```

---

### Task 0.4: Migrate main-grid tab-chip rendering to DOM helpers

**Files:**
- Modify: `extension/app.js` (the tab chip builders around lines 770 and 850 where domain-card and homepage-card chips are built)

**Context:** These also interpolate page-controlled tab titles into `innerHTML`. Same fix pattern.

- [ ] **Step 1: Locate the chip builders**

In `extension/app.js`, search for `data-action="defer-single-tab"`. You'll find two builder functions (one for domain-card chips, one for homepage-card chips). They currently return HTML strings.

- [ ] **Step 2: Convert each chip builder to return a DOM node**

For each location, replace the template-literal construction with `el()`/`textNode()` calls that mirror the original structure. User-controlled inputs (tab title, tab url) always go through `textNode` or through `{title: …, href: …}` attrs — never interpolated into HTML strings.

Example shape:

```js
const chip = el('a', {
  href: tab.url,
  class: 'chip',
  'data-action': 'focus-tab',
  'data-tab-id': tab.id,
  title: tab.title || tab.url
}, [
  faviconEl(tab.url, 14),
  textNode(' '),
  el('span', { class: 'chip-title' }, tab.title || tab.url)
]);

const saveBtn = el('button', {
  class: 'chip-action chip-save',
  'data-action': 'defer-single-tab',
  'data-tab-url': tab.url,
  'data-tab-title': tab.title || '',
  title: 'Save for later'
});
saveBtn.innerHTML = '<svg ...>'; // static SVG only — no interpolation
```

For SVG icons (static markup), `innerHTML` is acceptable because none of the string is user-controlled. Do NOT use innerHTML to set wrapper markup that *contains* user-controlled text.

- [ ] **Step 3: Update the card builders**

The functions that assemble a full mission card currently concatenate chip-HTML strings and set the card's `innerHTML`. Convert them: the card builder now creates a container `el('div', …)` and `appendChild`s each chip.

- [ ] **Step 4: Verify**

Reload. Open several tabs including one with a title containing `<>` characters. Confirm:
- All domain cards render.
- Hovering a chip shows the full title in the native tooltip.
- Clicking a chip still focuses the tab.
- The Save-for-later button on each chip still works.
- No console errors.

Malicious-title test (same recipe as Task 0.3): set a tab's title to `<img src=x onerror=alert(1)>`, reload the new-tab page, confirm the chip shows literal text, no alert.

- [ ] **Step 5: Commit**

```bash
git add extension/app.js
git commit -m "refactor: render main-grid chips via DOM helpers (XSS fix)"
```

---

### Task 0.5: Toast controller rewrite

**Files:**
- Modify: `extension/app.js` (`showToast` function, ~line 438)
- Modify: `extension/index.html` (toast markup, ~line 120)
- Modify: `extension/style.css` (`.toast` rules, grep for `.toast {`)

- [ ] **Step 1: Replace `showToast` implementation**

Find `function showToast(message) {` and replace the entire function with:

```js
/* ----------------------------------------------------------------
   TOAST CONTROLLER
   Object API: showToast({ message, actionLabel?, onAction?, durationMs? })
   - message: required string
   - actionLabel: optional string — if present, a clickable button is shown
   - onAction: optional function — called when the action is clicked
   - durationMs: auto-dismiss timer (default 4000; 10000 for actionable toasts)
   Toasts queue: one visible at a time; next fires after current dismisses.
   ---------------------------------------------------------------- */

const _toastQueue = [];
let _toastActive = false;
let _toastTimer = null;

function showToast(argOrMessage) {
  // Back-compat: showToast('string') still works.
  const arg = typeof argOrMessage === 'string' ? { message: argOrMessage } : argOrMessage;
  _toastQueue.push(arg);
  if (!_toastActive) _toastPump();
}

function _toastPump() {
  const next = _toastQueue.shift();
  if (!next) { _toastActive = false; return; }
  _toastActive = true;

  const { message, actionLabel, onAction, durationMs } = next;
  const effectiveDuration = durationMs != null
    ? durationMs
    : (actionLabel ? 10000 : 4000);

  const toast = document.getElementById('toast');
  const textEl = document.getElementById('toastText');
  const actionSlot = document.getElementById('toastAction');

  textEl.textContent = message;
  actionSlot.replaceChildren();  // clear any previous action

  if (actionLabel) {
    const btn = el('button', {
      class: 'toast-action',
      onClick: () => {
        try { onAction && onAction(); } catch (e) { console.warn('[tab-out] toast action threw', e); }
        _toastDismiss();
      }
    }, actionLabel);
    actionSlot.appendChild(btn);
  }

  toast.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(_toastDismiss, effectiveDuration);
}

function _toastDismiss() {
  clearTimeout(_toastTimer);
  const toast = document.getElementById('toast');
  toast.classList.remove('visible');
  // Allow the CSS fade to complete before pumping the next toast (~300ms).
  setTimeout(_toastPump, 320);
}
```

- [ ] **Step 2: Update toast markup**

In `extension/index.html`, find the existing toast block (around line 120):

```html
<div class="toast" id="toast">
  <svg ...>...</svg>
  <span id="toastText"></span>
</div>
```

Add a sibling action slot after the text span:

```html
<div class="toast" id="toast">
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
  </svg>
  <span id="toastText"></span>
  <span id="toastAction" class="toast-action-slot"></span>
</div>
```

- [ ] **Step 3: Update toast CSS**

In `extension/style.css`, find `.toast {`. Ensure the container keeps `pointer-events: none` (so the toast doesn't steal clicks from the page), but add rules that make the action button clickable:

```css
.toast-action-slot {
  display: inline-flex;
  pointer-events: auto;
}

.toast-action {
  background: transparent;
  border: 1px solid rgba(255,255,255,0.4);
  color: inherit;
  font: inherit;
  font-weight: 500;
  padding: 2px 10px;
  border-radius: 999px;
  cursor: pointer;
  margin-left: 8px;
}
.toast-action:hover {
  background: rgba(255,255,255,0.1);
}
```

- [ ] **Step 4: Verify back-compat**

Reload. Save a tab for later. The existing "Saved for later" toast should still appear and auto-dismiss. No regressions.

- [ ] **Step 5: Verify new action toast**

In DevTools console on the new-tab page:

```js
showToast({
  message: 'Test',
  actionLabel: 'Click me',
  onAction: () => console.log('clicked'),
  durationMs: 5000
});
```

Expected: toast with a clickable "Click me" button. Click it → "clicked" in console + toast dismisses.

- [ ] **Step 6: Commit**

```bash
git add extension/app.js extension/index.html extension/style.css
git commit -m "refactor: object-API toast with clickable action + queue"
```

---

### Task 0.6: Sidebar visibility rework

**Files:**
- Modify: `extension/index.html` (rename `#deferredColumn` to `#sidebarColumn`, retain class for CSS)
- Modify: `extension/app.js` (visibility logic around line 925 and the render function around line 1167)

- [ ] **Step 1: Add `sidebar-column` class and a wrapper markup**

In `extension/index.html`, find:

```html
<div class="deferred-column" id="deferredColumn" style="display:none">
```

Change to:

```html
<div class="deferred-column sidebar-column" id="sidebarColumn" style="display:none">
```

Keep everything inside for now (pill switcher is added in Task 0.7; this task only handles visibility).

- [ ] **Step 2: Update visibility helper in app.js**

Search for `deferredColumn` in `app.js` (there should be two or three occurrences). For each:
- `document.getElementById('deferredColumn')` → `document.getElementById('sidebarColumn')`.

Find the function that toggles `display`. It currently reads something like:

```js
if (active.length === 0 && archived.length === 0) {
  col.style.display = 'none';
} else {
  col.style.display = 'block';
}
```

Replace with a helper:

```js
function updateSidebarVisibility() {
  const col = document.getElementById('sidebarColumn');
  if (!col) return;
  const hasDeferred = (_lastDeferred || []).some(d => !d.dismissedAt);
  const hasSessions = (_lastSessionsCount || 0) > 0;
  const hasTrash = (_lastTrashCount || 0) > 0;
  const userOnSessionsPane = (sidebarState.pane || 'deferred') !== 'deferred';
  col.style.display = (hasDeferred || hasSessions || hasTrash || userOnSessionsPane) ? 'block' : 'none';
}
```

Add these module-scoped caches near the top of the section:

```js
let _lastDeferred = [];
let _lastSessionsCount = 0;
let _lastTrashCount = 0;
const sidebarState = { pane: 'deferred' };
```

The cache variables are updated by the renderers (next tasks).

- [ ] **Step 3: Verify back-compat**

Reload. With no deferred items, the sidebar is hidden (matches current behavior). Save a tab for later — sidebar appears. Dismiss all deferred items — sidebar hides again.

- [ ] **Step 4: Commit**

```bash
git add extension/index.html extension/app.js
git commit -m "refactor: sidebar visibility keyed on all panes (prep for Sessions)"
```

---

### Task 0.7: Pill switcher markup + pane render router

**Files:**
- Modify: `extension/index.html` (add pill switcher + pane containers)
- Modify: `extension/app.js` (add renderSidebar that dispatches to pane renderers)
- Modify: `extension/style.css` (pill styling)

- [ ] **Step 1: Wrap the existing Deferred content in a pane container**

In `extension/index.html`, inside `#sidebarColumn`, wrap the current contents (`section-header` + `deferred-list` + `deferred-empty` + `deferred-archive`) in a new `<div class="sidebar-pane" id="deferredPane">`. Add sibling empty containers for the Sessions and Trash panes:

```html
<div class="deferred-column sidebar-column" id="sidebarColumn" style="display:none">

  <!-- Pill switcher -->
  <div class="sidebar-pills" id="sidebarPills">
    <button class="pill pill-active" data-pane="deferred">
      Saved for later <span class="pill-count" id="deferredPillCount">0</span>
    </button>
    <button class="pill" data-pane="sessions">
      Sessions <span class="pill-count" id="sessionsPillCount">0</span>
    </button>
    <a class="trash-link" data-pane="trash" style="display:none" id="trashLink">
      Trash <span id="trashLinkCount">0</span>
    </a>
  </div>

  <!-- Deferred pane -->
  <div class="sidebar-pane" id="deferredPane">
    <!-- existing section-header, deferred-list, deferred-empty, deferred-archive stay here -->
  </div>

  <!-- Sessions pane (populated in Phase 3) -->
  <div class="sidebar-pane" id="sessionsPane" style="display:none"></div>

  <!-- Trash pane (populated in Phase 6) -->
  <div class="sidebar-pane" id="trashPane" style="display:none"></div>

</div>
```

- [ ] **Step 2: Add pill CSS**

In `extension/style.css`, near other sidebar styles:

```css
.sidebar-pills {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.pill {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 999px;
  cursor: pointer;
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.pill-active {
  background: var(--fg);
  color: var(--bg);
  border-color: var(--fg);
}
.pill-count {
  opacity: 0.7;
  font-size: 11px;
}
.trash-link {
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
```

- [ ] **Step 3: Add pane router in app.js**

```js
/* ----------------------------------------------------------------
   SIDEBAR STATE & PANE ROUTER
   ---------------------------------------------------------------- */

async function initSidebarState() {
  const { sidebarPane = 'deferred' } = await chrome.storage.local.get('sidebarPane');
  sidebarState.pane = sidebarPane;
}

function switchSidebarPane(pane) {
  sidebarState.pane = pane;
  chrome.storage.local.set({ sidebarPane: pane });
  // Update pill active state
  document.querySelectorAll('#sidebarPills .pill').forEach(p => {
    p.classList.toggle('pill-active', p.dataset.pane === pane);
  });
  // Show the right pane
  document.getElementById('deferredPane').style.display = pane === 'deferred' ? 'block' : 'none';
  document.getElementById('sessionsPane').style.display = pane === 'sessions' ? 'block' : 'none';
  document.getElementById('trashPane').style.display = pane === 'trash' ? 'block' : 'none';
  renderSidebar();
  updateSidebarVisibility();
}

function renderSidebar() {
  renderDeferredPane();           // existing logic moved into this function
  // renderSessionsPane() and renderTrashPane() are added in later phases
  const deferredActive = (_lastDeferred || []).filter(d => !d.completedAt && !d.dismissedAt).length;
  const deferredPillCount = document.getElementById('deferredPillCount');
  if (deferredPillCount) deferredPillCount.textContent = deferredActive;
}
```

Wire click handlers on the pills into the existing delegated click listener (search for `data-action` handler and add a clause for `e.target.closest('.pill')` / `.trash-link`):

```js
const pillBtn = e.target.closest('[data-pane]');
if (pillBtn) {
  e.preventDefault();
  switchSidebarPane(pillBtn.dataset.pane);
  return;
}
```

Call `initSidebarState()` from the page-init code (search for `DOMContentLoaded` or the top-level `async function init` — add `await initSidebarState();` before the first render).

- [ ] **Step 4: Rename `renderDeferredColumn` to `renderDeferredPane`**

The existing async function `renderDeferredColumn()` already exists as a standalone render entry point. Simply rename it and all call sites. Grep:

```bash
grep -n "renderDeferredColumn" extension/app.js
```

Rename every occurrence to `renderDeferredPane`. The function body stays the same.

- [ ] **Step 5: Verify**

Reload. With no deferred and no sessions, sidebar is hidden. Save a deferred tab — sidebar shows with both pills visible, "Saved for later" active. Click the "Sessions" pill — Deferred pane hides, empty Sessions pane is visible (we haven't populated it yet; that comes in Phase 3). Click "Saved for later" pill — Deferred returns.

- [ ] **Step 6: Commit**

```bash
git add extension/app.js extension/index.html extension/style.css
git commit -m "refactor: add sidebar pill switcher with per-pane routing"
```

---

### Task 0.8: `chrome.storage.onChanged` listener + write-token dedup

**Files:**
- Modify: `extension/app.js` (add listener near page init)

- [ ] **Step 1: Add write-token helper and listener**

Near the top of `app.js` (after DOM helpers section), add:

```js
/* ----------------------------------------------------------------
   STORAGE CHANGE SYNC — keep multiple new-tab pages consistent
   ---------------------------------------------------------------- */

let _lastSelfWriteToken = null;

function newWriteToken() {
  const t = 'wt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  _lastSelfWriteToken = t;
  return t;
}

function installStorageSync() {
  if (!chrome.storage || !chrome.storage.onChanged) return;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (changes.sessions) {
      const nv = changes.sessions.newValue;
      // Skip echoes of our own writes.
      if (nv && nv.writeToken === _lastSelfWriteToken) return;
      renderSessionsPane();            // defined in Phase 3; harmless no-op until then
      updateSidebarVisibility();
    }
    if (changes.sessionsTrash) {
      renderTrashPane();               // defined in Phase 6
      updateSidebarVisibility();
    }
    if (changes.deferred) {
      renderDeferredPane();
      updateSidebarVisibility();
    }
  });
}
```

At page init (same place you called `initSidebarState()`), add `installStorageSync();` after it.

- [ ] **Step 2: Stub the pane renderers that don't exist yet**

Until Phases 3 and 6 land, add no-op stubs so the listener does not throw:

```js
function renderSessionsPane() { /* populated in Phase 3 */ }
function renderTrashPane() { /* populated in Phase 6 */ }
```

Remove these stubs when the real implementations are added.

- [ ] **Step 3: Verify**

Open two new tabs (two Tab Out pages). In the first one's DevTools console, save a deferred tab:

```js
await chrome.storage.local.set({ deferred: [{ id: 't1', url: 'https://example.com', title: 'Example', savedAt: new Date().toISOString() }] });
```

Expected: the **other** tab's Deferred pane updates within ~1 s without a manual reload.

- [ ] **Step 4: Commit**

```bash
git add extension/app.js
git commit -m "refactor: add chrome.storage.onChanged listener for multi-page sync"
```

---

### Task 0.9: `_favicon` endpoint + `faviconEl` helper

**Files:**
- Modify: `extension/manifest.json` (add `optional_permissions`)
- Modify: `extension/app.js` (add helper section)

- [ ] **Step 1: Add `optional_permissions` to manifest**

In `extension/manifest.json`, add:

```json
{
  "manifest_version": 3,
  "name": "Tab Out",
  "version": "1.0.0",
  "description": "...",
  "permissions": ["tabs", "activeTab", "storage"],
  "optional_permissions": ["favicon", "tabGroups"],
  "chrome_url_overrides": { "newtab": "index.html" },
  ...
}
```

- [ ] **Step 2: Add permission-check + favicon helper**

Insert in `app.js`:

```js
/* ----------------------------------------------------------------
   PERMISSIONS
   ---------------------------------------------------------------- */

let _faviconPermissionChecked = false;
let _faviconPermissionGranted = false;

async function ensureFaviconPermission({ prompt = false } = {}) {
  if (_faviconPermissionChecked) return _faviconPermissionGranted;
  _faviconPermissionGranted = await chrome.permissions.contains({ permissions: ['favicon'] });
  if (!_faviconPermissionGranted && prompt) {
    _faviconPermissionGranted = await chrome.permissions.request({ permissions: ['favicon'] });
  }
  _faviconPermissionChecked = true;
  return _faviconPermissionGranted;
}

async function ensureTabGroupsPermission({ prompt = false } = {}) {
  const granted = await chrome.permissions.contains({ permissions: ['tabGroups'] });
  if (granted) return true;
  if (!prompt) return false;
  return await chrome.permissions.request({ permissions: ['tabGroups'] });
}

/* ----------------------------------------------------------------
   FAVICON RENDERING
   Returns an <img> that uses Chrome's _favicon endpoint when granted,
   or a letter-chip fallback element.
   ---------------------------------------------------------------- */

function faviconEl(url, size = 16) {
  let hostname = '';
  try { hostname = new URL(url).hostname; } catch {}

  if (_faviconPermissionGranted && hostname) {
    const faviconHref = chrome.runtime.getURL('_favicon/')
      + '?pageUrl=' + encodeURIComponent(url)
      + '&size=' + size;
    const img = el('img', {
      src: faviconHref,
      alt: '',
      width: size,
      height: size,
      class: 'favicon',
      style: { verticalAlign: '-2px' }
    });
    img.addEventListener('error', () => {
      const chip = letterChipEl(hostname, size);
      img.replaceWith(chip);
    });
    return img;
  }

  return letterChipEl(hostname, size);
}

function letterChipEl(hostname, size = 16) {
  const letter = (hostname || '?').replace(/^www\./, '').charAt(0).toUpperCase();
  return el('span', {
    class: 'favicon-letter',
    style: {
      display: 'inline-block',
      width: size + 'px',
      height: size + 'px',
      lineHeight: size + 'px',
      textAlign: 'center',
      background: 'var(--border)',
      color: 'var(--muted)',
      borderRadius: '50%',
      fontSize: Math.floor(size * 0.65) + 'px',
      fontWeight: '500',
      verticalAlign: '-2px'
    }
  }, letter);
}
```

Call `ensureFaviconPermission()` (no prompt) at page init so `_faviconPermissionGranted` is populated before any rendering.

- [ ] **Step 3: Migrate Deferred pane to `faviconEl`**

In `renderDeferredItem` (already rewritten in Task 0.3), replace the placeholder comment `faviconEl(item.url, 14)` — it's already in place from Task 0.3; this task just makes the helper resolve correctly.

Also replace the `google.com/s2/favicons` URL construction — grep for `google.com/s2/favicons` in `app.js`. There are two other call sites (main-grid chips, archive-list-item). Replace all with `faviconEl(url, 14)`.

- [ ] **Step 4: Verify**

Reload. Sidebar and main grid should render with letter-chip favicons initially (permission not yet granted).

Grant favicon permission via DevTools console:

```js
await chrome.permissions.request({ permissions: ['favicon'] });
```

Reload the page. Now real favicons should render, loaded from `chrome-extension://…/_favicon/...` — confirm in DevTools Network. No `google.com/s2/favicons` requests.

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json extension/app.js
git commit -m "refactor: favicons via Chrome _favicon endpoint (optional permission)"
```

---

### Task 0.10: Remove inline `onerror` from `index.html`

**Files:**
- Modify: `extension/index.html` (line ~130, the `config.local.js` script tag)
- Modify: `extension/app.js` (add a JS-only fallback)

- [ ] **Step 1: Remove the inline handler**

Find in `extension/index.html`:

```html
<script src="config.local.js" onerror="/* no personal config, that's fine */"></script>
```

Replace with:

```html
<script src="config.local.js" data-optional="true"></script>
```

- [ ] **Step 2: Attach an error listener in JS**

At the top of `app.js` (very early, before other init):

```js
document.querySelectorAll('script[data-optional="true"]').forEach(s => {
  s.addEventListener('error', () => {
    // Optional config file absent — that's fine.
  });
});
```

Note: `<script>` tags are loaded at parse time, so this listener is installed after the error has already fired for `config.local.js`. The listener's purpose is to suppress uncaught errors during Chrome's MV3 CSP enforcement and document intent; the actual "optional" behavior relies on `app.js` checking `typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined'`, which already exists.

- [ ] **Step 3: Verify**

Reload. Console should not log a CSP violation. The extension should behave identically (the optional config still loads if present).

- [ ] **Step 4: Commit**

```bash
git add extension/index.html extension/app.js
git commit -m "refactor: remove inline onerror attribute (MV3 CSP compliance)"
```

---

## Phase 1 — Sessions data layer

### Task 1.1: Session schema + read helpers with validation and quarantine

**Files:**
- Modify: `extension/app.js` (add new section after existing storage helpers, around line 290)

- [ ] **Step 1: Add ULID helper**

Chrome MV3 has `crypto.randomUUID()` but no built-in ULID. A tiny implementation works fine:

```js
/* ----------------------------------------------------------------
   ULID — 26-char, lexicographically sortable by creation time
   ---------------------------------------------------------------- */

const _ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';  // Crockford's base32
function ulid(nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  let timePart = '';
  let t = now;
  for (let i = 9; i >= 0; i--) {
    timePart = _ULID_ALPHABET[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(16));
  let randPart = '';
  for (let i = 0; i < 16; i++) randPart += _ULID_ALPHABET[rand[i] % 32];
  return timePart + randPart;
}
```

- [ ] **Step 2: Add schema validator**

```js
/* ----------------------------------------------------------------
   SESSIONS — schema + validation
   ---------------------------------------------------------------- */

const SESSION_SCHEMA_VERSION = 1;
const TRASH_SCHEMA_VERSION = 1;

const VALID_GROUP_COLORS = new Set(['grey','blue','red','yellow','green','pink','purple','cyan','orange']);

function validateSession(s) {
  if (!s || typeof s !== 'object') return false;
  if (typeof s.id !== 'string' || !s.id) return false;
  if (typeof s.rev !== 'number') return false;
  if (s.kind !== 'named' && s.kind !== 'snapshot') return false;
  if (typeof s.name !== 'string') return false;
  if (typeof s.savedAt !== 'string' || !s.savedAt) return false;
  if (typeof s.updatedAt !== 'string' || !s.updatedAt) return false;
  if (!Array.isArray(s.tabs)) return false;

  for (const t of s.tabs) {
    if (!t || typeof t !== 'object') return false;
    if (typeof t.url !== 'string') return false;
    if (!/^https?:\/\//i.test(t.url)) return false;  // scheme allowlist
    if (typeof t.title !== 'string') return false;
    if (typeof t.pinned !== 'boolean') return false;
    if (typeof t.index !== 'number') return false;
    if (t.savedGroupKey != null && typeof t.savedGroupKey !== 'string') return false;
  }

  if (s.groups && typeof s.groups === 'object') {
    for (const key in s.groups) {
      const g = s.groups[key];
      if (!g || typeof g !== 'object') return false;
      if (typeof g.title !== 'string') return false;
      if (!VALID_GROUP_COLORS.has(g.color)) return false;
    }
  }
  return true;
}
```

- [ ] **Step 3: Add `readSessions` with quarantine**

```js
async function readSessions() {
  const { sessions } = await chrome.storage.local.get('sessions');
  if (!sessions || typeof sessions !== 'object') {
    return { schemaVersion: SESSION_SCHEMA_VERSION, items: [], writeToken: null };
  }
  if (sessions.schemaVersion !== SESSION_SCHEMA_VERSION) {
    console.warn('[tab-out] sessions schemaVersion mismatch — v1 is current; future migrations go here');
  }

  const items = Array.isArray(sessions.items) ? sessions.items : [];
  const valid = [];
  const invalid = [];
  for (const item of items) {
    if (validateSession(item)) valid.push(item);
    else invalid.push(item);
  }

  if (invalid.length > 0) {
    await quarantineSessions(invalid);
    showToast({ message: `Skipped ${invalid.length} invalid session${invalid.length > 1 ? 's' : ''} — check Trash → Quarantine.` });
  }

  return { schemaVersion: SESSION_SCHEMA_VERSION, items: valid, writeToken: sessions.writeToken || null };
}

async function quarantineSessions(invalid) {
  const { sessionsQuarantine = { items: [] } } = await chrome.storage.local.get('sessionsQuarantine');
  const existing = Array.isArray(sessionsQuarantine.items) ? sessionsQuarantine.items : [];
  existing.push(...invalid.map(raw => ({ quarantinedAt: new Date().toISOString(), raw })));
  await chrome.storage.local.set({ sessionsQuarantine: { items: existing } });
}
```

- [ ] **Step 4: Add `writeSessions` with optimistic-concurrency check**

```js
async function setSessionsIfUnchanged(expectedWriteToken, newItems) {
  const { sessions } = await chrome.storage.local.get('sessions');
  const currentToken = sessions ? sessions.writeToken : null;
  if (currentToken !== expectedWriteToken) return false;
  const writeToken = newWriteToken();
  await chrome.storage.local.set({
    sessions: { schemaVersion: SESSION_SCHEMA_VERSION, items: newItems, writeToken }
  });
  return true;
}

// Update an existing session atomically; retries up to 3 times on conflict.
async function updateSession(id, mutator) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { items, writeToken } = await readSessions();
    const idx = items.findIndex(s => s.id === id);
    if (idx === -1) throw new Error('session-gone');
    const next = mutator(structuredClone(items[idx]));
    next.rev = (items[idx].rev || 0) + 1;
    next.updatedAt = new Date().toISOString();
    const newItems = items.slice();
    newItems[idx] = next;
    const ok = await setSessionsIfUnchanged(writeToken, newItems);
    if (ok) return next;
  }
  showToast({ message: 'Another Tab Out tab changed this session — reload to see the latest.' });
  throw new Error('write-conflict');
}

// Insert a new session; no conflict retry (insert is unambiguous).
async function appendSession(session) {
  const { items, writeToken } = await readSessions();
  const newItems = [session, ...items];
  const ok = await setSessionsIfUnchanged(writeToken, newItems);
  if (!ok) {
    // Retry once.
    const { items: items2, writeToken: wt2 } = await readSessions();
    const ok2 = await setSessionsIfUnchanged(wt2, [session, ...items2]);
    if (!ok2) throw new Error('write-conflict');
  }
}

async function removeSession(id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { items, writeToken } = await readSessions();
    const newItems = items.filter(s => s.id !== id);
    if (newItems.length === items.length) return;
    const ok = await setSessionsIfUnchanged(writeToken, newItems);
    if (ok) return;
  }
  throw new Error('write-conflict');
}
```

- [ ] **Step 5: Verify in DevTools console**

```js
await readSessions();
// → { schemaVersion: 1, items: [], writeToken: null }

await appendSession({
  id: ulid(),
  rev: 0,
  name: 'Test',
  kind: 'named',
  savedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  summary: { tabCount: 1, uniqueDomains: 1, topDomains: [{hostname:'example.com', count:1}] },
  tabs: [{ url: 'https://example.com', title: 'Example', favIconUrl: '', pinned: false, index: 0, savedGroupKey: null }],
  groups: {}
});
const out = await readSessions();
console.log(out);
// Expected: items has one valid session

// Try to corrupt:
await chrome.storage.local.set({ sessions: { schemaVersion: 1, items: [{ garbage: true }], writeToken: null } });
const out2 = await readSessions();
// Expected: items is [], toast fires about 1 invalid session, sessionsQuarantine contains the garbage
```

- [ ] **Step 6: Commit**

```bash
git add extension/app.js
git commit -m "feat: sessions storage layer with schema validation and quarantine"
```

---

### Task 1.2: Session CRUD — create, rename, duplicate, delete, saveAsNamed

**Files:**
- Modify: `extension/app.js` (new section)

- [ ] **Step 1: Add `createNamedSession` / `createSnapshotSession`**

```js
const SNAPSHOT_ID = '__snap__';

async function createNamedSession({ name, tabs, groups, summary }) {
  const now = new Date().toISOString();
  const session = {
    id: ulid(),
    rev: 0,
    name,
    kind: 'named',
    savedAt: now,
    updatedAt: now,
    summary,
    tabs,
    groups: groups || {}
  };
  await appendSession(session);
  return session;
}

async function writeSnapshotSession({ tabs, groups, summary }) {
  // Move existing snapshot to trash, then overwrite.
  const { items, writeToken } = await readSessions();
  const existing = items.find(s => s.id === SNAPSHOT_ID);
  if (existing) {
    await trashAdd({ reason: 'snapshot-overwritten', session: existing });
  }
  const now = new Date().toISOString();
  const snapshot = {
    id: SNAPSHOT_ID,
    rev: existing ? (existing.rev + 1) : 0,
    name: 'Snapshot',
    kind: 'snapshot',
    savedAt: now,
    updatedAt: now,
    summary,
    tabs,
    groups: groups || {}
  };
  const filtered = items.filter(s => s.id !== SNAPSHOT_ID);
  const newItems = [snapshot, ...filtered];
  const ok = await setSessionsIfUnchanged(writeToken, newItems);
  if (!ok) {
    // Retry once
    const { items: items2, writeToken: wt2 } = await readSessions();
    const filtered2 = items2.filter(s => s.id !== SNAPSHOT_ID);
    const ok2 = await setSessionsIfUnchanged(wt2, [snapshot, ...filtered2]);
    if (!ok2) throw new Error('write-conflict');
  }
  return { snapshot, previous: existing };
}
```

- [ ] **Step 2: Add `renameSession`, `duplicateSession`, `deleteSession`**

```js
function normalizeName(s) { return (s || '').trim().toLowerCase(); }

async function isNameAvailable(name, ignoreId) {
  const { items } = await readSessions();
  const target = normalizeName(name);
  return !items.some(s => s.kind === 'named' && s.id !== ignoreId && normalizeName(s.name) === target);
}

async function renameSession(id, newName) {
  const trimmed = (newName || '').trim();
  if (!trimmed) throw new Error('empty-name');
  if (!(await isNameAvailable(trimmed, id))) throw new Error('name-collision');
  const { items } = await readSessions();
  const existing = items.find(s => s.id === id);
  if (!existing) throw new Error('gone');
  if (existing.name === trimmed) return existing;  // self-rename no-op; do NOT bump updatedAt
  return updateSession(id, s => {
    s.name = trimmed;
    return s;
  });
}

async function duplicateSession(id) {
  const { items } = await readSessions();
  const src = items.find(s => s.id === id);
  if (!src) throw new Error('gone');

  // Generate a unique name: "X (copy)", "X (copy 2)", ...
  const base = src.name.replace(/ \(copy(?: \d+)?\)$/, '');
  let candidate = `${base} (copy)`;
  let n = 2;
  while (!(await isNameAvailable(candidate))) {
    candidate = `${base} (copy ${n++})`;
  }

  const copy = structuredClone(src);
  copy.id = ulid();
  copy.rev = 0;
  copy.name = candidate;
  copy.kind = 'named';
  const now = new Date().toISOString();
  copy.savedAt = now;
  copy.updatedAt = now;

  await appendSession(copy);
  return copy;
}

async function deleteSession(id) {
  const { items } = await readSessions();
  const target = items.find(s => s.id === id);
  if (!target) return;
  await trashAdd({ reason: 'deleted', session: target });
  await removeSession(id);
  return target;
}
```

- [ ] **Step 3: Add `saveAsNamedSession` (the renamed "Promote")**

```js
async function saveAsNamedSession({ fromSnapshotOrId, name }) {
  const { items } = await readSessions();
  const src = typeof fromSnapshotOrId === 'string'
    ? items.find(s => s.id === fromSnapshotOrId)
    : fromSnapshotOrId;
  if (!src) throw new Error('gone');
  if (!(await isNameAvailable(name))) throw new Error('name-collision');
  const now = new Date().toISOString();
  const created = {
    id: ulid(),
    rev: 0,
    name: name.trim(),
    kind: 'named',
    savedAt: now,
    updatedAt: now,
    summary: structuredClone(src.summary),
    tabs: structuredClone(src.tabs),
    groups: structuredClone(src.groups || {})
  };
  await appendSession(created);
  return created;
}
```

- [ ] **Step 4: Verify in DevTools console**

```js
// Setup
const s1 = await createNamedSession({
  name: 'Test',
  tabs: [{url:'https://example.com',title:'Ex',favIconUrl:'',pinned:false,index:0,savedGroupKey:null}],
  groups: {},
  summary: {tabCount:1,uniqueDomains:1,topDomains:[{hostname:'example.com',count:1}]}
});

// Collision
try { await createNamedSession({ name: 'Test', tabs: s1.tabs, groups: {}, summary: s1.summary }); }
catch (e) { console.log('expected error:', e); }
// Direct createNamedSession does NOT collision-check; collision check is in the UI layer.
// But rename should collision-check:
await renameSession(s1.id, 'Test');   // self-rename no-op — ok
await renameSession(s1.id, 'Other');  // ok
try { await renameSession(s1.id, 'Other'); } catch {}  // self-rename ok
await createNamedSession({ name: 'Third', tabs: s1.tabs, groups: {}, summary: s1.summary });
try { await renameSession(s1.id, 'Third'); } catch(e) { console.log('expected collision:', e.message); }

// Duplicate
const dup = await duplicateSession(s1.id);
console.log('dup name should end with (copy):', dup.name);

// Delete
await deleteSession(s1.id);
const after = await readSessions();
console.log('items after delete:', after.items.length);
```

- [ ] **Step 5: Commit**

```bash
git add extension/app.js
git commit -m "feat: session CRUD helpers (create, rename, duplicate, delete, saveAsNamed)"
```

---

### Task 1.3: Tab removal + trash helpers

**Files:**
- Modify: `extension/app.js` (new trash section)

- [ ] **Step 1: Add trash read/write helpers**

```js
/* ----------------------------------------------------------------
   TRASH — 7-day retention, 50-item cap, lazy-purge on read
   ---------------------------------------------------------------- */

const TRASH_MAX_ITEMS = 50;
const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function readTrash() {
  const { sessionsTrash } = await chrome.storage.local.get('sessionsTrash');
  if (!sessionsTrash || typeof sessionsTrash !== 'object') {
    return { schemaVersion: TRASH_SCHEMA_VERSION, items: [] };
  }
  const raw = Array.isArray(sessionsTrash.items) ? sessionsTrash.items : [];
  const now = Date.now();
  const kept = raw.filter(item => {
    const age = now - new Date(item.trashedAt).getTime();
    return Number.isFinite(age) && age >= 0 && age < TRASH_RETENTION_MS;
  });
  if (kept.length !== raw.length) {
    await chrome.storage.local.set({ sessionsTrash: { schemaVersion: TRASH_SCHEMA_VERSION, items: kept } });
  }
  return { schemaVersion: TRASH_SCHEMA_VERSION, items: kept };
}

async function writeTrash(items) {
  await chrome.storage.local.set({ sessionsTrash: { schemaVersion: TRASH_SCHEMA_VERSION, items } });
}

async function trashAdd({ reason, session, removedTab }) {
  const { items } = await readTrash();
  const record = {
    trashId: 'tr_' + ulid(),
    trashedAt: new Date().toISOString(),
    reason,
    session: session ? structuredClone(session) : undefined,
    removedTab: removedTab ? structuredClone(removedTab) : undefined
  };
  let newItems = [record, ...items];
  if (newItems.length > TRASH_MAX_ITEMS) newItems = newItems.slice(0, TRASH_MAX_ITEMS);
  await writeTrash(newItems);
  return record;
}

async function trashDrop(trashId) {
  const { items } = await readTrash();
  await writeTrash(items.filter(r => r.trashId !== trashId));
}

async function trashRestore(trashId) {
  const { items } = await readTrash();
  const record = items.find(r => r.trashId === trashId);
  if (!record) return null;

  if (record.reason === 'deleted' && record.session) {
    // Restore session; if name collides, suffix " (restored)".
    const { items: sessionItems } = await readSessions();
    const taken = new Set(sessionItems.filter(s => s.kind === 'named').map(s => normalizeName(s.name)));
    let name = record.session.name;
    if (taken.has(normalizeName(name))) {
      let n = 1;
      let candidate = `${name} (restored)`;
      while (taken.has(normalizeName(candidate))) {
        candidate = `${name} (restored ${++n})`;
      }
      name = candidate;
    }
    const restored = structuredClone(record.session);
    restored.id = ulid();
    restored.rev = 0;
    restored.name = name;
    restored.updatedAt = new Date().toISOString();
    await appendSession(restored);
  } else if (record.reason === 'snapshot-overwritten' && record.session) {
    // Put the old snapshot back; current snapshot goes to trash.
    await writeSnapshotSession({
      tabs: record.session.tabs,
      groups: record.session.groups,
      summary: record.session.summary
    });
  } else if (record.reason === 'tab-removed' && record.removedTab) {
    // Find the parent session; append or insert at original index.
    const parentId = record.parentSessionId;
    const { items: sessionItems } = await readSessions();
    const parent = sessionItems.find(s => s.id === parentId);
    if (!parent) {
      // Parent is gone; create a new named session for the lone tab.
      const tabs = [record.removedTab];
      await createNamedSession({
        name: `Recovered tab · ${timeAgo(record.trashedAt)}`,
        tabs,
        groups: {},
        summary: computeSummary(tabs)
      });
    } else {
      await updateSession(parentId, s => {
        const t = structuredClone(record.removedTab);
        const insertAt = Math.min(Math.max(0, t.index), s.tabs.length);
        s.tabs.splice(insertAt, 0, t);
        s.summary = computeSummary(s.tabs);
        return s;
      });
    }
  }

  await trashDrop(trashId);
  return record;
}
```

- [ ] **Step 2: Add `computeSummary` helper**

```js
function computeSummary(tabs) {
  const counts = new Map();
  for (const t of tabs) {
    let host = '';
    try { host = new URL(t.url).hostname.replace(/^www\./, ''); } catch {}
    counts.set(host, (counts.get(host) || 0) + 1);
  }
  const hosts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([hostname, count]) => ({ hostname, count }));
  return {
    tabCount: tabs.length,
    uniqueDomains: counts.size,
    topDomains: hosts
  };
}
```

- [ ] **Step 3: Add `removeTabFromSession`**

```js
async function removeTabFromSession(sessionId, tabIndex) {
  const { items } = await readSessions();
  const src = items.find(s => s.id === sessionId);
  if (!src || !src.tabs[tabIndex]) throw new Error('gone');
  const removedTab = src.tabs[tabIndex];
  const record = await trashAdd({
    reason: 'tab-removed',
    removedTab: { ...removedTab, index: tabIndex }
  });
  // Attach parent id (trashAdd doesn't know about it).
  const trash = await readTrash();
  const updated = trash.items.map(r => r.trashId === record.trashId ? { ...r, parentSessionId: sessionId } : r);
  await writeTrash(updated);

  await updateSession(sessionId, s => {
    s.tabs.splice(tabIndex, 1);
    s.summary = computeSummary(s.tabs);
    return s;
  });
  return record;
}
```

- [ ] **Step 4: Verify**

```js
const s = await createNamedSession({
  name: 'TrashTest',
  tabs: [
    {url:'https://a.com',title:'A',favIconUrl:'',pinned:false,index:0,savedGroupKey:null},
    {url:'https://b.com',title:'B',favIconUrl:'',pinned:false,index:1,savedGroupKey:null}
  ],
  groups: {},
  summary: {tabCount:2,uniqueDomains:2,topDomains:[{hostname:'a.com',count:1},{hostname:'b.com',count:1}]}
});

const r = await removeTabFromSession(s.id, 0);
console.log('trash now:', (await readTrash()).items.length);

await trashRestore(r.trashId);
const after = await readSessions();
console.log('tabs restored:', after.items.find(x => x.id === s.id).tabs.length);
```

- [ ] **Step 5: Commit**

```bash
git add extension/app.js
git commit -m "feat: trash + removeTabFromSession with restore semantics"
```

---

## Phase 2 — Save flow

### Task 2.1: URL scheme allowlist + tab capture

**Files:**
- Modify: `extension/app.js`

- [ ] **Step 1: Add capture helper**

```js
/* ----------------------------------------------------------------
   SAVE FLOW — capture current window
   ---------------------------------------------------------------- */

const ALLOWED_SCHEMES = /^https?:\/\//i;

async function captureCurrentWindow() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const newtabUrl = chrome.runtime.getURL('index.html');

  let skipped = 0;
  const kept = [];
  for (const t of tabs) {
    if (!t.url) { skipped++; continue; }
    if (t.url === newtabUrl || t.url.startsWith('chrome://newtab')) { skipped++; continue; }
    if (!ALLOWED_SCHEMES.test(t.url)) { skipped++; continue; }
    kept.push(t);
  }

  // Map groupIds → synthetic keys in first-seen order.
  const groupKeyByChromeId = new Map();
  let nextKeyIdx = 0;
  for (const t of kept) {
    if (t.groupId != null && t.groupId >= 0 && !groupKeyByChromeId.has(t.groupId)) {
      groupKeyByChromeId.set(t.groupId, 'grp_' + (nextKeyIdx++));
    }
  }

  // Attempt tabGroups read (if permission granted and any groups present).
  let groupsMeta = {};
  if (groupKeyByChromeId.size > 0) {
    const granted = await ensureTabGroupsPermission({ prompt: true });
    if (granted) {
      for (const [chromeGroupId, savedKey] of groupKeyByChromeId) {
        try {
          const g = await chrome.tabGroups.get(chromeGroupId);
          const color = VALID_GROUP_COLORS.has(g.color) ? g.color : 'grey';
          groupsMeta[savedKey] = { title: g.title || '', color };
        } catch (e) {
          console.warn('[tab-out] tabGroups.get failed', e);
        }
      }
    } else {
      // Permission declined — drop group info silently, show one-time tooltip toast.
      const { _tabOutGroupNotice } = await chrome.storage.local.get('_tabOutGroupNotice');
      if (!_tabOutGroupNotice) {
        showToast({ message: "Groups won't be saved without permission — grant it from the kebab menu anytime." });
        await chrome.storage.local.set({ _tabOutGroupNotice: true });
      }
      groupKeyByChromeId.clear();
    }
  }

  const tabRecords = kept.map(t => ({
    url: t.url,
    title: (t.title && t.title.trim()) || (() => { try { return new URL(t.url).hostname; } catch { return 'Untitled'; } })(),
    favIconUrl: '',        // never stored; rendered via _favicon endpoint
    pinned: !!t.pinned,
    index: t.index,
    savedGroupKey: groupKeyByChromeId.get(t.groupId) || null
  }));

  return {
    tabs: tabRecords,
    groups: groupsMeta,
    summary: computeSummary(tabRecords),
    skipped
  };
}
```

- [ ] **Step 2: Verify**

In DevTools console on a new tab:

```js
const cap = await captureCurrentWindow();
console.log(cap);
// Expected: tabs array excludes the Tab Out page itself and any chrome:// tabs,
// skipped count reflects them.
```

- [ ] **Step 3: Commit**

```bash
git add extension/app.js
git commit -m "feat: captureCurrentWindow with scheme allowlist and group metadata"
```

---

### Task 2.2: Header "+ Save window" chip

**Files:**
- Modify: `extension/index.html` (header block)
- Modify: `extension/style.css` (header chip styling)
- Modify: `extension/app.js` (click handler)

- [ ] **Step 1: Add chip markup**

In `extension/index.html`, inside `<header>`, add a right-side container after `.header-left`:

```html
<div class="header-right">
  <button class="header-chip" id="saveWindowBtn" data-action="open-save-overlay">
    <span class="header-chip-plus">+</span>
    <span>Save window</span>
  </button>
</div>
```

- [ ] **Step 2: Add styles**

In `style.css`:

```css
header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
}
.header-right {
  display: flex;
  gap: 8px;
  align-items: center;
}
.header-chip {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg);
  font: inherit;
  font-weight: 500;
  font-size: 13px;
  padding: 6px 12px;
  border-radius: 999px;
  cursor: pointer;
  display: inline-flex;
  gap: 4px;
  align-items: center;
}
.header-chip:hover { background: var(--hover); }
.header-chip-plus { font-weight: 700; opacity: 0.8; }
```

- [ ] **Step 3: Wire the click handler**

In the delegated click handler section (search for `data-action`), add:

```js
if (action === 'open-save-overlay') {
  e.preventDefault();
  await openSaveOverlay({ capture: await captureCurrentWindow() });
  return;
}
```

Stub `openSaveOverlay` for now:

```js
async function openSaveOverlay({ capture, prefilledName }) {
  // Populated in Task 2.3
  console.log('[tab-out] openSaveOverlay TODO', { capture, prefilledName });
}
```

- [ ] **Step 4: Verify**

Reload. "+Save window" chip is visible in the header. Click it → no overlay yet, but console logs the capture.

- [ ] **Step 5: Commit**

```bash
git add extension/app.js extension/index.html extension/style.css
git commit -m "feat: header Save window chip (UI scaffold)"
```

---

### Task 2.3: Save overlay (name input + Quick save)

**Files:**
- Modify: `extension/index.html` (overlay markup)
- Modify: `extension/style.css` (overlay styling)
- Modify: `extension/app.js` (overlay logic)

- [ ] **Step 1: Add overlay markup**

Append inside `.container`, right before `</div><!-- end .container -->`:

```html
<div class="save-overlay" id="saveOverlay" style="display:none">
  <div class="save-overlay-inner">
    <div class="save-overlay-title">Save current window as a session</div>
    <div class="save-overlay-summary" id="saveOverlaySummary"></div>
    <input type="text" class="save-overlay-input" id="saveOverlayInput" placeholder="Session name" maxlength="120">
    <div class="save-overlay-error" id="saveOverlayError" style="display:none"></div>
    <div class="save-overlay-actions">
      <button class="save-overlay-cancel" data-action="cancel-save-overlay">Cancel</button>
      <button class="save-overlay-quicksave" data-action="quick-save-from-overlay">Quick save (overwrite snapshot)</button>
      <button class="save-overlay-save" id="saveOverlaySave" data-action="confirm-save-overlay">Save</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add overlay styles**

```css
.save-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 80px;
  z-index: 100;
}
.save-overlay-inner {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 24px;
  min-width: 400px;
  max-width: 90vw;
  box-shadow: 0 8px 40px rgba(0,0,0,0.3);
}
.save-overlay-title {
  font-family: 'Newsreader', serif;
  font-size: 20px;
  margin-bottom: 8px;
}
.save-overlay-summary {
  color: var(--muted);
  font-size: 13px;
  margin-bottom: 16px;
}
.save-overlay-input {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font: inherit;
  font-size: 14px;
}
.save-overlay-error {
  color: var(--red, #d9534f);
  font-size: 12px;
  margin-top: 6px;
}
.save-overlay-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
  justify-content: flex-end;
}
.save-overlay-save, .save-overlay-cancel, .save-overlay-quicksave {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg);
  font: inherit;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
}
.save-overlay-save { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.save-overlay-save:disabled { opacity: 0.5; cursor: not-allowed; }
.save-overlay-quicksave { margin-right: auto; }  /* left-align separately */
```

- [ ] **Step 3: Implement overlay logic**

Replace the `openSaveOverlay` stub with:

```js
let _activeSaveOverlay = null;

function formatDefaultSessionName(now = new Date()) {
  const base = 'Session · ' + now.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
  return base;
}

async function uniqueDefaultName(base) {
  let candidate = base;
  let n = 2;
  while (!(await isNameAvailable(candidate))) {
    candidate = `${base} (${n++})`;
  }
  return candidate;
}

async function openSaveOverlay({ capture, prefilledName }) {
  _activeSaveOverlay = { capture };

  const overlay = document.getElementById('saveOverlay');
  const input = document.getElementById('saveOverlayInput');
  const errorEl = document.getElementById('saveOverlayError');
  const saveBtn = document.getElementById('saveOverlaySave');
  const summaryEl = document.getElementById('saveOverlaySummary');

  const name = prefilledName || await uniqueDefaultName(formatDefaultSessionName());
  input.value = name;

  summaryEl.textContent = capture.skipped > 0
    ? `${capture.tabs.length} tabs will be saved · ${capture.skipped} skipped (unsupported URL schemes)`
    : `${capture.tabs.length} tabs will be saved`;

  errorEl.style.display = 'none';
  saveBtn.disabled = false;
  overlay.style.display = 'flex';
  input.focus();
  input.select();

  // Live validation on input
  const onInput = async () => {
    const trimmed = input.value.trim();
    if (!trimmed) {
      errorEl.style.display = 'none';
      saveBtn.disabled = false;  // will fall back to default name on save
      return;
    }
    const available = await isNameAvailable(trimmed);
    if (!available) {
      errorEl.textContent = `A session named "${trimmed}" already exists.`;
      errorEl.style.display = 'block';
      saveBtn.disabled = true;
    } else {
      errorEl.style.display = 'none';
      saveBtn.disabled = false;
    }
  };
  input.oninput = onInput;

  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (!saveBtn.disabled) saveBtn.click(); }
    if (e.key === 'Escape') { e.preventDefault(); closeSaveOverlay(); }
  };
}

function closeSaveOverlay() {
  _activeSaveOverlay = null;
  document.getElementById('saveOverlay').style.display = 'none';
}
```

- [ ] **Step 4: Wire the action handlers**

In the delegated click listener:

```js
if (action === 'cancel-save-overlay') {
  e.preventDefault();
  closeSaveOverlay();
  return;
}
if (action === 'confirm-save-overlay') {
  e.preventDefault();
  await confirmSaveOverlay();
  return;
}
if (action === 'quick-save-from-overlay') {
  e.preventDefault();
  await quickSaveFromOverlay();
  return;
}
```

And the implementations:

```js
async function confirmSaveOverlay() {
  if (!_activeSaveOverlay) return;
  const { capture } = _activeSaveOverlay;
  const input = document.getElementById('saveOverlayInput');
  let name = input.value.trim();
  if (!name) name = await uniqueDefaultName(formatDefaultSessionName());
  if (!(await isNameAvailable(name))) {
    showToast({ message: 'Name already taken — pick another.' });
    return;
  }
  try {
    await createNamedSession({ name, tabs: capture.tabs, groups: capture.groups, summary: capture.summary });
    closeSaveOverlay();
    const msg = capture.skipped > 0
      ? `Saved · ${capture.tabs.length} tabs (${capture.skipped} skipped)`
      : `Saved · ${capture.tabs.length} tabs`;
    showToast({ message: msg });
    switchSidebarPane('sessions');
    renderSessionsPane();
  } catch (e) {
    if (String(e.message).includes('QuotaExceeded') || String(e.message).includes('quota')) {
      showToast({ message: 'Storage full — empty the Trash or delete old sessions.' });
    } else {
      showToast({ message: 'Couldn\'t save session — see console for details.' });
      console.error('[tab-out] save failed', e);
    }
  }
}

async function quickSaveFromOverlay() {
  if (!_activeSaveOverlay) return;
  const { capture } = _activeSaveOverlay;
  try {
    const { previous } = await writeSnapshotSession({ tabs: capture.tabs, groups: capture.groups, summary: capture.summary });
    closeSaveOverlay();
    const msg = capture.skipped > 0
      ? `Snapshot saved · ${capture.tabs.length} tabs (${capture.skipped} skipped)`
      : `Snapshot saved · ${capture.tabs.length} tabs`;
    showToast({
      message: msg,
      actionLabel: previous ? 'Undo' : undefined,
      onAction: previous ? async () => {
        // Restore previous snapshot
        const trash = await readTrash();
        const target = trash.items.find(r => r.reason === 'snapshot-overwritten' && r.session && r.session.savedAt === previous.savedAt);
        if (target) await trashRestore(target.trashId);
        renderSessionsPane();
      } : undefined
    });
    switchSidebarPane('sessions');
    renderSessionsPane();
  } catch (e) {
    showToast({ message: 'Couldn\'t save snapshot — see console.' });
    console.error('[tab-out] quick save failed', e);
  }
}
```

- [ ] **Step 5: Verify**

Reload. Click "+ Save window" → overlay appears with an auto-default name. Edit it → if collides, error shows + Save is disabled. Confirm → toast appears, Sessions pane switches into view (pane is empty-looking until Phase 3 populates it — that's fine for now). Inspect storage:

```js
await readSessions();  // should show one saved session
```

Click "+ Save window" again → Quick save → storage shows the snapshot slot too.

- [ ] **Step 6: Commit**

```bash
git add extension/app.js extension/index.html extension/style.css
git commit -m "feat: save overlay with named save and quick-snapshot"
```

---

## Phase 3 — Sessions pane UI

### Task 3.1: Render sessions pane (cards, snapshot section, named section)

**Files:**
- Modify: `extension/app.js` (`renderSessionsPane`)
- Modify: `extension/style.css` (session card styling)

- [ ] **Step 1: Replace the stub**

```js
async function renderSessionsPane() {
  const pane = document.getElementById('sessionsPane');
  if (!pane) return;

  const { items } = await readSessions();
  _lastSessionsCount = items.length;

  const pillCount = document.getElementById('sessionsPillCount');
  if (pillCount) pillCount.textContent = items.length;

  // Render order: snapshot first, then named by (updatedAt desc, id desc)
  const snapshot = items.find(s => s.kind === 'snapshot');
  const named = items.filter(s => s.kind === 'named')
    .sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
      return b.id.localeCompare(a.id);
    });

  pane.replaceChildren();

  if (items.length === 0) {
    pane.appendChild(el('div', { class: 'sessions-empty' },
      'No sessions yet. Click "+ Save window" above to save your first one.'));
    return;
  }

  // Search input
  pane.appendChild(renderSessionsSearch());

  // Snapshot section
  if (snapshot) {
    pane.appendChild(el('div', { class: 'sessions-divider' }, 'Snapshot'));
    pane.appendChild(renderSessionCard(snapshot));
  }

  // Named section
  if (named.length > 0) {
    pane.appendChild(el('div', { class: 'sessions-divider' }, 'Named'));
    for (const s of named) pane.appendChild(renderSessionCard(s));
  }
}
```

- [ ] **Step 2: Add `renderSessionCard`**

```js
function renderSessionCard(session) {
  const isSnapshot = session.kind === 'snapshot';

  // Title line
  const title = el('span', { class: 'session-name' }, [
    isSnapshot ? textNode('📸 Snapshot') : textNode(session.name)
  ]);

  // Kebab
  const kebab = el('button', {
    class: 'session-kebab',
    'data-action': 'session-kebab',
    'data-session-id': session.id,
    title: 'More'
  }, '⋯');

  // Chevron
  const chevron = el('button', {
    class: 'session-chevron',
    'data-action': 'session-toggle-expand',
    'data-session-id': session.id,
    title: 'Expand'
  }, '▸');

  // Header row
  const header = el('div', { class: 'session-card-header' }, [title, kebab, chevron]);

  // Meta line
  const meta = el('div', { class: 'session-meta' }, [
    textNode(`${session.summary.tabCount} tabs · ${session.summary.uniqueDomains} site${session.summary.uniqueDomains === 1 ? '' : 's'} · `),
    textNode(timeAgo(session.updatedAt))
  ]);

  // Favicon row
  const faviconRow = el('div', { class: 'session-favicon-row' },
    (session.summary.topDomains || []).map(d => faviconEl('https://' + d.hostname, 16))
  );

  const card = el('div', {
    class: 'session-card' + (isSnapshot ? ' session-card-snapshot' : ''),
    'data-action': 'session-reopen',
    'data-session-id': session.id,
    'data-session-kind': session.kind
  }, [header, meta, faviconRow]);

  return card;
}
```

- [ ] **Step 3: Add `renderSessionsSearch` (stub until Phase 5)**

```js
function renderSessionsSearch() {
  return el('input', {
    type: 'text',
    class: 'sessions-search',
    id: 'sessionsSearchInput',
    placeholder: 'Search sessions…'
  });
}
```

- [ ] **Step 4: Add CSS**

```css
.sessions-empty {
  color: var(--muted);
  font-size: 13px;
  padding: 24px 4px;
  text-align: center;
}
.sessions-divider {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 16px 0 8px;
}
.sessions-search {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  font: inherit;
  font-size: 13px;
  margin-bottom: 8px;
}
.session-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: background 0.12s;
}
.session-card:hover { background: var(--hover); }
.session-card-snapshot { background: rgba(255,255,255,0.02); }
.session-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
}
.session-name {
  flex: 1;
  font-weight: 500;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-kebab, .session-chevron {
  background: transparent;
  border: none;
  color: var(--muted);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}
.session-kebab:hover, .session-chevron:hover { background: var(--hover); }
.session-meta {
  color: var(--muted);
  font-size: 12px;
  margin-top: 4px;
}
.session-favicon-row {
  display: flex;
  gap: -2px;
  margin-top: 8px;
}
.session-favicon-row > * { margin-right: -2px; }
```

- [ ] **Step 5: Call `renderSessionsPane` at page load**

Add to the init sequence (where `renderSidebar()` is called):

```js
await renderSessionsPane();
```

Also call it after the save overlay success paths (already in place via Task 2.3's `renderSessionsPane()` calls).

- [ ] **Step 6: Verify**

Reload. Save a named session. Switch to Sessions pane → see one card with name, meta, favicons. Save another → two cards. Quick save → snapshot card appears above named cards.

- [ ] **Step 7: Commit**

```bash
git add extension/app.js extension/style.css
git commit -m "feat: render sessions pane with snapshot and named cards"
```

---

### Task 3.2: Kebab menu (Reopen, Rename, Save as named, Duplicate, Delete)

**Files:**
- Modify: `extension/app.js`
- Modify: `extension/style.css`

- [ ] **Step 1: Add kebab menu rendering**

```js
let _openKebab = null;

async function openSessionKebab(sessionId, anchorEl) {
  closeSessionKebab();

  const session = await _getSessionById(sessionId);
  if (!session) return;

  const menu = el('div', { class: 'kebab-menu' }, [
    el('button', { 'data-action': 'session-reopen-menu', 'data-session-id': sessionId }, 'Reopen'),
    session.kind === 'named'
      ? el('button', { 'data-action': 'session-rename', 'data-session-id': sessionId }, 'Rename')
      : el('button', { 'data-action': 'session-save-as-named', 'data-session-id': sessionId }, 'Save as named session'),
    el('button', { 'data-action': 'session-duplicate', 'data-session-id': sessionId }, 'Duplicate'),
    el('button', { 'data-action': 'session-delete', 'data-session-id': sessionId, class: 'kebab-destructive' }, 'Delete')
  ]);

  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = rect.bottom + 4 + 'px';
  menu.style.left = Math.max(8, rect.right - 180) + 'px';
  _openKebab = menu;
}

function closeSessionKebab() {
  if (_openKebab) { _openKebab.remove(); _openKebab = null; }
}

// Close on outside click
document.addEventListener('click', (e) => {
  if (_openKebab && !_openKebab.contains(e.target) && !e.target.closest('.session-kebab')) {
    closeSessionKebab();
  }
});

async function _getSessionById(id) {
  const { items } = await readSessions();
  return items.find(s => s.id === id);
}
```

Note: `openSessionKebab` must be `async` because `_getSessionById` awaits storage. The kebab's click handler in the delegated listener also awaits (see Step 2 below).

- [ ] **Step 2: Wire all action handlers**

In the delegated click listener:

```js
if (action === 'session-kebab') {
  e.preventDefault();
  e.stopPropagation();
  const sid = target.dataset.sessionId;
  await openSessionKebab(sid, target);
  return;
}
if (action === 'session-toggle-expand') {
  e.preventDefault();
  e.stopPropagation();
  toggleSessionExpand(target.dataset.sessionId);
  return;
}
if (action === 'session-reopen' || action === 'session-reopen-menu') {
  e.preventDefault();
  e.stopPropagation();
  closeSessionKebab();
  await reopenSession(target.dataset.sessionId);
  return;
}
if (action === 'session-rename') {
  e.preventDefault(); closeSessionKebab();
  await promptRenameSession(target.dataset.sessionId);
  return;
}
if (action === 'session-save-as-named') {
  e.preventDefault(); closeSessionKebab();
  const { items } = await readSessions();
  const snap = items.find(s => s.id === target.dataset.sessionId);
  if (!snap) return;
  await openSaveOverlay({
    capture: { tabs: snap.tabs, groups: snap.groups, summary: snap.summary, skipped: 0 },
    prefilledName: await uniqueDefaultName('Snapshot · ' + new Date().toLocaleString(undefined, {month:'short',day:'numeric'}))
  });
  return;
}
if (action === 'session-duplicate') {
  e.preventDefault(); closeSessionKebab();
  try {
    await duplicateSession(target.dataset.sessionId);
    showToast({ message: 'Duplicated' });
    renderSessionsPane();
  } catch (e) {
    showToast({ message: 'Couldn\'t duplicate — see console.' });
    console.error('[tab-out] duplicate failed', e);
  }
  return;
}
if (action === 'session-delete') {
  e.preventDefault(); closeSessionKebab();
  const id = target.dataset.sessionId;
  try {
    const removed = await deleteSession(id);
    showToast({
      message: `Deleted`,
      actionLabel: 'Undo',
      onAction: async () => {
        const trash = await readTrash();
        const rec = trash.items.find(r => r.reason === 'deleted' && r.session && r.session.id === id);
        if (rec) await trashRestore(rec.trashId);
        renderSessionsPane();
        renderTrashPane();
      }
    });
    renderSessionsPane();
    renderTrashPane();
  } catch (e) {
    showToast({ message: 'Couldn\'t delete — see console.' });
    console.error('[tab-out] delete failed', e);
  }
  return;
}
```

- [ ] **Step 3: Implement `promptRenameSession`**

Inline rename replaces the card title with an input:

```js
async function promptRenameSession(id) {
  const card = document.querySelector(`.session-card[data-session-id="${id}"]`);
  if (!card) return;
  const nameEl = card.querySelector('.session-name');
  if (!nameEl) return;
  const currentName = nameEl.textContent;

  const input = el('input', {
    type: 'text',
    class: 'session-rename-input',
    value: currentName,
    maxlength: '120'
  });
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim();
    try {
      if (newName === '' || newName === currentName) {
        renderSessionsPane();
        return;
      }
      await renameSession(id, newName);
      showToast({ message: 'Renamed' });
      renderSessionsPane();
    } catch (e) {
      if (e.message === 'name-collision') {
        showToast({ message: `"${newName}" is already taken.` });
      } else {
        showToast({ message: 'Rename failed — see console.' });
        console.error('[tab-out] rename failed', e);
      }
      renderSessionsPane();
    }
  };

  input.onblur = commit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); renderSessionsPane(); }
  };
}
```

- [ ] **Step 4: CSS**

```css
.kebab-menu {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.2);
  min-width: 180px;
  z-index: 50;
}
.kebab-menu button {
  background: transparent;
  border: none;
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  text-align: left;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
  display: block;
  width: 100%;
}
.kebab-menu button:hover { background: var(--hover); }
.kebab-menu button.kebab-destructive { color: var(--red, #d9534f); }
.session-rename-input {
  background: var(--bg);
  border: 1px solid var(--fg);
  border-radius: 4px;
  padding: 2px 6px;
  font: inherit;
  font-size: 14px;
  width: 100%;
  flex: 1;
}
```

- [ ] **Step 5: Verify**

Reload. Save a session. Click its kebab → menu appears. Click each action: Rename (inline), Duplicate (new card "X (copy)"), Delete (goes to Trash — we'll verify the pane in Phase 6; for now check `await readTrash()` in console).

For snapshot card: kebab shows "Save as named session" instead of Rename.

Collision test: save "A", save "B", click B's kebab → Rename → type "A" → Enter → toast "already taken", rename cancels.

- [ ] **Step 6: Commit**

```bash
git add extension/app.js extension/style.css
git commit -m "feat: session kebab menu (reopen, rename, save-as-named, duplicate, delete)"
```

---

### Task 3.3: Expand-to-tab-list + single-tab open + remove-tab

**Files:**
- Modify: `extension/app.js`

- [ ] **Step 1: Track expansion state**

```js
const _expandedSessions = new Set();

function toggleSessionExpand(sessionId) {
  if (_expandedSessions.has(sessionId)) _expandedSessions.delete(sessionId);
  else _expandedSessions.add(sessionId);
  renderSessionsPane();
}
```

- [ ] **Step 2: Render expanded tab list inside `renderSessionCard`**

Update `renderSessionCard` to append the expanded tab list when the session is expanded:

```js
function renderSessionCard(session) {
  // ... existing header, meta, faviconRow ...

  const children = [header, meta, faviconRow];

  if (_expandedSessions.has(session.id)) {
    if (session.tabs.length === 0) {
      children.push(el('div', { class: 'session-empty-state' }, [
        textNode('0 tabs (all removed)'),
        el('button', {
          class: 'session-empty-delete',
          'data-action': 'session-delete',
          'data-session-id': session.id
        }, 'Delete session')
      ]));
    } else {
      const list = el('div', { class: 'session-tab-list' },
        session.tabs.map((t, i) => renderSessionTabRow(session.id, t, i)));
      children.push(list);
    }
  }

  // Flip chevron character when expanded
  chevron.textContent = _expandedSessions.has(session.id) ? '▾' : '▸';

  const card = el('div', { /* ... */ }, children);
  return card;
}
```

- [ ] **Step 3: Add `renderSessionTabRow`**

```js
function renderSessionTabRow(sessionId, tab, tabIndex) {
  const closeBtn = el('button', {
    class: 'session-tab-close',
    'data-action': 'session-tab-remove',
    'data-session-id': sessionId,
    'data-tab-index': String(tabIndex),
    title: 'Remove from session'
  }, '✕');

  return el('div', {
    class: 'session-tab-row',
    'data-action': 'session-tab-open',
    'data-session-id': sessionId,
    'data-tab-index': String(tabIndex)
  }, [
    faviconEl(tab.url, 14),
    textNode(' '),
    el('span', { class: 'session-tab-title' }, tab.title || tab.url),
    closeBtn
  ]);
}
```

- [ ] **Step 4: Wire the two new action handlers**

```js
if (action === 'session-tab-open') {
  e.preventDefault(); e.stopPropagation();
  const sid = target.dataset.sessionId;
  const idx = parseInt(target.dataset.tabIndex, 10);
  const { items } = await readSessions();
  const s = items.find(x => x.id === sid);
  if (!s || !s.tabs[idx]) return;
  const url = s.tabs[idx].url;
  if (!ALLOWED_SCHEMES.test(url)) {
    showToast({ message: 'Cannot open — invalid URL scheme.' });
    return;
  }
  const w = await chrome.windows.getCurrent();
  await chrome.tabs.create({ url, windowId: w.id, active: true });
  showToast({ message: 'Opened tab' });
  return;
}

if (action === 'session-tab-remove') {
  e.preventDefault(); e.stopPropagation();
  const sid = target.dataset.sessionId;
  const idx = parseInt(target.dataset.tabIndex, 10);
  try {
    const record = await removeTabFromSession(sid, idx);
    showToast({
      message: 'Tab removed',
      actionLabel: 'Undo',
      onAction: async () => {
        await trashRestore(record.trashId);
        renderSessionsPane();
      }
    });
    renderSessionsPane();
  } catch (e) {
    showToast({ message: 'Couldn\'t remove tab — see console.' });
    console.error('[tab-out] remove tab failed', e);
  }
  return;
}
```

- [ ] **Step 5: CSS**

```css
.session-tab-list {
  margin-top: 10px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
.session-tab-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  cursor: pointer;
  border-radius: 4px;
}
.session-tab-row:hover { background: var(--hover); }
.session-tab-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.session-tab-close {
  background: transparent;
  border: none;
  color: var(--muted);
  font-size: 14px;
  cursor: pointer;
  padding: 0 6px;
  border-radius: 4px;
}
.session-tab-close:hover { background: var(--hover); color: var(--fg); }
.session-empty-state {
  padding: 16px;
  text-align: center;
  color: var(--muted);
}
.session-empty-delete {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg);
  font: inherit;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  margin-top: 8px;
}
```

- [ ] **Step 6: Prevent expand-chevron click from triggering card-reopen**

Because the card itself has `data-action="session-reopen"`, clicking anywhere inside triggers reopen. We need the chevron, kebab, and tab-list interactions to NOT bubble to the card. This is handled by `e.stopPropagation()` in each specific handler above. Verify that reopen still triggers on card body clicks (outside chevron/kebab/tabs).

- [ ] **Step 7: Verify**

Reload. Expand a session → tab list shows. Click a row → opens in current window (active tab becomes the clicked URL). Click ✕ on a tab → toast "Tab removed · Undo", tab disappears. Undo → tab returns. Remove all tabs → "0 tabs (all removed)" + Delete session button.

- [ ] **Step 8: Commit**

```bash
git add extension/app.js extension/style.css
git commit -m "feat: expand session card + single-tab open + remove-tab"
```

---

## Phase 4 — Reopen flow

### Task 4.1: `reopenSession` with pin-pass and group-pass

**Files:**
- Modify: `extension/app.js`

- [ ] **Step 1: Implement `reopenSession`**

```js
async function reopenSession(sessionId) {
  const { items } = await readSessions();
  const session = items.find(s => s.id === sessionId);
  if (!session) return;

  // Defensive rescheme check (catches corrupted legacy data).
  const valid = session.tabs.filter(t => ALLOWED_SCHEMES.test(t.url));
  const dropped = session.tabs.length - valid.length;

  if (valid.length === 0) {
    showToast({ message: 'Session is empty or has no valid URLs.' });
    return;
  }

  if (valid.length > 75) {
    showToast({ message: `Opening ${valid.length} tabs — this may take a moment.` });
  }

  let newWindow;
  try {
    newWindow = await chrome.windows.create({
      url: valid.map(t => t.url),
      focused: true,
      state: 'normal'
    });
  } catch (err) {
    showToast({ message: "Couldn't open session — Chrome blocked the window." });
    console.error('[tab-out] windows.create failed', err);
    return;
  }

  // Re-query to get authoritative tab list (positional order is not a documented contract).
  const populated = await chrome.windows.get(newWindow.id, { populate: true });
  const createdTabs = populated.tabs || [];

  // Map saved tabs to created tabs positionally.
  // Chrome currently opens URLs in order; treat positional mapping as best-effort.
  let pinFailCount = 0;
  let groupFailCount = 0;

  // Pin pass
  for (let i = 0; i < valid.length && i < createdTabs.length; i++) {
    if (valid[i].pinned) {
      try {
        await chrome.tabs.update(createdTabs[i].id, { pinned: true });
      } catch (e) {
        pinFailCount++;
        console.warn('[tab-out] pin failed', e);
      }
    }
  }

  // Group pass (only if tabGroups permission is granted AND session has groups)
  if (session.groups && Object.keys(session.groups).length > 0) {
    const granted = await ensureTabGroupsPermission({ prompt: false });
    if (granted) {
      const bySavedKey = new Map();
      for (let i = 0; i < valid.length && i < createdTabs.length; i++) {
        const k = valid[i].savedGroupKey;
        if (!k) continue;
        if (!bySavedKey.has(k)) bySavedKey.set(k, []);
        bySavedKey.get(k).push(createdTabs[i].id);
      }
      for (const [savedKey, tabIds] of bySavedKey) {
        const meta = session.groups[savedKey];
        if (!meta) continue;
        try {
          const gid = await chrome.tabs.group({ tabIds, createProperties: { windowId: newWindow.id } });
          await chrome.tabGroups.update(gid, { title: meta.title, color: meta.color });
        } catch (e) {
          groupFailCount++;
          console.warn('[tab-out] group restore failed', e);
        }
      }
    }
  }

  const parts = [`Opened ${valid.length} tab${valid.length === 1 ? '' : 's'} in new window`];
  if (dropped > 0) parts.push(`${dropped} skipped`);
  if (pinFailCount > 0) parts.push(`${pinFailCount} pin${pinFailCount === 1 ? '' : 's'} failed`);
  if (groupFailCount > 0) parts.push(`${groupFailCount} group${groupFailCount === 1 ? '' : 's'} failed`);
  showToast({ message: parts.join(', ') });
}
```

- [ ] **Step 2: Verify**

Save a named session with a mix of regular tabs, one pinned tab, and one tab group (if you have tabGroups permission granted). Click the card → new window opens with all tabs, pin restored, group restored with title and color.

Delete all current tabs and reopen → additive behavior: current window untouched, session opens in a new one.

- [ ] **Step 3: Commit**

```bash
git add extension/app.js
git commit -m "feat: reopenSession with pin-pass and group-pass (best-effort)"
```

---

## Phase 5 — Search

### Task 5.1: Search input with debounced filtering

**Files:**
- Modify: `extension/app.js`

- [ ] **Step 1: Replace `renderSessionsSearch` stub**

```js
function renderSessionsSearch() {
  const input = el('input', {
    type: 'text',
    class: 'sessions-search',
    id: 'sessionsSearchInput',
    placeholder: 'Search sessions…',
    value: _sessionSearchQuery || ''
  });

  let debounceTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      _sessionSearchQuery = input.value.trim();
      applySessionsSearch();
    }, 150);
  });

  return input;
}

let _sessionSearchQuery = '';
```

- [ ] **Step 2: Add matcher functions**

```js
function sessionMatchesQuery(session, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (session.name.toLowerCase().includes(needle)) return true;
  return session.tabs.some(t => tabMatchesQuery(t, needle));
}

function tabMatchesQuery(tab, needle) {
  if (tab.title.toLowerCase().includes(needle)) return true;
  try {
    const u = new URL(tab.url);
    const hostAndPath = u.hostname.toLowerCase() + u.pathname.toLowerCase();
    if (hostAndPath.includes(needle)) return true;
  } catch {}
  return false;
}
```

- [ ] **Step 3: Filter & highlight on render**

Refactor `renderSessionsPane` to respect `_sessionSearchQuery`:

```js
async function renderSessionsPane() {
  const pane = document.getElementById('sessionsPane');
  if (!pane) return;

  const { items } = await readSessions();
  _lastSessionsCount = items.length;
  const pillCount = document.getElementById('sessionsPillCount');
  if (pillCount) pillCount.textContent = items.length;

  const q = _sessionSearchQuery || '';
  const snapshot = items.find(s => s.kind === 'snapshot');
  const named = items.filter(s => s.kind === 'named')
    .sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
      return b.id.localeCompare(a.id);
    });

  pane.replaceChildren();

  if (items.length === 0) {
    pane.appendChild(el('div', { class: 'sessions-empty' },
      'No sessions yet. Click "+ Save window" above to save your first one.'));
    return;
  }

  pane.appendChild(renderSessionsSearch());

  const visibleSnapshot = snapshot && sessionMatchesQuery(snapshot, q) ? snapshot : null;
  const visibleNamed = named.filter(s => sessionMatchesQuery(s, q));

  if (q) {
    const count = (visibleSnapshot ? 1 : 0) + visibleNamed.length;
    pane.appendChild(el('div', { class: 'sessions-search-count' },
      `${count} session${count === 1 ? '' : 's'} match`));
  }

  if (visibleSnapshot) {
    pane.appendChild(el('div', { class: 'sessions-divider' }, 'Snapshot'));
    pane.appendChild(renderSessionCard(visibleSnapshot, q));
  }
  if (visibleNamed.length > 0) {
    pane.appendChild(el('div', { class: 'sessions-divider' }, 'Named'));
    for (const s of visibleNamed) pane.appendChild(renderSessionCard(s, q));
  }

  // Refocus search input and restore caret after re-render
  if (q) {
    const input = document.getElementById('sessionsSearchInput');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

async function applySessionsSearch() {
  await renderSessionsPane();
}
```

- [ ] **Step 4: Highlight matched tabs inside expanded cards**

Update `renderSessionCard` and `renderSessionTabRow` to accept `q` and add a CSS class to matched tabs:

```js
function renderSessionCard(session, q = '') {
  // ... existing setup ...
  // When rendering the tab list in expanded state:
  const list = el('div', { class: 'session-tab-list' },
    session.tabs.map((t, i) => renderSessionTabRow(session.id, t, i, q)));
  // ...
}

function renderSessionTabRow(sessionId, tab, tabIndex, q = '') {
  const matched = q && tabMatchesQuery(tab, q.toLowerCase());
  // ... build row ...
  return el('div', {
    class: 'session-tab-row' + (matched ? ' session-tab-match' : ''),
    // ... other attrs
  }, [/* ... */]);
}
```

- [ ] **Step 5: CSS**

```css
.sessions-search-count {
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 8px;
}
.session-tab-match { background: rgba(255, 224, 94, 0.08); }
```

- [ ] **Step 6: Verify**

Save multiple sessions with varied tab titles. Search by partial name → non-matching sessions hide. Search by a tab title found only inside one session → only that session shows. Expand it → matched tabs have a faint yellow tint.

Clear the search → full list restores. Previously-expanded sessions stay expanded.

- [ ] **Step 7: Commit**

```bash
git add extension/app.js extension/style.css
git commit -m "feat: session search (name + tab title + URL hostname+path)"
```

---

## Phase 6 — Trash pane

### Task 6.1: Render Trash pane (sessions + removed tabs + quarantine)

**Files:**
- Modify: `extension/app.js`

- [ ] **Step 1: Replace the stub**

```js
async function renderTrashPane() {
  const pane = document.getElementById('trashPane');
  if (!pane) return;

  const { items } = await readTrash();
  _lastTrashCount = items.length;
  const link = document.getElementById('trashLink');
  const linkCount = document.getElementById('trashLinkCount');
  if (link && linkCount) {
    linkCount.textContent = items.length;
    link.style.display = items.length > 0 ? 'inline' : 'none';
  }

  pane.replaceChildren();

  if (items.length === 0) {
    pane.appendChild(el('div', { class: 'sessions-empty' }, 'Trash is empty.'));
    // Also check for quarantined items
    await appendQuarantineSection(pane);
    return;
  }

  pane.appendChild(el('div', { class: 'trash-header' }, 'Trash · 7-day retention'));

  const sessionRecords = items.filter(r => r.reason === 'deleted' || r.reason === 'snapshot-overwritten');
  const tabRecords = items.filter(r => r.reason === 'tab-removed');

  for (const r of sessionRecords) {
    pane.appendChild(renderTrashSessionCard(r));
  }

  if (tabRecords.length > 0) {
    pane.appendChild(el('div', { class: 'sessions-divider' }, 'Removed tabs'));
    for (const r of tabRecords) pane.appendChild(renderTrashTabCard(r));
  }

  await appendQuarantineSection(pane);
}

function renderTrashSessionCard(record) {
  const s = record.session;
  const label = record.reason === 'snapshot-overwritten' ? '📸 Snapshot (overwritten)' : `🗑 ${s.name} (deleted)`;
  const ago = timeAgo(record.trashedAt);

  return el('div', { class: 'trash-card' }, [
    el('div', { class: 'trash-card-title' }, label),
    el('div', { class: 'trash-card-meta' },
      `${s.tabs.length} tab${s.tabs.length === 1 ? '' : 's'} · ${record.reason === 'snapshot-overwritten' ? 'overwritten' : 'deleted'} ${ago}`),
    el('div', { class: 'trash-card-actions' }, [
      el('button', {
        class: 'trash-restore',
        'data-action': 'trash-restore',
        'data-trash-id': record.trashId
      }, 'Restore'),
      el('button', {
        class: 'trash-drop',
        'data-action': 'trash-drop',
        'data-trash-id': record.trashId
      }, 'Delete permanently')
    ])
  ]);
}

function renderTrashTabCard(record) {
  const tab = record.removedTab;
  const parentName = record.parentSessionId ? `session ${record.parentSessionId.slice(-6)}` : 'unknown';
  return el('div', { class: 'trash-card' }, [
    el('div', { class: 'trash-tab-title' }, tab.title || tab.url),
    el('div', { class: 'trash-card-meta' }, `from "${parentName}" · ${timeAgo(record.trashedAt)}`),
    el('div', { class: 'trash-card-actions' }, [
      el('button', {
        class: 'trash-restore',
        'data-action': 'trash-restore',
        'data-trash-id': record.trashId
      }, 'Restore'),
      el('button', {
        class: 'trash-drop',
        'data-action': 'trash-drop',
        'data-trash-id': record.trashId
      }, 'Delete permanently')
    ])
  ]);
}

async function appendQuarantineSection(pane) {
  const { sessionsQuarantine } = await chrome.storage.local.get('sessionsQuarantine');
  const items = sessionsQuarantine && Array.isArray(sessionsQuarantine.items) ? sessionsQuarantine.items : [];
  if (items.length === 0) return;

  pane.appendChild(el('div', { class: 'sessions-divider' }, 'Quarantine'));
  for (const q of items) {
    pane.appendChild(el('div', { class: 'trash-card' }, [
      el('div', { class: 'trash-card-title' }, 'Invalid session (schema mismatch)'),
      el('div', { class: 'trash-card-meta' }, 'Quarantined ' + timeAgo(q.quarantinedAt)),
      el('div', { class: 'trash-card-actions' }, [
        el('button', {
          class: 'trash-drop',
          'data-action': 'quarantine-drop',
          'data-quarantine-at': q.quarantinedAt
        }, 'Delete permanently')
      ])
    ]));
  }
}
```

- [ ] **Step 2: Wire handlers**

```js
if (action === 'trash-restore') {
  e.preventDefault();
  await trashRestore(target.dataset.trashId);
  showToast({ message: 'Restored' });
  renderSessionsPane();
  renderTrashPane();
  return;
}
if (action === 'trash-drop') {
  e.preventDefault();
  await trashDrop(target.dataset.trashId);
  renderTrashPane();
  return;
}
if (action === 'quarantine-drop') {
  e.preventDefault();
  const at = target.dataset.quarantineAt;
  const { sessionsQuarantine } = await chrome.storage.local.get('sessionsQuarantine');
  const items = (sessionsQuarantine?.items || []).filter(q => q.quarantinedAt !== at);
  await chrome.storage.local.set({ sessionsQuarantine: { items } });
  renderTrashPane();
  return;
}
```

- [ ] **Step 3: CSS**

```css
.trash-header {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 12px;
}
.trash-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 8px;
}
.trash-card-title, .trash-tab-title {
  font-weight: 500;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trash-card-meta {
  color: var(--muted);
  font-size: 11px;
  margin-top: 2px;
}
.trash-card-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.trash-restore, .trash-drop {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.trash-restore:hover { background: var(--hover); }
.trash-drop { color: var(--red, #d9534f); }
```

- [ ] **Step 4: Verify**

Delete a session → switch to Trash pane (click the "Trash (N)" link) → see the session. Click Restore → it returns to Sessions pane; name collision auto-suffix. Click Delete permanently → gone.

Quick save twice → older snapshot appears in Trash with "overwritten" label. Restore → old snapshot replaces current; current goes to Trash.

Remove a tab → switch to Trash → "Removed tabs" section has it. Restore → tab returns.

Corrupt storage via DevTools → reload → Quarantine section appears in Trash.

- [ ] **Step 5: Commit**

```bash
git add extension/app.js extension/style.css
git commit -m "feat: Trash pane (sessions, removed tabs, quarantine)"
```

---

## Phase 7 — Security hardening & polish

### Task 7.1: Secrets-in-URLs disclosure banner

**Files:**
- Modify: `extension/app.js`
- Modify: `extension/style.css`

- [ ] **Step 1: Add banner logic**

```js
async function maybeShowFirstSaveBanner() {
  const { _tabOutFirstSaveBannerDismissed } = await chrome.storage.local.get('_tabOutFirstSaveBannerDismissed');
  if (_tabOutFirstSaveBannerDismissed) return;
  const pane = document.getElementById('sessionsPane');
  if (!pane) return;

  const banner = el('div', { class: 'first-save-banner' }, [
    textNode('Tab Out saves full URLs including query parameters. If a tab contains a password-reset link or other sensitive URL, remove the tab from the session before saving. Your data stays on this device.'),
    el('button', {
      class: 'first-save-dismiss',
      onClick: async () => {
        await chrome.storage.local.set({ _tabOutFirstSaveBannerDismissed: true });
        banner.remove();
      }
    }, 'Got it')
  ]);
  pane.prepend(banner);
}
```

Call `maybeShowFirstSaveBanner()` inside `renderSessionsPane()` after rendering, only on first render after a save.

Simplest: call it at the end of `confirmSaveOverlay` and `quickSaveFromOverlay` success paths.

- [ ] **Step 2: CSS**

```css
.first-save-banner {
  background: rgba(255, 224, 94, 0.12);
  border: 1px solid rgba(255, 224, 94, 0.35);
  border-radius: 6px;
  padding: 12px;
  font-size: 12px;
  color: var(--fg);
  margin-bottom: 12px;
}
.first-save-dismiss {
  background: transparent;
  border: 1px solid var(--border);
  color: inherit;
  font: inherit;
  padding: 3px 10px;
  border-radius: 4px;
  cursor: pointer;
  margin-top: 8px;
}
```

- [ ] **Step 3: Verify**

Clear storage: `await chrome.storage.local.remove('_tabOutFirstSaveBannerDismissed')`. Save a session → banner appears. Click "Got it" → banner dismisses permanently.

- [ ] **Step 4: Commit**

```bash
git add extension/app.js extension/style.css
git commit -m "feat: first-save disclosure banner for URL privacy"
```

---

### Task 7.2: README update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update privacy wording**

Find in `README.md`:

```
No server. No account. No external API calls. Just a Chrome extension.
```

Replace with:

```
No server. No account. No external API calls — fonts are self-hosted and favicons use Chrome's built-in favicon endpoint. Just a Chrome extension.
```

Find:

```
**100% local** your data never leaves your machine
```

Replace with:

```
**Local** your sessions are stored in your Chrome profile on this device. Nothing is synced or uploaded.
```

Update the Features list to add sessions:

```
- **Save a window as a session** named or quick snapshot, reopen anytime in a new window, 7-day Trash for accidental deletes
```

- [ ] **Step 2: Verify**

```bash
grep -n "100% local" README.md
# Expected: no matches

grep -n "Just a Chrome extension" README.md
# Expected: updated line with fonts/favicons clarification
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: correct privacy wording now that fonts and favicons are local"
```

---

## Phase 8 — Smoke matrix run-through

### Task 8.1: Execute the spec's 30-item smoke matrix

**Files:** none modified; this is verification.

- [ ] **Step 1: Prepare a test Chrome profile**

Open a fresh Chrome profile (or disable other extensions) to isolate Tab Out. Load the extension in Developer mode from `extension/`.

- [ ] **Step 2: Run each test**

Walk through the numbered list from the spec's "Testing" section (1–30). For each, record pass/fail. The full list is at:

`docs/superpowers/specs/2026-04-18-tab-out-sessions-design.md` → *Testing (manual smoke matrix)*.

Create a scratchpad file `docs/superpowers/specs/2026-04-18-smoke-results.md` with:

```markdown
# Smoke matrix results — 2026-04-18

| # | Test | Result | Notes |
|---|---|---|---|
| 1 | Save named session with 5 tabs | PASS | |
| 2 | Duplicate snapshot overwrite | ... | ... |
...
```

- [ ] **Step 3: Fix any failures before merge**

For each FAIL, file an issue or a follow-up commit. Do not merge with a known failing smoke test unless explicitly waived by the reviewer.

- [ ] **Step 4: Commit results**

```bash
git add docs/superpowers/specs/2026-04-18-smoke-results.md
git commit -m "test: smoke matrix results for Sessions v2"
```

---

## Appendix — Migration notes for reviewers

- Phase 0 is a refactor PR by itself. It ships user-visible improvements (XSS-safe rendering, local fonts, local favicons, clickable toasts) without the Sessions feature. It should be reviewable independently.
- Phases 1-6 build on Phase 0. They can ship as one PR or be split (data layer / save / UI / reopen / search / trash).
- Phase 7 is polish and can land last.
- Phase 8 (smoke matrix) is a gate before merging to `main`.

## Appendix — Coverage check

Each spec section maps to at least one task:

| Spec section | Implementing task |
|---|---|
| R1 Sidebar visibility rework | 0.6, 0.7 |
| R2 Toast controller | 0.5 |
| R3 DOM-only rendering | 0.2, 0.3, 0.4 |
| R4 storage.onChanged | 0.8 |
| R5 Self-hosted fonts | 0.1 |
| R6 _favicon endpoint | 0.9 |
| Data model + optimistic concurrency + quarantine | 1.1, 1.2 |
| Trash | 1.3, 6.1 |
| Header chip + Save overlay | 2.2, 2.3 |
| Capture + scheme allowlist + group meta | 2.1 |
| Sessions pane render | 3.1 |
| Kebab menu + rename + duplicate + delete + save-as-named | 3.2 |
| Expand + single-tab open + remove-tab | 3.3 |
| Reopen with pin/group passes | 4.1 |
| Search | 5.1 |
| Trash pane (inc. quarantine) | 6.1 |
| Secrets banner | 7.1 |
| README | 7.2 |
| Manual testing | 8.1 |
