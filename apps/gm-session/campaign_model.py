"""Campaign data model for GM Session 0.6.19+: maps as first-class entities,
scenes that reference a map, and the sidebar organization tree.

Model
-----
* Map    ``world/maps/<id>.yaml``   reusable image stack + grid:
         ``{id, name, grid: {size, units, type}, layers: [{id, name, asset, visible,
         x, y, w?, h?, flipX?, flipY?, rotation?}]}``
* Scene  ``world/scenes/<id>.yaml`` references a map (``map: <id>`` or ``map: null``)
         and keeps walls/doors/lights/spawns + non-image layers; tokens stay in
         ``state/tokens/<scene>.json``. A scene without a map keeps its own ``grid``.
* Organization ``world/organization.yaml``: per panel (maps / actors / scenes) an
         ordered tree of folders (name, collapsed, children) and item references.
         GM-side sorting only; no player-visibility data yet.

Legacy scenes (map layers / ``background`` inline, no ``map:`` key) are migrated at
load by :func:`migrate_campaign`: idempotent, writes a backup of every scene it
rewrites under ``state/migrations/0.6.19/``, never deletes files.
"""

from __future__ import annotations

import re
import secrets
import shutil
from pathlib import Path

import yaml

PANELS = ("maps", "actors", "scenes")
ITEM_KEY = {"maps": "map", "actors": "actor", "scenes": "scene"}
FOLDER_ID_RE = re.compile(r"^f_[a-z0-9]{4,32}$")
ENTITY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
MAX_DEPTH = 16
MAX_NAME = 120
MIGRATION_TAG = "0.6.19"
MAP_HEADER = "# Map: reusable image layers + grid (GM Session 0.6.19+). Scenes reference it by id.\n"
DEFAULT_GRID = {"size": 70, "units": "ft", "type": "square"}


class OrgError(ValueError):
    """Validation error at the API boundary (→ HTTP 400)."""


# --------------------------------------------------------------------------- io

def _load_yaml(path: Path):
    """Parsed YAML, or None if missing/unreadable/invalid (callers treat as absent)."""
    if not path.is_file():
        return None
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except (yaml.YAMLError, OSError, UnicodeDecodeError):
        return None


