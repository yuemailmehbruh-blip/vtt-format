#!/usr/bin/env python3
"""0.6.20: DELETE /api/actor|map|scene/<id> moves files into state/trash/<time>-<kind>-<id>/
(recoverable, with manifest) and applies side effects: character → its tokens leave
every scene; map → scenes using it get map: null (keeping the grid); scene → its
per-scene state moves too. Other data untouched."""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import yaml  # noqa: E402

from server_lib import create_server  # noqa: E402

APP = Path(__file__).resolve().parents[1]
SAMPLE = APP.parents[1] / "examples" / "sample-campaign"


def req(method, url, body=None):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "camp"
        shutil.copytree(SAMPLE, root)
        toks = {"scene": "docks", "tokens": [
            {"id": "pf-1", "actor_id": "party-fighter", "name": "Party Fighter", "label": "PF", "x": 1, "y": 1},
            {"id": "dt-1", "actor_id": "dock-tough", "name": "Dock Tough", "label": "DT", "x": 2, "y": 2},
        ]}
        (root / "state/tokens/docks.json").write_text(json.dumps(toks))
        server, base = create_server(root, host="127.0.0.1", port=0, quiet=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            req("POST", f"{base}/api/scenes", {"name": "Cellar", "map": "docks"})
            (root / "state/tokens/cellar.json").write_text(json.dumps({"scene": "cellar", "tokens": [
                {"id": "pf-2", "actor_id": "party-fighter", "name": "Party Fighter", "label": "PF", "x": 3, "y": 3}]}))
            (root / "state/ui/cellar.json").write_text('{"scene": "cellar"}')
            pf_yaml = sha(root / "world/actors/party-fighter.yaml")
            dt_yaml = sha(root / "world/actors/dock-tough.yaml")

            # --- character
            s, out = req("DELETE", f"{base}/api/actor/party-fighter")
            check(s == 200 and out["trash"].startswith("state/trash/"), "DELETE actor → trash dir")
            trash = root / out["trash"]
            check(not (root / "world/actors/party-fighter.yaml").exists(), "actor file gone from world/")
            check(sha(trash / "files/world/actors/party-fighter.yaml") == pf_yaml, "actor file preserved byte-identical in trash")
            check((trash / "files/world/actors/party-fighter.sheet.txt").is_file(), "sheet doc moved to trash")
            docks = json.loads((root / "state/tokens/docks.json").read_text())["tokens"]
            cellar = json.loads((root / "state/tokens/cellar.json").read_text())["tokens"]
            check([t["id"] for t in docks] == ["dt-1"] and cellar == [], "its tokens removed from every scene; others kept")
            man = yaml.safe_load((trash / "manifest.yaml").read_text())
            check(sorted(e["scene"] for e in man["side_effects"]["removed_tokens"]) == ["cellar", "docks"], "manifest records removed tokens per scene")
            s, lib = req("GET", f"{base}/api/library")
            check("party-fighter" not in [a["id"] for a in lib["actors"]], "library no longer lists it")
            check("party-fighter" not in json.dumps(req("GET", f"{base}/api/organization")[1]), "organization entry dropped")
            check(sha(root / "world/actors/dock-tough.yaml") == dt_yaml, "other actors untouched")
            s, _ = req("DELETE", f"{base}/api/actor/party-fighter")
            check(s == 404, "deleting again → 404")
            s, _ = req("DELETE", f"{base}/api/actor/..%2F..%2Fetc")
            check(s in (400, 404), "path traversal rejected")

            # --- map
            s, out = req("DELETE", f"{base}/api/map/docks")
            check(s == 200 and sorted(out["side_effects"]["scenes_detached"]) == ["cellar", "docks"], "DELETE map detaches scenes using it")
            sc = yaml.safe_load((root / "world/scenes/docks.yaml").read_text())
            check(sc["map"] is None and sc["grid"]["size"] == 70, "scene keeps its grid with map: null")
            check(sc["walls"], "scene walls untouched")
            s, view = req("GET", f"{base}/api/scene/docks")
            check(s == 200 and [l for l in view["layers"] if l.get("type") == "map"] == [], "scene loads with no map layers")
            check((root / out["trash"] / "files/world/maps/docks.yaml").is_file(), "map file in trash")

            # --- scene
            s, out = req("DELETE", f"{base}/api/scene/cellar")
            moved = out["moved"]
            check(s == 200 and "world/scenes/cellar.yaml" in moved and "state/tokens/cellar.json" in moved and "state/ui/cellar.json" in moved, "DELETE scene moves scene + per-scene state")
            check((root / "world/scenes/docks.yaml").is_file() and (root / "state/tokens/docks.json").is_file(), "other scene untouched")
            s, _ = req("DELETE", f"{base}/api/scene/nope")
            check(s == 404, "unknown scene → 404")
            trashes = sorted(p.name for p in (root / "state/trash").iterdir())
            check(len(trashes) == 3, "one trash folder per delete")
        finally:
            server.shutdown()
            server.server_close()
    print("sidebar-delete: all passed")


if __name__ == "__main__":
    main()
