// Rendering and interaction.
//
// The whole screen is rebuilt from state on every change, which keeps the
// render path trivial to reason about. Interaction is delegated: elements
// declare `data-action` and the handlers below dispatch on it, so replacing
// markup never leaves a dead listener behind. Each sheet gets a fresh panel
// element, so its listeners die with it.

import * as S from "./store.js";
import { status, scheduleSync, sync, signIn } from "./sync.js";

const screenEl = document.getElementById("screen");
const toastEl = document.getElementById("toast");
const backdropEl = document.getElementById("sheet-backdrop");
const sheetEl = document.getElementById("sheet");
const projectNameEl = document.getElementById("project-name");
const syncDotEl = document.getElementById("sync-dot");
const syncTextEl = document.getElementById("sync-text");

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const EMOJI = [
  "🍼", "🤱", "💤", "😴", "🌙", "💩", "💧", "🧷",
  "🛁", "🌡️", "💊", "🩺", "⚖️", "📏", "🚼", "🧸",
  "🎵", "🚗", "🚶", "🏥", "😀", "😢", "😤", "🤒",
  "🍽️", "🥛", "🥣", "☕", "🍎", "💪", "🏃", "🧘",
  "📖", "✍️", "💻", "📞", "🧹", "🛒", "⏰", "⭐",
];

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const pad = (n) => String(n).padStart(2, "0");

function clockTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function dayLabel(ts) {
  const midnight = startOfToday();
  if (ts >= midnight) return "Today";
  if (ts >= midnight - DAY) return "Yesterday";
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: "short", day: "numeric", month: "short",
  });
}

const fullTime = (ts) => `${dayLabel(ts)} ${clockTime(ts)}`;

/** Day label for the timeline, where the column is only wide enough for
 *  "Yesterday". The full form clipped to "Thu, Au..." on a phone. */
function shortDayLabel(ts) {
  const midnight = startOfToday();
  if (ts >= midnight) return "Today";
  if (ts >= midnight - DAY) return "Yesterday";
  return new Date(ts).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}

/** Compact elapsed time: "4s", "12m", "2h 14m", "3d 4h". */
function duration(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Running-clock form for an open span: "00:42:13". */
function stopwatch(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/** `datetime-local` shows wall-clock text, so shift out the zone before ISO. */
function localInputValue(ts) {
  const offset = new Date(ts).getTimezoneOffset() * MINUTE;
  return new Date(ts - offset).toISOString().slice(0, 16);
}

// ---------------------------------------------------------------------------
// Toast with undo
// ---------------------------------------------------------------------------

let toastTimer = null;
let toastActions = [];

export function toast(message, actions = []) {
  toastActions = actions;
  toastEl.innerHTML =
    `<span class="toast-msg">${message}</span>` +
    actions
      .map(
        (a, i) =>
          `<button class="toast-btn ${a.primary ? "primary" : ""}" data-toast="${i}">${esc(a.label)}</button>`
      )
      .join("");
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 8000);
}

function hideToast() {
  toastEl.hidden = true;
  toastActions = [];
}

/** Replace the toast's text without disturbing its buttons. */
export function setToastMessage(html) {
  const msg = toastEl.querySelector(".toast-msg");
  if (msg) msg.innerHTML = html;
}

toastEl.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-toast]");
  if (!btn) return;
  const action = toastActions[Number(btn.dataset.toast)];
  // A stepper has to survive being pressed repeatedly, so it does not dismiss
  // the bar and it restarts the countdown.
  if (action?.keepOpen) {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 8000);
  } else {
    hideToast();
  }
  action?.onClick?.();
});

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/** Mount a sheet. `wire` receives the panel, and its listeners go away with it. */
function openSheet(html, wireFn) {
  // The toast is fixed to the bottom of the viewport above the sheet layer, so
  // a leftover one covers the sheet's own buttons. Clear it on the way in.
  hideToast();
  const panel = document.createElement("div");
  panel.className = "sheet-panel";
  panel.innerHTML = html;
  sheetEl.replaceChildren(panel);
  sheetEl.scrollTop = 0;
  backdropEl.hidden = false;
  document.body.classList.add("sheet-open");
  panel.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-action='close-sheet']")) closeSheet();
  });
  wireFn?.(panel);
}

function closeSheet() {
  backdropEl.hidden = true;
  document.body.classList.remove("sheet-open");
  sheetEl.replaceChildren();
}

backdropEl.addEventListener("click", (ev) => {
  if (ev.target === backdropEl) closeSheet();
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !backdropEl.hidden) closeSheet();
});

const sheetHead = (title) => `
  <div class="sheet-head">
    <h2>${esc(title)}</h2>
    <button class="icon-btn" data-action="close-sheet" aria-label="Close">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
  </div>`;

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

// Which screen is showing. History is a page rather than a sheet, so the
// browser's back gesture leaves it — on a phone that is the control people
// reach for first.
let view = location.hash === "#history" ? "history" : "log";

const NAV_ICONS = {
  log: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>`,
  back: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>`,
};

export function showView(next, { push = true } = {}) {
  if (next === view) return;
  view = next;
  if (next === "history") resetHistoryPaging();
  if (push) history.pushState({ view: next }, "", next === "history" ? "#history" : "#");
  window.scrollTo(0, 0);
  render();
}

window.addEventListener("popstate", (ev) => {
  const next = ev.state?.view || (location.hash === "#history" ? "history" : "log");
  if (next !== view) {
    view = next;
    render();
  }
});

export function render() {
  const project = S.currentProject();
  projectNameEl.textContent = project ? project.name : "Logbook";
  renderSyncStatus();

  const navBtn = document.getElementById("history-btn");
  navBtn.innerHTML = view === "history" ? NAV_ICONS.back : NAV_ICONS.log;
  navBtn.setAttribute("aria-label", view === "history" ? "Back" : "History");

  if (!S.projects().length) {
    screenEl.innerHTML = `
      <div class="welcome">
        <h1>Track anything</h1>
        <p>A project holds its own events and labels. Start with the thing you want to keep track of.</p>
        <button class="btn primary big" data-action="new-project">Create a project</button>
      </div>`;
    return;
  }
  if (!project) {
    // The selected project was deleted, here or on another device.
    S.setProject(S.projects()[0].id);
    return;
  }

  if (view === "history") {
    const scrolled = window.scrollY;
    screenEl.innerHTML = historyPageHtml(project);
    window.scrollTo(0, scrolled);
    return;
  }

  const scrollY = window.scrollY;
  const types = S.typesFor(project.id);
  const open = S.openSpans(project.id);
  const today = S.eventsFor(project.id).filter((e) => e.started_at >= startOfToday());

  screenEl.innerHTML = `
    ${open.length ? `<div class="active-strip">${open.map(activeCardHtml).join("")}</div>` : ""}
    ${
      types.length
        ? `<div class="tiles">${types.map(tileHtml).join("")}${addTileHtml()}</div>`
        : `<div class="welcome">
             <h1>No events yet</h1>
             <p>Create the first thing you want to log. After that it is one tap.</p>
             <button class="btn primary big" data-action="new-type">Create an event</button>
           </div>`
    }
    <section class="recent">
      <div class="recent-head">
        <h2>Today</h2>
        <button class="link" data-action="history">All history</button>
      </div>
      ${
        today.length
          ? `<ul class="entries">${today.map(entryHtml).join("")}</ul>`
          : `<p class="empty">Nothing logged yet today.</p>`
      }
    </section>`;

  window.scrollTo(0, scrollY);
  tick();
}

function tileHtml(type) {
  const last = S.lastEventOfType(type.id);
  const running = type.kind === "span" && last && last.ended_at === null;
  return `
    <div class="tile-wrap">
      <button class="tile ${running ? "running" : ""}" data-action="tile" data-id="${type.id}"
              style="--tile:${esc(type.color)}">
        <span class="tile-icon">${esc(type.icon) || "•"}</span>
        <span class="tile-name">${esc(type.name)}</span>
        <span class="tile-ago" ${last ? `data-ago="${last.started_at}"` : ""}>${last ? "" : "never"}</span>
        ${
          type.unit
            ? `<span class="tile-kind">${esc(S.amountText(type, Number(type.default_quantity) || 0))}</span>`
            : type.kind === "span"
              ? `<span class="tile-kind">${running ? "tap to end" : "span"}</span>`
              : ""
        }
      </button>
      <button class="tile-more" data-action="tile-detail" data-id="${type.id}"
              aria-label="Options for ${esc(type.name)}">⋯</button>
    </div>`;
}

const addTileHtml = () => `
  <div class="tile-wrap">
    <button class="tile add" data-action="new-type">
      <span class="tile-icon">＋</span>
      <span class="tile-name">New event</span>
    </button>
  </div>`;

function activeCardHtml(event) {
  const type = S.state.event_types.get(event.type_id);
  if (!type) return "";
  return `
    <div class="active-card" style="--tile:${esc(type.color)}">
      <span class="active-icon">${esc(type.icon) || "•"}</span>
      <div class="active-main">
        <div class="active-name">${esc(type.name)}</div>
        <div class="active-timer" data-since="${event.started_at}">00:00:00</div>
      </div>
      <button class="btn ghost small" data-action="entry" data-id="${event.id}">Edit</button>
      <button class="btn primary" data-action="end-span" data-id="${event.id}">End</button>
    </div>`;
}

