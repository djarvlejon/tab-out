/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';

document.querySelectorAll('script[data-optional="true"]').forEach(s => {
  s.addEventListener('error', () => {
    // Optional config file absent — that's fine.
  });
});


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({ currentWindow: true });
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  _deferredSelfWriteSuppress++;
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    _deferredSelfWriteSuppress++;
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    _deferredSelfWriteSuppress++;
    await chrome.storage.local.set({ deferred });
  }
}

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

/* ----------------------------------------------------------------
   SESSIONS — schema + validation
   ---------------------------------------------------------------- */

const SESSION_SCHEMA_VERSION = 1;
const TRASH_SCHEMA_VERSION = 1;
const QUARANTINE_SCHEMA_VERSION = 1;
const MAX_SESSION_NAME_LENGTH = 120;

const VALID_GROUP_COLORS = new Set(['grey','blue','red','yellow','green','pink','purple','cyan','orange']);

function sanitizeSessionInPlace(s) {
  if (Array.isArray(s && s.tabs)) {
    for (const t of s.tabs) {
      if (t && typeof t === 'object') t.favIconUrl = '';
    }
  }
  if (s && s.groups && typeof s.groups === 'object') {
    for (const key in s.groups) {
      const g = s.groups[key];
      if (g && typeof g.color === 'string' && !VALID_GROUP_COLORS.has(g.color)) {
        g.color = 'grey';
      }
    }
  }
}

function validateSession(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  if (typeof s.id !== 'string' || !s.id) return false;
  if (typeof s.rev !== 'number') return false;
  if (s.kind !== 'named' && s.kind !== 'snapshot') return false;
  if (typeof s.name !== 'string' || s.name.length > MAX_SESSION_NAME_LENGTH) return false;
  if (typeof s.savedAt !== 'string' || !s.savedAt) return false;
  if (typeof s.updatedAt !== 'string' || !s.updatedAt) return false;
  if (!Array.isArray(s.tabs)) return false;
  if (!s.summary || typeof s.summary !== 'object' || Array.isArray(s.summary)) return false;
  if (!s.groups || typeof s.groups !== 'object' || Array.isArray(s.groups)) return false;
  if (s.kind === 'snapshot' && (s.id !== SNAPSHOT_ID || s.name !== 'Snapshot')) return false;

  const referencedGroupKeys = new Set();
  for (const t of s.tabs) {
    if (!t || typeof t !== 'object') return false;
    if (typeof t.url !== 'string') return false;
    if (!/^https?:\/\//i.test(t.url)) return false;
    if (typeof t.title !== 'string') return false;
    if (typeof t.pinned !== 'boolean') return false;
    if (typeof t.index !== 'number') return false;
    if (t.savedGroupKey != null && typeof t.savedGroupKey !== 'string') return false;
    if (t.savedGroupKey != null) referencedGroupKeys.add(t.savedGroupKey);
  }

  for (const key in s.groups) {
    const g = s.groups[key];
    if (!g || typeof g !== 'object' || Array.isArray(g)) return false;
    if (typeof g.title !== 'string') return false;
    if (!VALID_GROUP_COLORS.has(g.color)) return false;
    if (!referencedGroupKeys.has(key)) return false;
  }

  for (const key of referencedGroupKeys) {
    if (!Object.prototype.hasOwnProperty.call(s.groups, key)) return false;
  }

  const expectedSummary = computeSummary(s.tabs);
  const topDomains = s.summary.topDomains;
  if (!Number.isFinite(s.summary.tabCount) || s.summary.tabCount !== s.tabs.length) return false;
  if (!Number.isFinite(s.summary.uniqueDomains) || s.summary.uniqueDomains !== expectedSummary.uniqueDomains) return false;
  if (!Array.isArray(topDomains) || topDomains.length > 4 || topDomains.length !== expectedSummary.topDomains.length) return false;

  for (let i = 0; i < topDomains.length; i++) {
    const top = topDomains[i];
    const expectedTop = expectedSummary.topDomains[i];
    if (!top || typeof top !== 'object' || Array.isArray(top)) return false;
    if (typeof top.hostname !== 'string') return false;
    if (!Number.isFinite(top.count)) return false;
    if (!expectedTop) return false;
    if (top.hostname !== expectedTop.hostname || top.count !== expectedTop.count) return false;
  }

  return true;
}

async function readSessions() {
  let { sessions } = await chrome.storage.local.get('sessions');
  if (!sessions || typeof sessions !== 'object') {
    const created = await setSessionsIfUnchanged(null, []);
    if (created) {
      return { schemaVersion: SESSION_SCHEMA_VERSION, items: [], writeToken: _lastSelfWriteToken };
    }
    const latest = await chrome.storage.local.get('sessions');
    sessions = latest.sessions;
    if (!sessions || typeof sessions !== 'object') {
      return { schemaVersion: SESSION_SCHEMA_VERSION, items: [], writeToken: null };
    }
  }
  if (sessions.schemaVersion !== SESSION_SCHEMA_VERSION) {
    console.warn('[tab-out] sessions schemaVersion mismatch — v1 is current; future migrations go here');
  }

  const items = Array.isArray(sessions.items) ? sessions.items : [];
  const valid = [];
  const invalid = [];
  for (const item of items) {
    sanitizeSessionInPlace(item);
    if (validateSession(item)) valid.push(item);
    else invalid.push(item);
  }

  let resultItems = valid;
  let resultWriteToken = sessions.writeToken || null;
  if (invalid.length > 0) {
    await quarantineSessions(invalid);
    let cleanedItems = valid;
    let expectedWriteToken = resultWriteToken;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ok = await setSessionsIfUnchanged(expectedWriteToken, cleanedItems);
      if (ok) {
        resultItems = cleanedItems;
        resultWriteToken = _lastSelfWriteToken;
        break;
      }
      const { sessions: latestSessions } = await chrome.storage.local.get('sessions');
      if (!latestSessions || typeof latestSessions !== 'object') {
        resultItems = [];
        resultWriteToken = null;
        break;
      }
      const latestItems = Array.isArray(latestSessions.items) ? latestSessions.items : [];
      const latestValid = [];
      const latestInvalid = [];
      for (const item of latestItems) {
        sanitizeSessionInPlace(item);
        if (validateSession(item)) latestValid.push(item);
        else latestInvalid.push(item);
      }
      resultItems = latestValid;
      resultWriteToken = latestSessions.writeToken || null;
      if (latestInvalid.length === 0) break;
      await quarantineSessions(latestInvalid);
      cleanedItems = latestValid;
      expectedWriteToken = resultWriteToken;
    }
    showToast({ message: `Skipped ${invalid.length} invalid session${invalid.length > 1 ? 's' : ''} — check Trash → Quarantine.` });
  }

  return { schemaVersion: SESSION_SCHEMA_VERSION, items: resultItems, writeToken: resultWriteToken };
}

function quarantineHash(raw) {
  return JSON.stringify(raw);
}

async function quarantineSessions(invalid) {
  if (!Array.isArray(invalid) || invalid.length === 0) return;
  const { sessionsQuarantine } = await chrome.storage.local.get('sessionsQuarantine');
  const existing = sessionsQuarantine && Array.isArray(sessionsQuarantine.items)
    ? sessionsQuarantine.items.slice()
    : [];
  const seen = new Set(existing.map(item => quarantineHash(item.raw)));
  let didAdd = false;
  for (const raw of invalid) {
    const hash = quarantineHash(raw);
    if (seen.has(hash)) continue;
    seen.add(hash);
    existing.push({
      quarantineId: 'qrn_' + ulid(),
      quarantinedAt: new Date().toISOString(),
      raw
    });
    didAdd = true;
  }
  if (!didAdd) return;
  await writeSessionsQuarantineItems(existing);
}

async function setSessionsIfUnchanged(expectedWriteToken, newItems) {
  const { sessions } = await chrome.storage.local.get('sessions');
  const currentToken = sessions ? (sessions.writeToken || null) : null;
  if (currentToken !== expectedWriteToken) return false;
  const writeToken = newWriteToken();
  await chrome.storage.local.set({
    sessions: { schemaVersion: SESSION_SCHEMA_VERSION, items: newItems, writeToken }
  });
  return true;
}

async function setTrashIfUnchanged(expectedWriteToken, newItems) {
  const { sessionsTrash } = await chrome.storage.local.get('sessionsTrash');
  const currentToken = sessionsTrash ? (sessionsTrash.writeToken || null) : null;
  if (currentToken !== expectedWriteToken) return false;
  const writeToken = newTrashWriteToken();
  _trashSelfWriteSuppress++;
  await chrome.storage.local.set({
    sessionsTrash: { schemaVersion: TRASH_SCHEMA_VERSION, items: newItems, writeToken }
  });
  return true;
}

async function writeSessionsAndTrashAtomic({ sessionsItems, expectedSessionsToken, trashItems, expectedTrashToken }) {
  const { sessions, sessionsTrash } = await chrome.storage.local.get(['sessions', 'sessionsTrash']);
  const currentSessionsToken = sessions ? (sessions.writeToken || null) : null;
  const currentTrashToken = sessionsTrash ? (sessionsTrash.writeToken || null) : null;
  if (currentSessionsToken !== expectedSessionsToken) return false;
  if (currentTrashToken !== expectedTrashToken) return false;
  const newSessionsToken = newWriteToken();
  const newTrashToken = newTrashWriteToken();
  _trashSelfWriteSuppress++;
  await chrome.storage.local.set({
    sessions: { schemaVersion: SESSION_SCHEMA_VERSION, items: sessionsItems, writeToken: newSessionsToken },
    sessionsTrash: { schemaVersion: TRASH_SCHEMA_VERSION, items: trashItems, writeToken: newTrashToken }
  });
  return true;
}

// Update an existing session using optimistic retry (storage has no atomic CAS); retries up to 3 times on conflict.
async function updateSession(id, mutator) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { items, writeToken } = await readSessions();
    const idx = items.findIndex(s => s.id === id);
    if (idx === -1) throw new Error('session-gone');
    const current = items[idx];
    const nextResult = await mutator(structuredClone(current), items);
    const normalized = nextResult && typeof nextResult === 'object' && !Array.isArray(nextResult)
      && Object.prototype.hasOwnProperty.call(nextResult, 'session')
      ? nextResult
      : { session: nextResult, skipUpdatedAt: false };
    if (normalized.skipUpdatedAt) return current;
    const next = normalized.session;
    next.rev = (current.rev || 0) + 1;
    next.updatedAt = new Date().toISOString();
    const newItems = items.slice();
    newItems[idx] = next;
    const ok = await setSessionsIfUnchanged(writeToken, newItems);
    if (ok) return next;
  }
  throw new Error('write-conflict');
}

