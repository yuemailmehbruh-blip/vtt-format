#!/usr/bin/env python3
"""0.7.1 integration: real GM server + two real GM Session Player processes.
Map view (active scene, layers, tokens, assets) pushed within ~1 s, scene switch,
shared chat round trip both ways, player token moves (ownership boundary, snap,
GM merge does not clobber), and boundary tests for the new player-port endpoints."""
from __future__ import annotations

import json
import math
import shutil
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
sys.path.insert(0, str(Path(__file__).resolve().parent))
import yaml  # noqa: E402

from server_lib import create_server  # noqa: E402

PLAYER_APP = APP.parent / "player-session" / "player_app.py"
SAMPLE = APP.parents[1] / "examples" / "sample-campaign"
AID = "party-fighter"
OTHER = "dock-tough"
ASSET = "a433eb2ba6774bcb8ff2ecf7c63fd52d839cb783af7615ba69be2bed472bb6d7"
results = {}


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


def free_port():
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def req(method, url, body=None, headers=None, raw=False):
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    r = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            b = resp.read()
            return resp.status, (b if raw else json.loads(b.decode() or "{}"))
    except urllib.error.HTTPError as e:
        b = e.read()
        try:
            return e.code, json.loads(b.decode() or "{}")
        except ValueError:
            return e.code, {}
    except (urllib.error.URLError, ConnectionError):
        return 0, {}


def wait_for(fn, timeout=8.0, step=0.02):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if fn():
            return time.time() - t0
        time.sleep(step)
    return None


