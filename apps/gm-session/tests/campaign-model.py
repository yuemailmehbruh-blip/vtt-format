#!/usr/bin/env python3
"""0.6.19: maps as first-class entities + load-time migration of legacy scenes,
sidebar organization (folders / order / collapse) in world/organization.yaml,
create + rename endpoints, actor rename updating derived token labels."""
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

import campaign_model as cm  # noqa: E402
from server_lib import create_server  # noqa: E402

APP = Path(__file__).resolve().parents[1]
SAMPLE = APP.parents[1] / "examples" / "sample-campaign"
BG = "a433eb2ba6774bcb8ff2ecf7c63fd52d839cb783af7615ba69be2bed472bb6d7"


def req(method, url, body=None):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r) as resp:
            payload = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            return resp.status, (json.loads(payload.decode()) if "json" in ctype else payload)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def old_client_layers(scene: dict) -> list[dict]:
    """What session.js resolveMapLayerDefs showed before 0.6.19."""
    layers = scene.get("layers") or []
    typed = [l for l in layers if isinstance(l, dict) and l.get("type") == "map" and l.get("asset")]
    if typed:
        return [{k: v for k, v in l.items() if k != "type"} for l in typed]
    if scene.get("background"):
        return [{"id": "background", "name": "Base map", "asset": scene["background"], "visible": True, "x": 0, "y": 0}]
    return []


def view_layers(resolved: dict) -> list[dict]:
    return [{k: v for k, v in l.items() if k != "type"} for l in resolved["layers"] if l.get("type") == "map"]


def tree_hash(root: Path, rel: str) -> dict:
    base = root / rel
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(base.rglob("*")) if p.is_file()}


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


def test_migration(tmp: Path) -> None:
    # --- A: sample campaign (background only) --------------------------------
    root = tmp / "a"
    shutil.copytree(SAMPLE, root)
    legacy = yaml.safe_load((root / "world/scenes/docks.yaml").read_text())
    expect = old_client_layers(legacy)
    actors_before = tree_hash(root, "world/actors")
    tokens_before = tree_hash(root, "state")
    rep = cm.migrate_campaign(root)
    check([e["scene"] for e in rep["scenes"]] == ["docks"], "sample: docks migrated")
    scene = yaml.safe_load((root / "world/scenes/docks.yaml").read_text())
    m = yaml.safe_load((root / "world/maps/docks.yaml").read_text())
    check(scene["map"] == "docks" and "background" not in scene and "grid" not in scene, "scene references map, background/grid moved")
    check(m["grid"]["size"] == 70 and m["layers"][0]["asset"] == BG, "map carries grid 70 + background layer")
    check(scene["walls"] == legacy["walls"] and scene["doors"] == legacy["doors"], "walls/doors untouched")
    check(view_layers(cm.resolve_scene(root, scene)) == expect, "resolved view layers identical to pre-0.6.19 view")
    check(cm.resolve_scene(root, scene)["grid"] == legacy["grid"], "resolved grid identical")
    backup = root / "state/migrations/0.6.19/scenes/docks.yaml"
    check(yaml.safe_load(backup.read_text()) == legacy, "backup of original scene written")
    check((root / "world/organization.yaml").is_file(), "organization.yaml created")
    check(tree_hash(root, "world/actors") == actors_before, "actors untouched")
    st = tree_hash(root, "state")
    check(all(st.get(k) == v for k, v in tokens_before.items()), "existing state files (tokens/ui) untouched")
    # idempotent
    snap = {**tree_hash(root, "world"), **tree_hash(root, "state")}
    rep2 = cm.migrate_campaign(root)
    check(rep2["scenes"] == [] and not rep2["organization_created"], "second run is a no-op")
    check({**tree_hash(root, "world"), **tree_hash(root, "state")} == snap, "second run changes no file")

    # --- B: user-like: map layer deleted, only tokens layer + background ------
    root = tmp / "b"
    shutil.copytree(SAMPLE, root)
    sp = root / "world/scenes/docks.yaml"
    legacy = yaml.safe_load(sp.read_text())
    legacy["layers"] = [{"id": "tokens", "type": "tokens"}]
    sp.write_text(yaml.safe_dump(legacy, sort_keys=False))
    tok = {"scene": "docks", "tokens": [{"id": "party-fighter-1", "actor_id": "party-fighter", "name": "Party Fighter", "label": "PF", "x": 245, "y": 175, "size_tiles": 1}]}
    (root / "state/tokens/docks.json").write_text(json.dumps(tok, indent=2))
    expect = old_client_layers(legacy)
    cm.migrate_campaign(root)
    scene = yaml.safe_load(sp.read_text())
    check(view_layers(cm.resolve_scene(root, scene)) == expect and expect[0]["name"] == "Base map", "user-like: Base map fallback preserved")
    check(json.loads((root / "state/tokens/docks.json").read_text()) == tok, "user-like: token unchanged")

    # --- C: typed multi-layer scene with transforms + a map-less scene --------
    root = tmp / "c"
    shutil.copytree(SAMPLE, root)
    sp = root / "world/scenes/docks.yaml"
    legacy = yaml.safe_load(sp.read_text())
    legacy["layers"] = [
        {"id": "floor", "type": "map", "name": "Floor", "asset": BG, "visible": True, "x": 10, "y": 20, "w": 700, "h": 490, "flipX": True, "rotation": 90},
        {"id": "roof", "type": "map", "name": "Roof", "asset": BG, "visible": False, "x": 0, "y": 0},
        {"id": "tokens", "type": "tokens"},
    ]
    sp.write_text(yaml.safe_dump(legacy, sort_keys=False))
    (root / "world/scenes/void.yaml").write_text(yaml.safe_dump({"id": "void", "name": "Void", "grid": {"size": 50, "units": "ft", "type": "square"}, "layers": [{"id": "tokens", "type": "tokens"}]}))
    # a pre-existing unrelated map with the same id → migration picks a free id
    (root / "world/maps").mkdir(parents=True)
    (root / "world/maps/docks.yaml").write_text(yaml.safe_dump({"id": "docks", "name": "Other", "grid": {"size": 70}, "layers": []}))
    expect = old_client_layers(legacy)
    cm.migrate_campaign(root)
    scene = yaml.safe_load(sp.read_text())
    check(scene["map"] == "docks-2", "id collision → new map id docks-2, existing map untouched")
    check(yaml.safe_load((root / "world/maps/docks.yaml").read_text())["name"] == "Other", "unrelated map not overwritten")
    check(view_layers(cm.resolve_scene(root, scene)) == expect, "typed layers (transforms, hidden) preserved exactly")
    check([l["id"] for l in scene["layers"]] == ["tokens"], "scene keeps only non-image layers")
    void = yaml.safe_load((root / "world/scenes/void.yaml").read_text())
    check(void["map"] is None and void["grid"]["size"] == 50, "scene without images → map: null, keeps own grid")
    check(cm.resolve_scene(root, void)["grid"]["size"] == 50, "map-less scene resolves its own grid")


