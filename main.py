"""Tracker — offline-first event logging.

The client owns the data model: every row is created on a device with a
client-generated UUID and a client-clock `updated_at`, so a phone with no
network can create projects, event types, labels and events, then reconcile
later. The server is a durable last-write-wins merge point.

Sync is a single endpoint. A client posts every row it has changed since its
last successful sync and the cursor it reached then; it gets back every row the
server has accepted since that cursor. `seq` is a server-assigned monotonic
counter shared by all tables, so one integer describes a client's position in
the whole dataset.
"""

import csv
import io
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "tracker.db"
STATIC_DIR = Path(__file__).parent / "static"

# Rows returned by a single pull. A client loops while `more` is true.
PULL_LIMIT = 2000
# Rows accepted by a single push, to bound the work one request can cause.
PUSH_LIMIT = 5000

# Column order per table. The sync merge is generic over this: adding a column
# here and in SCHEMA_SQL is all it takes to sync a new field.
TABLES = {
    "projects": ["id", "name", "color", "archived", "deleted", "updated_at"],
    "event_types": [
        "id", "project_id", "name", "kind", "icon", "color",
        "position", "unit", "step", "default_quantity",
        "archived", "deleted", "updated_at",
    ],
    "labels": ["id", "project_id", "name", "color", "archived", "deleted", "updated_at"],
    "events": [
        "id", "project_id", "type_id", "started_at", "ended_at",
        "label_ids", "note", "quantity", "deleted", "updated_at",
    ],
}

