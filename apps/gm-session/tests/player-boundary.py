#!/usr/bin/env python3
"""0.7.0 security boundary: the LAN player listener only exposes /player/api/*; a
player can read/write only sheets assigned to them; GM APIs are unreachable there;
bad/missing credentials, GM-only keys, malformed changes and oversize bodies are
rejected before anything is applied."""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
import yaml  # noqa: E402

from server_lib import create_server  # noqa: E402

SAMPLE = APP.parents[1] / "examples" / "sample-campaign"


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


def req(method, url, body=None, headers=None, raw=None):
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except ValueError:
            return e.code, {}
    except (ConnectionError, urllib.error.URLError):
        return -1, {}


def main():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "camp"
        shutil.copytree(SAMPLE, root)
        server, gm = create_server(root, host="127.0.0.1", port=0, quiet=True, player_host="127.0.0.1", player_port=0)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        H = server.RequestHandlerClass
        P = f"http://127.0.0.1:{H.player_server.server_address[1]}"
        before = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
        try:
            # --- GM APIs are not on the player port at all
            for m, path in (("GET", "/api/players"), ("GET", "/api/library"), ("GET", "/api/sheet/party-fighter"),
                            ("PUT", "/api/actor/party-fighter/fields"), ("DELETE", "/api/actor/party-fighter"),
                            ("PUT", "/api/players/assign"), ("GET", "/"), ("GET", "/index.html"), ("GET", "/player/../api/players")):
                st, _ = req(m, P + path, {} if m != "GET" else None)
                check(st == 404, f"player port: {m} {path} → 404 (GM API/UI not exposed)")

            # --- join (with a join code)
            H.player_hub.gm_set_join_code("sesame")
            pa, pb = "a" * 32, "b" * 32
            st, _ = req("POST", P + "/player/api/join", {"player_id": pa, "name": "A", "join_code": "wrong"})
            check(st == 403, "wrong join code → 403")
            st, ja = req("POST", P + "/player/api/join", {"player_id": pa, "name": "A", "join_code": "sesame"})
            st2, jb = req("POST", P + "/player/api/join", {"player_id": pb, "name": "B", "join_code": "sesame"})
            check(st == 200 and st2 == 200 and ja["secret"] and jb["secret"], "correct join code → secret issued")
            st, _ = req("POST", P + "/player/api/join", {"player_id": pa, "name": "Impostor", "join_code": "sesame"})
            check(st == 403, "re-joining an existing player id without its secret → 403 (no identity takeover)")
            st, _ = req("POST", P + "/player/api/join", {"player_id": "../x", "name": "A", "join_code": "sesame"})
            check(st == 400, "malformed player id → 400")
            A = {"X-Player-Id": pa, "X-Player-Secret": ja["secret"]}
            B = {"X-Player-Id": pb, "X-Player-Secret": jb["secret"]}

            # --- auth
            st, _ = req("GET", P + "/player/api/sheets")
            check(st == 401, "no credentials → 401")
            st, _ = req("GET", P + "/player/api/sheets", headers={"X-Player-Id": pa, "X-Player-Secret": jb["secret"]})
            check(st == 401, "another player's secret → 401")

            # --- assignment scope
            H.player_hub.gm_assign("party-fighter", [pa])
            st, _ = req("GET", P + "/player/api/sheet/party-fighter", headers=B)
            check(st == 403, "unassigned sheet download → 403")
            st, _ = req("GET", P + "/player/api/sheet/dock-tough", headers=A)
            check(st == 403, "A cannot read a sheet not assigned to A → 403")
            st, snap = req("GET", P + "/player/api/sheet/party-fighter", headers=A)
            check(st == 200 and snap["registers"]["fields.hp_current"]["v"] == 20, "assigned sheet download → 200")
            t = snap["registers"]["fields.hp_current"]["t"]
            future_ok = "9" * 0 + t  # a valid stamp
            chg = [{"seq": 1, "k": "fields.hp_current", "v": 1, "t": future_ok.replace(".gm", ".pb")}]
            st, out = req("POST", P + "/player/api/sync", {"sheets": {"party-fighter": {"changes": chg, "ack": 0}}}, headers=B)
            check(st == 200 and out["ignored"] == ["party-fighter"] and out["sheets"] == {}, "B's changes to an unassigned sheet are ignored")
            st, _ = req("POST", P + "/player/api/fullsync/party-fighter", {"values": {"fields.hp_current": 1}}, headers=B)
            check(st == 403, "B full sync on an unassigned sheet → 403")
            st, _ = req("POST", P + "/player/api/fullsync/dock-tough", {"values": {"fields.hp_current": 1}}, headers=A)
            check(st == 403, "A full sync on dock-tough (not assigned) → 403")

            # --- key / value validation (whole request rejected)
            def bad_sync(changes, why, code=400):
                s, _ = req("POST", P + "/player/api/sync", {"sheets": {"party-fighter": {"changes": changes, "ack": 0}}}, headers=A)
                check(s == code, f"{why} → {code}")
            stamp = "0000000000001.00000.pa"
            bad_sync([{"seq": 1, "k": "name", "v": "Hacked", "t": stamp}], "player changing the character name")
            bad_sync([{"seq": 1, "k": "appearance", "v": {}, "t": stamp}], "unknown key")
            bad_sync([{"seq": 1, "k": "fields.../x", "v": 1, "t": stamp}], "path-like field id")
            bad_sync([{"seq": 1, "k": "fields.hp", "v": 1, "t": "not-a-stamp"}], "bad stamp")
            bad_sync([{"seq": 0, "k": "fields.hp", "v": 1, "t": stamp}], "bad seq")
            bad_sync([{"seq": 1, "k": "notes", "v": 5, "t": stamp}], "non-string notes")
            st, _ = req("POST", P + "/player/api/fullsync/party-fighter", {"values": {"name": "Hacked"}}, headers=A)
            check(st == 400, "full sync with GM-only key (name) → 400")
            big = json.dumps({"sheets": {}, "pad": "x" * 1_100_000}).encode()
            st, _ = req("POST", P + "/player/api/sync", headers=A, raw=big)
            check(st in (413, -1), "oversize body → 413")
            st, _ = req("POST", P + "/player/api/sync", headers=A, raw=b"not json")
            check(st == 400, "malformed JSON → 400")
            st, _ = req("GET", P + "/player/api/sheet/..%2F..%2Fworld", headers=A)
            check(st in (400, 404), "path traversal sheet id rejected")

            after = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
            changed = sorted(k for k in before if after.get(k) != before[k])
            new = sorted(k for k in after if k not in before and not (k.startswith("state/sync/") or k == "world/players.yaml"))
            check(changed == [] and new == [], "rejected requests changed no campaign data (only players.yaml / state/sync bookkeeping)")

            # --- a forgotten player loses access immediately
            H.player_hub.gm_forget(pa)
            st, _ = req("GET", P + "/player/api/sheets", headers=A)
            check(st == 401, "forgotten player → 401")
            # --- GM endpoints stay on the loopback GM server
            st, _ = req("GET", gm + "/api/players")
            check(st == 200, "GM /api/players works on the GM (loopback) server")
        finally:
            server.shutdown(); server.server_close()
            H.player_server.shutdown(); H.player_server.server_close()
    print("player-boundary: all ok")


if __name__ == "__main__":
    main()