def test_organization(tmp: Path) -> None:
    root = tmp / "org"
    shutil.copytree(SAMPLE, root)
    cm.migrate_campaign(root)
    org = cm.load_organization(root)
    check([n["actor"] for n in org["actors"]] == ["blank-npc", "dock-tough", "party-fighter"], "actors listed at root in id order")
    tree = [
        {"folder": "f_aaaa1111", "name": "Heroes", "collapsed": True, "children": [
            {"actor": "party-fighter"},
            {"folder": "f_bbbb2222", "name": "Sub", "children": []},
        ]},
        {"actor": "dock-tough"},
    ]
    out = cm.set_panel_tree(root, "actors", tree)
    check(out[0]["collapsed"] is True and out[0]["children"][1]["collapsed"] is False, "folder collapse stored (default expanded)")
    check([n.get("actor") for n in out[1:]] == ["dock-tough", "blank-npc"], "item missing from PUT is re-appended, never lost")
    text = (root / "world/organization.yaml").read_text()
    check(text.startswith("# GM Session organization") and "name: Heroes" in text, "organization.yaml is commented human-readable YAML")
    check("visible_to_players" not in text, "no player-visibility data stored (GM-only sorting)")
    for bad, why in [
        ([{"folder": "bad", "name": "x"}], "bad folder id"),
        ([{"folder": "f_aaaa1111", "name": "x"}, {"folder": "f_aaaa1111", "name": "y"}], "duplicate folder"),
        ([{"actor": "dock-tough"}, {"actor": "dock-tough"}], "duplicate item"),
        ([{"folder": "f_aaaa1111", "name": ""}], "missing name"),
        ([{"folder": "f_aaaa1111", "name": "x", "collapsed": "yes"}], "non-bool collapsed"),
        ([{"scene": "docks"}], "wrong kind for panel"),
        ("nope", "tree not a list"),
    ]:
        try:
            cm.set_panel_tree(root, "actors", bad)
        except cm.OrgError:
            print("ok - rejects", why)
        else:
            raise AssertionError(f"accepted {why}")
    deep = {"folder": "f_d0000000", "name": "d", "children": []}
    cur = deep
    for i in range(1, 20):
        nxt = {"folder": f"f_d{i:07d}", "name": "d", "children": []}
        cur["children"].append(nxt)
        cur = nxt
    try:
        cm.set_panel_tree(root, "actors", [deep])
        raise AssertionError("accepted too-deep nesting")
    except cm.OrgError:
        print("ok - rejects nesting deeper than", cm.MAX_DEPTH)
    check((root / "world/organization.yaml").read_text() == text, "rejected PUTs leave the file unchanged")
    # hand-edited file with junk still loads (lenient read)
    (root / "world/organization.yaml").write_text("version: 1\nactors:\n- actor: ghost\n- folder: bad\n- actor: party-fighter\n")
    org = cm.load_organization(root)
    check([n.get("actor") for n in org["actors"]] == ["party-fighter", "blank-npc", "dock-tough"], "lenient load drops unknown ids, keeps all actors")
    (root / "world/organization.yaml").write_text(": : not yaml [")
    check(len(cm.load_organization(root)["actors"]) == 3, "corrupt organization.yaml falls back to flat lists")