function entryHtml(event) {
  const type = S.state.event_types.get(event.type_id);
  const labels = S.labelIdsOf(event)
    .map((id) => S.state.labels.get(id))
    .filter(Boolean);
  const isOpenSpan = event.ended_at === null;
  let sub = clockTime(event.started_at);
  if (isOpenSpan) sub += " · running";
  else if (type?.kind === "span" && event.ended_at > event.started_at) {
    sub += `–${clockTime(event.ended_at)} · ${duration(event.ended_at - event.started_at)}`;
  }
  const amount = S.amountText(type, event.quantity);
  if (amount) sub += ` · ${amount}`;
  return `
    <li class="entry" data-action="entry" data-id="${event.id}">
      <span class="entry-icon" style="--tile:${esc(type?.color || "#8b91a1")}">${esc(type?.icon) || "•"}</span>
      <div class="entry-main">
        <div class="entry-title">${esc(type?.name || "Removed event")}</div>
        <div class="entry-sub">${esc(sub)}</div>
        ${labels.length ? `<div class="entry-labels">${labels.map(staticChipHtml).join("")}</div>` : ""}
      </div>
      ${event.note ? `<span class="entry-note" title="${esc(event.note)}">✎</span>` : ""}
    </li>`;
}

const staticChipHtml = (label) =>
  `<span class="chip static" style="--chip:${esc(label.color)}">${esc(label.name)}</span>`;

export function renderSyncStatus() {
  syncDotEl.className = `dot ${status.phase}`;
  if (status.phase === "signed-out") {
    syncTextEl.textContent = "sign in";
  } else if (status.phase === "offline") {
    syncTextEl.textContent = status.pending ? `${status.pending} offline` : "offline";
  } else if (status.pending) {
    syncTextEl.textContent = String(status.pending);
  } else {
    syncTextEl.textContent = status.phase === "error" ? "retry" : "";
  }
}

/** Update elapsed-time text in place, so timers run without a re-render. */
export function tick() {
  const now = Date.now();
  for (const el of screenEl.querySelectorAll("[data-since]")) {
    el.textContent = stopwatch(now - Number(el.dataset.since));
  }
  for (const el of screenEl.querySelectorAll("[data-ago]")) {
    el.textContent = `${duration(now - Number(el.dataset.ago))} ago`;
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

async function quickLog(type) {
  if (!type) return;
  const project = S.currentProject();

  // A span type toggles: if one of its spans is open, the tap closes it.
  if (type.kind === "span") {
    const running = S.openSpans(project.id).find((e) => e.type_id === type.id);
    if (running) return endSpan(running);
  }

  const event = await S.createEvent(project.id, type);
  scheduleSync();
  const verb = type.kind === "span" ? "started" : "logged";
  const said = `${esc(type.icon)} ${esc(type.name)} ${verb} ${esc(clockTime(event.started_at))}`;
  toast(loggedMessage(type, event, said), amountActions(type, event, said));
}

/** The toast text, with the amount when the type carries one. */
function loggedMessage(type, event, said) {
  const stored = S.state.events.get(event.id);
  const amount = S.amountText(type, stored?.quantity);
  return amount ? `${said} · <strong>${esc(amount)}</strong>` : said;
}

/**
 * Undo, plus a stepper when the type carries an amount.
 *
 * Correcting the amount stays one tap and never opens a sheet, which is what
 * lets a tap still be the whole interaction.
 */
function amountActions(type, event, said) {
  const undo = { label: "Undo", onClick: () => S.softDelete("events", event.id).then(scheduleSync) };
  if (!type.unit) {
    return [undo, { label: "Details", primary: true, onClick: () => openEventSheet(S.state.events.get(event.id)) }];
  }
  const step = Number(type.step) || 1;
  const adjust = (delta) => async () => {
    const current = S.state.events.get(event.id);
    if (!current || current.deleted) return;
    await S.put("events", { id: event.id, quantity: Math.max(0, (current.quantity || 0) + delta) });
    scheduleSync();
    setToastMessage(loggedMessage(type, event, said));
  };
  return [
    { label: "−", keepOpen: true, onClick: adjust(-step) },
    { label: "+", keepOpen: true, onClick: adjust(step) },
    undo,
  ];
}

async function endSpan(event) {
  const type = S.state.event_types.get(event.type_id);
  await S.endEvent(event);
  scheduleSync();
  toast(`${esc(type?.name || "Span")} ended · ${esc(duration(Date.now() - event.started_at))}`, [
    { label: "Undo", onClick: () => S.put("events", { id: event.id, ended_at: null }).then(scheduleSync) },
    { label: "Edit", primary: true, onClick: () => openEventSheet(S.state.events.get(event.id)) },
  ]);
}

// ---------------------------------------------------------------------------
// Home Screen links
//
// A Shortcut or widget opens the app on a URL that carries the action. On iOS
// these open Safari rather than the installed app, and Safari keeps its own
// storage, so the write lands in a second local copy and reaches the phone's
// installed app through the server.
// ---------------------------------------------------------------------------

export function homeScreenLink(type) {
  return `${location.origin}/?toggle=${encodeURIComponent(type.id)}`;
}

/** Poll local state for a row that a sync may still be fetching. */
async function waitForRow(find, ms = 5000) {
  const deadline = Date.now() + ms;
  let found = find();
  while (!found && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    found = find();
  }
  return found;
}

// A deep link that arrives before the device is signed in is held here rather
// than dropped, and replayed once the passcode is accepted. Losing the tap
// would be worse than delaying it.
let pendingAction = null;

export function hasPendingAction() {
  return Boolean(pendingAction);
}

/** Take the action out of the URL and hold it. Called once, before sign-in. */
export function captureDeepLink() {
  const params = new URLSearchParams(location.search);
  const end = params.get("end");
  const typeId = params.get("toggle") || params.get("log");
  if (!end && !typeId) return;
  // Strip the action before doing anything, so reloading the page or restoring
  // the tab does not log the event a second time.
  history.replaceState(null, "", location.pathname);
  pendingAction = { end, typeId };
}

/** Carry out a held action, if the device is in a position to do it. */
export async function runPendingAction() {
  if (!pendingAction) return;
  const { end, typeId } = pendingAction;
  pendingAction = null;

  // A device opening this link for the first time has an empty local database,
  // so the target may still be on its way down.
  sync();

  if (end) {
    const event = await waitForRow(() => S.state.events.get(end));
    if (!event) return toast("That entry has not reached this device yet");
    if (event.deleted) return toast("That entry was deleted");
    if (event.ended_at !== null) {
      const type = S.state.event_types.get(event.type_id);
      return toast(`${esc(type?.name || "It")} had already ended`);
    }
    return endSpan(event);
  }

  const type = await waitForRow(() => S.state.event_types.get(typeId));
  if (!type || type.deleted) return toast("That event no longer exists");
  if (S.state.projectId !== type.project_id) await S.setProject(type.project_id);
  return quickLog(type);
}

/**
 * Ask for the passcode.
 *
 * `blocking` is true only when this device holds no data of its own — there is
 * nothing to show and nothing to lose. When local data exists the sheet can be
 * dismissed, because logging must keep working whether or not the session is
 * alive.
 */
export function openSignInSheet({ blocking = false } = {}) {
  const html = `
    ${blocking ? `<div class="sheet-head"><h2>Sign in</h2></div>` : sheetHead("Sign in")}
    <div class="sheet-body">
      <p class="note-text">${
        blocking
          ? "Enter the passcode for this tracker."
          : "Your entries are saved on this device. Sign in to sync them."
      }</p>
      <input class="text-input" data-passcode type="password" inputmode="text"
             autocomplete="current-password" placeholder="Passcode" />
      <p class="field-error" data-error hidden></p>
      <div class="sheet-actions">
        <button class="btn primary big" data-action="sign-in">Sign in</button>
      </div>
    </div>`;

  openSheet(html, (panel) => {
    const input = panel.querySelector("[data-passcode]");
    const errorEl = panel.querySelector("[data-error]");
    setTimeout(() => input.focus(), 60);

    const submit = async () => {
      const passcode = input.value.trim();
      if (!passcode) return;
      const button = panel.querySelector("[data-action='sign-in']");
      button.disabled = true;
      errorEl.hidden = true;
      try {
        await signIn(passcode);
        closeSheet();
        toast("Signed in");
        // A Home Screen link that arrived before sign-in runs now.
        await runPendingAction();
        render();
      } catch (err) {
        button.disabled = false;
        input.select();
        // Shown in the sheet, not as a toast: a toast sits over the button and
        // makes a second attempt impossible.
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    };

    panel.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-action='sign-in']")) submit();
    });
    panel.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") submit();
    });
  });
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage);
  } catch {
    toast("Could not copy — select the text below instead");
  }
}