def main():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "camp"
        shutil.copytree(SAMPLE, root)
        alley = yaml.safe_load((root / "world/scenes/docks.yaml").read_text())
        alley.update(id="alley", name="Back Alley")
        (root / "world/scenes/alley.yaml").write_text(yaml.safe_dump(alley))
        (root / "state/tokens/docks.json").write_text(json.dumps({"scene": "docks", "tokens": [
            {"id": "t-f", "actor_id": AID, "name": "Fighter", "label": "", "x": 105, "y": 105, "size_tiles": 1},
            {"id": "t-o", "actor_id": OTHER, "name": "Tough", "label": "", "x": 315, "y": 175, "size_tiles": 1}]}))
        (root / "state/ui").mkdir(parents=True, exist_ok=True)
        lport = free_port()
        server, gm = create_server(root, host="127.0.0.1", port=0, quiet=True, player_host="127.0.0.1", player_port=lport)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        gmp = f"http://127.0.0.1:{lport}"
        procs, pls = [], []
        for i, name in enumerate(["Live P1", "Live P2"]):
            port = free_port()
            procs.append(subprocess.Popen([sys.executable, str(PLAYER_APP), "--headless", "--data-dir", str(Path(tmp) / f"p{i}"),
                                           "--port", str(port), "--gm", f"127.0.0.1:{lport}", "--name", name],
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            pls.append(f"http://127.0.0.1:{port}")
        p1, p2 = pls
        try:
            for pl in pls:
                check(wait_for(lambda pl=pl: req("GET", pl + "/papi/status")[1].get("state") == "connected", 10) is not None,
                      f"player {pl[-5:]} connects")
            players = req("GET", gm + "/api/players")[1]["players"]
            pid1 = next(p["id"] for p in players if p["name"] == "Live P1")
            check(req("PUT", gm + "/api/players/assign", {"actor": AID, "players": [pid1]})[0] == 200, "GM assigns the fighter to P1")

            # --- map view -----------------------------------------------------
            st, _ = req("POST", gm + "/api/session/active", {"scene": "docks"})
            check(st == 200, "GM map window reports its active scene")
            for pl in pls:
                check(wait_for(lambda pl=pl: req("GET", pl + "/papi/live?since=-1&timeout=0")[1].get("scene_id") == "docks", 6) is not None,
                      f"player {pl[-5:]} gets the active scene")
            st, scn = req("GET", p1 + "/api/scene/docks")
            check(st == 200 and scn["layers"][0]["asset"] == ASSET and scn["grid"]["size"] == 70, "player scene has map layer + grid")
            check("walls" not in scn and "lights" not in scn and "doors" not in scn, "walls/doors/lights are not exposed to players")
            check(scn["snap"] == {"snapToGrid": True, "snapTarget": "center"}, "GM snap setting is in the view")
            st, data = req("GET", p1 + f"/assets/{ASSET}", raw=True)
            check(st == 200 and data == (root / "world/assets/by-hash" / ASSET).read_bytes(), "map image fetched from the GM by hash and cached")
            toks = req("GET", p1 + "/api/tokens/docks")[1]["tokens"]
            check({t["id"] for t in toks} == {"t-f", "t-o"}, "player sees the tokens")

            # GM moves a token (GM map window merge-save) → players within ~1 s
            def gm_tokens():
                return req("GET", gm + "/api/tokens/docks")[1]["tokens"]
            cur = gm_tokens()
            for t in cur:
                if t["id"] == "t-o":
                    t["x"] = 385
            t0 = time.time()
            req("PUT", gm + "/api/tokens/docks", {"scene": "docks", "tokens": cur, "merge": {"changed": ["t-o"], "removed": []}})
            for pl in pls:
                dt = wait_for(lambda pl=pl: any(t["id"] == "t-o" and t["x"] == 385 for t in req("GET", pl + "/api/tokens/docks")[1]["tokens"]), 5)
                check(dt is not None and dt < 1.5, f"GM token move reaches player {pl[-5:]} in {dt:.2f}s")
                results.setdefault("gm_move_s", []).append(round(time.time() - t0, 3))

            # --- player token moves -------------------------------------------
            t0 = time.time()
            st, out = req("POST", p1 + "/api/token-move", {"scene": "docks", "token": "t-f", "x": 250, "y": 260})
            check(st == 200 and out["token"]["x"] == 245 and out["token"]["y"] == 245, f"P1 moves own token, snapped to cell centre ({out.get('token')})")
            dt = wait_for(lambda: any(t["id"] == "t-f" and t["x"] == 245 for t in gm_tokens()), 3)
            check(dt is not None, "move persisted on the GM (state/tokens/docks.json)")
            dt = wait_for(lambda: any(t["id"] == "t-f" and t["x"] == 245 for t in req("GET", p2 + "/api/tokens/docks")[1]["tokens"]), 5)
            check(dt is not None and time.time() - t0 < 1.5, f"P1's move reaches P2 in {time.time() - t0:.2f}s")
            results["player_move_to_other_player_s"] = round(time.time() - t0, 3)
            live0 = req("GET", gm + "/api/live?timeout=0")[1]["map_rev"]
            check(isinstance(live0, int), "GM map window live endpoint answers")
            # GM window's own save of another token must not clobber P1's move
            stale = [dict(t, x=105, y=105) if t["id"] == "t-f" else dict(t, x=455) if t["id"] == "t-o" else t for t in cur]
            req("PUT", gm + "/api/tokens/docks", {"scene": "docks", "tokens": stale, "merge": {"changed": ["t-o"], "removed": []}})
            g = {t["id"]: t for t in gm_tokens()}
            check(g["t-f"]["x"] == 245 and g["t-o"]["x"] == 455, "GM merge-save keeps a player's concurrent move (last move wins per token)")
            # corner snap follows the GM's setting
            (root / "state/ui/docks.json").write_text(json.dumps({"snapToGrid": True, "snapTarget": "corner"}))
            st, out = req("POST", p1 + "/api/token-move", {"scene": "docks", "token": "t-f", "x": 180, "y": 100})
            check(st == 200 and (out["token"]["x"], out["token"]["y"]) == (210, 70), "corner snap when the GM uses corner snapping")
            (root / "state/ui/docks.json").write_text(json.dumps({"snapToGrid": False}))
            st, out = req("POST", p1 + "/api/token-move", {"scene": "docks", "token": "t-f", "x": 181.5, "y": 99})
            check(st == 200 and (out["token"]["x"], out["token"]["y"]) == (181.5, 99), "no snap when the GM turned snapping off")
            # boundary
            st, e = req("POST", p1 + "/api/token-move", {"scene": "docks", "token": "t-o", "x": 0, "y": 0})
            check(st == 403, f"P1 cannot move a token it does not own (403 {e.get('error')})")
            st, _ = req("POST", p2 + "/api/token-move", {"scene": "docks", "token": "t-f", "x": 0, "y": 0})
            check(st == 403, "P2 (no assignment) cannot move P1's token")
            check(req("POST", p1 + "/api/token-move", {"scene": "docks", "token": "nope", "x": 0, "y": 0})[0] == 404, "unknown token → 404")
            check(req("POST", p1 + "/api/token-move", {"scene": "alley", "token": "t-f", "x": 0, "y": 0})[0] == 404, "move in a scene that is not active → 404")
            for bad in ({"x": 1e12, "y": 0}, {"x": "10", "y": 0}, {"x": True, "y": 0}, {"x": None, "y": 1}):
                st, _ = req("POST", p1 + "/api/token-move", {"scene": "docks", "token": "t-f", **bad})
                check(st == 400, f"bad coordinates rejected: {bad}")
            body = b'{"scene":"docks","token":"t-f","x":NaN,"y":0}'
            check(req("POST", p1 + "/api/token-move", body)[0] in (400,), "NaN coordinate rejected")
            g = {t["id"]: t for t in gm_tokens()}
            check(g["t-o"]["x"] == 455 and math.isfinite(g["t-f"]["x"]), "rejected moves changed nothing")

            # --- scene switch --------------------------------------------------
            t0 = time.time()
            req("POST", gm + "/api/session/active", {"scene": "alley"})
            dt = wait_for(lambda: req("GET", p2 + "/papi/live?since=-1&timeout=0")[1].get("scene_id") == "alley", 5)
            check(dt is not None and dt < 1.5, f"scene switch reaches the player in {dt:.2f}s")
            results["scene_switch_s"] = round(dt, 3)
            check(req("GET", p2 + "/api/scene/docks")[0] == 404, "old scene no longer served to players")

            # --- chat -----------------------------------------------------------
            evil = '<img src=x onerror="alert(1)"> & <b>hi</b>'
            t0 = time.time()
            st, out = req("POST", p1 + "/api/chat", {"kind": "message", "text": evil})
            check(st == 200, "P1 posts a chat message")
            dt = wait_for(lambda: any(e.get("text") == evil for e in req("GET", gm + "/api/chat?after=0")[1]["entries"]), 3, 0.005)
            results["player_to_gm_chat_s"] = round(dt, 3)
            check(dt is not None and dt < 0.5, f"player message in the GM chat log in {dt*1000:.0f} ms (stored verbatim, rendered as text)")
            dt = wait_for(lambda: any(e.get("text") == evil for e in req("GET", p2 + "/api/chat?after=0")[1]["entries"]), 3, 0.005)
            results["player_to_other_player_chat_s"] = round(time.time() - t0, 3)
            check(dt is not None and time.time() - t0 < 1.0, f"…and in P2's chat after {time.time() - t0:.2f}s")
            entry = next(e for e in req("GET", gm + "/api/chat?after=0")[1]["entries"] if e.get("text") == evil)
            check(entry["sender"]["name"] == "Live P1" and entry["sender"]["role"] == "player" and entry["seq"] >= 1 and entry["t"] > 0,
                  "entry has sender, role, sequence id and server timestamp")
            t0 = time.time()
            req("POST", gm + "/api/chat", {"kind": "roll", "label": "Tough: Attack", "result": 17, "detail": "d20+3"})
            dt = wait_for(lambda: any(e.get("label") == "Tough: Attack" for e in req("GET", p1 + "/api/chat?after=0")[1]["entries"]), 3, 0.005)
            results["gm_to_player_chat_s"] = round(dt, 3)
            check(dt is not None and dt < 0.5, f"GM roll reaches the player in {dt*1000:.0f} ms")
            st, out = req("POST", p2 + "/api/chat", {"kind": "roll", "label": "d20", "result": 11, "detail": "1d20"})
            check(st == 200, "player roll accepted")
            lines = (root / "state/chat/session.jsonl").read_text().splitlines()
            check(len(lines) >= 3 and json.loads(lines[-1])["kind"] == "roll", "chat persisted in state/chat/session.jsonl")
            # chat boundary
            check(req("POST", p1 + "/api/chat", {"kind": "message", "text": "x" * 501})[0] == 400, "over-long message rejected")
            check(req("POST", p1 + "/api/chat", {"kind": "html", "text": "x"})[0] == 400, "unknown kind rejected")
            check(req("POST", p1 + "/api/chat", {"kind": "roll", "label": "x", "result": [1]})[0] == 400, "bad roll result rejected")
            check(req("POST", p1 + "/api/chat", {"kind": "message", "text": "   "})[0] == 400, "empty message rejected")
            codes = [req("POST", p2 + "/api/chat", {"kind": "message", "text": f"spam {i}"})[0] for i in range(30)]
            check(429 in codes, f"chat rate limit kicks in ({codes.count(200)} accepted, then 429)")

            # --- direct player-port boundary ----------------------------------
            for path in ("/player/api/view", "/player/api/chat", f"/player/api/asset/{ASSET}", "/player/api/wait?timeout=0"):
                check(req("GET", gmp + path)[0] in (401, 403), f"{path} needs player auth")
            check(req("POST", gmp + "/player/api/token-move", {"scene": "alley", "token": "t-f", "x": 1, "y": 1})[0] in (401, 403),
                  "token-move needs player auth")
            check(req("POST", gmp + "/player/api/chat", {"kind": "message", "text": "hi"}, headers={"X-Player-Id": pid1, "X-Player-Secret": "wrong"})[0] in (401, 403),
                  "wrong player secret rejected")
            for path in ("/api/library", "/api/tokens/docks", "/api/chat", "/api/live", "/api/players"):
                check(req("GET", gmp + path)[0] == 404, f"GM API {path} not reachable on the player port")
            check(req("DELETE", gmp + "/api/chat")[0] in (404, 405, 501), "cannot clear chat via the player port")
            check(req("GET", p1 + "/assets/..%2F..%2Fconfig.json")[0] in (400, 404), "asset path traversal refused")
        finally:
            for p in procs:
                p.terminate()
            for p in procs:
                try:
                    p.wait(5)
                except subprocess.TimeoutExpired:
                    p.kill()
            server.RequestHandlerClass.player_server.shutdown()
            server.shutdown()
    print("RESULTS", json.dumps(results))
    print("all live integration checks passed")


if __name__ == "__main__":
    main()