# How to coerce an incoming JSON value for each column. Clients are trusted to
# be well-behaved but not to be correct, so every value is forced into shape
# rather than rejected — a dropped event is worse than a defaulted field.
TEXT_COLS = {
    "id", "name", "color", "icon", "kind", "note",
    "project_id", "type_id", "label_ids",
}
INT_COLS = {"archived", "deleted", "position", "updated_at", "started_at"}
NULLABLE_INT_COLS = {"ended_at"}
# Amounts are decimal: 4.2 kg would not survive the integer path.
FLOAT_COLS = {"step", "default_quantity"}
NULLABLE_FLOAT_COLS = {"quantity"}

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT '',
    archived    INTEGER NOT NULL DEFAULT 0,
    deleted     INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0,
    seq         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS event_types (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL DEFAULT 'point',
    icon        TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT '',
    position    INTEGER NOT NULL DEFAULT 0,
    unit             TEXT NOT NULL DEFAULT '',
    step             REAL NOT NULL DEFAULT 1,
    default_quantity REAL NOT NULL DEFAULT 0,
    archived    INTEGER NOT NULL DEFAULT 0,
    deleted     INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0,
    seq         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS labels (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT '',
    archived    INTEGER NOT NULL DEFAULT 0,
    deleted     INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0,
    seq         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL DEFAULT '',
    type_id     TEXT NOT NULL DEFAULT '',
    started_at  INTEGER NOT NULL DEFAULT 0,
    ended_at    INTEGER,
    label_ids   TEXT NOT NULL DEFAULT '[]',
    note        TEXT NOT NULL DEFAULT '',
    quantity    REAL,
    deleted     INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0,
    seq         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
    key         TEXT PRIMARY KEY,
    value       INTEGER NOT NULL
);

-- Not part of TABLES, so sessions never sync to a device.
CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    label       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_projects_seq    ON projects(seq);
CREATE INDEX IF NOT EXISTS idx_event_types_seq ON event_types(seq);
CREATE INDEX IF NOT EXISTS idx_labels_seq      ON labels(seq);
CREATE INDEX IF NOT EXISTS idx_events_seq      ON events(seq);
CREATE INDEX IF NOT EXISTS idx_events_project  ON events(project_id, started_at);
"""

_conn: sqlite3.Connection | None = None
# One process, one connection, one writer. Sync endpoints run in FastAPI's
# threadpool, so every database touch takes this lock.
_lock = threading.Lock()


def connect(path: Path | str = None) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path or DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=OFF")
    conn.executescript(SCHEMA_SQL)
    conn.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('seq', 0)")
    conn.commit()
    added = migrate(conn)
    if added:
        print(f"migrated: added {', '.join(added)}", flush=True)
    return conn


# Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves an
# existing database untouched, so without this a deployment carrying real data
# would start and then fail on the first query naming a new column.
LATER_COLUMNS = {
    "event_types": [
        ("unit", "TEXT NOT NULL DEFAULT ''"),
        ("step", "REAL NOT NULL DEFAULT 1"),
        ("default_quantity", "REAL NOT NULL DEFAULT 0"),
    ],
    "events": [("quantity", "REAL")],
}


def migrate(conn: sqlite3.Connection) -> list[str]:
    """Add any missing columns. Returns what it added, for the logs."""
    added = []
    for table, columns in LATER_COLUMNS.items():
        have = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        for name, declaration in columns:
            if name not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")
                added.append(f"{table}.{name}")
    if added:
        conn.commit()
    return added


def db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = connect()
    return _conn


def next_seq(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "UPDATE meta SET value = value + 1 WHERE key = 'seq' RETURNING value"
    ).fetchone()
    return int(row["value"])


def current_seq(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT value FROM meta WHERE key = 'seq'").fetchone()
    return int(row["value"]) if row else 0


def coerce(table: str, raw: dict) -> dict | None:
    """Force an incoming row into the shape of its table.

    Returns None when the row has no usable identity or timestamp — those are
    the only two fields that cannot be defaulted, because they are what the
    merge is decided on.
    """
    if not isinstance(raw, dict):
        return None
    rid = raw.get("id")
    if not isinstance(rid, str) or not rid.strip():
        return None
    try:
        updated_at = int(raw.get("updated_at"))
    except (TypeError, ValueError):
        return None

    out = {"id": rid.strip()[:64], "updated_at": updated_at}
    for col in TABLES[table]:
        if col in out:
            continue
        val = raw.get(col)
        if col in NULLABLE_INT_COLS:
            if val is None or val == "":
                out[col] = None
            else:
                try:
                    out[col] = int(val)
                except (TypeError, ValueError):
                    out[col] = None
        elif col in NULLABLE_FLOAT_COLS:
            if val is None or val == "":
                out[col] = None
            else:
                try:
                    out[col] = float(val)
                except (TypeError, ValueError):
                    out[col] = None
        elif col in FLOAT_COLS:
            try:
                out[col] = float(val)
            except (TypeError, ValueError):
                out[col] = 0.0
        elif col in INT_COLS:
            try:
                out[col] = int(val)
            except (TypeError, ValueError):
                out[col] = 0
        else:
            if col == "label_ids":
                # Accept a real list or an already-encoded string; store text.
                if isinstance(val, list):
                    val = json.dumps([str(v) for v in val if isinstance(v, (str, int))])
                elif not isinstance(val, str):
                    val = "[]"
            out[col] = ("" if val is None else str(val))[:4096]
    return out


def upsert(conn: sqlite3.Connection, table: str, row: dict) -> bool:
    """Apply a row if it is newer than what we hold. Returns whether it landed.

    A tie on `updated_at` keeps the stored row. Two devices editing the same
    row in the same millisecond is not a case worth a vector clock here; what
    matters is that both devices converge, and keeping the incumbent is stable
    because the loser's copy is overwritten on its next pull.
    """
    cols = TABLES[table]
    existing = conn.execute(
        f"SELECT updated_at FROM {table} WHERE id = ?", (row["id"],)
    ).fetchone()
    if existing is not None and int(existing["updated_at"]) >= row["updated_at"]:
        return False

    seq = next_seq(conn)
    placeholders = ", ".join("?" * (len(cols) + 1))
    assignments = ", ".join(f"{c} = excluded.{c}" for c in cols if c != "id")
    conn.execute(
        f"INSERT INTO {table} ({', '.join(cols)}, seq) VALUES ({placeholders}) "
        f"ON CONFLICT(id) DO UPDATE SET {assignments}, seq = excluded.seq",
        [row[c] for c in cols] + [seq],
    )
    return True


def row_to_dict(table: str, row: sqlite3.Row) -> dict:
    out = {c: row[c] for c in TABLES[table]}
    out["seq"] = row["seq"]
    return out


def pull(conn: sqlite3.Connection, since: int, limit: int | None = None) -> tuple[dict, int, bool]:
    """Read up to `limit` rows with seq > since, across every table.

    Each table contributes its lowest `limit + 1` sequence numbers, so after
    merging and truncating to `limit` the returned cursor is safe: any row a
    table withheld sits above the cursor and will arrive on the next page.
    """
    limit = PULL_LIMIT if limit is None else limit
    gathered = []
    for table in TABLES:
        rows = conn.execute(
            f"SELECT * FROM {table} WHERE seq > ? ORDER BY seq LIMIT ?",
            (since, limit + 1),
        ).fetchall()
        gathered.extend((row["seq"], table, row) for row in rows)

    gathered.sort(key=lambda item: item[0])
    more = len(gathered) > limit
    gathered = gathered[:limit]

    changes = {table: [] for table in TABLES}
    for _, table, row in gathered:
        changes[table].append(row_to_dict(table, row))

    cursor = gathered[-1][0] if gathered else max(since, current_seq(conn))
    return changes, cursor, more


app = FastAPI(title="tracker")

# ---------------------------------------------------------------------------
# Authentication
#
# One passcode per deployment, because one deployment serves one household.
# Leaving PASSCODE unset disables authentication entirely, which is how this
# runs behind a private network with nothing in front of it.
# ---------------------------------------------------------------------------

# TRACKER_PASSCODE is the original name, still honoured so an existing
# deployment keeps working without rotating its secret.
PASSCODE = (
    os.environ.get("LOGBOOK_PASSCODE") or os.environ.get("TRACKER_PASSCODE") or ""
).strip()
COOKIE_NAME = "tracker_session"
SESSION_DAYS = 365
# A passcode is short enough to guess, so failed attempts are throttled.
MAX_FAILURES = 10
FAILURE_WINDOW_S = 900

auth_required = bool(PASSCODE)
_failures: dict[str, list[float]] = {}


def issue_session(conn: sqlite3.Connection, label: str = "") -> str:
    token = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO sessions (token, created_at, label) VALUES (?, ?, ?)",
        (token, int(time.time() * 1000), label[:64]),
    )
    conn.commit()
    return token


def session_valid(token: str | None) -> bool:
    if not token:
        return False
    conn = db()
    with _lock:
        row = conn.execute("SELECT created_at FROM sessions WHERE token = ?", (token,)).fetchone()
    if row is None:
        return False
    age_days = (time.time() * 1000 - row["created_at"]) / 86_400_000
    return age_days <= SESSION_DAYS


def request_token(request: Request) -> str | None:
    """A browser sends a cookie; the widget sends a bearer token."""
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return request.cookies.get(COOKIE_NAME)


def require_auth(request: Request) -> None:
    if not auth_required:
        return
    if not session_valid(request_token(request)):
        raise HTTPException(status_code=401, detail="Sign in required")


def note_failure(ip: str) -> bool:
    """Record a bad passcode. Returns whether the caller is now locked out."""
    now = time.time()
    attempts = [t for t in _failures.get(ip, []) if now - t < FAILURE_WINDOW_S]
    attempts.append(now)
    _failures[ip] = attempts
    return len(attempts) >= MAX_FAILURES


def locked_out(ip: str) -> bool:
    now = time.time()
    return len([t for t in _failures.get(ip, []) if now - t < FAILURE_WINDOW_S]) >= MAX_FAILURES


class LoginBody(BaseModel):
    passcode: str = ""
    label: str = ""


@app.post("/api/login")
def login(body: LoginBody, request: Request, response: Response):
    if not auth_required:
        return {"ok": True, "auth": False}

    ip = request.client.host if request.client else "unknown"
    if locked_out(ip):
        raise HTTPException(status_code=429, detail="Too many attempts. Wait 15 minutes.")

    if not secrets.compare_digest(body.passcode.strip(), PASSCODE):
        note_failure(ip)
        raise HTTPException(status_code=401, detail="Wrong passcode")

    _failures.pop(ip, None)
    conn = db()
    with _lock:
        token = issue_session(conn, body.label)

    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=SESSION_DAYS * 86400,
        httponly=True,
        samesite="lax",  # so a Home Screen link still arrives signed in
        secure=request.url.scheme == "https",
        path="/",
    )
    return {"ok": True, "auth": True}


@app.get("/api/session")
def session_state(request: Request):
    """Lets the app find out whether it needs to ask for the passcode."""
    return {
        "auth": auth_required,
        "signedIn": not auth_required or session_valid(request_token(request)),
    }


class SyncBody(BaseModel):
    since: int = 0
    changes: dict[str, list[dict]] = Field(default_factory=dict)


@app.post("/api/sync")
def sync(body: SyncBody, _: None = Depends(require_auth)):
    since = max(0, int(body.since))

    pending = []
    for table, rows in (body.changes or {}).items():
        if table not in TABLES:
            raise HTTPException(status_code=400, detail=f"Unknown table: {table}")
        if not isinstance(rows, list):
            raise HTTPException(status_code=400, detail=f"Expected a list for {table}")
        for raw in rows:
            coerced = coerce(table, raw)
            if coerced is not None:
                pending.append((table, coerced))

    if len(pending) > PUSH_LIMIT:
        raise HTTPException(
            status_code=413, detail=f"Too many rows in one push (limit {PUSH_LIMIT})"
        )

    conn = db()
    with _lock:
        try:
            accepted = 0
            rejected = []
            for table, row in pending:
                if upsert(conn, table, row):
                    accepted += 1
                else:
                    rejected.append((table, row["id"]))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        changes, cursor, more = pull(conn, since)

        # A rejected push means the client is holding a row the server has
        # already superseded. Its winner may sit below the client's cursor and
        # so never appear in a pull, which would leave the two permanently
        # disagreeing — send it back explicitly.
        seen = {table: {row["id"] for row in rows} for table, rows in changes.items()}
        for table, rid in rejected:
            if rid in seen[table]:
                continue
            row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (rid,)).fetchone()
            if row is not None:
                changes[table].append(row_to_dict(table, row))
                seen[table].add(rid)

    return {"cursor": cursor, "more": more, "accepted": accepted, "changes": changes}


@app.get("/api/widget")
def widget_data(project: str, _: None = Depends(require_auth)):
    """What a Home Screen widget needs: what is running, and what can be started.

    Read-only and cheap, because a widget polls it on a schedule the phone
    decides. Timestamps go out as epoch milliseconds; the widget renders a start
    time rather than a counter, since iOS refreshes widgets too rarely for a
    running clock to stay honest.
    """
    conn = db()
    with _lock:
        active = conn.execute(
            "SELECT e.id, e.started_at, t.name, t.icon, t.color "
            "FROM events e JOIN event_types t ON t.id = e.type_id "
            "WHERE e.project_id = ? AND e.deleted = 0 AND e.ended_at IS NULL "
            "ORDER BY e.started_at",
            (project,),
        ).fetchall()
        types = conn.execute(
            "SELECT id, name, icon, color, kind FROM event_types "
            "WHERE project_id = ? AND deleted = 0 AND archived = 0 "
            "ORDER BY position",
            (project,),
        ).fetchall()

    return {
        "active": [
            {
                "id": r["id"],
                "name": r["name"],
                "icon": r["icon"],
                "color": r["color"],
                "started_at": r["started_at"],
            }
            for r in active
        ],
        "types": [
            {
                "id": r["id"],
                "name": r["name"],
                "icon": r["icon"],
                "color": r["color"],
                "kind": r["kind"],
            }
            for r in types
        ],
    }


@app.get("/widget.js")
def widget_script(project: str, request: Request, _: None = Depends(require_auth)):
    """A Scriptable widget script with this project already filled in.

    Served per project so the user copies it once and pastes it, instead of
    editing an identifier by hand on a phone.
    """
    token = ""
    if auth_required:
        # The widget cannot show a passcode prompt, so it carries its own
        # long-lived token. One is reused, so re-copying the script does not
        # leave a trail of live credentials behind.
        conn = db()
        with _lock:
            row = conn.execute(
                "SELECT token FROM sessions WHERE label = 'widget' ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            token = row["token"] if row else issue_session(conn, "widget")

    # Behind a proxy the scheme can arrive as http; the widget must call https.
    base = str(request.base_url).rstrip("/").replace("http://", "https://", 1)

    script = (STATIC_DIR / "widget.scriptable.js").read_text(encoding="utf-8")
    script = (
        script.replace("__PROJECT_ID__", project)
        .replace("__TOKEN__", token)
        .replace("__BASE__", base)
    )
    return PlainTextResponse(script, media_type="text/plain; charset=utf-8")


@app.get("/api/export")
def export_csv(project: str, _: None = Depends(require_auth)):
    """Flat CSV of one project's events, with names resolved for readability."""
    conn = db()
    with _lock:
        proj = conn.execute(
            "SELECT * FROM projects WHERE id = ?", (project,)
        ).fetchone()
        if proj is None:
            raise HTTPException(status_code=404, detail="No such project")
        types = {
            r["id"]: (r["name"], r["unit"])
            for r in conn.execute(
                "SELECT id, name, unit FROM event_types WHERE project_id = ?", (project,)
            )
        }
        labels = {
            r["id"]: r["name"]
            for r in conn.execute(
                "SELECT id, name FROM labels WHERE project_id = ?", (project,)
            )
        }
        events = conn.execute(
            "SELECT * FROM events WHERE project_id = ? AND deleted = 0 "
            "ORDER BY started_at DESC",
            (project,),
        ).fetchall()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        ["id", "event", "started_at", "ended_at", "duration_seconds",
         "quantity", "unit", "labels", "note"]
    )
    for ev in events:
        try:
            label_names = [
                labels.get(lid, lid) for lid in json.loads(ev["label_ids"] or "[]")
            ]
        except (TypeError, ValueError):
            label_names = []
        duration = ""
        if ev["ended_at"] is not None:
            duration = str(round((ev["ended_at"] - ev["started_at"]) / 1000))
        name, unit = types.get(ev["type_id"], (ev["type_id"], ""))
        writer.writerow(
            [
                ev["id"],
                name,
                iso(ev["started_at"]),
                iso(ev["ended_at"]),
                duration,
                "" if ev["quantity"] is None else ev["quantity"],
                unit,
                "; ".join(label_names),
                ev["note"],
            ]
        )

    filename = f"{slugify(proj['name']) or 'project'}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def iso(ms: int | None) -> str:
    if ms is None:
        return ""
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def slugify(name: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "-" for c in (name or "").lower()).strip("-")