def test_http(tmp: Path) -> None:
    root = tmp / "http"
    shutil.copytree(SAMPLE, root)
    tok = {"scene": "docks", "tokens": [
        {"id": "pf-1", "actor_id": "party-fighter", "name": "Party Fighter", "label": "PF", "x": 1, "y": 2, "size_tiles": 1},
        {"id": "pf-2", "actor_id": "party-fighter", "name": "Custom", "label": "ZZ", "x": 3, "y": 4, "size_tiles": 1},
        {"id": "dt-1", "actor_id": "dock-tough", "name": "Dock Tough", "label": "DT", "x": 5, "y": 6, "size_tiles": 1},
    ]}
    (root / "state/tokens/docks.json").write_text(json.dumps(tok, indent=2))
    server, base = create_server(root, host="127.0.0.1", port=0, quiet=True)  # migration runs here
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        check((root / "world/maps/docks.yaml").is_file(), "create_server ran the migration")
        s, rep = req("GET", f"{base}/api/migration")
        check(s == 200 and rep["scenes"][0]["map"] == "docks", "/api/migration reports it")
        s, sc = req("GET", f"{base}/api/scene/docks")
        check(s == 200 and sc["grid"]["size"] == 70 and sc["layers"][0]["asset"] == BG and sc["map_info"]["id"] == "docks", "GET scene resolves map layers + grid")
        s, lib = req("GET", f"{base}/api/library")
        check([m["id"] for m in lib["maps"]] == ["docks"] and lib["maps"][0]["used_by"] == ["docks"], "library lists maps with usage")
        check("organization" in lib and lib["scenes"][0]["map"] == "docks", "library carries organization + scene→map")
        s, body = req("GET", f"{base}/org-tree.js")
        check(s == 200 and b"OrgTree" in body, "org-tree.js served")

        # layer writes go into the map
        layers = sc["layers"]
        layers[0] = {**layers[0], "x": 35}
        s, out = req("PUT", f"{base}/api/scene/docks/layers", {"layers": layers})
        check(s == 200 and yaml.safe_load((root / "world/maps/docks.yaml").read_text())["layers"][0]["x"] == 35, "PUT layers writes image layers into the map")
        check("background" not in yaml.safe_load((root / "world/scenes/docks.yaml").read_text()), "scene file stays map-free")

        # create
        s, a = req("POST", f"{base}/api/actors", {"name": "Harbor Guard"})
        check(s == 200 and a["actor"]["id"] == "harbor-guard" and (root / "world/actors/harbor-guard.yaml").is_file(), "POST /api/actors creates a blank character")
        s, sh = req("GET", f"{base}/api/sheet/harbor-guard")
        check(s == 200 and sh["name"] == "Harbor Guard", "new character opens as a sheet")
        s, a2 = req("POST", f"{base}/api/actors", {"name": "Harbor Guard"})
        check(a2["actor"]["id"] == "harbor-guard-2", "duplicate names get unique ids")
        s, e = req("POST", f"{base}/api/actors", {"name": "   "})
        check(s == 400, "blank name rejected")
        s, sc2 = req("POST", f"{base}/api/scenes", {"name": "Warehouse", "map": "docks"})
        check(s == 200 and sc2["scene"]["map"] == "docks", "POST /api/scenes with a map")
        s, v = req("GET", f"{base}/api/scene/warehouse")
        check(v["layers"][0]["asset"] == BG and v["grid"]["size"] == 70, "new scene shows the shared map")
        s, e = req("POST", f"{base}/api/scenes", {"name": "X", "map": "nope"})
        check(s == 400, "unknown map rejected")
        s, mp = req("POST", f"{base}/api/maps", {"name": "Cellar", "layers": [{"id": "cellar", "name": "Cellar", "asset": BG, "x": 0, "y": 0}], "grid": {"size": 50}})
        check(s == 200 and mp["map"]["id"] == "cellar", "POST /api/maps creates a map")
        s, e = req("POST", f"{base}/api/maps", {"name": "Bad", "layers": [{"asset": "../etc"}]})
        check(s == 400, "bad asset hash rejected")
        s, r = req("PUT", f"{base}/api/scene/warehouse/map", {"map": "cellar"})
        check(s == 200 and req("GET", f"{base}/api/scene/warehouse")[1]["grid"]["size"] == 50, "PUT scene map switches map + grid")
        s, e = req("PUT", f"{base}/api/scene/warehouse/map", {"map": "ghost"})
        check(s == 400, "switching to unknown map rejected")
        s, e = req("POST", f"{base}/api/actors", {"name": "Y", "folder": "../x"})
        check(s == 400, "bad folder id rejected at the boundary")

        # folders via API + create into folder
        s, t = req("PUT", f"{base}/api/organization/actors", {"tree": [{"folder": "f_abcd1234", "name": "Guards", "children": []}]})
        check(s == 200, "PUT organization/actors")
        s, a3 = req("POST", f"{base}/api/actors", {"name": "Gate Guard", "folder": "f_abcd1234"})
        s, org = req("GET", f"{base}/api/organization")
        check(org["actors"][0]["children"] == [{"actor": "gate-guard"}], "new item created inside chosen folder")
        s, e = req("PUT", f"{base}/api/organization/nope", {"tree": []})
        check(s == 400, "unknown panel rejected")

        # rename
        s, r = req("POST", f"{base}/api/organization/rename", {"kind": "folder", "panel": "actors", "id": "f_abcd1234", "name": "City Watch"})
        check(s == 200 and req("GET", f"{base}/api/organization")[1]["actors"][0]["name"] == "City Watch", "rename folder")
        s, r = req("POST", f"{base}/api/organization/rename", {"kind": "actor", "id": "party-fighter", "name": "Sir Roland"})
        check(s == 200 and r["tokens_updated"] == 1, "rename actor → 1 derived token updated")
        toks = {t["id"]: t for t in json.loads((root / "state/tokens/docks.json").read_text())["tokens"]}
        check(toks["pf-1"]["name"] == "Sir Roland" and toks["pf-1"]["label"] == "SR", "derived token name + label follow")
        check(toks["pf-2"]["name"] == "Custom" and toks["pf-2"]["label"] == "ZZ", "custom token name/label untouched")
        check(toks["dt-1"]["name"] == "Dock Tough", "other actors' tokens untouched")
        actor = yaml.safe_load((root / "world/actors/party-fighter.yaml").read_text())
        check(actor["id"] == "party-fighter" and actor["name"] == "Sir Roland" and actor["fields"]["name"] == "Sir Roland", "actor id unchanged, name + fields.name updated")
        check(req("GET", f"{base}/api/sheet/party-fighter")[1]["name"] == "Sir Roland", "sheet title source updated")
        s, r = req("POST", f"{base}/api/organization/rename", {"kind": "scene", "id": "docks", "name": "Docks at night"})
        check(s == 200 and req("GET", f"{base}/api/scene/docks")[1]["name"] == "Docks at night", "rename scene")
        s, r = req("POST", f"{base}/api/organization/rename", {"kind": "map", "id": "docks", "name": "Harbor"})
        check(s == 200 and req("GET", f"{base}/api/map/docks")[1]["name"] == "Harbor", "rename map")
        s, e = req("POST", f"{base}/api/organization/rename", {"kind": "actor", "id": "../x", "name": "a"})
        check(s == 400, "rename with bad id rejected")
        s, e = req("POST", f"{base}/api/organization/rename", {"kind": "actor", "id": "party-fighter", "name": ""})
        check(s == 400, "rename to empty rejected")
        # panel collapse pref in global UI prefs
        s, u = req("PUT", f"{base}/api/ui", {"sidebarCollapsed": {"maps": True, "actors": False, "scenes": False}})
        check(req("GET", f"{base}/api/ui")[1]["sidebarCollapsed"]["maps"] is True, "panel collapse persisted in state/ui.json")
        # tokens API still works
        check(len(req("GET", f"{base}/api/tokens/docks")[1]["tokens"]) == 3, "tokens endpoint unchanged")
    finally:
        server.shutdown()
        server.server_close()
    # restart: migration no-op, everything still there
    server, base = create_server(root, host="127.0.0.1", port=0, quiet=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        check(req("GET", f"{base}/api/migration")[1]["scenes"] == [], "restart: migration is a no-op")
        check(req("GET", f"{base}/api/scene/docks")[1]["layers"][0]["x"] == 35, "restart: map edits persisted")
    finally:
        server.shutdown()
        server.server_close()


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        test_migration(tmp)
        test_organization(tmp)
        test_http(tmp)
    print("campaign-model: all passed")


if __name__ == "__main__":
    main()
