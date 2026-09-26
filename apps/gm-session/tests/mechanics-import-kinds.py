#!/usr/bin/env python3
"""0.7.3: library import of trigger functions, toggle functions and formula macros.

Collisions → 409 + suggested name (never an overwrite); rename import; field dependencies
added only when missing; everything already on the sheet (nodes, edges, compressed blocks,
fields, the compiled yaml's own graph) is preserved exactly.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server_lib import create_server, mechanic_kind  # noqa: E402

SAMPLE = Path(__file__).resolve().parents[3] / "examples" / "sample-campaign"
N = 0


def check(cond, msg):
    global N
    if not cond:
        raise SystemExit(f"FAIL - {msg}")
    N += 1
    print(f"ok - {msg}")


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


MACRO = {
    "name": "half_mod", "kind": "macro",
    "nodes": [
        {"id": "a", "kind": "field", "field": "[x]", "role": "source", "x": 0, "y": 0},
        {"id": "k", "kind": "const", "value": 2, "x": 0, "y": 60},
        {"id": "d", "kind": "op", "op": "/", "x": 140, "y": 30},
        {"id": "f", "kind": "op", "op": "floor", "x": 280, "y": 30},
        {"id": "o", "kind": "field", "field": "[x]_half", "role": "output", "x": 420, "y": 30},
    ],
    "edges": [{"id": "1", "from": "a", "to": "d", "toPort": 0}, {"id": "2", "from": "k", "to": "d", "toPort": 1},
              {"id": "3", "from": "d", "to": "f", "toPort": 0}, {"id": "4", "from": "f", "to": "o", "toPort": 0}],
    "collapsed": [{"id": "c", "name": "half_mod", "nodeIds": ["a", "k", "d", "f", "o"], "x": 0, "y": 0, "w": 260, "h": 110}],
    "fields": {"STR_half": {"type": "integer", "default": 0, "label": "½ STR"}},
}
TOGGLE = {
    "name": "rage", "kind": "toggle",
    "nodes": [
        {"id": "e", "kind": "entry", "name": "rage", "mode": "toggle", "x": 0, "y": 0},
        {"id": "p", "kind": "popup", "prompt": "Rage rounds?", "var": "rounds", "vtype": "number", "default": 3, "x": 0, "y": 80},
        {"id": "s", "kind": "field", "field": "STR", "role": "source", "x": 0, "y": 160},
        {"id": "m", "kind": "field", "field": "fury", "role": "source", "x": 0, "y": 220},
        {"id": "c", "kind": "send_to_chat", "label": "Rage {rounds}", "x": 200, "y": 80},
    ],
    "edges": [{"id": "1", "from": "e", "to": "p", "toPort": 0}, {"id": "2", "from": "p", "to": "c", "toPort": 0}],
    "fields": {"rage": {"type": "integer", "default": 0, "label": "Raging"}, "STR": {"type": "integer", "default": 99}},
}
LEGACY = {"name": "old_attack", "nodes": [{"id": "e", "kind": "entry", "name": "old_attack"}, {"id": "r", "kind": "roll", "sides": 20}],
          "edges": [{"id": "w", "from": "e", "to": "r", "toPort": 0}]}


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "camp"
        shutil.copytree(SAMPLE, root)
        mdir = root / "editor-scratch" / "mechanics"
        mdir.mkdir(parents=True, exist_ok=True)
        for p in mdir.glob("*.json"):
            p.unlink()
        (mdir / "old_attack.json").write_text(json.dumps(LEGACY))
        # the compiled sheet carries its own formula macro (compressed block) — must survive imports
        ypath = root / "build" / "sheets" / "player.yaml"
        y = yaml.safe_load(ypath.read_text())
        y["graph"]["collapsed"] = [{"id": "c_keep", "name": "STR block", "nodeIds": ["n_str"], "x": 1, "y": 2, "w": 300, "h": 90}]
        y["fields"]["STR_half"] = {"type": "integer", "default": 0}
        ypath.write_text(yaml.safe_dump(y, sort_keys=False))
        scratch = root / "editor-scratch" / "sheets" / "player.builder.json"
        sdoc = json.loads(scratch.read_text())
        sdoc["fields"]["STR_half"] = {"type": "integer", "default": 0, "label": "mine"}
        scratch.write_text(json.dumps(sdoc, indent=2) + "\n")
        before_s = json.loads(scratch.read_text())
        before_y = yaml.safe_load(ypath.read_text())

        server, base = create_server(root, host="127.0.0.1", port=0, quiet=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        imp = f"{base}/api/sheet-builder/player/import-mechanic"
        try:
            check(req("PUT", f"{base}/api/mechanics/half_mod", MACRO)[0] == 200, "publish macro")
            check(req("PUT", f"{base}/api/mechanics/rage", TOGGLE)[0] == 200, "publish toggle")
            stored = json.loads((mdir / "rage.json").read_text())
            check(stored.get("kind") == "toggle" and "rage" in stored.get("fields", {}), "library stores kind + field dependencies")
            st, lib = req("GET", f"{base}/api/mechanics")
            kinds = {m["name"]: m["kind"] for m in lib["mechanics"]}
            check(kinds == {"half_mod": "macro", "rage": "toggle", "old_attack": "function"}, f"library list carries kinds (legacy file = function): {kinds}")
            check(mechanic_kind({"nodes": [{"kind": "field"}]}) == "macro", "entry-less legacy file = macro")

            # macro
            st, d = req("POST", imp, {"name": "half_mod"})
            check(st == 200 and d["kind"] == "macro" and d["added_fields"] == [] and d["kept_fields"] == ["STR_half"], f"macro imported; existing field kept: {d}")
            s1 = json.loads(scratch.read_text())
            blk = [c for c in s1["graph"]["collapsed"] if c["name"] == "half_mod"]
            check(len(blk) == 1 and len(blk[0]["nodeIds"]) == 5 and blk[0]["w"] == 260, "macro arrives as its compressed block (size kept)")
            check(s1["fields"]["STR_half"] == {"type": "integer", "default": 0, "label": "mine"}, "existing field definition untouched")
            y1 = yaml.safe_load(ypath.read_text())
            check(any(c["id"] == "c_keep" for c in y1["graph"]["collapsed"]), "compiled yaml keeps its own compressed blocks (0.6.x import dropped them)")
            check(y1["graph"]["nodes"][: len(before_y["graph"]["nodes"])] == before_y["graph"]["nodes"]
                  and y1["graph"]["edges"][: len(before_y["graph"]["edges"])] == before_y["graph"]["edges"], "compiled yaml nodes/edges only appended")
            st, d = req("POST", imp, {"name": "half_mod"})
            check(st == 409 and d.get("conflict") == "name" and d.get("suggested") == "half_mod_2", f"same macro again → name conflict + suggestion: {d}")
            st, d = req("POST", imp, {"name": "half_mod", "as": "half_mod_2"})
            check(st == 409 and d.get("conflict") == "fields", "renamed duplicate macro still refused: two macros cannot own [x]_half")

            # toggle
            st, d = req("POST", imp, {"name": "rage"})
            check(st == 200 and d["kind"] == "toggle" and d["added_fields"] == ["rage"] and d["kept_fields"] == ["STR"]
                  and d["missing_fields"] == ["fury"], f"toggle imported with its 0/1 field; STR kept; fury reported: {d}")
            s2 = json.loads(scratch.read_text())
            ent = [n for n in s2["graph"]["nodes"] if n.get("kind") == "entry" and n.get("name") == "rage"]
            check(len(ent) == 1 and ent[0].get("mode") == "toggle", "imported toggle keeps mode: toggle")
            check(s2["fields"]["rage"]["default"] == 0 and s2["fields"]["STR"] == before_s["fields"]["STR"], "toggle field added (default 0); STR def untouched")
            check("rage" in yaml.safe_load(ypath.read_text())["fields"], "toggle field added to the compiled sheet too")
            st, d = req("POST", imp, {"name": "rage"})
            check(st == 409 and d.get("suggested") == "rage_2", "toggle name collision → suggestion")
            st, d = req("POST", imp, {"name": "rage", "as": "rage_2"})
            check(st == 200 and d["name"] == "rage_2" and d["renamed"] and "rage_2" in d["added_fields"], f"import as rage_2: {d}")
            s3 = json.loads(scratch.read_text())
            ent2 = [n for n in s3["graph"]["nodes"] if n.get("kind") == "entry" and n.get("name") == "rage_2"]
            check(len(ent2) == 1 and ent2[0].get("mode") == "toggle" and "rage_2" in s3["fields"], "renamed toggle flips its own field rage_2")
            check(len([n for n in s3["graph"]["nodes"] if n.get("name") == "rage"]) == 1, "original rage untouched")
            st, d = req("POST", imp, {"name": "rage", "as": "bad name!"})
            check(st == 400, "invalid new name rejected")

            # legacy function file
            st, d = req("POST", imp, {"name": "old_attack"})
            check(st == 200 and d["kind"] == "function", "pre-0.7.3 library file imports as a trigger function")

            # nothing that was there before changed
            s4 = json.loads(scratch.read_text())
            old_ids = {n["id"] for n in before_s["graph"]["nodes"]}
            check([n for n in s4["graph"]["nodes"] if n["id"] in old_ids] == before_s["graph"]["nodes"], "existing builder nodes byte-identical")
            check(s4["graph"]["edges"][: len(before_s["graph"]["edges"])] == before_s["graph"]["edges"], "existing builder edges identical")
            check(all(s4["fields"][k] == v for k, v in before_s["fields"].items()), "every existing field definition identical")
            new_ids = [n["id"] for n in s4["graph"]["nodes"] if n["id"] not in old_ids]
            check(len(new_ids) == len(set(new_ids)) and not (set(new_ids) & old_ids), "imported nodes got fresh ids (no id collisions)")
            # the sheet payload has the macro + toggle and live-compiles
            st, sheet = req("GET", f"{base}/api/sheet/party-fighter")
            g = sheet["graph"]
            check(any(c.get("name") == "half_mod" for c in g.get("collapsed", [])) and any(n.get("name") == "rage_2" for n in g["nodes"]),
                  "character sheet payload carries imported macro + toggles")
        finally:
            server.shutdown()
            server.server_close()
    print(f"mechanics-import-kinds: ok ({N} checks)")


if __name__ == "__main__":
    main()
