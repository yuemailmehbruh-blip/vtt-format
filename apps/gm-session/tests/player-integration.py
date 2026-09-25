#!/usr/bin/env python3
"""0.7.0 integration: a real GM server (create_server + LAN player listener) and a
real GM Session Player process (player_app.py --headless) talking HTTP on localhost.
Covers join, assignment, edits both ways within a few seconds, offline queue across
a GM listener outage, full sync in both directions, and persistence of the player id."""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
import yaml  # noqa: E402

import player_host as ph  # noqa: E402
from server_lib import create_server  # noqa: E402

PLAYER_APP = APP.parent / "player-session" / "player_app.py"
SAMPLE = APP.parents[1] / "examples" / "sample-campaign"
AID = "party-fighter"


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def req(method, url, body=None):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")
    except (urllib.error.URLError, ConnectionError):
        return 0, {}


def wait_for(fn, timeout=8.0, step=0.2):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return time.time() - t0
        time.sleep(step)
    return None


def main():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "camp"
        shutil.copytree(SAMPLE, root)
        lport, pport = free_port(), free_port()
        server, gm = create_server(root, host="127.0.0.1", port=0, quiet=True, player_host="127.0.0.1", player_port=lport)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        hub = server.RequestHandlerClass.player_hub
        pdata = Path(tmp) / "player-data"
        pl = f"http://127.0.0.1:{pport}"

        def spawn():
            return subprocess.Popen([sys.executable, str(PLAYER_APP), "--headless", "--data-dir", str(pdata),
                                     "--port", str(pport), "--gm", f"127.0.0.1:{lport}", "--name", "Integration Player"],
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

        proc = spawn()
        try:
            check(wait_for(lambda: req("GET", pl + "/papi/status")[1].get("state") == "connected", 10) is not None,
                  "player process connects to the GM listener")
            st, players = req("GET", gm + "/api/players")
            check(st == 200 and len(players["players"]) == 1 and players["players"][0]["name"] == "Integration Player",
                  "GM sees the joined player (GM /api/players)")
            pid = players["players"][0]["id"]
            check(players["players"][0]["online"], "GM shows the player online")
            st, _ = req("PUT", gm + "/api/players/assign", {"actor": AID, "players": [pid]})
            check(st == 200, "GM assigns the character")
            check(wait_for(lambda: req("GET", pl + f"/api/sheet/{AID}")[0] == 200, 8) is not None,
                  "assigned sheet appears in the player app")
            s, sheet = req("GET", pl + f"/api/sheet/{AID}")
            check(sheet["fields"]["hp_current"] == 20 and sheet["layout"].get("widgets"), "player sheet has values and the sheet layout (renderer input)")

            # player → GM
            req("PUT", pl + f"/api/actor/{AID}/fields", {"fields": {"hp_current": 12}})
            dt = wait_for(lambda: req("GET", gm + f"/api/sheet/{AID}")[1]["fields"].get("hp_current") == 12, 6)
            check(dt is not None, f"player edit arrives at the GM ({dt:.1f}s)" if dt else "player edit arrives at the GM")
            # GM → player (via the GM's own sheet API, as the GM sheet window does)
            st, _ = req("PUT", gm + f"/api/actor/{AID}/fields", {"fields": {"hp_max": 30}})
            check(st == 200, "GM edits a field through its sheet API")
            dt = wait_for(lambda: req("GET", pl + f"/api/sheet/{AID}")[1]["fields"].get("hp_max") == 30, 6)
            check(dt is not None, f"GM edit arrives at the player ({dt:.1f}s)" if dt else "GM edit arrives at the player")
            check(wait_for(lambda: req("GET", pl + "/papi/status")[1]["sheets"][0]["pending"] == 0, 5) is not None,
                  "player change log drains after ack")

            # offline queue: GM listener goes away, player keeps editing
            ls = server.RequestHandlerClass.player_server
            ls.shutdown(); ls.server_close()
            check(wait_for(lambda: req("GET", pl + "/papi/status")[1].get("state") == "offline", 8) is not None,
                  "player shows offline when the GM is unreachable")
            req("PUT", pl + f"/api/actor/{AID}/fields", {"fields": {"STR": 17}})
            req("PUT", pl + f"/api/actor/{AID}/fields", {"fields": {"DEX": 15}})
            req("PUT", pl + f"/api/sheet/{AID}", {"text": "written offline"})
            s, stt = req("GET", pl + "/papi/status")
            check(stt["sheets"][0]["pending"] == 3, "offline edits queued in the player log (3 pending)")
            time.sleep(1)
            check(yaml.safe_load((root / f"world/actors/{AID}.yaml").read_text())["fields"]["STR"] == 16, "GM copy unchanged while offline")
            # restart player process too (queue must survive a restart)
            proc.terminate(); proc.wait(5)
            proc = spawn()
            time.sleep(1.5)
            server.RequestHandlerClass.player_server = ph.start_player_listener(hub, "127.0.0.1", lport, "test")
            def arrived():
                f = req("GET", gm + f"/api/sheet/{AID}")[1]
                return f["fields"].get("STR") == 17 and f["fields"].get("DEX") == 15 and f.get("text") == "written offline"
            dt = wait_for(arrived, 10)
            check(dt is not None, "queued offline edits (surviving a player restart) arrive after reconnect")
            s, players2 = req("GET", gm + "/api/players")
            check(len(players2["players"]) == 1 and players2["players"][0]["id"] == pid, "player id stable across player restart (no duplicate player)")

            # full sync GM → player
            st, _ = req("PUT", gm + f"/api/actor/{AID}/fields", {"fields": {"AC": 18}})
            st, out = req("POST", gm + "/api/players/fullsync", {"actor": AID, "player": pid})
            check(st == 200, "GM queues a full sheet send to the player")
            check(wait_for(lambda: req("GET", pl + f"/api/sheet/{AID}")[1]["fields"].get("AC") == 18, 6) is not None,
                  "GM full sync overwrites the player copy")
            # full sync player → GM: diverge GM, then player pushes full
            wait_for(lambda: req("GET", pl + "/papi/status")[1]["sheets"][0]["pending"] == 0, 5)
            p = root / f"world/actors/{AID}.yaml"
            mine = req("GET", pl + f"/api/sheet/{AID}")[1]["fields"]["CHA"]
            d = yaml.safe_load(p.read_text()); d["fields"]["CHA"] = 3; p.write_text(yaml.safe_dump(d, sort_keys=False))
            # GM copy now diverges (CHA 3); the player's full push must put its value back
            st, out = req("POST", pl + f"/papi/fullsync/{AID}")
            check(st == 200 and out.get("ok"), "player full sync accepted by the GM")
            f = yaml.safe_load(p.read_text())["fields"]
            check(f["CHA"] == mine != 3, "player full sync overwrote the GM copy")
        finally:
            proc.terminate()
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()
            server.shutdown(); server.server_close()
    print("player-integration: all ok")


if __name__ == "__main__":
    main()