def _dump_yaml(path: Path, data, header: str | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = yaml.safe_dump(data, sort_keys=False, default_flow_style=False, allow_unicode=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text((header or "") + text, encoding="utf-8")
    tmp.replace(path)


def clean_name(value, fallback: str = "") -> str:
    s = "" if value is None else str(value)
    s = re.sub(r"[\x00-\x1f\x7f]", " ", s).strip()
    s = re.sub(r"\s+", " ", s)
    if len(s) > MAX_NAME:
        s = s[:MAX_NAME].rstrip()
    return s or fallback


def slugify(name: str, fallback: str = "item") -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", str(name or "").strip().lower()).strip("-")
    s = s[:48].strip("-")
    return s or fallback


def unique_id(base: str, exists) -> str:
    base = slugify(base)
    if not exists(base):
        return base
    n = 2
    while exists(f"{base}-{n}"):
        n += 1
    return f"{base}-{n}"


def new_folder_id() -> str:
    return "f_" + secrets.token_hex(5)


# ---------------------------------------------------------------- entity lists

def maps_dir(root: Path) -> Path:
    return root / "world" / "maps"


def scenes_dir(root: Path) -> Path:
    return root / "world" / "scenes"


def actors_dir(root: Path) -> Path:
    return root / "world" / "actors"


def map_path(root: Path, map_id: str) -> Path:
    return maps_dir(root) / f"{map_id}.yaml"


def scene_path(root: Path, scene_id: str) -> Path:
    return scenes_dir(root) / f"{scene_id}.yaml"


def actor_path(root: Path, actor_id: str) -> Path:
    return actors_dir(root) / f"{actor_id}.yaml"


def entity_ids(root: Path, panel: str) -> list[str]:
    d = {"maps": maps_dir, "actors": actors_dir, "scenes": scenes_dir}[panel](root)
    if not d.is_dir():
        return []
    return [p.stem for p in sorted(d.glob("*.yaml"))]


def load_map(root: Path, map_id) -> dict | None:
    if not map_id or not isinstance(map_id, str) or not ENTITY_ID_RE.match(map_id):
        return None
    data = _load_yaml(map_path(root, map_id))
    return data if isinstance(data, dict) else None


# ------------------------------------------------------------------- migration

def legacy_map_layers(scene: dict) -> list[dict]:
    """Map image layers exactly as the pre-0.6.19 client resolved them
    (typed ``map`` layers with an asset, else legacy ``background``)."""
    layers = scene.get("layers") if isinstance(scene.get("layers"), list) else []
    out = []
    for i, layer in enumerate(layers):
        if not isinstance(layer, dict) or layer.get("type") != "map" or not layer.get("asset"):
            continue
        entry = {k: v for k, v in layer.items() if k != "type"}
        entry.setdefault("id", f"map-{i}")
        out.append(entry)
    if out:
        return out
    if scene.get("background"):
        return [
            {
                "id": "background",
                "name": "Base map",
                "asset": str(scene["background"]),
                "visible": True,
                "x": 0,
                "y": 0,
            }
        ]
    return []


def migrate_scene(root: Path, scene_id: str) -> dict | None:
    """Split one legacy scene into scene + map. Returns a report entry or None if
    nothing to do (already migrated)."""
    path = scene_path(root, scene_id)
    scene = _load_yaml(path)
    if not isinstance(scene, dict) or "map" in scene:
        return None
    map_layers = legacy_map_layers(scene)
    backup = root / "state" / "migrations" / MIGRATION_TAG / "scenes" / f"{scene_id}.yaml"
    if not backup.exists():
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, backup)

    map_id = None
    if map_layers:
        # Reuse a map from an interrupted earlier run; otherwise pick a free id.
        existing = load_map(root, scene_id)
        if existing is not None and existing.get("migrated_from_scene") == scene_id:
            map_id = scene_id
        else:
            map_id = unique_id(scene_id, lambda i: map_path(root, i).exists())
            grid = scene.get("grid") if isinstance(scene.get("grid"), dict) else dict(DEFAULT_GRID)
            _dump_yaml(
                map_path(root, map_id),
                {
                    "id": map_id,
                    "name": clean_name(scene.get("name"), scene_id),
                    "grid": grid,
                    "layers": map_layers,
                    "migrated_from_scene": scene_id,
                },
                header=MAP_HEADER,
            )
    new_scene = {}
    for k, v in scene.items():
        if map_id and k in ("background", "grid"):
            continue  # moved into the map (kept in the backup copy)
        if k == "layers" and isinstance(v, list):
            v = [l for l in v if not (isinstance(l, dict) and l.get("type") == "map")]
        new_scene[k] = v
        if k == "name":
            new_scene["map"] = map_id
    new_scene.setdefault("map", map_id)
    _dump_yaml(path, new_scene)
    return {"scene": scene_id, "map": map_id, "layers": len(map_layers), "backup": str(backup)}


def migrate_campaign(root: Path) -> dict:
    """Idempotent load-time migration. Safe to call on every start."""
    report = {"scenes": [], "organization_created": False}
    for sid in entity_ids(root, "scenes"):
        try:
            entry = migrate_scene(root, sid)
        except Exception as exc:  # noqa: BLE001 - never block app start
            report["scenes"].append({"scene": sid, "error": str(exc)})
            continue
        if entry:
            report["scenes"].append(entry)
    try:
        if not org_path(root).is_file():
            save_organization(root, load_organization(root))
            report["organization_created"] = True
    except Exception as exc:  # noqa: BLE001
        report["organization_error"] = str(exc)
    return report


# ---------------------------------------------------------------- scene views

def resolve_scene(root: Path, scene: dict) -> dict:
    """Scene as the map view consumes it: grid + typed map layers come from the
    referenced map; legacy (unmigrated) scenes pass through unchanged."""
    if not isinstance(scene, dict) or "map" not in scene:
        return scene
    out = {k: v for k, v in scene.items() if k != "background"}
    non_map = [l for l in (scene.get("layers") or []) if isinstance(l, dict) and l.get("type") != "map"]
    m = load_map(root, scene.get("map"))
    if m is not None:
        grid = m.get("grid") if isinstance(m.get("grid"), dict) else None
        out["grid"] = grid or scene.get("grid") or dict(DEFAULT_GRID)
        layers = [{**l, "type": "map"} for l in (m.get("layers") or []) if isinstance(l, dict)]
        out["layers"] = layers + non_map
        out["map_info"] = {"id": m.get("id") or scene.get("map"), "name": m.get("name") or scene.get("map")}
    else:
        out["grid"] = scene.get("grid") or dict(DEFAULT_GRID)
        out["layers"] = non_map
        out["map_info"] = None
    return out


def write_scene_layers(root: Path, scene_id: str, cleaned: list[dict]) -> list[dict]:
    """Persist layers from the map view: image layers → the scene's map, others →
    scene. Creates a map for a map-less scene on first image layer."""
    path = scene_path(root, scene_id)
    if isinstance(_load_yaml(path), dict) and "map" not in _load_yaml(path):
        migrate_scene(root, scene_id)
    scene = _load_yaml(path) or {}
    map_layers = [{k: v for k, v in l.items() if k != "type"} for l in cleaned if l.get("type") == "map"]
    other = [l for l in cleaned if l.get("type") != "map"]
    map_id = scene.get("map")
    m = load_map(root, map_id) if map_id else None
    if m is None and map_layers:
        map_id = unique_id(scene_id, lambda i: map_path(root, i).exists())
        m = {
            "id": map_id,
            "name": clean_name(scene.get("name"), scene_id),
            "grid": scene.get("grid") if isinstance(scene.get("grid"), dict) else dict(DEFAULT_GRID),
            "layers": [],
        }
        scene["map"] = map_id
        scene.pop("grid", None)
        _dump_yaml(map_path(root, map_id), m, header=MAP_HEADER)
        add_to_organization(root, "maps", map_id)
    if m is not None:
        m["layers"] = map_layers
        _dump_yaml(map_path(root, map_id), m, header=MAP_HEADER)
    scene["layers"] = other
    _dump_yaml(path, scene)
    return resolve_scene(root, scene)["layers"]


def maps_summary(root: Path) -> list[dict]:
    used: dict[str, list[str]] = {}
    for sid in entity_ids(root, "scenes"):
        s = _load_yaml(scene_path(root, sid))
        if isinstance(s, dict) and s.get("map"):
            used.setdefault(str(s["map"]), []).append(sid)
    out = []
    for mid in entity_ids(root, "maps"):
        m = _load_yaml(map_path(root, mid))
        if not isinstance(m, dict):
            continue
        layers = [l for l in (m.get("layers") or []) if isinstance(l, dict)]
        thumb = next((l.get("asset") for l in layers if l.get("asset") and l.get("visible", True)), None)
        out.append(
            {
                "id": mid,
                "name": m.get("name") or mid,
                "grid": m.get("grid") or dict(DEFAULT_GRID),
                "layer_count": len(layers),
                "thumb": thumb,
                "used_by": used.get(mid, []),
            }
        )
    return out


def entity_name(root: Path, panel: str, eid: str) -> str:
    p = {"maps": map_path, "actors": actor_path, "scenes": scene_path}[panel](root, eid)
    d = _load_yaml(p)
    if isinstance(d, dict) and d.get("name"):
        return str(d["name"])
    return eid


# ------------------------------------------------------------- organization

def org_path(root: Path) -> Path:
    return root / "world" / "organization.yaml"


def _iter_nodes(tree):
    for n in tree:
        yield n
        if "folder" in n:
            yield from _iter_nodes(n.get("children") or [])


def _normalize_tree(panel: str, tree, known: set[str], *, strict: bool) -> list:
    """Validate/normalize one panel tree. strict → raise OrgError on malformed
    input (API boundary); non-strict → drop bad nodes (reading files)."""
    key = ITEM_KEY[panel]
    seen_items: set[str] = set()
    seen_folders: set[str] = set()

    def fail(msg):
        if strict:
            raise OrgError(msg)

    def walk(nodes, depth):
        if not isinstance(nodes, list):
            fail("tree/children must be a list")
            return []
        if depth > MAX_DEPTH:
            fail(f"folders nested deeper than {MAX_DEPTH}")
            return []
        out = []
        for n in nodes:
            if not isinstance(n, dict):
                fail("each node must be an object")
                continue
            if "folder" in n:
                fid = n.get("folder")
                if not isinstance(fid, str) or not FOLDER_ID_RE.match(fid):
                    fail(f"invalid folder id: {fid!r}")
                    continue
                if fid in seen_folders:
                    fail(f"duplicate folder id: {fid}")
                    continue
                seen_folders.add(fid)
                name = clean_name(n.get("name"))
                if not name:
                    fail(f"folder {fid} needs a name")
                    name = "Folder"
                col = n.get("collapsed", False)
                if not isinstance(col, bool):
                    fail(f"folder {fid}: collapsed must be true/false")
                    col = False
                out.append(
                    {
                        "folder": fid,
                        "name": name,
                        "collapsed": col,
                        "children": walk(n.get("children") or [], depth + 1),
                    }
                )
            elif key in n:
                eid = n.get(key)
                if not isinstance(eid, str) or not ENTITY_ID_RE.match(eid):
                    fail(f"invalid {key} id: {eid!r}")
                    continue
                if eid in seen_items:
                    fail(f"duplicate {key}: {eid}")
                    continue
                if eid not in known:
                    continue  # entity no longer exists → drop the reference
                seen_items.add(eid)
                out.append({key: eid})
            else:
                fail(f"node in {panel} must be a folder or a {key}")
        return out

    return walk(tree, 0)


def reconcile(panel: str, tree: list, known_ordered: list[str]) -> list:
    """Append entities missing from the tree at root so no item is ever lost."""
    key = ITEM_KEY[panel]
    present = {n[key] for n in _iter_nodes(tree) if key in n}
    for eid in known_ordered:
        if eid not in present:
            tree.append({key: eid})
    return tree


def load_organization(root: Path) -> dict:
    raw = _load_yaml(org_path(root))
    raw = raw if isinstance(raw, dict) else {}
    out = {"version": 1}
    for panel in PANELS:
        known = entity_ids(root, panel)
        tree = _normalize_tree(panel, raw.get(panel) or [], set(known), strict=False)
        out[panel] = reconcile(panel, tree, known)
    return out


ORG_HEADER = (
    "# GM Session organization (0.6.19+): sidebar folders and order (GM view only).\n"
    "# Panels: maps / actors / scenes. Nodes are folders {folder, name, collapsed,\n"
    "# children} or items {map|actor|scene: <id>}. Items missing here are listed at\n"
    "# the end of their panel; deleting this file just resets the sorting.\n"
)


def save_organization(root: Path, org: dict) -> None:
    p = org_path(root)
    if p.is_file() and not isinstance(_load_yaml(p), dict):
        # never silently overwrite a hand-edited file we could not parse
        import time

        shutil.copy2(p, p.with_name(f"organization.unreadable-{time.strftime('%Y%m%d-%H%M%S')}.yaml"))
    data = {"version": 1}
    for panel in PANELS:
        data[panel] = org.get(panel) or []
    _dump_yaml(org_path(root), data, header=ORG_HEADER)


def set_panel_tree(root: Path, panel: str, tree) -> list:
    """API boundary: validate strictly, reconcile, persist. Raises OrgError."""
    if panel not in PANELS:
        raise OrgError(f"unknown panel: {panel}")
    known = entity_ids(root, panel)
    org = load_organization(root)
    clean = _normalize_tree(panel, tree, set(known), strict=True)
    org[panel] = reconcile(panel, clean, known)
    save_organization(root, org)
    return org[panel]


def add_to_organization(root: Path, panel: str, eid: str, folder: str | None = None) -> None:
    org = load_organization(root)
    key = ITEM_KEY[panel]
    # load_organization already appended it at root → move it to the target
    tree = _remove_item(org[panel], key, eid)
    node = {key: eid}
    target = _find_folder(tree, folder) if folder else None
    (target["children"] if target else tree).append(node)
    org[panel] = tree
    save_organization(root, org)


def _remove_item(tree, key, eid):
    out = []
    for n in tree:
        if n.get(key) == eid:
            continue
        if "folder" in n:
            n = {**n, "children": _remove_item(n.get("children") or [], key, eid)}
        out.append(n)
    return out


def _find_folder(tree, fid):
    for n in _iter_nodes(tree):
        if n.get("folder") == fid:
            return n
    return None


def rename_folder(root: Path, panel: str, fid: str, name: str) -> str:
    if panel not in PANELS:
        raise OrgError(f"unknown panel: {panel}")
    name = clean_name(name)
    if not name:
        raise OrgError("name required")
    org = load_organization(root)
    f = _find_folder(org[panel], fid)
    if f is None:
        raise OrgError(f"folder not found: {fid}")
    f["name"] = name
    save_organization(root, org)
    return name


# ------------------------------------------------------------ create / rename

def initials(name: str) -> str:
    parts = [p for p in str(name or "").strip().split() if p]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def create_actor(root: Path, name: str, folder: str | None = None) -> dict:
    name = clean_name(name)
    if not name:
        raise OrgError("name required")
    aid = unique_id(name, lambda i: actor_path(root, i).exists())
    sheets = root / "build" / "sheets"
    sheet = "player" if (sheets / "player.yaml").is_file() else None
    doc = {"id": aid, "name": name}
    if sheet:
        doc["sheet"] = sheet
    doc["sheet_doc"] = f"world/actors/{aid}.sheet.txt"
    doc["fields"] = {"name": name}
    doc["appearance"] = {"size_tiles": 1.0}
    _dump_yaml(actor_path(root, aid), doc)
    add_to_organization(root, "actors", aid, folder)
    return doc


def create_scene(root: Path, name: str, map_id: str | None = None, folder: str | None = None) -> dict:
    name = clean_name(name)
    if not name:
        raise OrgError("name required")
    if map_id is not None and load_map(root, map_id) is None:
        raise OrgError(f"map not found: {map_id}")
    sid = unique_id(name, lambda i: scene_path(root, i).exists())
    doc = {"id": sid, "name": name, "map": map_id}
    if map_id is None:
        doc["grid"] = dict(DEFAULT_GRID)
    doc.update({"layers": [{"id": "tokens", "type": "tokens"}], "walls": [], "doors": [],
                "lights": [], "spawns": [], "tokens": []})
    _dump_yaml(scene_path(root, sid), doc)
    add_to_organization(root, "scenes", sid, folder)
    return doc


def create_map(root: Path, name: str, layers, grid=None, folder: str | None = None) -> dict:
    name = clean_name(name)
    if not name:
        raise OrgError("name required")
    if not isinstance(layers, list):
        raise OrgError("layers must be a list")
    clean_layers = []
    ids = set()
    for i, l in enumerate(layers):
        if not isinstance(l, dict):
            raise OrgError("each layer must be an object")
        asset = str(l.get("asset") or "")
        if not re.fullmatch(r"[0-9a-fA-F]{64}", asset):
            raise OrgError(f"invalid asset hash: {asset}")
        lid = str(l.get("id") or f"layer-{i}")
        if not ENTITY_ID_RE.match(lid) or lid in ids:
            raise OrgError(f"invalid/duplicate layer id: {lid}")
        ids.add(lid)
        entry = {"id": lid, "name": clean_name(l.get("name"), lid), "asset": asset.lower(),
                 "visible": l.get("visible", True) is not False}
        for k in ("x", "y", "w", "h"):
            if l.get(k) is not None:
                try:
                    entry[k] = float(l[k])
                except (TypeError, ValueError) as exc:
                    raise OrgError(f"layer.{k} must be a number") from exc
        clean_layers.append(entry)
    g = dict(DEFAULT_GRID)
    if isinstance(grid, dict):
        try:
            size = float(grid.get("size", g["size"]))
        except (TypeError, ValueError) as exc:
            raise OrgError("grid.size must be a number") from exc
        if not (4 <= size <= 1000):
            raise OrgError("grid.size out of range")
        g["size"] = int(size) if size.is_integer() else size
    mid = unique_id(name, lambda i: map_path(root, i).exists())
    doc = {"id": mid, "name": name, "grid": g, "layers": clean_layers}
    _dump_yaml(map_path(root, mid), doc, header=MAP_HEADER)
    add_to_organization(root, "maps", mid, folder)
    return doc


def set_scene_map(root: Path, scene_id: str, map_id) -> dict:
    path = scene_path(root, scene_id)
    scene = _load_yaml(path)
    if not isinstance(scene, dict):
        raise OrgError(f"scene not found: {scene_id}")
    if "map" not in scene:
        migrate_scene(root, scene_id)
        scene = _load_yaml(path)
    if map_id is not None and load_map(root, map_id) is None:
        raise OrgError(f"map not found: {map_id}")
    old = load_map(root, scene.get("map"))
    if map_id is None and old is not None and "grid" not in scene:
        scene["grid"] = old.get("grid") or dict(DEFAULT_GRID)
    scene["map"] = map_id
    _dump_yaml(path, scene)
    return scene


def rename_entity(root: Path, panel: str, eid: str, name: str) -> dict:
    """Rename display name only (ids never change). Actors also update tokens
    whose name/label were derived from the old actor name, and fields.name."""
    if panel not in PANELS:
        raise OrgError(f"unknown panel: {panel}")
    if not isinstance(eid, str) or not ENTITY_ID_RE.match(eid):
        raise OrgError("invalid id")
    name = clean_name(name)
    if not name:
        raise OrgError("name required")
    p = {"maps": map_path, "actors": actor_path, "scenes": scene_path}[panel](root, eid)
    doc = _load_yaml(p)
    if not isinstance(doc, dict):
        raise OrgError(f"not found: {eid}")
    old = str(doc.get("name") or eid)
    doc["name"] = name
    result = {"ok": True, "panel": panel, "id": eid, "name": name, "old_name": old, "tokens_updated": 0}
    if panel == "actors":
        fields = doc.get("fields")
        if isinstance(fields, dict) and fields.get("name") in (old, None, ""):
            fields["name"] = name
        tok_dir = root / "state" / "tokens"
        import json

        if tok_dir.is_dir():
            for tp in sorted(tok_dir.glob("*.json")):
                try:
                    data = json.loads(tp.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    continue
                if not isinstance(data, dict) or not isinstance(data.get("tokens"), list):
                    continue
                changed = 0
                for t in data["tokens"]:
                    if not isinstance(t, dict) or t.get("actor_id") != eid:
                        continue
                    touched = False
                    if t.get("name") in (old, None, ""):
                        t["name"] = name
                        touched = True
                    if t.get("label") in (initials(old), None, ""):
                        t["label"] = initials(name)
                        touched = True
                    changed += touched
                if changed:
                    tp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
                    result["tokens_updated"] += changed
    _dump_yaml(p, doc)
    return result