// Insert a new session with optimistic retry; named inserts can require uniqueness inside the CAS loop.
async function appendSession(session, { requireNameUnique = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { items, writeToken } = await readSessions();
    if (requireNameUnique && session.kind === 'named') {
      const target = normalizeName(session.name);
      if (items.some(s => s.kind === 'named' && s.id !== session.id && normalizeName(s.name) === target)) {
        throw new Error('name-collision');
      }
    }
    const ok = await setSessionsIfUnchanged(writeToken, [session, ...items]);
    if (ok) return session;
  }
  throw new Error('write-conflict');
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

/* ----------------------------------------------------------------
   SESSIONS — CRUD
   ---------------------------------------------------------------- */

const SNAPSHOT_ID = '__snap__';

async function createNamedSession({ name, tabs, groups, summary }) {
  const safeName = clampSessionName(name);
  if (!safeName) throw new Error('empty-name');
  const now = new Date().toISOString();
  const session = {
    id: ulid(),
    rev: 0,
    name: safeName,
    kind: 'named',
    savedAt: now,
    updatedAt: now,
    summary,
    tabs,
    groups: groups || {}
  };
  await appendSession(session, { requireNameUnique: true });
  return session;
}

function buildSnapshotSession({ existing, tabs, groups, summary }) {
  const now = new Date().toISOString();
  return {
    id: SNAPSHOT_ID,
    rev: existing ? ((existing.rev || 0) + 1) : 0,
    name: 'Snapshot',
    kind: 'snapshot',
    savedAt: now,
    updatedAt: now,
    summary,
    tabs,
    groups: groups || {}
  };
}

async function writeSnapshotSession({ tabs, groups, summary }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [{ items, writeToken }, { items: trashItems, writeToken: trashWriteToken }] = await Promise.all([readSessions(), readTrash()]);
    const existing = items.find(s => s.id === SNAPSHOT_ID);
    const previous = existing ? structuredClone(existing) : null;
    const snapshot = buildSnapshotSession({ existing, tabs, groups, summary });
    const filtered = items.filter(s => s.id !== SNAPSHOT_ID);
    const overwrittenRecord = previous
      ? buildTrashRecord({ reason: 'snapshot-overwritten', session: previous })
      : null;
    const ok = await writeSessionsAndTrashAtomic({
      sessionsItems: [snapshot, ...filtered],
      expectedSessionsToken: writeToken,
      trashItems: overwrittenRecord ? prependTrashRecord(trashItems, overwrittenRecord) : trashItems,
      expectedTrashToken: trashWriteToken
    });
    if (ok) {
      return { snapshot, overwrittenTrashId: overwrittenRecord ? overwrittenRecord.trashId : null };
    }
  }
  throw new Error('write-conflict');
}

function normalizeName(s) { return (s || '').trim().toLowerCase(); }

function clampSessionName(name) {
  return String(name == null ? '' : name).trim().slice(0, MAX_SESSION_NAME_LENGTH);
}

function buildSuffixedSessionName(baseName, suffixLabel, takenNames) {
  const normalizedBase = clampSessionName(baseName) || 'Session';
  let n = 1;
  while (true) {
    const suffix = n === 1 ? ` (${suffixLabel})` : ` (${suffixLabel} ${n})`;
    const headLimit = Math.max(0, MAX_SESSION_NAME_LENGTH - suffix.length);
    const head = (normalizedBase.slice(0, headLimit) || 'Session'.slice(0, headLimit));
    const candidate = `${head}${suffix}`.slice(0, MAX_SESSION_NAME_LENGTH);
    if (!takenNames.has(normalizeName(candidate))) return candidate;
    n++;
  }
}

async function isNameAvailable(name, ignoreId) {
  const { items } = await readSessions();
  const target = normalizeName(name);
  return !items.some(s => s.kind === 'named' && s.id !== ignoreId && normalizeName(s.name) === target);
}

async function renameSession(id, newName) {
  const trimmed = clampSessionName(newName);
  if (!trimmed) throw new Error('empty-name');
  return updateSession(id, async (s, allItems) => {
    const target = normalizeName(trimmed);
    if (allItems.some(o => o.kind === 'named' && o.id !== id && normalizeName(o.name) === target)) {
      throw new Error('name-collision');
    }
    if (s.name === trimmed) {
      return { session: s, skipUpdatedAt: true };
    }
    s.name = trimmed;
    return { session: s, skipUpdatedAt: false };
  });
}

async function duplicateSession(id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { items, writeToken } = await readSessions();
    const src = items.find(s => s.id === id);
    if (!src) throw new Error('gone');

    const base = src.name.replace(/ \(copy(?: \d+)?\)$/, '');
    const taken = new Set(items.filter(s => s.kind === 'named').map(s => normalizeName(s.name)));
    const candidate = buildSuffixedSessionName(base, 'copy', taken);

    const copy = structuredClone(src);
    copy.id = ulid();
    copy.rev = 0;
    copy.name = candidate;
    copy.kind = 'named';
    const now = new Date().toISOString();
    copy.savedAt = now;
    copy.updatedAt = now;

    const ok = await setSessionsIfUnchanged(writeToken, [copy, ...items]);
    if (ok) return copy;
  }
  throw new Error('write-conflict');
}

async function deleteSession(id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [{ items, writeToken }, { items: trashItems, writeToken: trashWriteToken }] = await Promise.all([readSessions(), readTrash()]);
    const target = items.find(s => s.id === id);
    if (!target) return null;
    const trashRecord = buildTrashRecord({ reason: 'deleted', session: target });
    const ok = await writeSessionsAndTrashAtomic({
      sessionsItems: items.filter(s => s.id !== id),
      expectedSessionsToken: writeToken,
      trashItems: prependTrashRecord(trashItems, trashRecord),
      expectedTrashToken: trashWriteToken
    });
    if (ok) return trashRecord.trashId;
  }
  throw new Error('write-conflict');
}

async function saveAsNamedSession({ fromSnapshotOrId, name: rawName }) {
  const name = clampSessionName(rawName);
  if (!name) throw new Error('empty-name');
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
    name,
    kind: 'named',
    savedAt: now,
    updatedAt: now,
    summary: structuredClone(src.summary),
    tabs: structuredClone(src.tabs),
    groups: structuredClone(src.groups || {})
  };
  await appendSession(created, { requireNameUnique: true });
  return created;
}

/* ----------------------------------------------------------------
   TRASH — 7-day retention, 50-item cap, lazy-purge on read
   ---------------------------------------------------------------- */

const TRASH_MAX_ITEMS = 50;
const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function readTrash() {
  let { sessionsTrash } = await chrome.storage.local.get('sessionsTrash');
  if (!sessionsTrash || typeof sessionsTrash !== 'object') {
    const created = await setTrashIfUnchanged(null, []);
    if (created) {
      return { schemaVersion: TRASH_SCHEMA_VERSION, items: [], writeToken: _lastSelfTrashWriteToken };
    }
    const latest = await chrome.storage.local.get('sessionsTrash');
    sessionsTrash = latest.sessionsTrash;
    if (!sessionsTrash || typeof sessionsTrash !== 'object') {
      return { schemaVersion: TRASH_SCHEMA_VERSION, items: [], writeToken: null };
    }
  }
  const raw = Array.isArray(sessionsTrash.items) ? sessionsTrash.items : [];
  const now = Date.now();
  const kept = raw.filter(item => {
    const age = now - new Date(item.trashedAt).getTime();
    return Number.isFinite(age) && age >= 0 && age < TRASH_RETENTION_MS;
  });
  let resultItems = kept;
  let resultWriteToken = sessionsTrash.writeToken || null;
  if (kept.length !== raw.length) {
    let nextItems = kept;
    let expectedWriteToken = resultWriteToken;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ok = await setTrashIfUnchanged(expectedWriteToken, nextItems);
      if (ok) {
        resultItems = nextItems;
        resultWriteToken = _lastSelfTrashWriteToken;
        break;
      }
      const { sessionsTrash: latestTrash } = await chrome.storage.local.get('sessionsTrash');
      if (!latestTrash || typeof latestTrash !== 'object') {
        resultItems = [];
        resultWriteToken = null;
        break;
      }
      const latestRaw = Array.isArray(latestTrash.items) ? latestTrash.items : [];
      nextItems = latestRaw.filter(item => {
        const age = now - new Date(item.trashedAt).getTime();
        return Number.isFinite(age) && age >= 0 && age < TRASH_RETENTION_MS;
      });
      resultItems = nextItems;
      resultWriteToken = latestTrash.writeToken || null;
      if (nextItems.length === latestRaw.length) break;
      expectedWriteToken = resultWriteToken;
    }
  }
  return { schemaVersion: TRASH_SCHEMA_VERSION, items: resultItems, writeToken: resultWriteToken };
}

async function writeTrash(items) {
  const writeToken = newTrashWriteToken();
  _trashSelfWriteSuppress++;
  await chrome.storage.local.set({ sessionsTrash: { schemaVersion: TRASH_SCHEMA_VERSION, items, writeToken } });
}

function buildTrashRecord({ reason, session, removedTab, parentSessionId, parentSessionName }) {
  return {
    trashId: 'tr_' + ulid(),
    trashedAt: new Date().toISOString(),
    reason,
    session: session ? structuredClone(session) : undefined,
    removedTab: removedTab ? structuredClone(removedTab) : undefined,
    parentSessionId: parentSessionId != null ? parentSessionId : undefined,
    parentSessionName: parentSessionName != null ? parentSessionName : undefined
  };
}

function prependTrashRecord(items, record) {
  const next = [record, ...items];
  return next.length > TRASH_MAX_ITEMS ? next.slice(0, TRASH_MAX_ITEMS) : next;
}

async function trashAdd({ reason, session, removedTab, parentSessionId, parentSessionName }) {
  const record = buildTrashRecord({ reason, session, removedTab, parentSessionId, parentSessionName });
  for (let attempt = 0; attempt < 3; attempt++) {
    const { items, writeToken } = await readTrash();
    const ok = await setTrashIfUnchanged(writeToken, prependTrashRecord(items, record));
    if (ok) return record;
  }
  throw new Error('write-conflict');
}

async function trashDrop(trashId) {
  // Trash-only writes use a dedicated trash CAS helper instead of re-reading sessions.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { items, writeToken } = await readTrash();
    const nextItems = items.filter(r => r.trashId !== trashId);
    if (nextItems.length === items.length) return;
    const ok = await setTrashIfUnchanged(writeToken, nextItems);
    if (ok) return;
  }
  throw new Error('write-conflict');
}

