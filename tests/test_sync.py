"""Merge semantics for /api/sync.

The client is offline-first, so the only things holding the two sides together
are last-write-wins on `updated_at` and the monotonic `seq` cursor. These test
the cases that would silently corrupt a device's copy if they regressed.
"""

import importlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    import main

    importlib.reload(main)
    with TestClient(main.app) as c:
        yield c


def project(pid, name, updated_at):
    return {"id": pid, "name": name, "archived": 0, "deleted": 0, "updated_at": updated_at}


def push(client, since=0, **tables):
    res = client.post("/api/sync", json={"since": since, "changes": tables})
    assert res.status_code == 200, res.text
    return res.json()


def test_push_then_pull_round_trips(client):
    body = push(client, projects=[project("p1", "Newborn", 1000)])
    assert body["accepted"] == 1
    assert [p["name"] for p in body["changes"]["projects"]] == ["Newborn"]
    assert body["cursor"] > 0
    assert body["more"] is False


def test_newer_write_wins_and_older_is_rejected(client):
    cursor = push(client, projects=[project("p1", "First", 2000)])["cursor"]

    stale = push(client, since=cursor, projects=[project("p1", "Stale", 1000)])
    assert stale["accepted"] == 0
    # Nothing moved, so the pull is empty — but the loser is still handed the
    # winner, or the two would disagree forever.
    assert [p["name"] for p in stale["changes"]["projects"]] == ["First"]

    fresh = push(client, since=cursor, projects=[project("p1", "Newer", 3000)])
    assert fresh["accepted"] == 1
    assert [p["name"] for p in fresh["changes"]["projects"]] == ["Newer"]


def test_equal_timestamp_keeps_the_stored_row(client):
    cursor = push(client, projects=[project("p1", "Original", 5000)])["cursor"]
    body = push(client, since=cursor, projects=[project("p1", "Tie", 5000)])
    assert body["accepted"] == 0
    assert [p["name"] for p in body["changes"]["projects"]] == ["Original"]


def test_cursor_only_returns_later_changes(client):
    first = push(client, projects=[project("p1", "A", 1000)])
    second = push(client, since=first["cursor"], projects=[project("p2", "B", 1000)])
    assert [p["id"] for p in second["changes"]["projects"]] == ["p2"]

    # Nothing new since then.
    third = push(client, since=second["cursor"])
    assert third["changes"]["projects"] == []
    assert third["cursor"] == second["cursor"]


def test_seq_advances_across_tables_so_one_cursor_covers_everything(client):
    body = push(
        client,
        projects=[project("p1", "Newborn", 1000)],
        event_types=[
            {"id": "t1", "project_id": "p1", "name": "Feed", "kind": "point", "updated_at": 1000}
        ],
        labels=[{"id": "l1", "project_id": "p1", "name": "left", "updated_at": 1000}],
        events=[
            {
                "id": "e1",
                "project_id": "p1",
                "type_id": "t1",
                "started_at": 1700,
                "ended_at": None,
                "label_ids": ["l1"],
                "updated_at": 1000,
            }
        ],
    )
    assert body["accepted"] == 4
    seqs = [row["seq"] for rows in body["changes"].values() for row in rows]
    assert sorted(seqs) == list(range(1, 5))

    replay = push(client, since=0)
    assert {t: len(rows) for t, rows in replay["changes"].items()} == {
        "projects": 1, "event_types": 1, "labels": 1, "events": 1
    }


def test_open_span_keeps_a_null_end_then_closes(client):
    push(
        client,
        events=[
            {"id": "e1", "project_id": "p1", "type_id": "t1", "started_at": 100,
             "ended_at": None, "updated_at": 1000}
        ],
    )
    body = push(client, since=0)
    assert body["changes"]["events"][0]["ended_at"] is None

    push(
        client,
        events=[
            {"id": "e1", "project_id": "p1", "type_id": "t1", "started_at": 100,
             "ended_at": 900, "updated_at": 2000}
        ],
    )
    body = push(client, since=0)
    assert body["changes"]["events"][0]["ended_at"] == 900


def test_label_ids_accepts_a_list_or_an_encoded_string(client):
    push(client, events=[
        {"id": "e1", "project_id": "p1", "type_id": "t1", "started_at": 1,
         "label_ids": ["a", "b"], "updated_at": 1},
        {"id": "e2", "project_id": "p1", "type_id": "t1", "started_at": 1,
         "label_ids": '["c"]', "updated_at": 1},
    ])
    rows = {e["id"]: e["label_ids"] for e in push(client, since=0)["changes"]["events"]}
    assert rows["e1"] == '["a", "b"]'
    assert rows["e2"] == '["c"]'


def test_rows_without_an_id_or_timestamp_are_skipped_not_fatal(client):
    body = push(client, projects=[
        {"name": "no id", "updated_at": 1},
        {"id": "p1", "name": "no timestamp"},
        project("p2", "fine", 1),
    ])
    assert body["accepted"] == 1
    assert [p["id"] for p in body["changes"]["projects"]] == ["p2"]


def test_unknown_table_is_rejected(client):
    res = client.post("/api/sync", json={"since": 0, "changes": {"secrets": []}})
    assert res.status_code == 400


def test_pull_pages_without_dropping_rows(client, monkeypatch):
    import main

    monkeypatch.setattr(main, "PULL_LIMIT", 3)
    push(client, projects=[project(f"p{i}", f"P{i}", 1000) for i in range(10)])

    seen, cursor, pages = [], 0, 0
    while True:
        body = push(client, since=cursor)
        seen.extend(p["id"] for p in body["changes"]["projects"])
        cursor = body["cursor"]
        pages += 1
        if not body["more"]:
            break
        assert pages < 20, "pagination did not terminate"

    assert pages > 1
    assert sorted(seen) == sorted(f"p{i}" for i in range(10))


def test_soft_delete_propagates(client):
    push(client, projects=[project("p1", "Gone", 1000)])
    push(client, projects=[{**project("p1", "Gone", 2000), "deleted": 1}])
    body = push(client, since=0)
    assert body["changes"]["projects"][0]["deleted"] == 1


def test_export_resolves_names(client):
    push(
        client,
        projects=[project("p1", "Newborn", 1)],
        event_types=[{"id": "t1", "project_id": "p1", "name": "Sleep", "kind": "span", "updated_at": 1}],
        labels=[{"id": "l1", "project_id": "p1", "name": "cot", "updated_at": 1}],
        events=[{"id": "e1", "project_id": "p1", "type_id": "t1", "started_at": 0,
                 "ended_at": 3_600_000, "label_ids": ["l1"], "note": "long one", "updated_at": 1}],
    )
    res = client.get("/api/export", params={"project": "p1"})
    assert res.status_code == 200
    body = res.text
    assert "Sleep" in body and "cot" in body and "long one" in body
    assert "3600" in body  # duration in seconds

    assert client.get("/api/export", params={"project": "nope"}).status_code == 404


def test_health_reports_counts(client):
    push(client, projects=[project("p1", "Newborn", 1)])
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["counts"]["projects"] == 1
    assert body["seq"] >= 1
