#!/usr/bin/env python3
"""0.6.18 HTTP-level: token image + crop / auras persistence, old-save compat,
new JS served, default player-sheet template for NEW sheets (existing untouched)."""
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
PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360f8cf0000000301010018dd8db40000000049454e44ae426082"
)


def req(method, url, body=None, raw=None, headers=None):
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
    r = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r) as resp:
            payload = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            return resp.status, (json.loads(payload.decode()) if "json" in ctype else payload)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def main() -> None:
    sample = APP.parents[1] / "examples" / "sample-campaign"
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "camp"
        shutil.copytree(sample, root, symlinks=True)
        actor_path = root / "world" / "actors" / "party-fighter.yaml"
        old_actor_text = actor_path.read_text(encoding="utf-8")
        sheets_before = {
            p.name: p.read_bytes()
            for p in list((root / "build" / "sheets").glob("*.yaml"))
            + list((root / "editor-scratch" / "sheets").glob("*.json"))
        }

        server, base = create_server(root, host="127.0.0.1", port=0, quiet=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            # New JS served
            for f in ("image-xform.js", "token-auras.js"):
                st, body = req("GET", f"{base}/{f}")
                assert st == 200 and body == (APP / f).read_bytes(), f

            # Old save (no image/auras) loads unchanged
            st, lib = req("GET", f"{base}/api/library")
            fighter = next(a for a in lib["actors"] if a["id"] == "party-fighter")
            assert "image" not in fighter["appearance"] and "auras" not in fighter["appearance"], fighter
            assert fighter["aura_fields"] == {"AURA1_RADIUS": 0.0, "AURA2_RADIUS": 0.0, "AURA3_RADIUS": 0.0}
            st, sheet = req("GET", f"{base}/api/sheet/party-fighter")
            assert st == 200 and "image" not in sheet["appearance"]
            old_tokens = [{"id": "t1", "actor_id": "party-fighter", "name": "Fighter", "label": "FI",
                           "x": 105.0, "y": 105.0, "size_tiles": 1.0}]
            (root / "state/tokens/docks.json").write_text(json.dumps({"scene": "docks", "tokens": old_tokens}))
            st, toks = req("GET", f"{base}/api/tokens/docks")
            assert st == 200 and toks["tokens"] == old_tokens, toks
            st, _ = req("PUT", f"{base}/api/tokens/docks", {"tokens": toks["tokens"]})
            assert st == 200
            assert json.loads((root / "state/tokens/docks.json").read_text())["tokens"] == old_tokens
            assert actor_path.read_text(encoding="utf-8") == old_actor_text, "reads must not rewrite actor"

            # Import image → copied into campaign assets (by-hash), not linked
            st, asset = req(
                "POST", f"{base}/api/assets", raw=PNG_1PX,
                headers={"Content-Type": "image/png", "X-Asset-Name": "tokens/party-fighter/me.png"},
            )
            assert st == 200 and asset["hash"] == hashlib.sha256(PNG_1PX).hexdigest()
            stored = root / "world" / "assets" / "by-hash" / asset["hash"]
            assert stored.read_bytes() == PNG_1PX

            crop = {"x": -0.25, "y": 0.1, "w": 1.5, "h": 1.5, "flipX": True, "flipY": False, "rotation": 450}
            st, out = req("PUT", f"{base}/api/actor/party-fighter/appearance",
                          {"appearance": {"image": {"asset": asset["hash"], "name": "me.png", "crop": crop}}})
            assert st == 200, out
            img = out["appearance"]["image"]
            assert img["crop"]["rotation"] == 90 and img["crop"]["flipX"] is True and img["crop"]["x"] == -0.25
            assert out["appearance"]["size_tiles"] == 1.0

            # Auras: max 3 enforced server-side, sanitized
            five = [{"slot": i, "color": "#FF0000", "opacity": 2, "enabled": True} for i in range(1, 6)]
            st, out = req("PUT", f"{base}/api/actor/party-fighter/appearance", {"appearance": {"auras": five}})
            auras = out["appearance"]["auras"]
            assert len(auras) == 3 and [a["slot"] for a in auras] == [1, 2, 3], auras
            assert all(a["opacity"] == 1.0 and a["color"] == "#ff0000" for a in auras)
            assert out["appearance"]["image"]["asset"] == asset["hash"], "partial PUT keeps image"

            # Persisted in actor YAML; library exposes image/auras + field values
            y = yaml.safe_load(actor_path.read_text(encoding="utf-8"))
            assert y["appearance"]["image"]["crop"]["w"] == 1.5 and len(y["appearance"]["auras"]) == 3
            st, _ = req("PUT", f"{base}/api/actor/party-fighter/fields", {"fields": {"AURA1_RADIUS": 2}})
            st, lib = req("GET", f"{base}/api/library")
            fighter = next(a for a in lib["actors"] if a["id"] == "party-fighter")
            assert fighter["appearance"]["image"]["asset"] == asset["hash"]
            assert fighter["aura_fields"]["AURA1_RADIUS"] == 2.0

            # Size save keeps image/auras; Remove image (null) deletes only image
            st, out = req("PUT", f"{base}/api/actor/party-fighter/appearance", {"appearance": {"size_tiles": 2}})
            assert out["appearance"]["image"] and len(out["appearance"]["auras"]) == 3
            st, out = req("PUT", f"{base}/api/actor/party-fighter/appearance", {"appearance": {"image": None}})
            assert "image" not in out["appearance"] and len(out["appearance"]["auras"]) == 3
            assert out["appearance"]["size_tiles"] == 2.0
            st, out = req("PUT", f"{base}/api/actor/party-fighter/appearance",
                          {"appearance": {"image": {"asset": "../etc/passwd", "crop": crop}}})
            assert st == 400

            # --- Default template: NEW sheet id gets template content ---
            tpl = json.loads((APP / "defaults" / "player-sheet.builder.json").read_text(encoding="utf-8"))
            st, doc = req("GET", f"{base}/api/sheet-builder/wizard")
            assert st == 200 and doc["_source"] == "template", doc.get("_source")
            assert doc["sheet_id"] == "wizard" and doc["name"] == "wizard"
            assert doc["fields"] == tpl["fields"]
            assert doc["layout"]["widgets"] == tpl["layout"]["widgets"]
            assert doc["graph"]["nodes"] == tpl["graph"]["nodes"]
            assert doc["graph"]["edges"] == tpl["graph"]["edges"]
            assert doc["graph"]["collapsed"] == tpl["graph"].get("collapsed", [])
            assert not (root / "build" / "sheets" / "wizard.yaml").exists(), "GET must not create files"

            # Existing sheets load as before (not replaced by template)
            st, doc = req("GET", f"{base}/api/sheet-builder/npc")
            assert doc["_source"] in ("yaml", "scratch") and doc["fields"] != tpl["fields"]
            st, doc = req("GET", f"{base}/api/sheet-builder/player")
            assert doc["_source"] == "scratch"
            sample_player = json.loads((sample / "editor-scratch/sheets/player.builder.json").read_text())
            assert doc["fields"] == sample_player["fields"], "existing player sheet untouched"

            # Compiling the new template-based sheet works and leaves others alone
            st, doc = req("GET", f"{base}/api/sheet-builder/wizard")
            doc.pop("_source", None)
            doc.pop("_template", None)
            st, out = req("POST", f"{base}/api/sheet-builder/wizard/compile", doc)
            assert st == 200, out
            compiled = yaml.safe_load((root / "build/sheets/wizard.yaml").read_text(encoding="utf-8"))
            assert set(compiled["fields"]) == set(tpl["fields"]) and compiled["id"] == "wizard"
            for name, data in sheets_before.items():
                p = (root / "build/sheets" / name) if name.endswith(".yaml") else (root / "editor-scratch/sheets" / name)
                assert p.read_bytes() == data, f"existing sheet changed: {name}"
            st, doc = req("GET", f"{base}/api/sheet-builder/wizard")
            assert doc["_source"] == "scratch", "after compile the sheet is no longer new"
        finally:
            server.shutdown()

    # Missing template → legacy empty doc (fallback)
    import server_lib
    orig = server_lib.DEFAULT_SHEET_TEMPLATE
    server_lib.DEFAULT_SHEET_TEMPLATE = "does-not-exist"
    try:
        assert server_lib.load_default_sheet_template("x", APP) is None
    finally:
        server_lib.DEFAULT_SHEET_TEMPLATE = orig
    # Bundled snapshot is a byte-identical file in the repo defaults dir
    assert (APP / "defaults" / "player-sheet.yaml").is_file()
    print("token-appearance-api: ok")


if __name__ == "__main__":
    main()