async function trashRestore(trashId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [{ items: sessionItems, writeToken: sessionWriteToken }, { items: trashItems, writeToken: trashWriteToken }] = await Promise.all([readSessions(), readTrash()]);
    const record = trashItems.find(r => r.trashId === trashId);
    if (!record) return null;
    let nextTrashItems = trashItems.filter(r => r.trashId !== trashId);

    if (record.reason === 'deleted' && record.session) {
      const taken = new Set(sessionItems.filter(s => s.kind === 'named').map(s => normalizeName(s.name)));
      let name = clampSessionName(record.session.name) || 'Restored session';
      if (taken.has(normalizeName(name))) {
        name = buildSuffixedSessionName(name, 'restored', taken);
      }
      const restored = structuredClone(record.session);
      restored.id = ulid();
      restored.rev = 0;
      restored.name = name;
      restored.updatedAt = new Date().toISOString();
      const ok = await writeSessionsAndTrashAtomic({
        sessionsItems: [restored, ...sessionItems],
        expectedSessionsToken: sessionWriteToken,
        trashItems: nextTrashItems,
        expectedTrashToken: trashWriteToken
      });
      if (ok) return record;
      continue;
    }

    if (record.reason === 'snapshot-overwritten' && record.session) {
      const existing = sessionItems.find(s => s.id === SNAPSHOT_ID);
      const previous = existing ? structuredClone(existing) : null;
      const snapshot = buildSnapshotSession({
        existing,
        tabs: record.session.tabs,
        groups: record.session.groups,
        summary: record.session.summary
      });
      const filtered = sessionItems.filter(s => s.id !== SNAPSHOT_ID);
      if (previous) {
        const overwrittenRecord = buildTrashRecord({ reason: 'snapshot-overwritten', session: previous });
        nextTrashItems = prependTrashRecord(nextTrashItems, overwrittenRecord);
      }
      const ok = await writeSessionsAndTrashAtomic({
        sessionsItems: [snapshot, ...filtered],
        expectedSessionsToken: sessionWriteToken,
        trashItems: nextTrashItems,
        expectedTrashToken: trashWriteToken
      });
      if (ok) return record;
      continue;
    }

    if (record.reason === 'tab-removed' && record.removedTab) {
      const parentId = record.parentSessionId;
      const parentIdx = sessionItems.findIndex(s => s.id === parentId);
      if (parentIdx === -1) {
        const recoveredTab = structuredClone(record.removedTab);
        recoveredTab.savedGroupKey = null;
        const tabs = [recoveredTab];
        let recoveredName = clampSessionName(`Recovered tab · ${timeAgo(record.trashedAt)}`) || 'Recovered tab';
        if (record.parentSessionName && record.parentSessionName.trim()) {
          const parentSessionName = clampSessionName(record.parentSessionName);
          const taken = new Set(sessionItems.filter(s => s.kind === 'named').map(s => normalizeName(s.name)));
          recoveredName = buildSuffixedSessionName(parentSessionName || 'Recovered tab', 'recovered', taken);
        }
        const now = new Date().toISOString();
        const restored = {
          id: ulid(),
          rev: 0,
          name: recoveredName,
          kind: 'named',
          savedAt: now,
          updatedAt: now,
          summary: computeSummary(tabs),
          tabs,
          groups: {}
        };
        const ok = await writeSessionsAndTrashAtomic({
          sessionsItems: [restored, ...sessionItems],
          expectedSessionsToken: sessionWriteToken,
          trashItems: nextTrashItems,
          expectedTrashToken: trashWriteToken
        });
        if (ok) return record;
        continue;
      }

      const current = sessionItems[parentIdx];
      const updated = structuredClone(current);
      const restoredTab = structuredClone(record.removedTab);
      if (restoredTab.savedGroupKey != null && !Object.prototype.hasOwnProperty.call(updated.groups || {}, restoredTab.savedGroupKey)) {
        restoredTab.savedGroupKey = null;
      }
      const insertAt = Math.min(Math.max(0, restoredTab.index), updated.tabs.length);
      updated.tabs.splice(insertAt, 0, restoredTab);
      updated.summary = computeSummary(updated.tabs);
      updated.rev = (current.rev || 0) + 1;
      updated.updatedAt = new Date().toISOString();
      const nextSessions = sessionItems.slice();
      nextSessions[parentIdx] = updated;
      const ok = await writeSessionsAndTrashAtomic({
        sessionsItems: nextSessions,
        expectedSessionsToken: sessionWriteToken,
        trashItems: nextTrashItems,
        expectedTrashToken: trashWriteToken
      });
      if (ok) return record;
      continue;
    }

    const ok = await setTrashIfUnchanged(trashWriteToken, nextTrashItems);
    if (ok) return record;
  }
  throw new Error('write-conflict');
}

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

async function removeTabFromSession(sessionId, tabIndex) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [{ items, writeToken }, { items: trashItems, writeToken: trashWriteToken }] = await Promise.all([readSessions(), readTrash()]);
    const idx = items.findIndex(s => s.id === sessionId);
    if (idx === -1) throw new Error('session-gone');
    const current = items[idx];
    if (!current.tabs[tabIndex]) throw new Error('gone');

    const updated = structuredClone(current);
    const removedTab = structuredClone({ ...updated.tabs[tabIndex], index: tabIndex });
    const removedGroupKey = updated.tabs[tabIndex].savedGroupKey;
    updated.tabs.splice(tabIndex, 1);
    if (removedGroupKey != null && !updated.tabs.some(tab => tab.savedGroupKey === removedGroupKey)) {
      delete updated.groups[removedGroupKey];
      removedTab.savedGroupKey = null;
    }
    updated.rev = (current.rev || 0) + 1;
    updated.updatedAt = new Date().toISOString();
    updated.summary = computeSummary(updated.tabs);

    const trashRecord = buildTrashRecord({
      reason: 'tab-removed',
      removedTab,
      parentSessionId: sessionId,
      parentSessionName: current.name
    });
    const nextSessions = items.slice();
    nextSessions[idx] = updated;
    const ok = await writeSessionsAndTrashAtomic({
      sessionsItems: nextSessions,
      expectedSessionsToken: writeToken,
      trashItems: prependTrashRecord(trashItems, trashRecord),
      expectedTrashToken: trashWriteToken
    });
    if (ok) return trashRecord.trashId;
  }
  throw new Error('write-conflict');
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

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

/* ----------------------------------------------------------------
   STORAGE CHANGE SYNC — keep multiple new-tab pages consistent
   ---------------------------------------------------------------- */

let _lastSelfWriteToken = null;
let _lastSelfTrashWriteToken = null;
let _deferredSelfWriteSuppress = 0;
let _trashSelfWriteSuppress = 0;

function newWriteToken() {
  const t = 'wt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  _lastSelfWriteToken = t;
  return t;
}

function newTrashWriteToken() {
  const t = 'twt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  _lastSelfTrashWriteToken = t;
  return t;
}

function showWriteConflictToast() {
  showToast({ message: 'Another Tab Out tab changed this session — reload to see the latest.' });
}

function isQuotaError(e) {
  const msg = String(e && e.message ? e.message : e || '');
  return msg.toLowerCase().includes('quota') || msg.includes('QUOTA_BYTES');
}

function showQuotaToast() {
  showToast({ message: 'Storage full — empty the Trash or delete old sessions.' });
}

function installStorageSync() {
  if (!chrome.storage || !chrome.storage.onChanged) return;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (changes.sessions) {
      const nv = changes.sessions.newValue;
      if (_lastSelfWriteToken && nv && nv.writeToken === _lastSelfWriteToken) return;
      renderSessionsPane();
      updateSidebarVisibility();
    }
    if (changes.sessionsTrash) {
      if (_trashSelfWriteSuppress > 0) {
        _trashSelfWriteSuppress--;
        return;
      }
      const nv = changes.sessionsTrash.newValue;
      if (_lastSelfTrashWriteToken && nv && nv.writeToken === _lastSelfTrashWriteToken) return;
      renderTrashPane();
      updateSidebarVisibility();
    }
    if (changes.sessionsQuarantine) {
      renderTrashPane();
      updateSidebarVisibility();
    }
    if (changes.deferred) {
      if (_deferredSelfWriteSuppress > 0) {
        _deferredSelfWriteSuppress--;
        return;
      }
      renderSidebar();
      updateSidebarVisibility();
    }
    if (changes.workspaceLinks) {
      const nv = changes.workspaceLinks.newValue;
      if (_lastSelfWorkspaceWriteToken && nv && nv.writeToken === _lastSelfWorkspaceWriteToken) return;
      renderWorkspaceSection();
    }
  });
}

/* ----------------------------------------------------------------
   PERMISSIONS
   ---------------------------------------------------------------- */

let _faviconPermissionGranted = false;
let _faviconPromptAttempted = false;

async function ensureFaviconPermission({ prompt = false } = {}) {
  const currentlyGranted = await chrome.permissions.contains({ permissions: ['favicon'] });
  if (currentlyGranted) {
    _faviconPermissionGranted = true;
    return true;
  }

  if (prompt) {
    const requested = await chrome.permissions.request({ permissions: ['favicon'] });
    _faviconPermissionGranted = !!requested;
    return _faviconPermissionGranted;
  }

  _faviconPermissionGranted = false;
  return _faviconPermissionGranted;
}

async function ensureTabGroupsPermission({ prompt = false } = {}) {
  const currentlyGranted = await chrome.permissions.contains({ permissions: ['tabGroups'] });
  if (currentlyGranted) return true;

  if (prompt) {
    return !!(await chrome.permissions.request({ permissions: ['tabGroups'] }));
  }

  return false;
}

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

/* ----------------------------------------------------------------
   FAVICON RENDERING
   Returns an <img> that uses Chrome's _favicon endpoint when granted,
   or a letter-chip fallback element.
   ---------------------------------------------------------------- */

function faviconEl(url, size = 16, { promptContext = '' } = {}) {
  // promptContext is accepted for call-site compatibility but no longer
  // triggers a runtime permission prompt — chrome.permissions.request requires
  // a user gesture, which render paths don't have. Users can grant the
  // "favicon" permission from chrome://extensions if they want real favicons;
  // otherwise the letter-chip fallback is used.
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
      style: {
        verticalAlign: '-2px',
        borderRadius: '2px',
        flexShrink: '0'
      }
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
  actionSlot.replaceChildren();

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
  setTimeout(_toastPump, 320);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return hostname.replace('.substack.com', '').toLowerCase() + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return hostname.replace('.github.io', '').toLowerCase() + ' (GitHub Pages)';
  }

  return hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '')
    .toLowerCase();
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
async function checkTabOutDupes() {
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  let tabOutCount = 0;
  try {
    const extensionId = chrome.runtime.id;
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;
    const allTabs = await chrome.tabs.query({});
    tabOutCount = allTabs.filter(t =>
      t.url === newtabUrl || t.url === 'chrome://newtab/'
    ).length;
  } catch {
    banner.style.display = 'none';
    return;
  }

  if (tabOutCount > 1) {
    if (countEl) countEl.textContent = tabOutCount;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildPageChip(tab, label, count) {
  const chip = el('div', {
    class: `page-chip clickable${count > 1 ? ' chip-has-dupes' : ''}`,
    'data-action': 'focus-tab',
    'data-tab-url': tab.url,
    title: label
  }, [
    faviconEl(tab.url, 14),
    el('span', { class: 'chip-text' }, label),
    count > 1 ? el('span', { class: 'chip-dupe-badge' }, `(${count}x)`) : null
  ]);

  const saveBtn = el('button', {
    class: 'chip-action chip-save',
    'data-action': 'defer-single-tab',
    'data-tab-url': tab.url,
    'data-tab-title': label,
    title: 'Save for later'
  });
  saveBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>';

  const closeBtn = el('button', {
    class: 'chip-action chip-close',
    'data-action': 'close-single-tab',
    'data-tab-url': tab.url,
    title: 'Close this tab'
  });
  closeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>';

  chip.appendChild(el('div', { class: 'chip-actions' }, [saveBtn, closeBtn]));
  return chip;
}

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count = urlCounts[tab.url] || 1;
    return buildPageChip(tab, label, count);
  });

  return [
    el('div', { class: 'page-chips-overflow', style: { display: 'none' } }, hiddenChips),
    el('div', {
      class: 'page-chip page-chip-overflow clickable',
      'data-action': 'expand-chips'
    }, el('span', { class: 'chip-text' }, `+${hiddenTabs.length} more`))
  ];
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const dupeBadge = hasDupes
    ? el('span', {
      class: 'open-tabs-badge',
      style: {
        color: 'var(--accent-amber)',
        background: 'rgba(200,113,58,0.08)'
      }
    }, `${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}`)
    : null;

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    return buildPageChip(tab, label, urlCounts[tab.url]);
  });
  if (extraCount > 0) pageChips.push(...buildOverflowChips(uniqueTabs.slice(8), urlCounts));

  const closeIcon = el('span');
  closeIcon.innerHTML = ICONS.close;
  const actions = [
    el('button', {
      class: 'action-btn close-tabs',
      'data-action': 'close-domain-tabs',
      'data-domain-id': stableId
    }, [
      closeIcon,
      textNode(` Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}`)
    ])
  ];

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actions.push(
      el('button', {
        class: 'action-btn',
        'data-action': 'dedup-keep-one',
        'data-dupe-urls': dupeUrlsEncoded
      }, `Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}`)
    );
  }

  return el('div', {
    class: `mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}`,
    'data-domain-id': stableId
  }, [
    el('div', { class: 'status-bar' }),
    el('div', { class: 'mission-content' }, [
      el('div', { class: 'mission-top' }, [
        el('span', { class: 'mission-name' }, isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))),
        dupeBadge
      ]),
      el('div', { class: 'mission-pages' }, pageChips),
      el('div', { class: 'actions' }, actions)
    ]),
    el('div', { class: 'mission-meta' }, [
      el('div', { class: 'mission-page-count' }, String(tabCount)),
      el('div', { class: 'mission-page-label' }, 'tabs')
    ])
  ]);
}


