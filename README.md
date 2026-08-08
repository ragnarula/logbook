# tracker

## Product vision

Tracker records events that happen over time. The user decides what to track.
The code knows nothing about the subject.

The first use is newborn care. A project can hold any kind of event.

Two goals drive every decision:

1. The user logs an event with one tap, on a phone, using one hand.
2. Reading the data stays as easy as entering it.

## Features

- **Projects.** Each project owns its event types and labels. Projects never
  share them.
- **Event types.** The user names a type once, then reuses it by tapping a tile.
- **Two kinds of event.** A moment happens at one time. A span starts, then ends
  later.
- **One tap entry.** The home screen shows one tile for each event type. One tap
  logs a moment. One tap starts a span, and the next tap on the same tile ends
  it. The app asks nothing and shows no form.
- **Labels.** The user names a label once, then selects it.
- **Corrections.** The user adjusts times, labels and notes on any entry. To
  change a time, the user taps buttons that move it in fixed steps.
- **Past entries.** The user records something that already finished in one
  step. The user sets the start time, then picks how long it lasted. The app
  saves a complete entry, so the user never has to start an event and repair it
  afterwards.
- **Undo.** Every action offers an undo.
- **History.** A separate page with three views. **Days** draws one row per day.
  **Last 24 hours** draws one row for the moving window, so a night is not split
  at midnight, and totals each event type below it. **List** shows entries in
  order. The back gesture leaves the page.
- **Stats.** Totals, a bar per day, a bar per hour of the day, and a ranking by
  event type and by label. The user picks the period and, when spans are in
  view, whether to count entries or add up time.
- **Filtering.** The user taps an event type or a label to show only matching
  entries. The app builds both sets of buttons from the project's own data, so a
  new type or label appears without any code change. The same buttons filter the
  stats, so "feeds per day" and "left-side feeds per day" are one screen with one
  more button pressed. The app needs no query builder for this.
- **Labels on the timeline.** Each bar carries a band of its label colours, so
  the user reads labels off the timeline instead of opening each entry.
- **Export.** The server returns one project as CSV.
- **Offline use.** The app works with no network and syncs later.
- **Install.** The user adds the app to a phone home screen.
- **Home Screen buttons.** Each event type provides a link. The user adds that
  link to the iPhone Home Screen using the Shortcuts app, then logs the event
  without opening the app first. A link opens the app, which logs the event and
  offers an undo.
- **Home Screen widget.** The app generates a script for Scriptable. The widget
  lists the spans that are running and the time each one started. The user taps
  a row to end that span. iOS cannot show a live counter in a widget, so the
  widget shows start times instead.

## Design principles

1. **Keep data entry to one tap.** This rule outranks every other feature. To
   log an event, the user taps once. The app opens no form, asks no question and
   needs no confirmation. The keyboard appears only when the user names
   something new, and only the first time. The user sets every other value by
   tapping: times move in fixed steps, and labels, icons and colours come from
   lists. A new feature must not add a step to this path.
2. **Keep the code generic.** No event name or label name appears in the code.
   The only meaning the code uses is the kind, moment or span, and the user sets
   that.
3. **Write locally first.** Every change reaches the device before the network.
   The user never waits for a request.
4. **Resolve conflicts by time.** Each row carries the time of its last change.
   The newer change wins. Merging happens per row.
5. **Keep data.** Deletes only set a flag. Removing an event type keeps the
   entries already logged.
6. **Serve code from the network first.** The offline cache must never decide
   which version of the app runs.
7. **Make actions reversible.** The user can undo an action instead of
   confirming it first.

## High level architecture

**Server.** One Python process using FastAPI, with one SQLite file. It stores
rows, merges incoming changes and returns changes. It holds no rules about what
an event means.

**Client.** Static HTML, CSS and JavaScript. No build step and no external
libraries, so the browser loads only files this service serves.

**Device storage.** The browser keeps a full copy of the project data in
IndexedDB. A flag marks each row the server has not yet accepted.

**Sync.** One endpoint handles both directions. The client sends its changed
rows and a position marker. The server replies with every row that changed after
that marker. A counter on the server orders all changes, so one number describes
how far a device has caught up. Devices create rows with their own identifiers,
so two offline devices never collide.

**Offline shell.** A service worker stores the application files. The app opens
without a network. The stored data still comes from IndexedDB.

**Deployment.** A Docker container joins the shared network. Caddy serves it at
a hostname. The SQLite file lives in a mounted directory, which the existing
backup job already covers.

**Access.** The service has no authentication, which matches the other services
behind the same proxy.
