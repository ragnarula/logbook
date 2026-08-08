// Local database and in-memory model.
//
// Every write lands in IndexedDB first and is mirrored in memory, so the UI
// never waits on the network to confirm a tap. Rows carry a `_dirty` flag; the
// sync layer drains those and clears the flag once the server has them.

const DB_NAME = "tracker";
const DB_VERSION = 1;

export const STORES = ["projects", "event_types", "labels", "events"];

export const state = {
  projects: new Map(),
  event_types: new Map(),
  labels: new Map(),
  events: new Map(),
  cursor: 0,
  projectId: null,
};

let db = null;
const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) fn();
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const idb = req.result;
      for (const name of STORES) {
        if (!idb.objectStoreNames.contains(name)) {
          idb.createObjectStore(name, { keyPath: "id" }).createIndex("_dirty", "_dirty");
        }
      }
      if (!idb.objectStoreNames.contains("meta")) {
        idb.createObjectStore("meta", { keyPath: "k" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(names, mode) {
  const t = db.transaction(names, mode);
  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return { t, done };
}

function all(store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function readMeta(key, fallback) {
  return new Promise((resolve) => {
    const req = db.transaction("meta", "readonly").objectStore("meta").get(key);
    req.onsuccess = () => resolve(req.result ? req.result.v : fallback);
    req.onerror = () => resolve(fallback);
  });
}

async function writeMeta(key, value) {
  const { t, done } = tx("meta", "readwrite");
  t.objectStore("meta").put({ k: key, v: value });
  return done;
}

export async function load() {
  db = await open();
  for (const name of STORES) {
    const rows = await all(name);
    const map = state[name];
    map.clear();
    for (const row of rows) map.set(row.id, row);
  }
  state.cursor = await readMeta("cursor", 0);
  state.projectId = await readMeta("projectId", null);
}

export async function setCursor(value) {
  state.cursor = value;
  await writeMeta("cursor", value);
}

export async function setProject(id) {
  state.projectId = id;
  await writeMeta("projectId", id);
  emit();
}

/** Persist rows exactly as given, without touching `updated_at` or `_dirty`. */
async function persist(store, rows) {
  const { t, done } = tx(store, "readwrite");
  const objectStore = t.objectStore(store);
  for (const row of rows) objectStore.put(row);
  return done;
}

/**
 * Write a row as a local edit: stamp it, mark it for the outbox, and tell the
 * UI to redraw. `patch` is merged over whatever is already stored.
 */
export async function put(store, patch) {
  const existing = state[store].get(patch.id) || {};
  const row = { ...existing, ...patch, updated_at: Date.now(), _dirty: 1 };
  state[store].set(row.id, row);
  await persist(store, [row]);
  emit();
  return row;
}

/** Apply a row that came from the server. It is authoritative unless we hold a newer local edit. */
export async function applyRemote(store, incoming) {
  const local = state[store].get(incoming.id);
  if (local && local._dirty && local.updated_at > incoming.updated_at) return false;
  const row = { ...incoming, _dirty: 0 };
  state[store].set(row.id, row);
  await persist(store, [row]);
  return true;
}

export function dirtyRows() {
  const out = {};
  for (const name of STORES) {
    const rows = [];
    for (const row of state[name].values()) {
      if (row._dirty) {
        const { _dirty, seq, ...clean } = row;
        rows.push(clean);
      }
    }
    if (rows.length) out[name] = rows;
  }
  return out;
}

export function pendingCount() {
  let n = 0;
  for (const name of STORES) {
    for (const row of state[name].values()) if (row._dirty) n++;
  }
  return n;
}

/**
 * Clear the outbox flag for rows the server has now seen. A row edited again
 * while the request was in flight keeps its flag, so the newer edit is pushed.
 */
export async function clearDirty(snapshot) {
  const byStore = {};
  for (const { store, id, updated_at } of snapshot) {
    const row = state[store].get(id);
    if (!row || !row._dirty || row.updated_at !== updated_at) continue;
    const cleared = { ...row, _dirty: 0 };
    state[store].set(id, cleared);
    (byStore[store] ||= []).push(cleared);
  }
  for (const [store, rows] of Object.entries(byStore)) await persist(store, rows);
}

// ---------------------------------------------------------------------------
// Model helpers. Everything below is a thin wrapper over `put` that knows the
// default shape of each kind of row.
// ---------------------------------------------------------------------------

export const PALETTE = [
  "#f87171", "#fb923c", "#fbbf24", "#a3e635",
  "#34d399", "#22d3ee", "#60a5fa", "#a78bfa",
  "#f472b6", "#94a3b8",
];

export function createProject(name) {
  return put("projects", {
    id: uid(),
    name: name.trim(),
    color: PALETTE[state.projects.size % PALETTE.length],
    archived: 0,
    deleted: 0,
  });
}

export function createType(projectId, { name, kind, icon, color }) {
  const positions = typesFor(projectId).map((t) => t.position || 0);
  return put("event_types", {
    id: uid(),
    project_id: projectId,
    name: name.trim(),
    kind: kind === "span" ? "span" : "point",
    icon: icon || "",
    color: color || PALETTE[0],
    position: positions.length ? Math.max(...positions) + 1 : 0,
    archived: 0,
    deleted: 0,
  });
}

export function createLabel(projectId, name, color) {
  return put("labels", {
    id: uid(),
    project_id: projectId,
    name: name.trim(),
    color: color || PALETTE[labelsFor(projectId).length % PALETTE.length],
    archived: 0,
    deleted: 0,
  });
}

export function createEvent(projectId, type, { startedAt, labelIds = [], note = "" } = {}) {
  const start = startedAt ?? Date.now();
  return put("events", {
    id: uid(),
    project_id: projectId,
    type_id: type.id,
    started_at: start,
    // A point event is closed at birth; a span stays open until it is ended.
    ended_at: type.kind === "span" ? null : start,
    label_ids: JSON.stringify(labelIds),
    note,
    deleted: 0,
  });
}

export function endEvent(event, endedAt) {
  return put("events", { id: event.id, ended_at: endedAt ?? Date.now() });
}

export function softDelete(store, id) {
  return put(store, { id, deleted: 1 });
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

const live = (row) => !row.deleted;

export function projects() {
  return [...state.projects.values()].filter(live).sort((a, b) => a.name.localeCompare(b.name));
}

export function currentProject() {
  const project = state.projectId ? state.projects.get(state.projectId) : null;
  // A project deleted on another device is still in the map until it is purged.
  return project && !project.deleted ? project : null;
}

export function typesFor(projectId) {
  return [...state.event_types.values()]
    .filter((t) => t.project_id === projectId && live(t))
    .sort((a, b) => (a.position || 0) - (b.position || 0));
}

export function labelsFor(projectId) {
  return [...state.labels.values()]
    .filter((l) => l.project_id === projectId && live(l))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function eventsFor(projectId) {
  return [...state.events.values()]
    .filter((e) => e.project_id === projectId && live(e))
    .sort((a, b) => b.started_at - a.started_at);
}

/** Spans that have been started but not yet ended, oldest first. */
export function openSpans(projectId) {
  return [...state.events.values()]
    .filter((e) => e.project_id === projectId && live(e) && e.ended_at === null)
    .sort((a, b) => a.started_at - b.started_at);
}

export function lastEventOfType(typeId) {
  let best = null;
  for (const e of state.events.values()) {
    if (e.type_id !== typeId || e.deleted) continue;
    if (!best || e.started_at > best.started_at) best = e;
  }
  return best;
}

export function labelIdsOf(event) {
  try {
    const parsed = JSON.parse(event.label_ids || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