/* ----------------------------------------------------------------
   SIDEBAR STATE & PANE ROUTER
   ---------------------------------------------------------------- */

let _lastDeferred = [];
let _lastSessionsCount = 0;
let _lastTrashCount = 0;
const sidebarState = { pane: 'deferred' };

function updateSidebarVisibility() {
  const col = document.getElementById('sidebarColumn');
  if (!col) return;
  const hasDeferred = (_lastDeferred || []).some(d => !d.dismissedAt);
  const hasSessions = (_lastSessionsCount || 0) > 0;
  const hasTrash = (_lastTrashCount || 0) > 0;
  col.style.display = (hasDeferred || hasSessions || hasTrash) ? 'block' : 'none';
}

async function initSidebarState() {
  const stored = await chrome.storage.local.get('sidebarPane');
  if (stored.sidebarPane) {
    sidebarState.pane = stored.sidebarPane;
    return;
  }
  const { items } = await readSessions();
  sidebarState.pane = items.length > 0 ? 'sessions' : 'deferred';
}

async function switchSidebarPane(pane) {
  sidebarState.pane = pane;
  await chrome.storage.local.set({ sidebarPane: pane });
  syncSidebarPaneState(pane);
  await renderSidebar();
  updateSidebarVisibility();
}

function syncSidebarPaneState(pane) {
  document.querySelectorAll('#sidebarPills .pill').forEach(p => {
    p.classList.toggle('pill-active', p.dataset.pane === pane);
  });

  const trashLink = document.getElementById('trashLink');
  if (trashLink) trashLink.classList.toggle('trash-link-active', pane === 'trash');
}

async function renderSidebar() {
  const pane = sidebarState.pane || 'deferred';

  syncSidebarPaneState(pane);

  const deferredPane = document.getElementById('deferredPane');
  const sessionsPane = document.getElementById('sessionsPane');
  const trashPane = document.getElementById('trashPane');
  if (deferredPane) deferredPane.style.display = pane === 'deferred' ? 'block' : 'none';
  if (sessionsPane) sessionsPane.style.display = pane === 'sessions' ? 'block' : 'none';
  if (trashPane) trashPane.style.display = pane === 'trash' ? 'block' : 'none';

  await renderDeferredPane();
  await renderTrashPane();

  const deferredActive = (_lastDeferred || []).filter(d => !d.completedAt && !d.dismissedAt).length;
  const deferredPillCount = document.getElementById('deferredPillCount');
  if (deferredPillCount) deferredPillCount.textContent = deferredActive;

  const sessionsPillCount = document.getElementById('sessionsPillCount');
  if (sessionsPillCount) sessionsPillCount.textContent = _lastSessionsCount;

  const trashLink = document.getElementById('trashLink');
  if (trashLink) trashLink.style.display = _lastTrashCount > 0 ? '' : 'none';

  const trashLinkCount = document.getElementById('trashLinkCount');
  if (trashLinkCount) trashLinkCount.textContent = _lastTrashCount;

  updateSidebarVisibility();
}

async function renderSessionsPane() {
  const pane = document.getElementById('sessionsPane');
  if (!pane) return;

  const { items } = await readSessions();
  _lastSessionsCount = items.length;

  const pillCount = document.getElementById('sessionsPillCount');
  if (pillCount) pillCount.textContent = items.length;

  const q = _sessionSearchQuery || '';
  const shouldRestoreSearchFocus = _sessionSearchRestoreFocus || document.activeElement?.id === 'sessionsSearchInput';
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
    updateSidebarVisibility();
    return;
  }

  // Search input
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

  if (shouldRestoreSearchFocus) {
    const input = document.getElementById('sessionsSearchInput');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
  _sessionSearchRestoreFocus = false;

  updateSidebarVisibility();
}

async function maybeShowFirstSaveBanner() {
  const { _tabOutFirstSaveBannerDismissed } = await chrome.storage.local.get('_tabOutFirstSaveBannerDismissed');
  if (_tabOutFirstSaveBannerDismissed) return;

  const pane = document.getElementById('sessionsPane');
  if (!pane || pane.querySelector('.first-save-banner')) return;

  const banner = el('div', { class: 'first-save-banner' }, [
    el('div', { class: 'first-save-banner-text' }, textNode(
      'Tab Out saves full URLs including query parameters. If a tab contains a password-reset link or other sensitive URL, remove the tab from the session before saving. Your data stays on this device.'
    )),
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

function renderSessionCard(session, q = '') {
  const isSnapshot = session.kind === 'snapshot';
  const isExpanded = _expandedSessions.has(session.id);
  const isEmptySession = session.tabs.length === 0;

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

  const children = [header, meta];

  if (isEmptySession) {
    children.push(el('div', { class: 'session-empty-state' }, [
      el('div', { class: 'session-empty-title' }, '0 tabs (all removed)'),
      el('div', { class: 'session-empty-actions' }, [
        el('button', {
          class: 'session-empty-action',
          'data-action': 'session-open-trash',
          'data-session-id': session.id
        }, 'Restore from Trash'),
        el('button', {
          class: 'session-empty-action session-empty-delete',
          'data-action': 'session-delete',
          'data-session-id': session.id
        }, 'Delete')
      ])
    ]));
  } else {
    children.push(el('div', { class: 'session-favicon-row' },
      (session.summary.topDomains || []).map(d => faviconEl('https://' + d.hostname, 16, { promptContext: 'sessions' }))
    ));
    if (isExpanded) {
      const list = el('div', { class: 'session-tab-list' },
        session.tabs.map((t, i) => renderSessionTabRow(session.id, t, i, q)));
      children.push(list);
    }
  }

  // Flip chevron character when expanded
  chevron.textContent = isExpanded ? '▾' : '▸';

  const cardAttrs = {
    class: 'session-card' + (isSnapshot ? ' session-card-snapshot' : ''),
    'data-session-id': session.id,
    'data-session-kind': session.kind
  };
  if (!isEmptySession) cardAttrs['data-action'] = 'session-reopen';
  const card = el('div', cardAttrs, children);

  return card;
}

function renderSessionTabRow(sessionId, tab, tabIndex, q = '') {
  const matched = q && tabMatchesQuery(tab, q.toLowerCase());
  const closeBtn = el('button', {
    class: 'session-tab-close',
    'data-action': 'session-tab-remove',
    'data-session-id': sessionId,
    'data-tab-index': String(tabIndex),
    title: 'Remove from session'
  }, '✕');

  return el('div', {
    class: 'session-tab-row' + (matched ? ' session-tab-match' : ''),
    'data-action': 'session-tab-open',
    'data-session-id': sessionId,
    'data-tab-index': String(tabIndex)
  }, [
    faviconEl(tab.url, 14, { promptContext: 'sessions' }),
    textNode(' '),
    el('span', { class: 'session-tab-title' }, tab.title || tab.url),
    closeBtn
  ]);
}

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
      _sessionSearchRestoreFocus = true;
      applySessionsSearch();
    }, 150);
  });

  return input;
}

let _sessionSearchQuery = '';
let _sessionSearchRestoreFocus = false;
let _openKebab = null;
let _kebabOpenToken = 0;
const _expandedSessions = new Set();

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

async function applySessionsSearch() {
  await renderSessionsPane();
}

async function openSessionKebab(sessionId, anchorEl) {
  const token = ++_kebabOpenToken;
  closeSessionKebab();

  const session = await _getSessionById(sessionId);
  if (token !== _kebabOpenToken) return;
  if (!anchorEl.isConnected) return;
  if (!session) return;

  const menu = el('div', { class: 'session-kebab-menu' }, [
    el('button', { 'data-action': 'session-reopen-menu', 'data-session-id': sessionId }, 'Reopen'),
    session.kind === 'named'
      ? el('button', { 'data-action': 'session-rename', 'data-session-id': sessionId }, 'Rename')
      : el('button', { 'data-action': 'session-save-as-named', 'data-session-id': sessionId }, 'Save as named session'),
    el('button', { 'data-action': 'session-duplicate', 'data-session-id': sessionId }, 'Duplicate'),
    el('button', { 'data-action': 'session-delete', 'data-session-id': sessionId, class: 'kebab-destructive' }, 'Delete')
  ]);

  menu.style.position = 'fixed';
  menu.style.top = '-9999px';
  menu.style.left = '-9999px';
  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = Math.max(8, rect.right - menuRect.width);
  if (top + menuRect.height > window.innerHeight) {
    top = rect.top - menuRect.height - 4;
  }
  if (left + menuRect.width > window.innerWidth - 8) {
    left = window.innerWidth - menuRect.width - 8;
  }
  menu.style.top = top + 'px';
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.visibility = '';
  _openKebab = menu;
}

function closeSessionKebab() {
  if (_openKebab) { _openKebab.remove(); _openKebab = null; }
}

async function _getSessionById(id) {
  const { items } = await readSessions();
  return items.find(s => s.id === id);
}

function toggleSessionExpand(sessionId) {
  if (_expandedSessions.has(sessionId)) _expandedSessions.delete(sessionId);
  else _expandedSessions.add(sessionId);
  renderSessionsPane();
}

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
    maxlength: '120',
    'data-action': 'none'
  });
  const errorEl = el('div', {
    class: 'session-rename-error',
    style: { display: 'none' },
    'data-action': 'none'
  });
  const renameWrap = el('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      flex: '1',
      minWidth: '0'
    },
    'data-action': 'none'
  }, [input, errorEl]);
  nameEl.replaceWith(renameWrap);
  for (const target of [renameWrap, input]) {
    for (const eventName of ['click', 'focus', 'mousedown']) {
      target.addEventListener(eventName, e => e.stopPropagation());
    }
  }
  input.focus();
  input.select();

  let renameCancelled = false;

  const clearInlineError = () => {
    errorEl.textContent = '';
    errorEl.style.display = 'none';
  };

  const commit = async () => {
    if (renameCancelled) return;
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
        errorEl.textContent = `A session named "${newName}" already exists.`;
        errorEl.style.display = 'block';
        requestAnimationFrame(() => {
          if (input.isConnected) {
            input.focus();
            input.select();
          }
        });
        return;
      }
      if (e.message === 'write-conflict') {
        showWriteConflictToast();
      } else {
        showToast({ message: 'Rename failed — see console.' });
        console.error('[tab-out] rename failed', e);
      }
      renderSessionsPane();
    }
  };

  input.oninput = () => {
    clearInlineError();
  };
  input.onblur = commit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      renameCancelled = true;
      renderSessionsPane();
    }
  };
}

