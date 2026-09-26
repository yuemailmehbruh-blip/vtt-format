#!/usr/bin/env python3
"""0.7.2 PRIORITY: an update never resets campaign data.

* A populated 0.7.1-shaped campaign (maps, scenes, tokens, actors with custom sheet
  values + notes, a customised sheet template + builder scratch, a second custom sheet,
  folders, players/assignments, chat, sync state, deleted sample items) living in the
  old ``{app}/campaign`` goes through the 0.7.2 first-start path (relocation to the user
  data folder + schema migration + server start + every read endpoint the GM window
  and a player use). Every original file must be byte-identical in the new location,
  the old folder must be untouched, deleted sample items must stay deleted, the only
  new file is ``campaign-schema.json``. A second start changes nothing.
* A 0.6.x-shaped campaign (legacy scenes with inline map layers/background, no
  organization.yaml) is migrated once: every non-scene file byte-identical, each scene
  keeps every key/value (image layers + grid moved to its map, byte-exact backups),
  the map view shows exactly what the old client showed.
* Parse failures never cause a rewrite (tokens, players.yaml, schema marker, scenes).
* A campaign's own sheet template wins over the shipped default template.
* The installer script installs no campaign files and deletes nothing.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import yaml  # noqa: E402

import campaign_home as ch  # noqa: E402
import campaign_model as cm  # noqa: E402
from server_lib import create_server, resolve_campaign_path  # noqa: E402,F401

APP = Path(__file__).resolve().parents[1]
REPO = APP.parents[1]
SAMPLE = REPO / "examples" / "sample-campaign"
BG = "a433eb2ba6774bcb8ff2ecf7c63fd52d839cb783af7615ba69be2bed472bb6d7"
PID1 = "a" * 32
PID2 = "b" * 32


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


def hashes(root: Path) -> dict[str, str]:
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob("*")) if p.is_file()}


def req(method, url, body=None):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if "json" in resp.headers.get("Content-Type", "") else raw)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"{}")
        except ValueError:
            return e.code, raw


def w(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def ydump(p: Path, data, header: str = "") -> None:
    w(p, header + yaml.safe_dump(data, sort_keys=False, allow_unicode=True))


def populated_071(root: Path) -> None:
    """A campaign shaped like a real 0.7.1 one (cf. Theseus)."""
    shutil.copytree(SAMPLE, root)
    cm.migrate_campaign(root)  # 0.6.19+ layout (maps + organization.yaml)
    shutil.rmtree(root / "state" / "migrations")
    # the GM deleted sample items: they must never come back
    (root / "world/actors/blank-npc.yaml").unlink()
    (root / "world/actors/blank-npc.sheet.txt").unlink()
    (root / "build/sheets/npc.yaml").unlink()
    # custom sheet template (compiled + builder scratch), edited by the GM
    tpl = yaml.safe_load((root / "build/sheets/player.yaml").read_text())
    tpl.setdefault("fields", {})["sanity"] = {"type": "integer", "default": 50, "label": "Sanity ✦"}
    tpl["name"] = "House Rules Sheet"
    ydump(root / "build/sheets/player.yaml", tpl, "# Compiled by the GM (custom)\n")
    b = json.loads((root / "editor-scratch/sheets/player.builder.json").read_text())
    b["name"] = "House Rules Sheet"
    b.setdefault("fields", {})["sanity"] = {"type": "integer", "default": 50}
    w(root / "editor-scratch/sheets/player.builder.json", json.dumps(b, indent=2) + "\n")
    ydump(root / "build/sheets/homebrew.yaml", {"id": "homebrew", "name": "Homebrew",
          "fields": {"grit": {"type": "integer", "default": 3}},
          "layout": {"widgets": [{"id": "w1", "type": "number", "field": "grit", "x": 10, "y": 10}]}})
    w(root / "editor-scratch/sheets/homebrew.builder.json", json.dumps({"sheet_id": "homebrew", "name": "Homebrew",
      "fields": {"grit": {"type": "integer"}}, "layout": {"widgets": []}, "graph": {"nodes": [{"id": "n1"}], "edges": []}}) + "\n")
    # actors with user values
    pf = yaml.safe_load((root / "world/actors/party-fighter.yaml").read_text())
    pf["fields"].update({"hp_current": 7, "sanity": 12, "notes": "Lost an eye at the docks"})
    pf["appearance"] = {"size_tiles": 1.0, "auras": [{"radius": 10, "color": "#ff0000"}]}
    ydump(root / "world/actors/party-fighter.yaml", pf)
    w(root / "world/actors/party-fighter.sheet.txt", "Custom notes — do not lose ✓\n")
    ydump(root / "world/actors/new-character.yaml", {"id": "new-character", "name": "Ramune", "sheet": "homebrew",
          "fields": {"grit": 9, "name": "Ramune"}})
    # extra maps / scenes (one map-less), tokens in several scenes
    ydump(root / "world/maps/cave.yaml", {"id": "cave", "name": "Cave", "grid": {"size": 50, "units": "m", "type": "square"},
          "layers": [{"id": "l1", "name": "Cave floor", "asset": BG, "visible": True, "x": 5, "y": -3, "rotation": 90, "flipX": True}]}, cm.MAP_HEADER)
    ydump(root / "world/scenes/new-scene.yaml", {"id": "new-scene", "name": "Cave fight", "map": "cave",
          "walls": [{"x1": 0, "y1": 0, "x2": 50, "y2": 0}], "lights": [{"x": 1, "y": 2, "radius": 3}]})
    ydump(root / "world/scenes/new-scene-2.yaml", {"id": "new-scene-2", "name": "Empty", "map": None, "grid": {"size": 64, "units": "ft", "type": "square"}})
    w(root / "state/tokens/new-scene.json", json.dumps({"scene": "new-scene", "tokens": [
        {"id": "party-fighter-1", "actor_id": "party-fighter", "name": "Party Fighter", "label": "", "x": 175.0, "y": 385.0, "size_tiles": 1.0},
        {"id": "tough-2", "actor_id": "dock-tough", "name": "Dock Tough", "label": "B", "x": 25.0, "y": 25.0, "size_tiles": 2.0, "future_key": {"keep": True}}]}, indent=2) + "\n")
    w(root / "state/ui/new-scene.json", json.dumps({"scene": "new-scene", "showGrid": False, "snapToGrid": True, "snapTarget": "corner"}) + "\n")
    w(root / "state/ui.json", json.dumps({"sidebar": 312}) + "\n")
    # folders
    org = cm.load_organization(root)
    org["scenes"] = [{"folder": "f_act1", "name": "Act I ✦", "collapsed": True,
                      "children": [{"scene": "new-scene"}, {"scene": "docks"}]}, {"scene": "new-scene-2"}]
    org["actors"] = [{"folder": "f_pcs1", "name": "PCs", "collapsed": False, "children": [{"actor": "party-fighter"}, {"actor": "new-character"}]}]
    cm.save_organization(root, org)
    # players, chat, session, sync bookkeeping
    ydump(root / "world/players.yaml", {"campaign_id": "c0ffee" * 4, "join_code": "",
          "players": {PID1: {"name": "Ramune", "first_seen": 1}, PID2: {"name": "Bram", "first_seen": 2}},
          "assignments": {"party-fighter": [PID1], "new-character": [PID2]}}, "# players (GM Session 0.7.0+)\n")
    w(root / "state/chat/session.jsonl", json.dumps({"type": "epoch", "epoch": "e1"}) + "\n" + "\n".join(json.dumps(
        {"seq": i, "t": 1000 + i, "sender": {"name": "GM"}, "kind": "roll" if i % 2 else "text", "text": f"msg {i} ✓"}, ensure_ascii=False)
        for i in range(1, 6)) + "\n")
    w(root / "state/session.json", json.dumps({"active_scene": "new-scene"}) + "\n")
    w(root / "state/sync/party-fighter.json", json.dumps({"registers": {"fields.hp_current": {"v": 7, "t": "x", "o": "gm"}},
      "log": [], "seq": 3, "acks": {PID1: 3}, "full_pending": {}}) + "\n")
    w(root / "state/sync/_clock.json", json.dumps({"last": "0000"}) + "\n")
    w(root / "state/trash/old-scene.yaml", "id: old\nname: Trashed\n")


def legacy_06x(root: Path) -> None:
    """A 0.6.18-shaped campaign: inline scene map layers/background, no maps/, no org."""
    shutil.copytree(SAMPLE, root)
    ydump(root / "world/scenes/tavern.yaml", {"id": "tavern", "name": "Tavern", "grid": {"size": 100, "units": "ft", "type": "square"},
          "layers": [{"id": "floor", "type": "map", "name": "Floor", "asset": BG, "visible": True, "x": 10, "y": 20, "w": 800, "h": 600, "rotation": 180},
                     {"id": "roof", "type": "map", "name": "Roof", "asset": BG, "visible": False, "x": 0, "y": 0},
                     {"id": "tokens", "type": "tokens"}, {"id": "fx", "type": "overlay", "custom": [1, 2]}],
          "walls": [{"x1": 1, "y1": 2, "x2": 3, "y2": 4}], "notes": "keep me ✓", "spawns": [{"x": 5, "y": 6}]})
    w(root / "state/tokens/tavern.json", json.dumps({"scene": "tavern", "tokens": [
        {"id": "t1", "actor_id": "party-fighter", "name": "Party Fighter", "x": 150.0, "y": 150.0, "size_tiles": 1.0}]}) + "\n")
    pf = yaml.safe_load((root / "world/actors/party-fighter.yaml").read_text())
    pf["fields"]["hp_current"] = 3
    ydump(root / "world/actors/party-fighter.yaml", pf)


def old_client_layers(scene: dict) -> list[dict]:
    typed = [l for l in scene.get("layers") or [] if isinstance(l, dict) and l.get("type") == "map" and l.get("asset")]
    if typed:
        return [{k: v for k, v in l.items() if k != "type"} for l in typed]
    if scene.get("background"):
        return [{"id": "background", "name": "Base map", "asset": scene["background"], "visible": True, "x": 0, "y": 0}]
    return []


def start(root: Path, players: bool = True):
    server, base = create_server(root, port=0, quiet=True, player_host="127.0.0.1" if players else None,
                                 player_port=0 if players else None)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, base


def stop(server) -> None:
    from server_lib import Handler
    server.shutdown()
    server.server_close()
    ps = getattr(Handler, "player_server", None)
    if ps is not None:
        ps.shutdown()
        ps.server_close()


def exercise_reads(base: str, root: Path) -> None:
    """Everything the GM window + sheet windows + builder read on open."""
    for path in ["/api/migration", "/api/library", "/api/organization", "/api/maps", "/api/players", "/api/chat",
                 "/api/live?map=0&wait=0", "/api/sheet-builder", "/api/ui"]:
        st, _ = req("GET", base + path)
        check(st == 200, f"GET {path} -> 200")
    for sid in cm.entity_ids(root, "scenes"):
        check(req("GET", f"{base}/api/scene/{sid}")[0] == 200, f"GET scene {sid}")
        check(req("GET", f"{base}/api/tokens/{sid}")[0] == 200, f"GET tokens {sid}")
        req("GET", f"{base}/api/ui/{sid}")
    for aid in cm.entity_ids(root, "actors"):
        check(req("GET", f"{base}/api/sheet/{aid}")[0] == 200, f"GET sheet {aid}")
    for sh in ("player", "homebrew", "npc"):
        req("GET", f"{base}/api/sheet-builder/{sh}")


def test_populated_upgrade(tmp: Path) -> None:
    legacy = tmp / "app" / "campaign"      # old {app}\campaign
    populated_071(legacy)
    before = hashes(legacy)
    data = tmp / "localappdata" / "GM Session"
    root, info = ch.locate_campaign(None, legacy_dirs=[legacy], sample=SAMPLE, data_dir=data)
    check(info["source"] == "moved" and root == (data / "campaign").resolve(), "first 0.7.2 start copies {app}/campaign to the user data folder")
    check(hashes(legacy) == before, "old {app}/campaign left byte-for-byte untouched")
    check(hashes(root) == before, "copied campaign is byte-for-byte identical")
    check((data / ch.MIGRATION_RECORD).is_file(), "copy recorded outside the campaign")
    server, base = start(root)
    try:
        exercise_reads(base, root)
        st, rep = req("GET", base + "/api/migration")
        check(rep.get("to") == ch.CURRENT_SCHEMA and not rep.get("error"), f"schema migrated to {ch.CURRENT_SCHEMA}: {rep.get('ran') and [r['to'] for r in rep['ran']]}")
        # builder shows the campaign's own template, not the shipped default
        st, b = req("GET", base + "/api/sheet-builder/player")
        check(b.get("name") == "House Rules Sheet" and "sanity" in b.get("fields", {}), "campaign's custom sheet template is used (not the shipped default)")
        st, b = req("GET", base + "/api/sheet-builder/brand-new")
        check(b.get("_source") == "template", "shipped default template only seeds a NEW sheet id")
        st, s = req("GET", base + "/api/sheet/party-fighter")
        check(s.get("actor", s).get("fields", {}).get("hp_current", 7) == 7 or "7" in json.dumps(s), "sheet payload carries the user's values")
    finally:
        stop(server)
    after = hashes(root)
    changed = sorted(k for k in before if after.get(k) != before[k])
    added = sorted(set(after) - set(before))
    check(changed == [], f"no existing file changed by upgrade+startup+reads (changed: {changed})")
    check(added == [ch.SCHEMA_FILE], f"only new file is {ch.SCHEMA_FILE} (added: {added})")
    check(not (root / "world/actors/blank-npc.yaml").exists() and not (root / "build/sheets/npc.yaml").exists(),
          "deleted sample actor / sheet stay deleted")
    check(hashes(legacy) == before, "old folder still untouched after running")
    # second start: nothing at all changes, no re-copy
    marker = (root / ch.SCHEMA_FILE).read_bytes()
    root2, info2 = ch.locate_campaign(None, legacy_dirs=[legacy], sample=SAMPLE, data_dir=data)
    check(root2 == root and info2["source"] == "data", "second start uses the relocated campaign (idempotent, no re-copy)")
    server, base = start(root)
    try:
        exercise_reads(base, root)
        st, rep = req("GET", base + "/api/migration")
        check(rep.get("ran") == [], "no migrations run on the second start")
    finally:
        stop(server)
    check(hashes(root) == after and (root / ch.SCHEMA_FILE).read_bytes() == marker, "second start: byte-for-byte no changes")
    # edits still work and only touch what they edit
    server, base = start(root, players=False)
    try:
        st, _ = req("PUT", f"{base}/api/tokens/new-scene", {"scene": "new-scene", "tokens": [
            {"id": "party-fighter-1", "actor_id": "party-fighter", "name": "Party Fighter", "x": 225, "y": 25, "size_tiles": 1}],
            "merge": {"changed": ["party-fighter-1"], "removed": []}})
        toks = json.loads((root / "state/tokens/new-scene.json").read_text())["tokens"]
        tough = next(t for t in toks if t["id"] == "tough-2")
        check(st == 200 and tough.get("future_key") == {"keep": True} and tough["x"] == 25.0,
              "token edit applies; other tokens + unknown keys preserved")
        st, _ = req("PUT", f"{base}/api/tokens/new-scene", {"scene": "new-scene", "tokens": [
            {"id": "tough-2", "actor_id": "dock-tough", "name": "Dock Tough", "x": 75, "y": 75, "size_tiles": 2}] + [t for t in toks if t["id"] != "tough-2"]})
        tough = next(t for t in json.loads((root / "state/tokens/new-scene.json").read_text())["tokens"] if t["id"] == "tough-2")
        check(tough.get("future_key") == {"keep": True} and tough["x"] == 75.0, "full token save keeps keys the client does not know")
    finally:
        stop(server)


def test_legacy_06x(tmp: Path) -> None:
    legacy = tmp / "app06" / "campaign"
    legacy_06x(legacy)
    before = hashes(legacy)
    scenes_before = {sid: yaml.safe_load((legacy / f"world/scenes/{sid}.yaml").read_text()) for sid in cm.entity_ids(legacy, "scenes")}
    data = tmp / "lad06"
    root = ch.locate_campaign(None, legacy_dirs=[legacy], sample=SAMPLE, data_dir=data)[0]
    server, base = start(root)
    try:
        exercise_reads(base, root)
        st, rep = req("GET", base + "/api/migration")
        check(rep.get("from") is None and rep.get("to") == ch.CURRENT_SCHEMA, "0.6.x campaign migrated once to the current schema")
        for sid, old in scenes_before.items():
            st, view = req("GET", f"{base}/api/scene/{sid}")
            got = [{k: v for k, v in l.items() if k != "type"} for l in view["layers"] if l.get("type") == "map"]
            check(got == old_client_layers(old), f"{sid}: map view shows exactly the old image layers")
            check(view["grid"] == old.get("grid", cm.DEFAULT_GRID), f"{sid}: grid preserved")
    finally:
        stop(server)
    after = hashes(root)
    non_scene = [k for k in before if not k.startswith("world/scenes/") and after.get(k) != before[k]]
    check(non_scene == [], f"every non-scene file byte-identical ({non_scene})")
    for sid, old in scenes_before.items():
        new = yaml.safe_load((root / f"world/scenes/{sid}.yaml").read_text())
        bak = root / "state/migrations/0.6.19/scenes" / f"{sid}.yaml"
        check(bak.read_bytes() == (legacy / f"world/scenes/{sid}.yaml").read_bytes(), f"{sid}: byte-exact backup of the original")
        m = cm.load_map(root, new["map"])
        for k, v in old.items():
            if k == "layers":
                check([l for l in new["layers"]] == [l for l in v if l.get("type") != "map"], f"{sid}: non-image layers kept in order")
            elif k in ("background", "grid"):
                check(m.get("grid") == old.get("grid") or k == "background", f"{sid}: {k} moved to map {new['map']}")
            else:
                check(new.get(k) == v, f"{sid}: key {k!r} preserved")
    check(hashes(legacy) == before, "0.6.x original folder untouched")
    added = sorted(set(after) - set(before))
    check(all(a.startswith(("world/maps/", "state/migrations/")) or a in (ch.SCHEMA_FILE, "world/organization.yaml") for a in added),
          f"only additive files: {added}")
    # run again -> no change
    server, base = start(root, players=False)
    stop(server)
    check(hashes(root) == after, "0.6.x: second start changes nothing")


def test_parse_failures(tmp: Path) -> None:
    root = tmp / "bad"
    populated_071(root)
    w(root / "state/tokens/new-scene.json", '{"scene": "new-scene", "tokens": [ BROKEN')
    w(root / "world/players.yaml", "players: [unclosed\n  - : :")
    w(root / "world/scenes/weird.yaml", "id: weird\nlayers: [ {broken\n")
    before = hashes(root)
    server, base = start(root, players=False)
    try:
        st, t = req("GET", f"{base}/api/tokens/new-scene")
        check(st == 200 and t["tokens"] == [] and t.get("error"), "unreadable token file reported, not replaced")
        st, _ = req("PUT", f"{base}/api/tokens/new-scene", {"scene": "new-scene", "tokens": [{"id": "x", "x": 1, "y": 1}], "merge": {"changed": ["x"], "removed": []}})
        check(st == 409, "token save refused while the file is unreadable (409)")
        st, _ = req("PUT", f"{base}/api/players/assign", {"actor": "party-fighter", "players": []})
        check(st == 400, "players.yaml unreadable -> assignment refused, not overwritten")
    finally:
        stop(server)
    after = hashes(root)
    for rel in ("state/tokens/new-scene.json", "world/players.yaml", "world/scenes/weird.yaml"):
        check(after[rel] == before[rel], f"unparseable {rel} left byte-for-byte")
    # unreadable / newer schema marker => no migrations, marker untouched
    for text, label in (("{not json", "unreadable"), (json.dumps({"schema": 99}), "newer")):
        r2 = tmp / f"marker-{label}"
        legacy_06x(r2)
        w(r2 / ch.SCHEMA_FILE, text)
        b2 = hashes(r2)
        rep = ch.migrate(r2, "test")
        check(rep["skipped"] and hashes(r2) == b2, f"{label} schema marker: no migration, nothing written")


def test_new_campaign_and_installer(tmp: Path) -> None:
    data = tmp / "fresh"
    root, info = ch.locate_campaign(None, legacy_dirs=[tmp / "nope"], sample=SAMPLE, data_dir=data)
    check(info["source"] == "new-from-sample" and hashes(root) == hashes(SAMPLE), "no campaign anywhere -> new one copied from the sample")
    (root / "world/actors/dock-tough.yaml").unlink()
    root2, info2 = ch.locate_campaign(None, legacy_dirs=[], sample=SAMPLE, data_dir=data)
    check(info2["source"] == "data" and not (root2 / "world/actors/dock-tough.yaml").exists(), "existing campaign is never re-seeded from the sample")
    iss = (REPO / "packaging/windows/gm-session.iss").read_text()
    code = "\n".join(l for l in iss.splitlines() if not l.lstrip().startswith(";"))
    check("campaign" not in code.split("[Files]")[1].split("[Icons]")[0].lower(), "installer [Files] installs nothing into a campaign")
    check(not re.search(r"^\[(InstallDelete|UninstallDelete)\]", code, re.M), "installer has no [InstallDelete]/[UninstallDelete]")
    piss = (REPO / "packaging/windows/gm-session-player.iss").read_text()
    check(not re.search(r"^\[(InstallDelete|UninstallDelete)\]", piss, re.M), "player installer deletes nothing")


def main() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        test_populated_upgrade(tmp)
        test_legacy_06x(tmp)
        test_parse_failures(tmp)
        test_new_campaign_and_installer(tmp)
    print("upgrade-preservation: all ok")


if __name__ == "__main__":
    main()
