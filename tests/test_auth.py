"""Passcode authentication.

The rules that matter: data endpoints refuse an unauthenticated caller, a wrong
passcode cannot be guessed indefinitely, and leaving the passcode unset keeps
the service open, which is how it runs behind a private network.
"""

import importlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

PASSCODE = "correct horse"
GUARDED = [
    ("post", "/api/sync", {"json": {"since": 0, "changes": {}}}),
    ("get", "/api/widget", {"params": {"project": "p1"}}),
    ("get", "/widget.js", {"params": {"project": "p1"}}),
    ("get", "/api/export", {"params": {"project": "p1"}}),
]


def build(tmp_path, monkeypatch, passcode):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.delenv("TRACKER_PASSCODE", raising=False)
    if passcode is None:
        monkeypatch.delenv("LOGBOOK_PASSCODE", raising=False)
    else:
        monkeypatch.setenv("LOGBOOK_PASSCODE", passcode)
    import main

    importlib.reload(main)
    return main


@pytest.fixture()
def secured(tmp_path, monkeypatch):
    main = build(tmp_path, monkeypatch, PASSCODE)
    with TestClient(main.app) as c:
        yield c


@pytest.fixture()
def open_service(tmp_path, monkeypatch):
    main = build(tmp_path, monkeypatch, None)
    with TestClient(main.app) as c:
        yield c


def test_data_endpoints_refuse_without_a_session(secured):
    for method, url, kwargs in GUARDED:
        res = getattr(secured, method)(url, **kwargs)
        assert res.status_code == 401, f"{url} answered {res.status_code}"


def test_signing_in_opens_every_data_endpoint(secured):
    assert secured.post("/api/login", json={"passcode": PASSCODE}).status_code == 200
    for method, url, kwargs in GUARDED:
        res = getattr(secured, method)(url, **kwargs)
        assert res.status_code in (200, 404), f"{url} answered {res.status_code}"


def test_wrong_passcode_is_refused_and_grants_nothing(secured):
    assert secured.post("/api/login", json={"passcode": "nope"}).status_code == 401
    assert secured.post("/api/sync", json={"since": 0, "changes": {}}).status_code == 401


def test_guessing_is_throttled(secured):
    codes = [secured.post("/api/login", json={"passcode": f"bad{i}"}).status_code for i in range(12)]
    assert 429 in codes, "brute force was never throttled"
    # The lockout must hold even once the right passcode is offered.
    assert secured.post("/api/login", json={"passcode": PASSCODE}).status_code == 429


def test_the_widget_token_works_without_a_cookie(secured):
    secured.post("/api/login", json={"passcode": PASSCODE})
    script = secured.get("/widget.js", params={"project": "p1"}).text
    token = script.split('const TOKEN = "')[1].split('"')[0]
    assert token

    secured.cookies.clear()
    assert secured.get("/api/widget", params={"project": "p1"}).status_code == 401
    res = secured.get(
        "/api/widget", params={"project": "p1"}, headers={"Authorization": f"Bearer {token}"}
    )
    assert res.status_code == 200


def test_the_same_widget_token_is_reused(secured):
    secured.post("/api/login", json={"passcode": PASSCODE})
    grab = lambda: secured.get("/widget.js", params={"project": "p1"}).text.split(
        'const TOKEN = "'
    )[1].split('"')[0]
    assert grab() == grab()


def test_session_endpoint_reports_state(secured):
    before = secured.get("/api/session").json()
    assert before == {"auth": True, "signedIn": False}
    secured.post("/api/login", json={"passcode": PASSCODE})
    assert secured.get("/api/session").json() == {"auth": True, "signedIn": True}


def test_health_hides_counts_until_signed_in(secured):
    assert "counts" not in secured.get("/health").json()
    secured.post("/api/login", json={"passcode": PASSCODE})
    assert "counts" in secured.get("/health").json()


def test_no_passcode_leaves_the_service_open(open_service):
    for method, url, kwargs in GUARDED:
        res = getattr(open_service, method)(url, **kwargs)
        assert res.status_code in (200, 404), f"{url} answered {res.status_code}"
    assert open_service.get("/api/session").json() == {"auth": False, "signedIn": True}


def test_the_app_shell_stays_public_so_it_can_show_a_sign_in_screen(secured):
    for url in ["/", "/sw.js", "/manifest.webmanifest", "/static/app.js"]:
        assert secured.get(url).status_code == 200, url


def test_sessions_never_sync_to_a_device(secured):
    secured.post("/api/login", json={"passcode": PASSCODE})
    body = secured.post("/api/sync", json={"since": 0, "changes": {}}).json()
    assert "sessions" not in body["changes"]

    refused = secured.post(
        "/api/sync", json={"since": 0, "changes": {"sessions": [{"id": "x", "updated_at": 1}]}}
    )
    assert refused.status_code == 400


def test_the_old_variable_name_still_works(tmp_path, monkeypatch):
    """An existing deployment sets TRACKER_PASSCODE. Renaming must not lock it out."""
    monkeypatch.delenv("LOGBOOK_PASSCODE", raising=False)
    main = build(tmp_path, monkeypatch, None)
    monkeypatch.setenv("TRACKER_PASSCODE", PASSCODE)
    import importlib

    importlib.reload(main)
    with TestClient(main.app) as c:
        assert c.post("/api/sync", json={"since": 0, "changes": {}}).status_code == 401
        assert c.post("/api/login", json={"passcode": PASSCODE}).status_code == 200
        assert c.post("/api/sync", json={"since": 0, "changes": {}}).status_code == 200