async function renderTrashPane() {
  const pane = document.getElementById('trashPane');
  if (!pane) return;

  const [{ items }, quarantineItems] = await Promise.all([readTrash(), readSessionsQuarantineItems()]);
  const totalCount = items.length + quarantineItems.length;
  _lastTrashCount = totalCount;

  const link = document.getElementById('trashLink');
  const linkCount = document.getElementById('trashLinkCount');
  if (link && linkCount) {
    linkCount.textContent = totalCount;
    link.style.display = totalCount > 0 ? 'inline' : 'none';
  }

  pane.replaceChildren();

  if (totalCount === 0) {
    pane.appendChild(el('div', { class: 'sessions-empty' }, 'Trash is empty.'));
    updateSidebarVisibility();
    return;
  }

  pane.appendChild(el('div', { class: 'trash-header' }, 'Trash · 7-day retention'));

  const sessionRecords = items.filter(r => r.reason === 'deleted' || r.reason === 'snapshot-overwritten');
  const tabRecords = items.filter(r => r.reason === 'tab-removed');

  if (sessionRecords.length > 0) {
    pane.appendChild(el('div', { class: 'sessions-divider' }, 'Sessions'));
    for (const r of sessionRecords) {
      pane.appendChild(renderTrashSessionCard(r));
    }
  }

  if (tabRecords.length > 0) {
    pane.appendChild(el('div', { class: 'sessions-divider' }, 'Removed tabs'));
    for (const r of tabRecords) pane.appendChild(renderTrashTabCard(r));
  }

  appendQuarantineSection(pane, quarantineItems);
  updateSidebarVisibility();
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
  const parentName = (record.parentSessionName && record.parentSessionName.trim())
    || (record.parentSessionId ? `session ${record.parentSessionId.slice(-6)}` : 'unknown');
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

async function readSessionsQuarantineItems() {
  const { sessionsQuarantine } = await chrome.storage.local.get('sessionsQuarantine');
  if (!sessionsQuarantine || typeof sessionsQuarantine !== 'object') return [];
  const rawItems = Array.isArray(sessionsQuarantine.items) ? sessionsQuarantine.items : [];
  const needsMigration = rawItems.some(item =>
    !item
    || typeof item !== 'object'
    || Array.isArray(item)
    || typeof item.quarantineId !== 'string'
    || !item.quarantineId
    || typeof item.quarantinedAt !== 'string'
    || !Object.prototype.hasOwnProperty.call(item, 'raw')
  ) || sessionsQuarantine.schemaVersion !== QUARANTINE_SCHEMA_VERSION;
  if (!needsMigration) return rawItems;

  const items = rawItems.map(item => ({
    quarantineId: item && typeof item === 'object' && !Array.isArray(item) && typeof item.quarantineId === 'string' && item.quarantineId
      ? item.quarantineId
      : 'qrn_' + ulid(),
    quarantinedAt: item && typeof item === 'object' && !Array.isArray(item) && typeof item.quarantinedAt === 'string'
      ? item.quarantinedAt
      : new Date().toISOString(),
    raw: item && typeof item === 'object' && !Array.isArray(item) && Object.prototype.hasOwnProperty.call(item, 'raw')
      ? item.raw
      : item
  }));
  await writeSessionsQuarantineItems(items);
  return items;
}

async function writeSessionsQuarantineItems(items) {
  await chrome.storage.local.set({
    sessionsQuarantine: { schemaVersion: QUARANTINE_SCHEMA_VERSION, items }
  });
}

function appendQuarantineSection(pane, items) {
  if (items.length === 0) return;

  pane.appendChild(el('div', { class: 'sessions-divider' }, 'Quarantine'));
  items.forEach(q => {
    pane.appendChild(el('div', { class: 'trash-card' }, [
      el('div', { class: 'trash-card-title' }, 'Invalid session (schema mismatch)'),
      el('div', { class: 'trash-card-meta' }, 'Quarantined ' + timeAgo(q.quarantinedAt)),
      el('div', { class: 'trash-card-actions' }, [
        el('button', {
          class: 'trash-restore',
          'data-action': 'quarantine-restore',
          'data-quarantine-id': q.quarantineId
        }, 'Restore'),
        el('button', {
          class: 'trash-drop',
          'data-action': 'quarantine-drop',
          'data-quarantine-id': q.quarantineId
        }, 'Delete permanently')
      ])
    ]));
  });
}

async function quarantineRestore(quarantineId) {
  const items = await readSessionsQuarantineItems();
  const record = items.find(item => item.quarantineId === quarantineId);
  if (!record) return null;

  const raw = record && record.raw && typeof record.raw === 'object' && !Array.isArray(record.raw)
    ? record.raw
    : {};
  const now = new Date().toISOString();
  const { items: sessionItems } = await readSessions();
  const takenNames = new Set(sessionItems.filter(s => s.kind === 'named').map(s => normalizeName(s.name)));
  const takenIds = new Set(sessionItems.map(s => s.id));

  let restoredId = (typeof raw.id === 'string' && raw.id) ? raw.id : ulid();
  if (restoredId === SNAPSHOT_ID || takenIds.has(restoredId)) {
    restoredId = ulid();
  }

  let restoredName = clampSessionName(raw.name) || 'Restored session';
  if (takenNames.has(normalizeName(restoredName))) {
    restoredName = buildSuffixedSessionName(restoredName, 'restored', takenNames);
  }

  const tabs = Array.isArray(raw.tabs)
    ? raw.tabs
      .filter(t => t && typeof t.url === 'string' && /^https?:\/\//i.test(t.url))
      .map(t => ({
        url: t.url,
        title: typeof t.title === 'string'
          ? t.title
          : (() => {
            try { return new URL(t.url).hostname; }
            catch { return t.url; }
          })(),
        favIconUrl: '',
        pinned: !!t.pinned,
        index: typeof t.index === 'number' ? t.index : 0,
        savedGroupKey: null
      }))
    : [];

  if (tabs.length === 0) {
    showToast({ message: 'Cannot restore — no valid tabs.' });
    return null;
  }

  const coerced = {
    id: restoredId,
    rev: typeof raw.rev === 'number' ? raw.rev : 0,
    kind: 'named',
    name: restoredName,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : now,
    updatedAt: now,
    tabs,
    groups: {}
  };
  coerced.summary = computeSummary(coerced.tabs);

  if (!validateSession(coerced)) {
    showToast({ message: 'Cannot restore — record too corrupted.' });
    return null;
  }

  await appendSession(coerced, { requireNameUnique: true });
  await writeSessionsQuarantineItems(items.filter(item => item.quarantineId !== quarantineId));
  return coerced;
}

async function reopenSession(sessionId) {
  const { items } = await readSessions();
  const session = items.find(s => s.id === sessionId);
  if (!session) return;

  if (session.tabs.length === 0) {
    showToast({ message: 'Session is empty' });
    return;
  }

  const valid = session.tabs.filter(t => ALLOWED_SCHEMES.test(t.url));
  const dropped = session.tabs.length - valid.length;

  if (valid.length === 0) {
    showToast({ message: 'Cannot reopen — all saved URLs were invalid.' });
    return;
  }

  if (dropped > 0) {
    showToast({ message: `Reopening ${valid.length}/${session.tabs.length} tabs (${dropped} had invalid URLs)` });
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

  const populated = await chrome.windows.get(newWindow.id, { populate: true });
  const createdTabs = (populated.tabs || []).slice().sort((a, b) => a.index - b.index);
  const createdCount = createdTabs.length;

  let pinRestoreFailCount = 0;
  let unpinnedTabCount = 0;
  let groupRestoreFailCount = 0;
  let ungroupedTabCount = 0;

  for (let i = 0; i < valid.length; i++) {
    const savedTab = valid[i];
    const createdTab = createdTabs[i];
    if (!savedTab.pinned) continue;
    if (!createdTab) {
      unpinnedTabCount++;
      continue;
    }
    try {
      await chrome.tabs.update(createdTab.id, { pinned: true });
    } catch (e) {
      pinRestoreFailCount++;
      console.warn('[tab-out] pin failed', e);
    }
  }

  if (session.groups && Object.keys(session.groups).length > 0) {
    const granted = await ensureTabGroupsPermission({ prompt: false });
    if (granted) {
      const bySavedKey = new Map();
      for (let i = 0; i < valid.length; i++) {
        const savedTab = valid[i];
        const k = savedTab.savedGroupKey;
        if (!k) continue;
        const createdTab = createdTabs[i];
        if (!createdTab) {
          ungroupedTabCount++;
          continue;
        }
        if (!bySavedKey.has(k)) bySavedKey.set(k, []);
        bySavedKey.get(k).push(createdTab.id);
      }
      for (const [savedKey, tabIds] of bySavedKey) {
        const meta = session.groups[savedKey];
        if (!meta) continue;
        const color = typeof meta.color === 'string' && VALID_GROUP_COLORS.has(meta.color)
          ? meta.color
          : 'grey';
        try {
          const gid = await chrome.tabs.group({ tabIds, createProperties: { windowId: newWindow.id } });
          await chrome.tabGroups.update(gid, { title: meta.title, color });
        } catch (e) {
          groupRestoreFailCount++;
          console.warn('[tab-out] group restore failed', e);
        }
      }
    }
  }

  const parts = [`Opened ${createdCount} tab${createdCount === 1 ? '' : 's'} in new window`];
  if (createdCount < valid.length) parts.push(`${valid.length - createdCount} not created`);
  if (pinRestoreFailCount > 0) parts.push(`${pinRestoreFailCount} pin${pinRestoreFailCount === 1 ? '' : 's'} failed`);
  if (unpinnedTabCount > 0) parts.push(`${unpinnedTabCount} tab${unpinnedTabCount === 1 ? '' : 's'} not pinned`);
  if (groupRestoreFailCount > 0) parts.push(`${groupRestoreFailCount} group${groupRestoreFailCount === 1 ? '' : 's'} failed`);
  if (ungroupedTabCount > 0) parts.push(`${ungroupedTabCount} tab${ungroupedTabCount === 1 ? '' : 's'} not grouped`);
  showToast({ message: parts.join(', ') });
}

/* ----------------------------------------------------------------
   SAVE FLOW — capture current window
   ---------------------------------------------------------------- */

const ALLOWED_SCHEMES = /^https?:\/\//i;

async function enrichCaptureWithTabGroups(capture) {
  const sourceGroupIds = Array.isArray(capture.sourceGroupIds) ? capture.sourceGroupIds : [];
  const groupKeyByChromeId = new Map();
  let nextKeyIdx = 0;

  for (const groupId of sourceGroupIds) {
    if (groupId != null && groupId >= 0 && !groupKeyByChromeId.has(groupId)) {
      groupKeyByChromeId.set(groupId, 'grp_' + (nextKeyIdx++));
    }
  }

  const groupsMeta = {};
  for (const [chromeGroupId, savedKey] of groupKeyByChromeId) {
    try {
      const g = await chrome.tabGroups.get(chromeGroupId);
      const color = VALID_GROUP_COLORS.has(g.color) ? g.color : 'grey';
      groupsMeta[savedKey] = { title: g.title || '', color };
    } catch (e) {
      console.warn('[tab-out] tabGroups.get failed', e);
      groupKeyByChromeId.delete(chromeGroupId);
    }
  }

  const tabs = capture.tabs.map((tab, index) => ({
    ...tab,
    savedGroupKey: groupKeyByChromeId.get(sourceGroupIds[index]) || null
  }));

  return {
    ...capture,
    tabs,
    groups: groupsMeta,
    summary: computeSummary(tabs),
    needsTabGroupsPermission: false
  };
}

async function showTabGroupsNoticeOnce() {
  const { _tabOutGroupNotice } = await chrome.storage.local.get('_tabOutGroupNotice');
  if (_tabOutGroupNotice) return;
  showToast({ message: "Groups won't be saved without permission — you can grant it next time you save a window with grouped tabs." });
  await chrome.storage.local.set({ _tabOutGroupNotice: true });
}

async function prepareCaptureForSave(capture) {
  if (!capture || !capture.needsTabGroupsPermission) return capture;

  const granted = await ensureTabGroupsPermission({ prompt: true });
  if (granted) {
    return enrichCaptureWithTabGroups(capture);
  }

  await showTabGroupsNoticeOnce();
  return {
    ...capture,
    needsTabGroupsPermission: false
  };
}

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

  const tabRecords = kept.map(t => ({
    url: t.url,
    title: (t.title && t.title.trim()) || (() => { try { return new URL(t.url).hostname; } catch { return 'Untitled'; } })(),
    favIconUrl: '',
    pinned: !!t.pinned,
    index: t.index,
    savedGroupKey: null
  }));

  const capture = {
    tabs: tabRecords,
    groups: {},
    summary: computeSummary(tabRecords),
    skipped,
    sourceGroupIds: kept.map(t => t.groupId),
    needsTabGroupsPermission: false
  };

  if (!capture.sourceGroupIds.some(groupId => groupId != null && groupId >= 0)) {
    return capture;
  }

  const granted = await ensureTabGroupsPermission({ prompt: false });
  if (!granted) {
    return {
      ...capture,
      needsTabGroupsPermission: true
    };
  }

  return enrichCaptureWithTabGroups(capture);
}

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

async function openSaveOverlay({
  capture,
  prefilledName,
  allowQuickSave = true,
  prepareCapture = true,
  onConfirm = null,
  title = 'Save current window as a session'
}) {
  if (!capture || !Array.isArray(capture.tabs) || capture.tabs.length === 0) {
    showToast({ message: 'Nothing to save (unsupported URL schemes)' });
    return;
  }
  const skipped = capture && Number.isFinite(capture.skipped) ? capture.skipped : 0;
  _activeSaveOverlay = {
    capture,
    allowQuickSave,
    prepareCapture,
    onConfirm,
    title
  };

  const overlay = document.getElementById('saveOverlay');
  const input = document.getElementById('saveOverlayInput');
  const errorEl = document.getElementById('saveOverlayError');
  const saveBtn = document.getElementById('saveOverlaySave');
  const summaryEl = document.getElementById('saveOverlaySummary');
  const quickSaveBtn = overlay.querySelector('[data-action="quick-save-from-overlay"]');
  const titleEl = overlay.querySelector('.save-overlay-title');

  const name = prefilledName || await uniqueDefaultName(formatDefaultSessionName());
  input.value = name;
  if (titleEl) titleEl.textContent = _activeSaveOverlay.title;
  if (quickSaveBtn) quickSaveBtn.style.display = _activeSaveOverlay.allowQuickSave ? '' : 'none';
  saveBtn.textContent = 'Save';

  summaryEl.textContent = skipped > 0
    ? `${capture.tabs.length} tabs will be saved · ${skipped} skipped (unsupported URL schemes)`
    : `${capture.tabs.length} tabs will be saved`;

  errorEl.style.display = 'none';
  saveBtn.disabled = false;
  overlay.style.display = 'flex';
  input.focus();
  input.select();

  overlay.onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSaveOverlay();
      return;
    }
    if (e.key === 'Enter') {
      const target = e.target;
      const action = target && target.dataset ? target.dataset.action : '';
      if (action === 'cancel-save-overlay' || action === 'quick-save-from-overlay') {
        return;
      }
      if (!saveBtn.disabled) {
        e.preventDefault();
        saveBtn.click();
      }
    }
  };

  const onInput = async () => {
    const trimmed = input.value.trim();
    if (!trimmed) {
      errorEl.style.display = 'none';
      saveBtn.disabled = false;
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
}

function closeSaveOverlay() {
  _activeSaveOverlay = null;
  const overlay = document.getElementById('saveOverlay');
  const quickSaveBtn = overlay.querySelector('[data-action="quick-save-from-overlay"]');
  const titleEl = overlay.querySelector('.save-overlay-title');
  const saveBtn = document.getElementById('saveOverlaySave');
  overlay.onkeydown = null;
  if (titleEl) titleEl.textContent = 'Save current window as a session';
  if (quickSaveBtn) quickSaveBtn.style.display = '';
  if (saveBtn) {
    saveBtn.textContent = 'Save';
    saveBtn.disabled = false;
  }
  overlay.style.display = 'none';
}

function showSaveOverlayError(errorEl, message) {
  errorEl.textContent = message;
  errorEl.style.display = 'block';
}

async function confirmSaveOverlay() {
  if (!_activeSaveOverlay) return;
  let { capture, onConfirm, prepareCapture } = _activeSaveOverlay;
  const input = document.getElementById('saveOverlayInput');
  const errorEl = document.getElementById('saveOverlayError');
  const saveBtn = document.getElementById('saveOverlaySave');
  let name = input.value.trim();
  if (!name) name = await uniqueDefaultName(formatDefaultSessionName());
  errorEl.style.display = 'none';
  saveBtn.disabled = true;
  try {
    if (prepareCapture) {
      capture = await prepareCaptureForSave(capture);
      _activeSaveOverlay.capture = capture;
    }
    if (typeof onConfirm === 'function') {
      await onConfirm({ name, capture });
    } else {
      await createNamedSession({ name, tabs: capture.tabs, groups: capture.groups, summary: capture.summary });
    }
    closeSaveOverlay();
    const skipped = Number.isFinite(capture.skipped) ? capture.skipped : 0;
    const msg = skipped > 0
      ? `Saved · ${capture.tabs.length} tabs (${skipped} skipped)`
      : `Saved · ${capture.tabs.length} tabs`;
    showToast({ message: msg });
    await renderSessionsPane();
    await switchSidebarPane('sessions');
    updateSidebarVisibility();
    await maybeShowFirstSaveBanner();
  } catch (e) {
    if (e.message === 'name-collision') {
      showSaveOverlayError(errorEl, `A session named "${name}" already exists.`);
      input.focus();
      input.select();
    } else if (e.message === 'write-conflict') {
      showWriteConflictToast();
    } else if (isQuotaError(e)) {
      showQuotaToast();
    } else {
      showToast({ message: 'Couldn\'t save session — see console for details.' });
      console.error('[tab-out] save failed', e);
    }
    saveBtn.disabled = false;
  }
}

async function quickSaveFromOverlay() {
  if (!_activeSaveOverlay) return;
  if (_activeSaveOverlay.allowQuickSave === false) return;
  let { capture } = _activeSaveOverlay;
  try {
    capture = await prepareCaptureForSave(capture);
    _activeSaveOverlay.capture = capture;
    const { overwrittenTrashId } = await writeSnapshotSession({ tabs: capture.tabs, groups: capture.groups, summary: capture.summary });
    closeSaveOverlay();
    const skipped = Number.isFinite(capture.skipped) ? capture.skipped : 0;
    const msg = skipped > 0
      ? `Snapshot saved · ${capture.tabs.length} tabs (${skipped} skipped)`
      : `Snapshot saved · ${capture.tabs.length} tabs`;
    showToast({
      message: msg,
      actionLabel: overwrittenTrashId ? 'Undo' : undefined,
      onAction: overwrittenTrashId ? async () => {
        try {
          const restored = await trashRestore(overwrittenTrashId);
          if (!restored) {
            showToast({ message: 'That record is no longer in Trash.' });
            await renderTrashPane();
            updateSidebarVisibility();
            return;
          }
          await renderSessionsPane();
          await renderTrashPane();
          updateSidebarVisibility();
        } catch (restoreError) {
          if (restoreError.message === 'write-conflict') {
            showWriteConflictToast();
          } else if (isQuotaError(restoreError)) {
            showQuotaToast();
          } else {
            showToast({ message: "Couldn't restore — storage error." });
            console.error('[tab-out] quick-save undo restore failed', restoreError);
          }
        }
      } : undefined
    });
    await renderSessionsPane();
    await switchSidebarPane('sessions');
    updateSidebarVisibility();
    await maybeShowFirstSaveBanner();
  } catch (e) {
    if (e.message === 'write-conflict') {
      showWriteConflictToast();
    } else if (isQuotaError(e)) {
      showQuotaToast();
    } else {
      showToast({ message: 'Couldn\'t save snapshot — see console.' });
      console.error('[tab-out] quick save failed', e);
    }
  }
}

/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Pane
   ---------------------------------------------------------------- */

/**
 * renderDeferredPane()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredPane() {
  const column         = document.getElementById('sidebarColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();
    _lastDeferred = [...active, ...archived];
    updateSidebarVisibility();

    if (active.length === 0 && archived.length === 0) {
      list.replaceChildren();
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
      archiveList.replaceChildren();
      archiveEl.style.display = 'none';
      return;
    }

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.replaceChildren(...active.map(item => renderDeferredItem(item)));
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.replaceChildren(...archived.map(item => renderArchiveItem(item)));
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    _lastDeferred = [];
    updateSidebarVisibility();
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
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

  const favicon = faviconEl(item.url, 14);

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

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
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


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    openTabsMissionsEl.replaceChildren(...domainGroups.map(g => renderDomainCard(g)));
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render sidebar panes ---
  await renderSidebar();
  await renderSessionsPane();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  const pillBtn = e.target.closest('[data-pane]');
  if (pillBtn) {
    e.preventDefault();
    await switchSidebarPane(pillBtn.dataset.pane);
    return;
  }

  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  if (action === 'open-save-overlay') {
    e.preventDefault();
    const capture = await captureCurrentWindow();
    if (capture.tabs.length === 0) {
      showToast({ message: 'Nothing to save (unsupported URL schemes)' });
      return;
    }
    await openSaveOverlay({ capture });
    return;
  }
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

  if (action === 'session-kebab') {
    e.preventDefault();
    e.stopPropagation();
    await openSessionKebab(actionEl.dataset.sessionId, actionEl);
    return;
  }

  if (action === 'session-toggle-expand') {
    e.preventDefault();
    e.stopPropagation();
    toggleSessionExpand(actionEl.dataset.sessionId);
    return;
  }

  if (action === 'session-reopen' || action === 'session-reopen-menu') {
    e.preventDefault();
    e.stopPropagation();
    closeSessionKebab();
    await reopenSession(actionEl.dataset.sessionId);
    return;
  }

  if (action === 'session-rename') {
    e.preventDefault();
    closeSessionKebab();
    await promptRenameSession(actionEl.dataset.sessionId);
    return;
  }

  if (action === 'session-save-as-named') {
    e.preventDefault();
    closeSessionKebab();
    const { items } = await readSessions();
    const snap = items.find(s => s.id === actionEl.dataset.sessionId);
    if (!snap) return;
    await openSaveOverlay({
      capture: {
        tabs: structuredClone(snap.tabs),
        groups: structuredClone(snap.groups || {}),
        summary: structuredClone(snap.summary),
        skipped: 0,
        needsTabGroupsPermission: false
      },
      prefilledName: await uniqueDefaultName('Snapshot · ' + new Date().toLocaleString(undefined, { month: 'short', day: 'numeric' })),
      allowQuickSave: false,
      prepareCapture: false,
      onConfirm: ({ name }) => saveAsNamedSession({
        fromSnapshotOrId: actionEl.dataset.sessionId,
        name
      }),
      title: 'Save snapshot as a named session'
    });
    return;
  }

  if (action === 'session-open-trash') {
    e.preventDefault();
    e.stopPropagation();
    await switchSidebarPane('trash');
    return;
  }

  if (action === 'session-duplicate') {
    e.preventDefault();
    closeSessionKebab();
    try {
      await duplicateSession(actionEl.dataset.sessionId);
      showToast({ message: 'Duplicated' });
      renderSessionsPane();
    } catch (e2) {
      if (e2.message === 'write-conflict') {
        showWriteConflictToast();
      } else if (isQuotaError(e2)) {
        showQuotaToast();
      } else {
        showToast({ message: 'Couldn\'t duplicate — see console.' });
        console.error('[tab-out] duplicate failed', e2);
      }
    }
    return;
  }

  if (action === 'session-delete') {
    e.preventDefault();
    closeSessionKebab();
    const id = actionEl.dataset.sessionId;
    try {
      const trashId = await deleteSession(id);
      showToast({
        message: 'Deleted',
        actionLabel: trashId ? 'Undo' : undefined,
        onAction: trashId ? async () => {
          try {
            const restored = await trashRestore(trashId);
            if (!restored) {
              showToast({ message: 'That record is no longer in Trash.' });
              await renderTrashPane();
              updateSidebarVisibility();
              return;
            }
            await renderSessionsPane();
            await renderTrashPane();
            updateSidebarVisibility();
          } catch (restoreError) {
            if (restoreError.message === 'write-conflict') {
              showWriteConflictToast();
            } else if (isQuotaError(restoreError)) {
              showQuotaToast();
            } else {
              showToast({ message: "Couldn't restore — storage error." });
              console.error('[tab-out] delete undo restore failed', restoreError);
            }
          }
        } : undefined
      });
      await renderSessionsPane();
      await renderTrashPane();
      updateSidebarVisibility();
    } catch (e2) {
      if (e2.message === 'write-conflict') {
        showWriteConflictToast();
      } else if (isQuotaError(e2)) {
        showQuotaToast();
      } else {
        showToast({ message: 'Couldn\'t delete — see console.' });
        console.error('[tab-out] delete failed', e2);
      }
    }
    return;
  }

  if (action === 'session-tab-open') {
    e.preventDefault();
    e.stopPropagation();
    const sid = actionEl.dataset.sessionId;
    const idx = parseInt(actionEl.dataset.tabIndex, 10);
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
    e.preventDefault();
    e.stopPropagation();
    const sid = actionEl.dataset.sessionId;
    const idx = parseInt(actionEl.dataset.tabIndex, 10);
    try {
      const trashId = await removeTabFromSession(sid, idx);
      showToast({
        message: 'Tab removed',
        actionLabel: trashId ? 'Undo' : undefined,
        onAction: trashId ? async () => {
          try {
            const restored = await trashRestore(trashId);
            if (!restored) {
              showToast({ message: 'That record is no longer in Trash.' });
              await renderTrashPane();
              updateSidebarVisibility();
              return;
            }
            await renderSessionsPane();
            await renderTrashPane();
            updateSidebarVisibility();
          } catch (restoreError) {
            if (restoreError.message === 'write-conflict') {
              showWriteConflictToast();
            } else if (isQuotaError(restoreError)) {
              showQuotaToast();
            } else {
              showToast({ message: "Couldn't restore — storage error." });
              console.error('[tab-out] remove-tab undo restore failed', restoreError);
            }
          }
        } : undefined
      });
      await renderSessionsPane();
      await renderTrashPane();
      updateSidebarVisibility();
    } catch (e2) {
      if (e2.message === 'write-conflict') {
        showWriteConflictToast();
      } else if (isQuotaError(e2)) {
        showQuotaToast();
      } else {
        showToast({ message: 'Couldn\'t remove tab — see console.' });
        console.error('[tab-out] remove tab failed', e2);
      }
    }
    return;
  }

  if (action === 'trash-restore') {
    e.preventDefault();
    try {
      const restored = await trashRestore(actionEl.dataset.trashId);
      if (!restored) {
        showToast({ message: 'That record is no longer in Trash.' });
        await renderTrashPane();
        updateSidebarVisibility();
        return;
      }
      showToast({ message: 'Restored' });
      await renderSessionsPane();
      await renderTrashPane();
      updateSidebarVisibility();
    } catch (restoreError) {
      if (restoreError.message === 'write-conflict') {
        showWriteConflictToast();
      } else if (isQuotaError(restoreError)) {
        showQuotaToast();
      } else {
        showToast({ message: "Couldn't restore — storage error." });
        console.error('[tab-out] trash restore failed', restoreError);
      }
    }
    return;
  }

  if (action === 'trash-drop') {
    e.preventDefault();
    try {
      await trashDrop(actionEl.dataset.trashId);
      await renderTrashPane();
      updateSidebarVisibility();
    } catch (dropError) {
      if (dropError.message === 'write-conflict') {
        showWriteConflictToast();
      } else {
        showToast({ message: "Couldn't remove from Trash — see console." });
        console.error('[tab-out] trash drop failed', dropError);
      }
    }
    return;
  }

  if (action === 'quarantine-drop') {
    e.preventDefault();
    const quarantineId = actionEl.dataset.quarantineId;
    const items = await readSessionsQuarantineItems();
    await writeSessionsQuarantineItems(items.filter(item => item.quarantineId !== quarantineId));
    await renderTrashPane();
    updateSidebarVisibility();
    return;
  }

  if (action === 'quarantine-restore') {
    e.preventDefault();
    try {
      await quarantineRestore(actionEl.dataset.quarantineId);
      await renderSessionsPane();
      await renderTrashPane();
      updateSidebarVisibility();
    } catch (restoreError) {
      if (restoreError.message === 'write-conflict') {
        showWriteConflictToast();
      } else if (isQuotaError(restoreError)) {
        showQuotaToast();
      } else {
        showToast({ message: "Couldn't restore — storage error." });
        console.error('[tab-out] quarantine restore failed', restoreError);
      }
    }
    return;
  }

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast({ message: 'Closed extra Tab Out tabs' });
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast({ message: 'Tab closed' });
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast({ message: 'Failed to save tab' });
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast({ message: 'Saved for later' });
    await renderSidebar();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderSidebar();
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderSidebar();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast({ message: `Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}` });

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast({ message: 'Closed duplicates, kept one copy each' });
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast({ message: 'All tabs closed. Fresh start.' });
    return;
  }

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
    const id = actionEl.dataset.linkId;
    try {
      await removeWorkspaceLink(id);
    } catch (err) {
      const msg = err && err.message;
      if (msg === 'write-conflict') {
        showToast({ message: 'Another Tab Out tab changed Workspace — reload to see the latest.' });
      } else if (String(err).toLowerCase().includes('quota')) {
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
    // permissions.request must be called synchronously from a user gesture;
    // any prior await (e.g. contains()) breaks the gesture context.
    const granted = await chrome.permissions.request({ permissions: ['sessions'] });
    _sessionsPermissionGranted = !!granted;
    renderRecentlyClosedSection();
    return;
  }
  if (action === 'qa-restore-closed') {
    e.preventDefault();
    const sessionId = actionEl.dataset.sessionId;
    if (!sessionId) return;
    try {
      await chrome.sessions.restore(sessionId);
    } catch (err) {
      showToast({ message: "Couldn't reopen tab — it may be too old." });
      console.warn('[tab-out] sessions.restore failed', err);
    }
    return;
  }
});

// Close on outside click
document.addEventListener('click', (e) => {
  if (_openKebab && !_openKebab.contains(e.target) && !e.target.closest('.session-kebab')) {
    closeSessionKebab();
  }
});

window.addEventListener('scroll', () => {
  if (_openKebab) closeSessionKebab();
}, true);

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.replaceChildren(...archived.map(item => renderArchiveItem(item)));
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    if (results.length > 0) {
      archiveList.replaceChildren(...results.map(item => renderArchiveItem(item)));
    } else {
      archiveList.replaceChildren(
        el('div', {
          style: {
            fontSize: '12px',
            color: 'var(--muted)',
            padding: '8px 0'
          }
        }, 'No results')
      );
    }
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


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

const WORKSPACE_LOGOS = {
  'mail.google.com':     'icons/workspace/gmail.svg',
  'calendar.google.com': 'icons/workspace/google-calendar.svg',
  'drive.google.com':    'icons/workspace/google-drive.svg',
  'docs.google.com':     'icons/workspace/google-docs.svg',
  'sheets.google.com':   'icons/workspace/google-sheets.svg',
  'slides.google.com':   'icons/workspace/google-slides.svg',
  'gemini.google.com':   'icons/workspace/google-gemini.svg'
};

function workspaceIconEl(url, size) {
  try {
    const h = new URL(url).hostname;
    const relPath = WORKSPACE_LOGOS[h];
    if (relPath) {
      return el('img', {
        src: chrome.runtime.getURL(relPath),
        width: size,
        height: size,
        alt: '',
        class: 'qa-chip-logo'
      });
    }
  } catch {}
  return faviconEl(url, size);
}

let _workspaceEditMode = false;
let _sessionsPermissionGranted = false;
let _lastSelfWorkspaceWriteToken = null;
let _recentRefreshTimer = null;
let _addInputOpen = false;
let _recentlyClosedToastFired = false;

function newWorkspaceWriteToken() {
  const t = 'wtw_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  _lastSelfWorkspaceWriteToken = t;
  return t;
}

function _validateWorkspaceItems(items) {
  const valid = [];
  let droppedCount = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { droppedCount++; continue; }
    if (typeof item.id !== 'string' || !item.id.startsWith('ws_')) { droppedCount++; continue; }
    if (typeof item.url !== 'string' || !ALLOWED_SCHEMES.test(item.url)) { droppedCount++; continue; }
    if (typeof item.label !== 'string' || item.label.length < 1 || item.label.length > 48) { droppedCount++; continue; }
    if (valid.length >= WORKSPACE_MAX_ITEMS) { droppedCount++; continue; }
    valid.push(item);
  }
  return { valid, droppedCount };
}

function _notifyDroppedWorkspaceItems(count) {
  if (count <= 0) return;
  if (typeof showToast === 'function') {
    showToast({ message: 'Skipped ' + count + ' invalid workspace item' + (count === 1 ? '' : 's') + '.' });
  }
}

async function writeWorkspaceLinksIfUnchanged(expectedWriteToken, items) {
  const { workspaceLinks } = await chrome.storage.local.get(WORKSPACE_LINKS_KEY);
  const currentToken = workspaceLinks ? (workspaceLinks.writeToken || null) : null;
  if (currentToken !== expectedWriteToken) return false;
  const writeToken = newWorkspaceWriteToken();
  await chrome.storage.local.set({
    [WORKSPACE_LINKS_KEY]: {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      items,
      writeToken
    }
  });
  return true;
}

async function readWorkspaceLinks() {
  const { workspaceLinks } = await chrome.storage.local.get(WORKSPACE_LINKS_KEY);

  if (workspaceLinks
      && workspaceLinks.schemaVersion === WORKSPACE_SCHEMA_VERSION
      && Array.isArray(workspaceLinks.items)) {
    const { valid, droppedCount } = _validateWorkspaceItems(workspaceLinks.items);
    let writeToken = workspaceLinks.writeToken || null;
    if (droppedCount > 0) {
      try {
        const ok = await writeWorkspaceLinksIfUnchanged(writeToken, valid);
        if (ok) writeToken = _lastSelfWorkspaceWriteToken;
      } catch (e) {
        console.warn('[tab-out] workspace cleanup writeback skipped:', e && e.message);
      }
    }
    _notifyDroppedWorkspaceItems(droppedCount);
    return { ...workspaceLinks, items: valid, writeToken };
  }

  // Absent or corrupt — CAS-seed defaults so a concurrent seed on another page doesn't clobber newer state.
  const expectedToken = workspaceLinks ? (workspaceLinks.writeToken || null) : null;
  const seededItems = WORKSPACE_DEFAULTS.map(d => ({
    id: 'ws_' + ulid(),
    url: d.url,
    label: d.label
  }));
  const ok = await writeWorkspaceLinksIfUnchanged(expectedToken, seededItems);
  if (ok) {
    const after = await chrome.storage.local.get(WORKSPACE_LINKS_KEY);
    return after.workspaceLinks;
  }
  // Another page seeded/wrote first — re-read their state.
  return readWorkspaceLinks();
}

function normalizeWorkspaceUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

async function addWorkspaceLink(rawUrl, rawLabel) {
  const raw = String(rawUrl || '').trim();
  if (!ALLOWED_SCHEMES.test(raw)) throw new Error('invalid-scheme');
  const normalized = normalizeWorkspaceUrl(raw);
  if (!ALLOWED_SCHEMES.test(normalized)) throw new Error('invalid-scheme');

  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readWorkspaceLinks();
    const items = current.items;
    const writeToken = current.writeToken || null;
    if (items.length >= WORKSPACE_MAX_ITEMS) throw new Error('cap-reached');

    const dupKey = normalized.toLowerCase();
    if (items.some(i => normalizeWorkspaceUrl(i.url).toLowerCase() === dupKey)) {
      throw new Error('duplicate-url');
    }

    const label = (rawLabel && String(rawLabel).trim()) || deriveLabelFromUrl(raw);
    const trimmedLabel = label.slice(0, 48);
    const next = { id: 'ws_' + ulid(), url: normalized, label: trimmedLabel };
    const ok = await writeWorkspaceLinksIfUnchanged(writeToken, [...items, next]);
    if (ok) return next;
  }
  throw new Error('write-conflict');
}

async function removeWorkspaceLink(id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readWorkspaceLinks();
    const items = current.items;
    const writeToken = current.writeToken || null;
    const ok = await writeWorkspaceLinksIfUnchanged(writeToken, items.filter(i => i.id !== id));
    if (ok) return;
  }
  throw new Error('write-conflict');
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

async function renderQuickAccessRow() {
  await renderWorkspaceSection();
  await renderRecentlyClosedSection();
}

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

function renderWorkspaceChip(item) {
  const editClass = _workspaceEditMode ? ' qa-edit-mode' : '';
  const urlOk = typeof item.url === 'string' && ALLOWED_SCHEMES.test(item.url);

  let chip;
  if (urlOk) {
    chip = el('a', {
      class: 'qa-chip',
      href: item.url,
      target: '_blank',
      rel: 'noopener',
      title: item.label,
      'data-link-id': item.id
    }, [workspaceIconEl(item.url, 24)]);
  } else {
    // Defensive: render non-clickable letter-chip when scheme is invalid.
    // Should be unreachable after readWorkspaceLinks validation, but defend the DOM.
    const letter = ((item.label && item.label.charAt(0)) || '?').toUpperCase();
    chip = el('span', {
      class: 'qa-chip qa-chip-disabled',
      title: item.label || 'Invalid link',
      'data-link-id': item.id,
      tabindex: '0'
    }, [el('span', { class: 'favicon-letter' }, letter)]);
  }

  const wrap = el('div', { class: 'qa-chip-wrap' + editClass }, [chip]);

  if (_workspaceEditMode) {
    const removeBtn = el('button', {
      class: 'qa-chip-remove',
      'data-action': 'qa-remove-link',
      'data-link-id': item.id,
      title: 'Remove ' + (item.label || 'link')
    }, '×');
    removeBtn.addEventListener('click', (e) => {
      e.preventDefault();
    }, { once: false });
    wrap.appendChild(removeBtn);
  }

  return wrap;
}

function renderAddLinkInput(currentCount) {
  const input = el('input', {
    type: 'url',
    class: 'qa-add-input',
    placeholder: 'https://example.com'
  });
  const errorEl = el('span', { class: 'qa-add-error', style: { display: 'none' } });

  const wrapper = el('span', { class: 'qa-add-wrapper' }, [input, errorEl]);

  let outsideClickHandler = null;
  let armTimer = null;

  function teardown() {
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    if (outsideClickHandler) {
      document.removeEventListener('click', outsideClickHandler, true);
      outsideClickHandler = null;
    }
  }

  function exit() {
    teardown();
    _addInputOpen = false;
    renderWorkspaceSection();
  }

  function commit() {
    let url = input.value.trim();
    if (!url) { exit(); return; }
    // If user typed a bare domain (e.g. "gemini.google.com"), prefix https://
    // so the scheme-allowlist accepts it. Matches common "paste URL in address
    // bar" muscle memory.
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }
    errorEl.style.display = 'none';
    addWorkspaceLink(url)
      .then(() => {
        // Route through exit() so teardown runs in both paths — otherwise
        // the document click-outside listener leaks as a zombie.
        exit();
      })
      .catch(err => {
        const msg = err && err.message;
        let text = "Couldn't add link.";
        if (msg === 'invalid-scheme') text = 'Use http:// or https://';
        else if (msg === 'duplicate-url') text = 'Already in the list';
        else if (msg === 'cap-reached') text = 'Remove a link first';
        else if (msg === 'write-conflict') text = 'Another Tab Out tab changed Workspace — reload to see the latest.';
        else if (String(err).toLowerCase().includes('quota')) text = 'Storage full — delete a link first';
        errorEl.textContent = text;
        errorEl.style.display = 'inline';
        input.focus();
        input.select();
      });
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); exit(); }
  });

  setTimeout(() => {
    input.focus();
    // Arm click-outside detection after a short delay so the click that opened
    // this input doesn't immediately close it. Use capture phase so we catch
    // the click before any action handler processes it. Track the arm timer
    // so teardown() can cancel it if exit() runs within the 150ms window.
    armTimer = setTimeout(() => {
      armTimer = null;
      outsideClickHandler = (e) => {
        if (!wrapper.contains(e.target)) {
          exit();
        }
      };
      document.addEventListener('click', outsideClickHandler, true);
    }, 150);
  }, 0);

  return wrapper;
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

function _normalizeLastAccessed(raw) {
  if (!raw || typeof raw !== 'number') return Date.now();
  return raw < 1e12 ? raw * 1000 : raw;
}

async function renderRecentlyClosedSection() {
  const container = document.getElementById('qaRecent');
  const divider = document.getElementById('qaDivider');
  if (!container) return;

  const granted = await ensureSessionsPermission({ prompt: false });
  if (!granted) {
    if (divider) divider.style.display = 'block';
    container.replaceChildren(
      el('div', { class: 'qa-section-label' }, 'Recently closed'),
      el('button', { class: 'qa-enable', 'data-action': 'qa-enable-sessions' }, 'Enable')
    );
    return;
  }

  let tabs = [];
  try {
    const entries = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
    tabs = entries
      .filter(e => e.tab && e.tab.url)
      .filter(e => {
        const u = e.tab.url;
        return !u.startsWith('chrome://') && !u.startsWith('chrome-extension://') && !u.startsWith('edge://') && !u.startsWith('about:');
      })
      .slice(0, 5)
      .map(e => e.tab);
  } catch (err) {
    console.warn('[tab-out] getRecentlyClosed failed', err);
    if (divider) divider.style.display = 'block';
    container.replaceChildren(
      el('div', { class: 'qa-section-label' }, 'Recently closed'),
      el('div', { class: 'qa-empty' }, "Couldn't load recently closed")
    );
    if (!_recentlyClosedToastFired) {
      _recentlyClosedToastFired = true;
      showToast({ message: "Couldn't load recently closed." });
    }
    return;
  }

  if (tabs.length === 0) {
    if (divider) divider.style.display = 'block';
    container.replaceChildren(
      el('div', { class: 'qa-section-label' }, 'Recently closed'),
      el('div', { class: 'qa-empty' }, 'Nothing recently closed')
    );
    return;
  }

  if (divider) divider.style.display = 'block';
  container.replaceChildren(
    el('div', { class: 'qa-section-label' }, 'Recently closed'),
    el('div', { class: 'qa-recent-strip' }, tabs.map(renderRecentChip))
  );
}

function renderRecentChip(tab) {
  let hostname = '';
  try { hostname = new URL(tab.url).hostname.replace(/^www\./, ''); } catch {}
  const hasTitle = tab.title && tab.title.trim();
  const titleText = hasTitle ? tab.title.trim() : '(no title)';
  const lastAccessedMs = _normalizeLastAccessed(tab.lastAccessed);
  const lastAccessedIso = new Date(lastAccessedMs).toISOString();
  const ago = timeAgo(lastAccessedIso);

  return el('button', {
    class: 'qa-recent-chip',
    'data-action': 'qa-restore-closed',
    'data-session-id': String(tab.sessionId || ''),
    title: hostname + ' · ' + ago
  }, [
    faviconEl(tab.url, 14),
    el('span', { class: 'qa-recent-chip-title' }, titleText)
  ]);
}

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
  const row = document.getElementById('quickAccessRow');
  if (row) {
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && _workspaceEditMode) {
        _workspaceEditMode = false;
        _addInputOpen = false;
        renderWorkspaceSection();
      }
    });
  }
}


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
async function initApp() {
  await initSidebarState();
  installStorageSync();
  installQuickAccessListeners();
  await ensureFaviconPermission({ prompt: false });
  await renderQuickAccessRow();
  await renderDashboard();
}

initApp();