export function openWidgetSheet() {
  const project = S.currentProject();
  if (!project) return;
  const scriptUrl = `${location.origin}/widget.js?project=${encodeURIComponent(project.id)}`;

  const html = `
    ${sheetHead("Home Screen widget")}
    <div class="sheet-body">
      <ol class="steps">
        <li>Install <strong>Scriptable</strong> from the App Store.</li>
        <li>Copy the script below.</li>
        <li>In Scriptable, add a new script and paste it.</li>
        <li>On the Home Screen, add a <strong>Scriptable</strong> widget in the
            medium size and choose that script.</li>
      </ol>
      <p class="note-text">The widget lists anything running, with the time it
        started. Tap a row to end it. When nothing runs, it lists your events so
        a tap starts one.</p>
      <div class="sheet-actions">
        <a class="btn ghost" href="${scriptUrl}" target="_blank" rel="noopener">Open script</a>
        <button class="btn primary big" data-action="copy-script">Copy script</button>
      </div>
    </div>`;

  openSheet(html, (panel) => {
    panel.addEventListener("click", async (ev) => {
      if (!ev.target.closest("[data-action='copy-script']")) return;
      try {
        const text = await (await fetch(scriptUrl)).text();
        await copyText(text, "Script copied");
      } catch {
        toast("Could not fetch the script — use Open script");
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Event sheet — adjust time, labels and note for one entry
// ---------------------------------------------------------------------------

// The value sits on its own line above the steppers. Squeezed between them it
// truncated to a couple of characters, which is useless precisely when the date
// matters — editing something that happened yesterday.
const timeControlsHtml = (field, label) => `
  <div class="time-label">${esc(label)}</div>
  <div class="time-value" data-time="${field}"></div>
  <div class="time-controls">
    <button class="step" data-shift="${field}:-15">−15m</button>
    <button class="step" data-shift="${field}:-5">−5m</button>
    <button class="step" data-shift="${field}:-1">−1m</button>
    <button class="step" data-shift="${field}:1">+1m</button>
    <button class="step" data-shift="${field}:5">+5m</button>
    <button class="step" data-shift="${field}:15">+15m</button>
  </div>
  <div class="time-extra">
    <button class="step" data-shift="${field}:-1440">−1d</button>
    <button class="btn ghost small" data-now="${field}">Now</button>
    <button class="step" data-shift="${field}:1440">+1d</button>
    <input class="time-input" type="datetime-local" data-picker="${field}" />
  </div>`;

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480];

const durationLabel = (mins) =>
  mins < 60 ? `${mins}m` : mins % 60 ? `${Math.floor(mins / 60)}h${mins % 60}` : `${mins / 60}h`;

/**
 * Record something that already finished, in one sheet.
 *
 * Without this, backfilling a span means starting it, correcting the start,
 * ending it, finding it again in the history and correcting the end. Here both
 * times exist before the entry is saved, so nothing has to be repaired
 * afterwards. The one-tap path is untouched — this lives behind the tile menu.
 */
export function openPastEntrySheet(type) {
  if (!type) return;
  const project = S.currentProject();
  const isSpan = type.kind === "span";

  // An hour ago, on a round five minutes, is a better starting guess than now:
  // nobody backfills something that just happened.
  const start = Math.round((Date.now() - 60 * MINUTE) / (5 * MINUTE)) * 5 * MINUTE;
  const draft = { started_at: start, ended_at: isSpan ? start + 30 * MINUTE : start };

  const html = `
    ${sheetHead(`Past ${type.icon || ""} ${type.name}`.trim())}
    <div class="sheet-body">
      <div class="time-row">${timeControlsHtml("started_at", isSpan ? "Started" : "Time")}</div>
      ${
        isSpan
          ? `<div class="section">
               <div class="section-head"><h3>Lasted</h3></div>
               <div class="chips">
                 ${DURATIONS.map(
                   (m) => `<button class="chip big-chip" data-duration="${m}">${durationLabel(m)}</button>`
                 ).join("")}
               </div>
             </div>
             <div class="time-row">${timeControlsHtml("ended_at", "Ended")}</div>
             <div class="preview" data-preview></div>`
          : ""
      }
      <div class="sheet-actions">
        <button class="btn primary big" data-action="save-past">Add entry</button>
      </div>
    </div>`;

  openSheet(html, (panel) => {
    const refresh = () => {
      for (const el of panel.querySelectorAll("[data-time]")) {
        el.textContent = fullTime(draft[el.dataset.time]);
      }
      for (const el of panel.querySelectorAll("[data-picker]")) {
        el.value = localInputValue(draft[el.dataset.picker]);
      }
      const preview = panel.querySelector("[data-preview]");
      if (preview) {
        const span = draft.ended_at - draft.started_at;
        // Name the days when the entry crosses one, or "22:00 → 06:30" reads as
        // a same-day entry going backwards.
        const crossesDay = dayLabel(draft.started_at) !== dayLabel(draft.ended_at);
        const from = crossesDay ? fullTime(draft.started_at) : clockTime(draft.started_at);
        const to = crossesDay ? fullTime(draft.ended_at) : clockTime(draft.ended_at);
        preview.textContent =
          span < 0 ? "The end is before the start" : `${from} → ${to} · ${duration(span)}`;
        preview.classList.toggle("bad", span < 0);
      }
      for (const chip of panel.querySelectorAll("[data-duration]")) {
        const mins = Number(chip.dataset.duration);
        chip.classList.toggle("on", draft.ended_at - draft.started_at === mins * MINUTE);
      }
    };
    refresh();

    panel.addEventListener("click", async (ev) => {
      const shift = ev.target.closest("[data-shift]");
      if (shift) {
        const [field, mins] = shift.dataset.shift.split(":");
        const delta = Number(mins) * MINUTE;
        draft[field] += delta;
        // Moving the start moves the whole entry, so the length you already
        // chose survives. Moving the end changes the length on purpose.
        if (field === "started_at" && isSpan) draft.ended_at += delta;
        refresh();
        return;
      }
      const nowBtn = ev.target.closest("[data-now]");
      if (nowBtn) {
        const field = nowBtn.dataset.now;
        const delta = Date.now() - draft[field];
        draft[field] = Date.now();
        if (field === "started_at" && isSpan) draft.ended_at += delta;
        refresh();
        return;
      }
      const chip = ev.target.closest("[data-duration]");
      if (chip) {
        draft.ended_at = draft.started_at + Number(chip.dataset.duration) * MINUTE;
        refresh();
        return;
      }
      if (ev.target.closest("[data-action='save-past']")) {
        const ended = isSpan ? Math.max(draft.ended_at, draft.started_at) : draft.started_at;
        closeSheet();
        const event = await S.createEvent(project.id, type, { startedAt: draft.started_at });
        await S.put("events", { id: event.id, ended_at: ended });
        scheduleSync();
        toast(
          `${esc(type.name)} added · ${esc(fullTime(draft.started_at))}${
            isSpan ? ` · ${esc(duration(ended - draft.started_at))}` : ""
          }`,
          [
            { label: "Undo", onClick: () => S.softDelete("events", event.id).then(scheduleSync) },
            { label: "Details", primary: true, onClick: () => openEventSheet(S.state.events.get(event.id)) },
          ]
        );
      }
    });

    panel.addEventListener("change", (ev) => {
      const picker = ev.target.closest("[data-picker]");
      if (!picker || !picker.value) return;
      const field = picker.dataset.picker;
      const next = new Date(picker.value).getTime();
      const delta = next - draft[field];
      draft[field] = next;
      if (field === "started_at" && isSpan) draft.ended_at += delta;
      refresh();
    });
  });
}

export function openEventSheet(event) {
  if (!event) return;
  const project = S.currentProject();
  const type = S.state.event_types.get(event.type_id);
  const isSpan = type?.kind === "span" || event.ended_at === null;
  const draft = {
    started_at: event.started_at,
    ended_at: event.ended_at,
    labels: new Set(S.labelIdsOf(event)),
    quantity: event.quantity,
  };

  const endBlock = !isSpan
    ? ""
    : draft.ended_at === null
      ? `<div class="time-row" data-end-block>
           <div class="running-note">Still running · started ${esc(clockTime(draft.started_at))}</div>
           <button class="btn primary big" data-action="end-now">End now</button>
         </div>`
      : `<div class="time-row" data-end-block>${timeControlsHtml("ended_at", "Ended")}</div>`;

  const html = `
    ${sheetHead(`${type?.icon || ""} ${type?.name || "Entry"}`.trim())}
    <div class="sheet-body">
      <div class="time-row">${timeControlsHtml("started_at", isSpan ? "Started" : "Time")}</div>
      ${endBlock}

      <div class="section">
        <div class="section-head"><h3>Labels</h3></div>
        <div class="chips" data-labels></div>
        <div class="new-label" data-new-label hidden>
          <input class="text-input" data-label-name placeholder="Label name" autocomplete="off" />
          <div class="swatches" data-label-colors>
            ${S.PALETTE.map(
              (c, i) => `<button class="swatch ${i === 0 ? "on" : ""}" data-color="${c}" style="--sw:${c}"></button>`
            ).join("")}
          </div>
          <button class="btn primary" data-action="create-label">Add label</button>
        </div>
      </div>

      ${
        type?.unit
          ? `<div class="time-row">
               <div class="time-label">Amount</div>
               <div class="time-value" data-amount-value></div>
               <div class="time-controls amount-controls">
                 <button class="step" data-adjust="${-10 * (Number(type.step) || 1)}">−${10 * (Number(type.step) || 1)}</button>
                 <button class="step" data-adjust="${-(Number(type.step) || 1)}">−${Number(type.step) || 1}</button>
                 <button class="step" data-adjust="${Number(type.step) || 1}">+${Number(type.step) || 1}</button>
                 <button class="step" data-adjust="${10 * (Number(type.step) || 1)}">+${10 * (Number(type.step) || 1)}</button>
               </div>
             </div>`
          : ""
      }

      <div class="section">
        <div class="section-head"><h3>Note</h3></div>
        <textarea class="note" data-note placeholder="Optional">${esc(event.note || "")}</textarea>
      </div>

      <div class="sheet-actions">
        <button class="btn danger" data-action="delete-event">Delete</button>
        <button class="btn primary big" data-action="save-event">Save</button>
      </div>
    </div>`;

  openSheet(html, (panel) => {
    let newLabelColor = S.PALETTE[0];
    const labelsEl = panel.querySelector("[data-labels]");
    const formEl = panel.querySelector("[data-new-label]");
    const nameEl = panel.querySelector("[data-label-name]");

    const refreshAmount = () => {
      const el = panel.querySelector("[data-amount-value]");
      if (el) el.textContent = S.amountText(type, draft.quantity ?? 0);
    };
    const refreshTimes = () => {
      refreshAmount();
      for (const el of panel.querySelectorAll("[data-time]")) {
        const field = el.dataset.time;
        if (draft[field] != null) el.textContent = fullTime(draft[field]);
      }
      for (const el of panel.querySelectorAll("[data-picker]")) {
        const field = el.dataset.picker;
        if (draft[field] != null) el.value = localInputValue(draft[field]);
      }
    };
    const refreshLabels = () => {
      labelsEl.innerHTML =
        S.labelsFor(project.id)
          .map(
            (l) => `<button class="chip ${draft.labels.has(l.id) ? "on" : ""}" data-label-id="${l.id}"
                            style="--chip:${esc(l.color)}">${esc(l.name)}</button>`
          )
          .join("") + `<button class="chip add" data-action="add-label">＋ label</button>`;
    };
    refreshTimes();
    refreshLabels();

    panel.addEventListener("click", async (ev) => {
      const adjust = ev.target.closest("[data-adjust]");
      if (adjust) {
        draft.quantity = Math.max(0, (draft.quantity || 0) + Number(adjust.dataset.adjust));
        refreshAmount();
        return;
      }
      const shift = ev.target.closest("[data-shift]");
      if (shift) {
        const [field, mins] = shift.dataset.shift.split(":");
        draft[field] = (draft[field] ?? Date.now()) + Number(mins) * MINUTE;
        refreshTimes();
        return;
      }
      const nowBtn = ev.target.closest("[data-now]");
      if (nowBtn) {
        draft[nowBtn.dataset.now] = Date.now();
        refreshTimes();
        return;
      }
      const chip = ev.target.closest("[data-label-id]");
      if (chip) {
        const id = chip.dataset.labelId;
        draft.labels.has(id) ? draft.labels.delete(id) : draft.labels.add(id);
        chip.classList.toggle("on");
        return;
      }
      if (ev.target.closest("[data-action='add-label']")) {
        formEl.hidden = false;
        nameEl.focus();
        return;
      }
      const swatch = ev.target.closest("[data-label-colors] [data-color]");
      if (swatch) {
        newLabelColor = swatch.dataset.color;
        panel.querySelectorAll("[data-label-colors] .swatch").forEach((s) =>
          s.classList.toggle("on", s === swatch)
        );
        return;
      }
      if (ev.target.closest("[data-action='create-label']")) {
        await addLabel();
        return;
      }
      if (ev.target.closest("[data-action='end-now']")) {
        draft.ended_at = Date.now();
        await commit();
        return;
      }
      if (ev.target.closest("[data-action='save-event']")) {
        await commit();
        return;
      }
      if (ev.target.closest("[data-action='delete-event']")) {
        closeSheet();
        await S.softDelete("events", event.id);
        scheduleSync();
        toast("Entry deleted", [
          { label: "Undo", onClick: () => S.put("events", { id: event.id, deleted: 0 }).then(scheduleSync) },
        ]);
      }
    });

    panel.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && ev.target === nameEl) {
        ev.preventDefault();
        addLabel();
      }
    });

    panel.addEventListener("change", (ev) => {
      const picker = ev.target.closest("[data-picker]");
      if (picker && picker.value) {
        draft[picker.dataset.picker] = new Date(picker.value).getTime();
        refreshTimes();
      }
    });

    async function addLabel() {
      const name = nameEl.value.trim();
      if (!name) return;
      const label = await S.createLabel(project.id, name, newLabelColor);
      scheduleSync();
      draft.labels.add(label.id);
      nameEl.value = "";
      formEl.hidden = true;
      refreshLabels();
    }

    async function commit() {
      const note = panel.querySelector("[data-note]").value.trim();
      // An end dragged behind the start is a mis-tap on the stepper; clamping
      // beats storing a negative duration.
      let ended = draft.ended_at;
      if (ended != null && ended < draft.started_at) ended = draft.started_at;
      closeSheet();
      await S.put("events", {
        id: event.id,
        started_at: draft.started_at,
        ended_at: ended,
        label_ids: JSON.stringify([...draft.labels]),
        note,
        quantity: draft.quantity,
      });
      scheduleSync();
    }
  });
}

// ---------------------------------------------------------------------------
// Event type sheets
// ---------------------------------------------------------------------------

export function openTypeSheet(type) {
  const project = S.currentProject();
  const editing = Boolean(type);
  const draft = {
    kind: type?.kind || "point",
    icon: type?.icon || EMOJI[0],
    color: type?.color || S.PALETTE[S.typesFor(project.id).length % S.PALETTE.length],
    unit: type?.unit || "",
    step: Number(type?.step) || 1,
    defaultQuantity: Number(type?.default_quantity) || 0,
  };

  const html = `
    ${sheetHead(editing ? "Edit event" : "New event")}
    <div class="sheet-body">
      <input class="text-input" data-name placeholder="Event name"
             value="${esc(type?.name || "")}" autocomplete="off" />

      <div class="section">
        <div class="section-head"><h3>Kind</h3></div>
        <div class="segmented">
          <button class="seg ${draft.kind === "point" ? "on" : ""}" data-kind-value="point">
            <strong>Moment</strong><span>Happens at a time</span>
          </button>
          <button class="seg ${draft.kind === "span" ? "on" : ""}" data-kind-value="span">
            <strong>Span</strong><span>Starts, then ends</span>
          </button>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h3>Icon</h3></div>
        <div class="emoji-grid">
          ${EMOJI.map(
            (e) => `<button class="emoji ${e === draft.icon ? "on" : ""}" data-emoji-value="${e}">${e}</button>`
          ).join("")}
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h3>Colour</h3></div>
        <div class="swatches">
          ${S.PALETTE.map(
            (c) => `<button class="swatch ${c === draft.color ? "on" : ""}" data-color="${c}" style="--sw:${c}"></button>`
          ).join("")}
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h3>Amount</h3></div>
        <p class="note-text">Leave the unit empty if this event has no amount.</p>
        <input class="text-input" data-unit placeholder="Unit, for example ml or kg"
               value="${esc(draft.unit)}" autocomplete="off" />
        <div class="amount-setup" data-amount-setup ${draft.unit ? "" : "hidden"}>
          <div class="section-head"><h3>Steps of</h3></div>
          <div class="chips">
            ${[1, 5, 10, 25, 50].map(
              (v) => `<button class="chip" data-step="${v}">${v}</button>`
            ).join("")}
          </div>
          <div class="section-head"><h3>A tap records</h3></div>
          <div class="time-controls amount-controls">
            <button class="step" data-amount="-10">−10</button>
            <button class="step" data-amount="-1">−1</button>
            <div class="time-value" data-default-amount></div>
            <button class="step" data-amount="1">+1</button>
            <button class="step" data-amount="10">+10</button>
          </div>
        </div>
      </div>

      <div class="sheet-actions">
        ${editing ? `<button class="btn danger" data-action="delete-type">Remove</button>` : ""}
        <button class="btn primary big" data-action="save-type">${editing ? "Save" : "Create"}</button>
      </div>
    </div>`;

  openSheet(html, (panel) => {
    const nameEl = panel.querySelector("[data-name]");
    const unitEl = panel.querySelector("[data-unit]");
    const setupEl = panel.querySelector("[data-amount-setup]");
    if (!editing) setTimeout(() => nameEl.focus(), 60);

    const refreshAmount = () => {
      draft.unit = unitEl.value.trim();
      setupEl.hidden = !draft.unit;
      panel.querySelector("[data-default-amount]").textContent =
        `${Math.round(draft.defaultQuantity * 100) / 100}${draft.unit}`;
      for (const chip of panel.querySelectorAll("[data-step]")) {
        chip.classList.toggle("on", Number(chip.dataset.step) === draft.step);
      }
    };
    refreshAmount();
    unitEl.addEventListener("input", refreshAmount);

    panel.addEventListener("click", async (ev) => {
      const stepChip = ev.target.closest("[data-step]");
      if (stepChip) {
        draft.step = Number(stepChip.dataset.step);
        refreshAmount();
        return;
      }
      const amountBtn = ev.target.closest("[data-amount]");
      if (amountBtn) {
        draft.defaultQuantity = Math.max(0, draft.defaultQuantity + Number(amountBtn.dataset.amount));
        refreshAmount();
        return;
      }
      const kind = ev.target.closest("[data-kind-value]");
      if (kind) {
        draft.kind = kind.dataset.kindValue;
        panel.querySelectorAll(".seg").forEach((s) => s.classList.toggle("on", s === kind));
        return;
      }
      const emoji = ev.target.closest("[data-emoji-value]");
      if (emoji) {
        draft.icon = emoji.dataset.emojiValue;
        panel.querySelectorAll(".emoji").forEach((s) => s.classList.toggle("on", s === emoji));
        return;
      }
      const swatch = ev.target.closest("[data-color]");
      if (swatch) {
        draft.color = swatch.dataset.color;
        panel.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("on", s === swatch));
        return;
      }
      if (ev.target.closest("[data-action='save-type']")) {
        const name = nameEl.value.trim();
        if (!name) return nameEl.focus();
        draft.unit = unitEl.value.trim();
        closeSheet();
        if (editing) {
          const becameMoment = type.kind === "span" && draft.kind === "point";
          await S.put("event_types", {
            id: type.id, name, kind: draft.kind, icon: draft.icon, color: draft.color,
            unit: draft.unit, step: draft.step, default_quantity: draft.defaultQuantity,
          });
          // A moment tile cannot end a span, so any span still running would be
          // stranded: it would run for ever, and tapping the tile would record
          // a new entry beside it. Close them at now, which keeps the time
          // already recorded rather than discarding it.
          if (becameMoment) {
            const running = S.openSpans(type.project_id).filter((e) => e.type_id === type.id);
            for (const event of running) await S.endEvent(event);
            if (running.length) {
              toast(
                `${esc(name)} is now a moment · ${running.length} running ` +
                  `${running.length === 1 ? "entry" : "entries"} ended`
              );
            }
          }
        } else {
          await S.createType(project.id, { name, ...draft });
        }
        scheduleSync();
        return;
      }
      if (ev.target.closest("[data-action='delete-type']")) {
        closeSheet();
        await S.softDelete("event_types", type.id);
        scheduleSync();
        toast(`${esc(type.name)} removed · past entries kept`, [
          { label: "Undo", onClick: () => S.put("event_types", { id: type.id, deleted: 0 }).then(scheduleSync) },
        ]);
      }
    });
  });
}

/** Tile options: log at a chosen time, review recent entries, edit the type. */
export function openTileSheet(type) {
  if (!type) return;
  const project = S.currentProject();
  const recent = S.eventsFor(project.id).filter((e) => e.type_id === type.id).slice(0, 5);

  const html = `
    ${sheetHead(`${type.icon || ""} ${type.name}`.trim())}
    <div class="sheet-body">
      <div class="section">
        <div class="section-head"><h3>${type.kind === "span" ? "Start it earlier" : "Log it earlier"}</h3></div>
        <div class="chips">
          ${[1, 5, 15, 30, 60, 120]
            .map(
              (m) => `<button class="chip big-chip" data-back="${m}">${m < 60 ? `${m}m` : `${m / 60}h`} ago</button>`
            )
            .join("")}
        </div>
      </div>

      ${recent.length
        ? `<div class="section">
             <div class="section-head"><h3>Recent</h3></div>
             <ul class="entries">${recent.map(entryHtml).join("")}</ul>
           </div>`
        : ""}

      <div class="section">
        <div class="section-head"><h3>Already happened</h3></div>
        <button class="btn ghost big" data-action="past-entry">
          ${type.kind === "span" ? "Add a finished span" : "Add at another time"}
        </button>
      </div>

      <div class="section">
        <div class="section-head"><h3>Home Screen</h3></div>
        <input class="text-input link-input" value="${esc(homeScreenLink(type))}" readonly
               onfocus="this.select()" />
        <button class="btn ghost" data-action="copy-link">Copy link for a Shortcut</button>
      </div>

      <div class="sheet-actions">
        <button class="btn ghost" data-action="edit-type">Edit event</button>
        <button class="btn primary big" data-action="log-now">
          ${type.kind === "span" ? "Start now" : "Log now"}
        </button>
      </div>
    </div>`;

  openSheet(html, (panel) => {
    panel.addEventListener("click", async (ev) => {
      if (ev.target.closest("[data-action='copy-link']")) {
        await copyText(homeScreenLink(type), `Link for ${esc(type.name)} copied`);
        return;
      }
      if (ev.target.closest("[data-action='past-entry']")) {
        openPastEntrySheet(type);
        return;
      }
      const back = ev.target.closest("[data-back]");
      if (back) {
        closeSheet();
        const startedAt = Date.now() - Number(back.dataset.back) * MINUTE;
        const event = await S.createEvent(project.id, type, { startedAt });
        scheduleSync();
        toast(`${esc(type.name)} logged ${esc(clockTime(startedAt))}`, [
          { label: "Undo", onClick: () => S.softDelete("events", event.id).then(scheduleSync) },
          { label: "Details", primary: true, onClick: () => openEventSheet(S.state.events.get(event.id)) },
        ]);
        return;
      }
      if (ev.target.closest("[data-action='log-now']")) {
        closeSheet();
        await quickLog(type);
        return;
      }
      if (ev.target.closest("[data-action='edit-type']")) {
        openTypeSheet(type);
        return;
      }
      const entry = ev.target.closest("[data-action='entry']");
      if (entry) openEventSheet(S.state.events.get(entry.dataset.id));
    });
  });
}

// ---------------------------------------------------------------------------
// Timeline
//
// One row per day, spans drawn as bars across a 24-hour track and moments as
// ticks. Nothing here knows what any event means — position comes from the
// timestamps, colour from the type the user chose.
// ---------------------------------------------------------------------------

/** Local midnight either side of a timestamp. Derived from the calendar rather
 *  than by adding 24h, so the two DST days a year stay the right length. */
function dayBounds(ts) {
  const d = new Date(ts);
  return {
    start: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
    end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(),
  };
}

/** Stack overlapping spans so neither hides behind the other. */
function assignLanes(spans) {
  spans.sort((a, b) => a.from - b.from);
  const laneEnds = [];
  for (const span of spans) {
    let lane = laneEnds.findIndex((end) => end <= span.from);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = span.to;
    span.lane = lane;
  }
  return Math.max(1, laneEnds.length);
}

/** Up to three label colours, drawn as a band under a bar. */
function labelStripe(event) {
  const colors = S.labelIdsOf(event)
    .map((id) => S.state.labels.get(id))
    .filter((l) => l && !l.deleted)
    .slice(0, 3)
    .map((l) => l.color);
  if (!colors.length) return null;
  const step = 100 / colors.length;
  return colors.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`).join(", ");
}

function eventPieces(event, now) {
  const type = S.state.event_types.get(event.type_id);
  const open = event.ended_at === null;
  const isMoment = !open && event.ended_at === event.started_at;
  return {
    type,
    open,
    isMoment,
    color: type?.color || "#8b91a1",
    stripe: labelStripe(event),
    finish: Math.max(open ? now : event.ended_at, event.started_at),
  };
}

/**
 * Cut events into per-day pieces.
 *
 * A span from 22:00 to 06:00 belongs to two days and must appear on both, so
 * events are cut at midnight rather than filed under whichever day they began.
 */
function buildDays(events, now, dayLimit) {
  const days = new Map();
  const dayFor = (ts) => {
    const { start, end } = dayBounds(ts);
    if (!days.has(start)) days.set(start, { start, end, label: shortDayLabel(start), spans: [], ticks: [] });
    return days.get(start);
  };

  for (const event of events) {
    const p = eventPieces(event, now);
    if (p.isMoment) {
      dayFor(event.started_at).ticks.push({ id: event.id, at: event.started_at, ...p });
      continue;
    }
    let cursor = event.started_at;
    for (let guard = 0; guard < 400; guard++) {
      const { start, end } = dayBounds(cursor);
      dayFor(cursor).spans.push({
        id: event.id,
        from: Math.max(event.started_at, start),
        to: Math.min(p.finish, end),
        ...p,
      });
      if (p.finish <= end) break;
      cursor = end;
    }
  }

  const ordered = [...days.values()].sort((a, b) => b.start - a.start);
  const shown = ordered.slice(0, dayLimit);
  for (const day of shown) day.lanes = assignLanes(day.spans);
  return { rows: shown, hasOlder: ordered.length > shown.length };
}

/** One track covering a moving window, so a night is not split at midnight. */
function buildWindow(events, from, to, now) {
  const row = { start: from, end: to, label: "", spans: [], ticks: [] };
  for (const event of events) {
    const p = eventPieces(event, now);
    if (p.isMoment) {
      if (event.started_at >= from && event.started_at <= to) {
        row.ticks.push({ id: event.id, at: event.started_at, ...p });
      }
      continue;
    }
    if (p.finish < from || event.started_at > to) continue;
    row.spans.push({
      id: event.id,
      from: Math.max(event.started_at, from),
      to: Math.min(p.finish, to),
      ...p,
    });
  }
  row.lanes = assignLanes(row.spans);
  return { rows: [row], hasOlder: false };
}

const LANE_H = 15;
const TICK_H = 11;

/**
 * Where to draw gridlines and their labels.
 *
 * A day is split at 0/6/12/18. A rolling window is snapped to whole six-hour
 * marks instead of quarters of the window, because "15:44" is a number nobody
 * reads a timeline against.
 */
function gridMarks(from, to, dayAligned) {
  if (dayAligned) return [0, 6, 12, 18].map((h) => ({ pct: (h / 24) * 100, label: pad(h) }));

  const width = to - from;
  const marks = [];
  const cursor = new Date(from);
  cursor.setMinutes(0, 0, 0);
  cursor.setHours(Math.ceil(cursor.getHours() / 6) * 6);
  for (let guard = 0; guard < 12 && cursor.getTime() <= to; guard++) {
    marks.push({ pct: ((cursor.getTime() - from) / width) * 100, label: clockTime(cursor.getTime()) });
    cursor.setHours(cursor.getHours() + 6);
  }
  return marks;
}

function trackHtml(row, now, { laneH = LANE_H, tickH = TICK_H, marks = null } = {}) {
  const width = row.end - row.start;
  const pct = (ts) => ((ts - row.start) / width) * 100;

  const bars = row.spans
    .map((s) => {
      const left = pct(s.from);
      const w = Math.max(pct(s.to) - left, 0.7);
      const title = `${s.type?.name || "Event"} ${clockTime(s.from)}–${s.open ? "now" : clockTime(s.to)}`;
      const stripe = s.stripe ? `--stripe:linear-gradient(to right, ${s.stripe});` : "";
      return `<button class="tl-span ${s.open ? "open" : ""} ${s.stripe ? "labelled" : ""}"
                      data-action="entry" data-id="${s.id}"
                      style="left:${left}%;width:${w}%;top:${s.lane * laneH}px;height:${laneH - 3}px;--tile:${esc(s.color)};${stripe}"
                      title="${esc(title)}" aria-label="${esc(title)}"></button>`;
    })
    .join("");

  const ticks = row.ticks
    .map((t) => {
      const title = `${t.type?.name || "Event"} ${clockTime(t.at)}`;
      const stripe = t.stripe ? `--stripe:linear-gradient(to right, ${t.stripe});` : "";
      return `<button class="tl-tick ${t.stripe ? "labelled" : ""}" data-action="entry" data-id="${t.id}"
                      style="left:${pct(t.at)}%;--tile:${esc(t.color)};${stripe}"
                      title="${esc(title)}" aria-label="${esc(title)}"></button>`;
    })
    .join("");

  const showsNow = now >= row.start && now <= row.end;
  const height = Math.max(row.lanes * laneH + (row.ticks.length ? tickH : 0), laneH);
  // Explicit lines when the marks are not at quarters, since the track's own
  // background grid is fixed at 25% steps.
  const lines = marks
    ? marks.map((m) => `<div class="tl-line" style="left:${m.pct}%"></div>`).join("")
    : "";

  return `
    <div class="tl-row">
      ${row.label ? `<div class="tl-daylabel">${esc(row.label)}</div>` : ""}
      <div class="tl-track ${marks ? "free" : ""}" style="height:${height}px">
        ${lines}
        ${bars}
        <div class="tl-ticks" style="top:${row.lanes * laneH}px;height:${tickH}px">${ticks}</div>
        ${showsNow ? `<div class="tl-now" style="left:${pct(now)}%"></div>` : ""}
      </div>
    </div>`;
}

function hoursHtml(marks, inset) {
  return `<div class="tl-hours ${inset ? "inset" : ""}">${marks
    .map((m) => `<span style="left:${m.pct}%">${esc(m.label)}</span>`)
    .join("")}</div>`;
}

/** Totals per event type for a window. Generic: names come from the data. */
function summaryHtml(events, from, to, now) {
  const totals = new Map();
  for (const event of events) {
    const p = eventPieces(event, now);
    if (!p.type) continue;
    if (p.finish < from || event.started_at > to) continue;
    const entry = totals.get(p.type.id) || { type: p.type, count: 0, ms: 0 };
    entry.count += 1;
    if (!p.isMoment) {
      entry.ms += Math.min(p.finish, to) - Math.max(event.started_at, from);
    }
    totals.set(p.type.id, entry);
  }
  if (!totals.size) return "";
  const chips = [...totals.values()]
    .sort((a, b) => b.count - a.count)
    .map(
      (t) => `<span class="chip static" style="--chip:${esc(t.type.color)}">${esc(t.type.icon)} ${esc(
        t.type.name
      )} ×${t.count}${t.ms ? ` · ${esc(duration(t.ms))}` : ""}</span>`
    )
    .join("");
  return `<div class="tl-summary">${chips}</div>`;
}

// ---------------------------------------------------------------------------
// Stats
//
// No query builder. The filter chips already on the page decide what is
// counted, so "feeds per day" and "left-side feeds per day" are the same screen
// with one more chip tapped. Nothing here knows any event or label name.
// ---------------------------------------------------------------------------

const PERIODS = [
  { key: "7", label: "7 days", days: 7 },
  { key: "30", label: "30 days", days: 30 },
  { key: "all", label: "All", days: null },
];
let statsPeriod = "7";
let statsMetric = "count";

function periodBounds(events, now) {
  const today = dayBounds(now);
  const period = PERIODS.find((p) => p.key === statsPeriod) || PERIODS[0];
  if (period.days) return { from: today.start - (period.days - 1) * DAY, to: today.end };
  const earliest = events.reduce((min, e) => Math.min(min, e.started_at), now);
  return { from: dayBounds(earliest).start, to: today.end };
}

/**
 * Bucket the filtered events by day, by hour, by type and by label.
 *
 * Counts go to the day an event started. Durations are split at midnight, the
 * same way the timeline draws them, so a night's sleep is not credited entirely
 * to the day it began.
 */
function computeStats(events, from, to, now) {
  const days = new Map();
  const hours = Array.from({ length: 24 }, () => ({ count: 0, ms: 0, qty: 0 }));
  const byType = new Map();
  const byLabel = new Map();
  let total = 0;
  let totalMs = 0;
  let totalQty = 0;
  let unit = "";

  for (let d = from; d < to; d = dayBounds(d).end) days.set(d, { count: 0, ms: 0, qty: 0 });

  const addMs = (bucketStart, ms) => {
    const bucket = days.get(bucketStart);
    if (bucket) bucket.ms += ms;
  };

  for (const event of events) {
    if (event.started_at >= to) continue;
    const p = eventPieces(event, now);
    if (p.finish < from) continue;

    total += 1;
    const startDay = dayBounds(event.started_at).start;
    if (days.has(startDay)) days.get(startDay).count += 1;
    hours[new Date(event.started_at).getHours()].count += 1;

    // An amount belongs to the moment it was recorded, not spread over a span.
    const qty = Number(event.quantity) || 0;
    if (qty) {
      totalQty += qty;
      if (days.has(startDay)) days.get(startDay).qty += qty;
      hours[new Date(event.started_at).getHours()].qty += qty;
      if (p.type?.unit) unit = p.type.unit;
    }

    const type = p.type;
    if (type) {
      const entry = byType.get(type.id) || { name: type.name, icon: type.icon, color: type.color, count: 0, ms: 0, qty: 0 };
      entry.count += 1;
      entry.qty += qty;
      byType.set(type.id, entry);
    }
    for (const id of S.labelIdsOf(event)) {
      const label = S.state.labels.get(id);
      if (!label || label.deleted) continue;
      const entry = byLabel.get(id) || { name: label.name, color: label.color, count: 0, ms: 0, qty: 0 };
      entry.count += 1;
      entry.qty += qty;
      byLabel.set(id, entry);
    }

    if (p.isMoment) continue;

    // Split the span across the days and hours it covers.
    let cursor = Math.max(event.started_at, from);
    const finish = Math.min(p.finish, to);
    for (let guard = 0; guard < 800 && cursor < finish; guard++) {
      const bounds = dayBounds(cursor);
      const chunkEnd = Math.min(finish, bounds.end);
      const ms = chunkEnd - cursor;
      addMs(bounds.start, ms);
      hours[new Date(cursor).getHours()].ms += ms;
      totalMs += ms;
      if (type) byType.get(type.id).ms += ms;
      for (const id of S.labelIdsOf(event)) {
        if (byLabel.has(id)) byLabel.get(id).ms += ms;
      }
      cursor = chunkEnd;
    }
  }

  return { days, hours, byType, byLabel, total, totalMs, totalQty, unit, dayCount: days.size };
}

const hasSpans = (events) =>
  events.some((e) => e.ended_at === null || e.ended_at !== e.started_at);

const metricValue = (bucket, metric) =>
  metric === "time" ? bucket.ms : metric === "amount" ? bucket.qty : bucket.count;

function barChartHtml(buckets, { metric, tickEvery, tickFor, labelFor, unit = "" }) {
  const format = (v) =>
    metric === "time" ? duration(v) : metric === "amount" ? `${Math.round(v * 10) / 10}${unit}` : String(v);
  const values = buckets.map((b) => metricValue(b, metric));
  const peak = Math.max(...values, 1);
  // Durations are wide, so only label them when a bar can hold one.
  const showValues = metric === "count" ? buckets.length <= 14 : buckets.length <= 7;

  const cols = buckets
    .map((b, i) => {
      const value = values[i];
      const height = value ? Math.max((value / peak) * 100, 4) : 0;
      const shown = value ? format(value) : "";
      return `
        <div class="bar-col" title="${esc(`${labelFor(b, i)}: ${format(value)}`)}">
          ${showValues ? `<span class="bar-val">${esc(String(shown))}</span>` : ""}
          <div class="bar ${value ? "" : "zero"}" style="height:${height}%"></div>
          <span class="bar-tick">${i % tickEvery === 0 ? esc(tickFor(b, i)) : ""}</span>
        </div>`;
    })
    .join("");

  return `<div class="bars">${cols}</div>`;
}

function rankHtml(map, metric, unit = "") {
  // A moment has no duration, so listing it as "0s" is noise, not information.
  const rows = [...map.values()]
    .filter((r) => metricValue(r, metric) > 0)
    .sort((a, b) => metricValue(b, metric) - metricValue(a, metric));
  if (!rows.length) return "";
  const peak = Math.max(...rows.map((r) => metricValue(r, metric)), 1);
  return `
    <div class="rank">
      ${rows
        .map((r) => {
          const value = metricValue(r, metric);
          return `
            <div class="rank-row">
              <span class="rank-name">${esc(r.icon || "")} ${esc(r.name)}</span>
              <div class="rank-track">
                <div class="rank-fill" style="width:${(value / peak) * 100}%;background:${esc(r.color)}"></div>
              </div>
              <span class="rank-val">${esc(
                metric === "time" ? duration(r.ms)
                  : metric === "amount" ? `${Math.round(r.qty * 10) / 10}${unit}`
                  : String(r.count)
              )}</span>
            </div>`;
        })
        .join("")}
    </div>`;
}

function statsHtml(events, now) {
  const { from, to } = periodBounds(events, now);
  const s = computeStats(events, from, to, now);
  const spans = hasSpans(events);
  const amounts = s.totalQty > 0;
  // Offer only the metrics the data can answer.
  const available = ["count", ...(spans ? ["time"] : []), ...(amounts ? ["amount"] : [])];
  const metric = available.includes(statsMetric) ? statsMetric : "count";

  const dayBuckets = [...s.days.entries()].map(([start, v]) => ({ start, ...v }));
  const perDay = s.dayCount ? s.total / s.dayCount : 0;

  const tiles = [
    { value: String(s.total), key: "entries" },
    { value: perDay.toFixed(perDay < 10 ? 1 : 0), key: "per day" },
    ...(s.totalMs ? [{ value: duration(s.totalMs), key: "total time" }] : []),
    ...(s.totalMs ? [{ value: duration(s.totalMs / Math.max(s.dayCount, 1)), key: "time/day" }] : []),
    ...(amounts ? [{ value: `${Math.round(s.totalQty * 10) / 10}${s.unit}`, key: "total" }] : []),
    ...(amounts
      ? [{ value: `${Math.round((s.totalQty / Math.max(s.dayCount, 1)) * 10) / 10}${s.unit}`, key: `${s.unit}/day` }]
      : []),
  ];

  const periodChips = PERIODS.map(
    (p) => `<button class="chip ${statsPeriod === p.key ? "on" : ""}" data-period="${p.key}">${p.label}</button>`
  ).join("");

  const metricLabel = { count: "Count", time: "Time", amount: "Amount" };
  const metricChips = available.length > 1
    ? `<div class="chips metric-chips">
         ${available.map(
           (m) => `<button class="chip ${metric === m ? "on" : ""}" data-metric="${m}">${metricLabel[m]}</button>`
         ).join("")}
       </div>`
    : "";

  if (!s.total) {
    return `
      <div class="stats">
        <div class="chips">${periodChips}</div>
        <p class="empty">Nothing in this period.</p>
      </div>`;
  }

  const tickEvery = dayBuckets.length <= 10 ? 1 : Math.ceil(dayBuckets.length / 6);

  return `
    <div class="stats">
      <div class="chips">${periodChips}</div>
      ${metricChips}

      <div class="stat-grid">
        ${tiles
          .map(
            (t) => `<div class="stat">
                      <span class="stat-val">${esc(t.value)}</span>
                      <span class="stat-key">${esc(t.key)}</span>
                    </div>`
          )
          .join("")}
      </div>

      <div class="section">
        <div class="section-head"><h3>Per day</h3></div>
        ${barChartHtml(dayBuckets, {
          metric,
          unit: s.unit,
          tickEvery,
          tickFor: (b) =>
            new Date(b.start).toLocaleDateString(undefined, { day: "numeric", month: "short" }),
          labelFor: (b) => dayLabel(b.start),
        })}
      </div>

      <div class="section">
        <div class="section-head"><h3>Time of day</h3></div>
        ${barChartHtml(s.hours, {
          metric,
          unit: s.unit,
          tickEvery: 6,
          tickFor: (_, i) => pad(i),
          labelFor: (_, i) => `${pad(i)}:00`,
        })}
      </div>

      <div class="section">
        <div class="section-head"><h3>By event</h3></div>
        ${rankHtml(s.byType, metric, s.unit)}
      </div>

      ${
        s.byLabel.size
          ? `<div class="section">
               <div class="section-head"><h3>By label</h3></div>
               ${rankHtml(s.byLabel, metric, s.unit)}
             </div>`
          : ""
      }
    </div>`;
}

// ---------------------------------------------------------------------------
// History page
// ---------------------------------------------------------------------------

const HISTORY_PAGE = 100;
const TIMELINE_PAGE = 14;
let historyLimit = HISTORY_PAGE;
let timelineDays = TIMELINE_PAGE;

// Which history view to show. A display preference, so it lives in
// localStorage rather than in the synced database.
const VIEW_KEY = "tracker-history-view";
let historyMode = "day";
try {
  historyMode = localStorage.getItem(VIEW_KEY) || "day";
} catch {
  /* private mode: default for this session */
}

// Filters are deliberately not persisted. Coming back to a screen that is
// silently hiding entries is worse than re-tapping a chip.
const filters = { types: new Set(), labels: new Set() };

function filtersActive() {
  return filters.types.size > 0 || filters.labels.size > 0;
}

function matchesFilters(event) {
  if (filters.types.size && !filters.types.has(event.type_id)) return false;
  if (filters.labels.size) {
    const ids = S.labelIdsOf(event);
    if (!ids.some((id) => filters.labels.has(id))) return false;
  }
  return true;
}

function setHistoryMode(mode) {
  historyMode = mode;
  try {
    localStorage.setItem(VIEW_KEY, mode);
  } catch {
    /* preference just will not persist */
  }
  render();
}

function filterBarHtml(project) {
  const types = S.typesFor(project.id);
  const labels = S.labelsFor(project.id);

  const typeChips = types
    .map(
      (t) => `<button class="chip ${filters.types.has(t.id) ? "on" : ""}" data-filter-type="${t.id}"
                      style="--chip:${esc(t.color)}">${esc(t.icon)} ${esc(t.name)}</button>`
    )
    .join("");

  const labelChips = labels
    .map(
      (l) => `<button class="chip ${filters.labels.has(l.id) ? "on" : ""}" data-filter-label="${l.id}"
                      style="--chip:${esc(l.color)}">${esc(l.name)}</button>`
    )
    .join("");

  return `
    <div class="filters">
      ${typeChips ? `<div class="chips">${typeChips}</div>` : ""}
      ${labelChips ? `<div class="chips">${labelChips}</div>` : ""}
      ${
        filtersActive()
          ? `<button class="btn ghost small clear-filters" data-clear-filters>Show everything</button>`
          : ""
      }
    </div>`;
}

export function historyPageHtml(project) {
  const now = Date.now();
  const all = S.eventsFor(project.id);
  const events = filtersActive() ? all.filter(matchesFilters) : all;

  const tabs = ["day", "rolling", "list", "stats"];
  const tabLabel = { day: "Days", rolling: "24h", list: "List", stats: "Stats" };
  const toggle = `
    <div class="segmented view-toggle">
      ${tabs
        .map(
          (t) => `<button class="seg ${historyMode === t ? "on" : ""}" data-view="${t}">${tabLabel[t]}</button>`
        )
        .join("")}
    </div>`;

  let body = "";
  let more = "";

  if (historyMode === "stats") {
    body = statsHtml(events, now);
  } else if (historyMode === "rolling") {
    const from = now - DAY;
    const built = buildWindow(events, from, now, now);
    const marks = gridMarks(from, now, false);
    // One row only, so it can afford to be taller and easier to hit.
    body = `
      <div class="tl">
        ${hoursHtml(marks, false)}
        ${trackHtml(built.rows[0], now, { laneH: 22, tickH: 16, marks })}
        ${summaryHtml(events, from, now, now)}
      </div>`;
  } else if (historyMode === "day") {
    const built = buildDays(events, now, timelineDays);
    body = built.rows.length
      ? `<div class="tl">
           ${hoursHtml(gridMarks(0, 0, true), true)}
           ${built.rows.map((r) => trackHtml(r, now)).join("")}
         </div>`
      : `<p class="empty">Nothing to show.</p>`;
    if (built.hasOlder) more = `<button class="btn ghost big" data-action="more-timeline">Earlier days</button>`;
  } else {
    const shown = events.slice(0, historyLimit);
    const groups = [];
    for (const event of shown) {
      const label = dayLabel(event.started_at);
      if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
      groups[groups.length - 1].items.push(event);
    }
    body = groups.length
      ? groups
          .map(
            (g) => `<div class="day-group">
                      <h3 class="day-head">${esc(g.label)}</h3>
                      <ul class="entries">${g.items.map(entryHtml).join("")}</ul>
                    </div>`
          )
          .join("")
      : `<p class="empty">Nothing to show.</p>`;
    if (events.length > shown.length) more = `<button class="btn ghost big" data-action="more-history">Show more</button>`;
  }

  return `
    <div class="page">
      ${toggle}
      ${filterBarHtml(project)}
      ${body}
      ${more}
      <div class="page-actions">
        <a class="btn ghost" href="/api/export?project=${encodeURIComponent(project.id)}" download>Export CSV</a>
      </div>
    </div>`;
}

/** Handles the history page's own controls. Returns whether it consumed the click. */
export function handleHistoryClick(target) {
  const view = target.closest("[data-view]");
  if (view) {
    setHistoryMode(view.dataset.view);
    return true;
  }
  const type = target.closest("[data-filter-type]");
  if (type) {
    const id = type.dataset.filterType;
    filters.types.has(id) ? filters.types.delete(id) : filters.types.add(id);
    render();
    return true;
  }
  const label = target.closest("[data-filter-label]");
  if (label) {
    const id = label.dataset.filterLabel;
    filters.labels.has(id) ? filters.labels.delete(id) : filters.labels.add(id);
    render();
    return true;
  }
  if (target.closest("[data-clear-filters]")) {
    filters.types.clear();
    filters.labels.clear();
    render();
    return true;
  }
  const period = target.closest("[data-period]");
  if (period) {
    statsPeriod = period.dataset.period;
    render();
    return true;
  }
  const metric = target.closest("[data-metric]");
  if (metric) {
    statsMetric = metric.dataset.metric;
    render();
    return true;
  }
  if (target.closest("[data-action='more-timeline']")) {
    timelineDays += TIMELINE_PAGE;
    render();
    return true;
  }
  if (target.closest("[data-action='more-history']")) {
    historyLimit += 2 * HISTORY_PAGE;
    render();
    return true;
  }
  return false;
}

export function resetHistoryPaging() {
  historyLimit = HISTORY_PAGE;
  timelineDays = TIMELINE_PAGE;
}

export function openProjectSheet() {
  const html = `
    ${sheetHead("Projects")}
    <div class="sheet-body">
      <ul class="project-list">
        ${S.projects()
          .map(
            (p) => `<li class="project-row ${p.id === S.state.projectId ? "on" : ""}">
                      <button class="project-pick" data-pick="${p.id}">
                        <span class="project-swatch" style="--sw:${esc(p.color)}"></span>
                        <span class="project-title">${esc(p.name)}</span>
                        <span class="project-count">${S.typesFor(p.id).length} events</span>
                      </button>
                      <button class="icon-btn" data-rename="${p.id}" aria-label="Rename ${esc(p.name)}">✎</button>
                      <button class="icon-btn danger" data-remove="${p.id}" aria-label="Delete ${esc(p.name)}">🗑</button>
                    </li>`
          )
          .join("")}
      </ul>
      <div class="sheet-actions">
        <button class="btn ghost" data-action="widget">Home Screen widget</button>
        <button class="btn primary big" data-action="new-project">New project</button>
      </div>
    </div>`;

  openSheet(html, (panel) => {
    panel.addEventListener("click", async (ev) => {
      if (ev.target.closest("[data-action='widget']")) {
        openWidgetSheet();
        return;
      }
      const pick = ev.target.closest("[data-pick]");
      if (pick) {
        closeSheet();
        await S.setProject(pick.dataset.pick);
        return;
      }
      const rename = ev.target.closest("[data-rename]");
      if (rename) {
        const id = rename.dataset.rename;
        openNameSheet("Rename project", S.state.projects.get(id).name, async (name) => {
          await S.put("projects", { id, name });
          scheduleSync();
          openProjectSheet();
        });
        return;
      }
      const remove = ev.target.closest("[data-remove]");
      if (remove) {
        const project = S.state.projects.get(remove.dataset.remove);
        closeSheet();
        await S.softDelete("projects", project.id);
        if (S.state.projectId === project.id) await S.setProject(S.projects()[0]?.id || null);
        scheduleSync();
        toast(`${esc(project.name)} deleted`, [
          { label: "Undo", onClick: () => S.put("projects", { id: project.id, deleted: 0 }).then(scheduleSync) },
        ]);
        return;
      }
      if (ev.target.closest("[data-action='new-project']")) newProject();
    });
  });
}

function newProject() {
  openNameSheet("New project", "", async (name) => {
    const project = await S.createProject(name);
    closeSheet();
    await S.setProject(project.id);
    scheduleSync();
  });
}

function openNameSheet(title, initial, onSave) {
  const html = `
    ${sheetHead(title)}
    <div class="sheet-body">
      <input class="text-input" data-name placeholder="Name" value="${esc(initial)}" autocomplete="off" />
      <div class="sheet-actions">
        <button class="btn primary big" data-action="save-name">Save</button>
      </div>
    </div>`;

  openSheet(html, (panel) => {
    const input = panel.querySelector("[data-name]");
    setTimeout(() => input.select(), 60);
    const save = () => {
      const name = input.value.trim();
      if (name) onSave(name);
    };
    panel.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-action='save-name']")) save();
    });
    panel.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") save();
    });
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function wire() {
  document.getElementById("project-btn").addEventListener("click", openProjectSheet);
  document.getElementById("history-btn").addEventListener("click", () => {
    showView(view === "history" ? "log" : "history");
  });
  document.getElementById("sync-btn").addEventListener("click", () => {
    if (status.phase === "signed-out") openSignInSheet();
    else sync();
  });

  screenEl.addEventListener("click", async (ev) => {
    // The history page owns its tabs, filters and paging.
    if (view === "history" && handleHistoryClick(ev.target)) return;

    const target = ev.target.closest("[data-action]");
    if (!target) return;
    const { action, id } = target.dataset;

    if (action === "tile") {
      // Swallow the click that follows a long press, which already acted.
      if (suppressClick) return;
      await quickLog(S.state.event_types.get(id));
    } else if (action === "tile-detail") {
      openTileSheet(S.state.event_types.get(id));
    } else if (action === "new-type") {
      openTypeSheet(null);
    } else if (action === "new-project") {
      newProject();
    } else if (action === "history") {
      showView("history");
    } else if (action === "entry") {
      openEventSheet(S.state.events.get(id));
    } else if (action === "end-span") {
      await endSpan(S.state.events.get(id));
    }
  });

  wireLongPress();
}

const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE = 10;

let suppressClick = false;
let pressTimer = null;
let pressOrigin = null;

function wireLongPress() {
  screenEl.addEventListener("pointerdown", (ev) => {
    const tile = ev.target.closest(".tile[data-id]");
    if (!tile) return;
    suppressClick = false;
    pressOrigin = { x: ev.clientX, y: ev.clientY };
    pressTimer = setTimeout(() => {
      suppressClick = true;
      navigator.vibrate?.(15);
      openTileSheet(S.state.event_types.get(tile.dataset.id));
    }, LONG_PRESS_MS);
  });

  const cancel = () => {
    clearTimeout(pressTimer);
    pressOrigin = null;
  };
  screenEl.addEventListener("pointerup", cancel);
  screenEl.addEventListener("pointercancel", cancel);
  screenEl.addEventListener("scroll", cancel, true);
  screenEl.addEventListener("pointermove", (ev) => {
    if (!pressOrigin) return;
    if (Math.hypot(ev.clientX - pressOrigin.x, ev.clientY - pressOrigin.y) > MOVE_TOLERANCE) cancel();
  });

  screenEl.addEventListener("contextmenu", (ev) => {
    const tile = ev.target.closest(".tile[data-id]");
    if (!tile) return;
    ev.preventDefault();
    openTileSheet(S.state.event_types.get(tile.dataset.id));
  });
}
