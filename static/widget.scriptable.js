// Tracker widget for Scriptable (iOS).
//
// Paste this into a new script in Scriptable, then add a Scriptable widget to
// the Home Screen and choose this script. Use a medium or large widget: small
// widgets only support one tap target for the whole tile.
//
// Serve this file from /widget.js?project=<id> and the project is filled in
// already.
//
// It shows any running span with the time it started, and tapping one opens the
// app on a link that ends it. A paused span shows when it was paused, and
// tapping it resumes. When nothing is running it shows the event types so a tap
// can start one.
//
// It deliberately shows a start time, not a counter. iOS refreshes widgets on
// its own schedule, so a counter would sit there showing a wrong number.

// Filled in from the address the script was fetched from, so the widget always
// points at the deployment that generated it.
const BASE = "__BASE__";
const PROJECT = "__PROJECT_ID__";
// Filled in when the deployment uses a passcode. Treat this script as a
// credential: anyone holding it can read and change the data.
const TOKEN = "__TOKEN__";
const MAX_ROWS = 4;

const BG = new Color("#0f1115");
const TEXT = new Color("#e8eaf0");
const MUTED = new Color("#8b91a1");

const widget = new ListWidget();
widget.backgroundColor = BG;
widget.setPadding(12, 12, 12, 12);

let data;
try {
  const req = new Request(`${BASE}/api/widget?project=${encodeURIComponent(PROJECT)}`);
  req.timeoutInterval = 8;
  if (TOKEN) req.headers = { Authorization: `Bearer ${TOKEN}` };
  data = await req.loadJSON();
} catch (err) {
  // No network, or the service is down. Say so rather than showing stale rows
  // that would invite a tap on something that is no longer true.
  const line = widget.addText("Tracker unavailable");
  line.font = Font.mediumSystemFont(13);
  line.textColor = MUTED;
  finish();
}

if (data) {
  const running = data.active || [];
  const heading = widget.addText(running.length ? "RUNNING" : "START");
  heading.font = Font.boldSystemFont(9);
  heading.textColor = MUTED;
  widget.addSpacer(6);

  const rows = running.length
    ? running.slice(0, MAX_ROWS).map((s) => ({
        id: s.id,
        icon: s.icon,
        name: s.name,
        color: s.color,
        // A paused row says so rather than showing a start time, which would
        // read as still counting. Tapping it continues it; ending a paused
        // span is a decision worth opening the app for.
        detail: s.paused_at ? `paused ${clock(s.paused_at)}` : `since ${clock(s.started_at)}`,
        url: s.paused_at
          ? `${BASE}/?resume=${encodeURIComponent(s.id)}`
          : `${BASE}/?end=${encodeURIComponent(s.id)}`,
      }))
    : (data.types || []).slice(0, MAX_ROWS).map((t) => ({
        id: t.id,
        icon: t.icon,
        name: t.name,
        color: t.color,
        detail: t.kind === "span" ? "start" : "log",
        url: `${BASE}/?toggle=${encodeURIComponent(t.id)}`,
      }));

  if (!rows.length) {
    const line = widget.addText("No events yet");
    line.font = Font.mediumSystemFont(13);
    line.textColor = MUTED;
  }

  for (const row of rows) {
    const stack = widget.addStack();
    stack.centerAlignContent();
    stack.url = row.url; // the tap target for this row
    stack.setPadding(4, 0, 4, 0);

    const dot = stack.addText(row.icon || "•");
    dot.font = Font.systemFont(14);
    stack.addSpacer(6);

    const name = stack.addText(row.name);
    name.font = Font.semiboldSystemFont(13);
    name.textColor = TEXT;
    name.lineLimit = 1;

    stack.addSpacer();

    const detail = stack.addText(row.detail);
    detail.font = Font.systemFont(11);
    detail.textColor = new Color(row.color || "#8b91a1");
  }
}

finish();

function clock(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function finish() {
  // Ask for a refresh reasonably soon. iOS treats this as a hint, not a promise.
  widget.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    widget.presentMedium();
  }
  Script.complete();
}
