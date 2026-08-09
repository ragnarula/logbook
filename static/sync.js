// Reconciliation with the server.
//
// One round trip does both directions: push everything in the outbox, receive
// everything changed since our cursor. Nothing here blocks the UI — a failed
// sync just leaves the outbox intact for the next attempt.

import { STORES, state, dirtyRows, applyRemote, clearDirty, setCursor, pendingCount, emit } from "./store.js";

// How often to check for other devices' changes while the app is in use, and
// the slowest it backs off to when nothing is happening.
const ACTIVE_MS = 30_000;
const IDLE_MAX_MS = 15 * 60_000;
const DEBOUNCE_MS = 500;
// Guards against a pathological backlog turning one sync into an endless loop.
const MAX_PAGES = 50;

export const status = { phase: "idle", pending: 0, lastError: null, lastSyncAt: null };

const statusListeners = new Set();

/** Status changes are frequent and cosmetic, so they get their own channel
 *  rather than triggering a full re-render through the store. */
export function onStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

let inFlight = false;
let queued = false;
let debounceTimer = null;

function setPhase(phase, error = null) {
  status.phase = phase;
  status.pending = pendingCount();
  status.lastError = error;
  for (const fn of statusListeners) fn();
}

export function scheduleSync() {
  status.pending = pendingCount();
  pollDelay = ACTIVE_MS;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => sync(), DEBOUNCE_MS);
}

export async function sync() {
  // Each of these reports "nothing applied", which lets the caller back off.
  if (inFlight) {
    queued = true;
    return 0;
  }
  if (!navigator.onLine) {
    setPhase("offline");
    return 0;
  }

  inFlight = true;
  setPhase("syncing");
  let applied = 0;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const changes = dirtyRows();
      // Remember exactly what we sent, so an edit made mid-flight is not
      // mistaken for a row the server has already accepted.
      const snapshot = [];
      for (const [store, rows] of Object.entries(changes)) {
        for (const row of rows) snapshot.push({ store, id: row.id, updated_at: row.updated_at });
      }

      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ since: state.cursor, changes }),
      });
      if (res.status === 401) {
        // The outbox stays exactly as it is. Signing in later pushes it, so a
        // night of entries never depends on a session staying alive.
        setPhase("signed-out");
        return 0;
      }
      if (!res.ok) throw new Error(`sync failed: HTTP ${res.status}`);
      const body = await res.json();

      for (const store of STORES) {
        for (const row of body.changes[store] || []) {
          if (await applyRemote(store, row)) applied++;
        }
      }
      await clearDirty(snapshot);
      await setCursor(body.cursor);

      if (!body.more && !Object.keys(dirtyRows()).length) break;
    }
    status.lastSyncAt = Date.now();
    setPhase("synced");
  } catch (err) {
    setPhase(navigator.onLine ? "error" : "offline", err.message);
    return applied;
  } finally {
    inFlight = false;
    // Rows arriving from another device change what is on screen.
    if (applied) emit();
    if (queued) {
      queued = false;
      setTimeout(() => sync(), 0);
    }
  }
}

/** Send the passcode. On success the browser holds a session cookie and the
 *  outbox drains on the next sync. */
export async function signIn(passcode) {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode, label: navigator.userAgent.slice(0, 60) }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || "Sign in failed");
  }
  await sync();
  return true;
}

export async function sessionState() {
  try {
    return await (await fetch("/api/session")).json();
  } catch {
    // Offline. Assume the stored session still works and let sync find out.
    return { auth: false, signedIn: true, offline: true };
  }
}

// Polling schedule.
//
// A fixed interval kept the server awake around the clock for any tab left
// open, which on a host that bills for running time is most of the cost — and
// it drains a phone battery for nothing. The app is offline-first, so a slower
// check costs only a delay in seeing another device's entries, and the cases
// where that matters (opening the app, coming back to the tab, logging
// something) all sync immediately anyway.
let pollDelay = ACTIVE_MS;
let pollTimer = null;

function scheduleNext(delay = pollDelay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, delay);
}

async function poll() {
  // A hidden tab with an empty outbox has no reason to wake anything.
  if (document.hidden && !pendingCount()) {
    pollDelay = IDLE_MAX_MS;
    scheduleNext();
    return;
  }
  const applied = await sync();
  // Something moved, so stay responsive. Otherwise ease off.
  pollDelay = applied || pendingCount() ? ACTIVE_MS : Math.min(pollDelay * 2, IDLE_MAX_MS);
  scheduleNext();
}

/** Sync now and return to the fast cadence. For anything the user just did. */
export function wake() {
  pollDelay = ACTIVE_MS;
  scheduleNext(0);
}

export function startSync() {
  sync();
  scheduleNext();
  window.addEventListener("online", wake);
  window.addEventListener("offline", () => setPhase("offline"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake();
  });
}
