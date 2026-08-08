"""Two devices going offline, diverging, and reconciling.

`Device` is a minimal port of static/sync.js — same outbox, same cursor, same
apply rules — so a protocol bug that would strand a phone shows up here.
"""

import importlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture()
def server(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    import main

    importlib.reload(main)
    with TestClient(main.app) as c:
        yield c


class Device:
    def __init__(self, server):
        self.server = server
        self.rows = {}
        self.dirty = set()
        self.cursor = 0

    def write(self, table, row):
        self.rows[(table, row["id"])] = dict(row)
        self.dirty.add((table, row["id"]))

    def sync(self):
        changes, snapshot = {}, []
        for table, rid in sorted(self.dirty):
            row = self.rows[(table, rid)]
            changes.setdefault(table, []).append(row)
            snapshot.append((table, rid, row["updated_at"]))

        res = self.server.post("/api/sync", json={"since": self.cursor, "changes": changes})
        assert res.status_code == 200, res.text
        body = res.json()

        for table, incoming in body["changes"].items():
            for row in incoming:
                key = (table, row["id"])
                local = self.rows.get(key)
                if local and key in self.dirty and local["updated_at"] > row["updated_at"]:
                    continue
                self.rows[key] = row
                self.dirty.discard(key)

        for table, rid, stamp in snapshot:
            key = (table, rid)
            if key in self.dirty and self.rows[key]["updated_at"] == stamp:
                self.dirty.discard(key)

        self.cursor = body["cursor"]
        return body

    def drain(self):
        while True:
            body = self.sync()
            if not body["more"] and not self.dirty:
                return

    @property
    def snapshot(self):
        return {k: {c: v for c, v in r.items() if c != "seq"} for k, r in self.rows.items()}


def event(eid, start, end, updated_at, note=""):
    return {
        "id": eid, "project_id": "p1", "type_id": "t1",
        "started_at": start, "ended_at": end, "label_ids": [],
        "note": note, "deleted": 0, "updated_at": updated_at,
    }


@pytest.fixture()
def seeded(server):
    """Two devices that already share a project and one span-shaped event type."""
    phone, laptop = Device(server), Device(server)
    phone.write("projects", {"id": "p1", "name": "Newborn", "archived": 0, "deleted": 0, "updated_at": 100})
    phone.write("event_types", {"id": "t1", "project_id": "p1", "name": "Sleep", "kind": "span",
                                "icon": "😴", "color": "#60a5fa", "position": 0,
                                "archived": 0, "deleted": 0, "updated_at": 100})
    phone.sync()
    laptop.sync()
    return phone, laptop


def test_offline_edits_on_both_devices_merge(seeded):
    phone, laptop = seeded
    assert laptop.rows[("event_types", "t1")]["name"] == "Sleep"

    # Both offline: the phone starts a span, the laptop logs its own entry.
    phone.write("events", event("e-phone", 1000, None, 200))
    laptop.write("events", event("e-laptop", 1100, 1200, 210))

    laptop.sync()
    assert ("events", "e-phone") not in laptop.rows

    phone.sync()
    assert phone.rows[("events", "e-laptop")]["started_at"] == 1100
    # A span the phone has not ended must survive the round trip as an open one.
    assert phone.rows[("events", "e-phone")]["ended_at"] is None


def test_conflicting_edits_settle_on_the_later_one(seeded):
    phone, laptop = seeded
    phone.write("events", event("e1", 1000, None, 200))
    phone.sync()
    laptop.sync()

    phone.write("events", event("e1", 1000, 1500, 300, note="from phone"))
    laptop.write("events", event("e1", 1000, 1600, 400, note="from laptop"))

    phone.sync()
    laptop.sync()
    phone.sync()

    for device in (phone, laptop):
        assert device.rows[("events", "e1")]["note"] == "from laptop"
        assert device.rows[("events", "e1")]["ended_at"] == 1600


def test_outboxes_drain_and_devices_agree(seeded):
    phone, laptop = seeded
    phone.write("events", event("e-phone", 1000, None, 200))
    laptop.write("events", event("e-laptop", 1100, 1200, 210))
    phone.write("events", event("e-phone", 1000, 1500, 300, note="from phone"))
    laptop.write("events", event("e-phone", 1000, 1600, 400, note="from laptop"))

    for _ in range(3):
        phone.drain()
        laptop.drain()

    assert not phone.dirty
    assert not laptop.dirty
    assert phone.snapshot == laptop.snapshot


def test_a_fresh_device_rebuilds_the_same_state(seeded, server):
    phone, laptop = seeded
    phone.write("events", event("e1", 1000, 1500, 300))
    laptop.write("events", event("e2", 1100, None, 310))
    phone.drain()
    laptop.drain()
    phone.drain()

    fresh = Device(server)
    fresh.drain()
    assert fresh.snapshot == phone.snapshot


def test_a_fresh_device_pages_through_a_large_backlog(server, monkeypatch):
    import main

    monkeypatch.setattr(main, "PULL_LIMIT", 7)
    seeder = Device(server)
    for i in range(40):
        seeder.write("events", event(f"e{i}", 1000 + i, None, 100 + i))
    seeder.drain()

    fresh = Device(server)
    fresh.drain()
    assert len(fresh.rows) == 40
    assert fresh.snapshot == seeder.snapshot