@app.get("/health")
def health(request: Request):
    """Public liveness. Row counts only for a signed-in caller, since they leak
    how much of the data exists."""
    if auth_required and not session_valid(request_token(request)):
        return {"ok": True, "auth": True}
    conn = db()
    with _lock:
        counts = {
            table: conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]
            for table in TABLES
        }
        seq = current_seq(conn)
    return {"ok": True, "auth": auth_required, "seq": seq, "counts": counts}


@app.get("/")
def index():
    # Always revalidated: this file carries the recovery code that repairs a
    # device stuck on a broken release, so it must never be served from a cache.
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(
        html.replace("__CACHE_VERSION__", CACHE_VERSION),
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


@app.get("/sw.js")
def service_worker():
    # Must be served from the root so its scope covers the whole app.
    return FileResponse(
        STATIC_DIR / "sw.js",
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")


# The one place a release is named. Read from sw.js so the service worker's
# cache key and the asset URLs can never drift apart.
CACHE_VERSION = re.search(
    r'const VERSION = "([^"]+)"', (STATIC_DIR / "sw.js").read_text(encoding="utf-8")
).group(1)

# Rewrites the relative imports inside a module: `from "./ui.js"` becomes
# `from "./ui.js?v=tracker-v9"`.
RELATIVE_IMPORT = re.compile(r'(from\s+")(\./[A-Za-z0-9_.\-]+\.js)(")')


@app.get("/static/{name}.js")
def module(name: str):
    """Serve an ES module with its imports stamped with the release.

    Every module URL carries the version, so a browser can never pair a cached
    file from one release with a fresh one from another. That mismatch breaks
    the imports between them, and the page renders as an empty shell — which is
    unrecoverable from the user's side, because the code that would fix it is
    the code that failed to load.
    """
    path = (STATIC_DIR / f"{name}.js").resolve()
    if not path.is_file() or STATIC_DIR.resolve() not in path.parents:
        raise HTTPException(status_code=404, detail="Not found")
    body = RELATIVE_IMPORT.sub(rf'\1\2?v={CACHE_VERSION}\3', path.read_text(encoding="utf-8"))
    return Response(
        body,
        media_type="text/javascript",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


class RevalidatingStatic(StaticFiles):
    """Serve static files with `no-cache`.

    The app is a graph of ES modules that import each other by name. If the
    browser keeps one file and re-fetches another, the imports between them
    stop matching, linking fails, and the page renders as an empty shell.
    `no-cache` does not stop the browser storing a copy — it requires it to
    revalidate first, so the answer is a cheap 304 when nothing changed and the
    current file when it did. Offline still works: that is the service worker's
    cache, which this does not touch.
    """

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


app.mount("/static", RevalidatingStatic(directory=STATIC_DIR), name="static")


@app.exception_handler(HTTPException)
def http_exception_handler(_: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})
