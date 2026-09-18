#!/usr/bin/env python3
"""HTTP-level: publish mechanic, import once, reject duplicate name."""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server_lib import create_server


def req(method, url, body=None):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def main() -> None:
    sample = Path(__file__).resolve().parents[3] / "examples" / "sample-campaign"
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "camp"
        # minimal campaign copy pointers via symlink where possible
        import shutil
        shutil.copytree(sample, root, symlinks=True)
        # clear mechanics
        mdir = root / "editor-scratch" / "mechanics"
        mdir.mkdir(parents=True, exist_ok=True)
        for p in mdir.glob("*.json"):
            p.unlink()

        server, base = create_server(root, host="127.0.0.1", port=0, quiet=True)
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        try:
            mech = {
                "name": "attack",
                "nodes": [
                    {"id": "e", "kind": "entry", "name": "attack", "x": 0, "y": 0},
                    {"id": "r", "kind": "roll", "sides": 20, "x": 120, "y": 0},
                ],
                "edges": [{"id": "w", "from": "e", "to": "r", "toPort": 0}],
            }
            st, data = req("PUT", f"{base}/api/mechanics/attack", mech)
            assert st == 200 and data.get("ok"), data

            st, data = req("GET", f"{base}/api/mechanics")
            assert st == 200 and any(m["name"] == "attack" for m in data["mechanics"])

            # strip attack entry from player scratch/yaml so import can succeed
            # player sheet already has attack — expect 409 when importing as-is
            st, data = req(
                "POST",
                f"{base}/api/sheet-builder/player/import-mechanic",
                {"name": "attack"},
            )
            assert st == 409, (st, data)

            # rename existing entry so import can proceed
            scratch = root / "editor-scratch" / "sheets" / "player.builder.json"
            doc = json.loads(scratch.read_text())
            for n in doc.get("graph", {}).get("nodes", []):
                if n.get("kind") in ("entry", "function") and n.get("name") == "attack":
                    n["name"] = "attack_old"
            scratch.write_text(json.dumps(doc, indent=2) + "\n")
            # also update yaml graph if present
            ypath = root / "build" / "sheets" / "player.yaml"
            if ypath.is_file():
                import yaml
                y = yaml.safe_load(ypath.read_text()) or {}
                g = y.get("graph") or {}
                for n in g.get("nodes") or []:
                    if isinstance(n, dict) and n.get("kind") in ("entry", "function") and n.get("name") == "attack":
                        n["name"] = "attack_old"
                ypath.write_text(yaml.safe_dump(y, sort_keys=False), encoding="utf-8")

            st, data = req(
                "POST",
                f"{base}/api/sheet-builder/player/import-mechanic",
                {"name": "attack"},
            )
            assert st == 200 and data.get("ok"), (st, data)
            assert data.get("name") == "attack"
            assert data.get("graph_node_count", 0) > 0

            st, data = req(
                "POST",
                f"{base}/api/sheet-builder/player/import-mechanic",
                {"name": "attack"},
            )
            assert st == 409, (st, data)

            print("mechanics-import-api: ok")
        finally:
            server.shutdown()


if __name__ == "__main__":
    main()
