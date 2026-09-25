"""Shared HTTP server for GM Session (CLI serve.py and desktop_app.py)."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import re
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import campaign_model as cm
import clipboard_os  # noqa: E402
import player_host as ph
import sync_core as sc

try:
    import yaml
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "PyYAML is required. Install with: pip install -r "
        "packages/campaign-format/requirements.txt"
    ) from exc


SAFE_ID = re.compile(r"^[A-Za-z0-9_./-]+$")


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"))


def resource_root() -> Path:
    """Directory containing bundled app assets (UI + optional sample campaign)."""
    if is_frozen():
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent


def default_app_dir() -> Path:
    """Directory with index.html / session.js."""
    root = resource_root()
    if is_frozen():
        bundled = root / "gm-session"
        if bundled.is_dir():
            return bundled
    return Path(__file__).resolve().parent


def exe_dir() -> Path:
    """Directory containing the frozen executable (or this package when not frozen)."""
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def bundled_sample_campaign() -> Path:
    root = resource_root()
    if is_frozen():
        return (root / "sample-campaign").resolve()
    return (
        Path(__file__).resolve().parent.parent.parent / "examples" / "sample-campaign"
    ).resolve()


def resolve_campaign_path(explicit: Path | None = None) -> Path:
    """
    Prefer user-editable campaign/ beside the exe (install layout),
    then an explicit path, then the bundled sample.
    """
    if explicit is not None:
        return explicit.resolve()

    beside = exe_dir() / "campaign"
    if (beside / "world" / "scenes").is_dir():
        return beside.resolve()

    sample = bundled_sample_campaign()
    if (sample / "world" / "scenes").is_dir():
        return sample

    raise FileNotFoundError(
        "No campaign found. Expected campaign/ next to the app "
        f"({beside}) or a bundled sample at {sample}."
    )


def _safe_segment(value: str) -> bool:
    return bool(value) and "/" not in value and ".." not in value and "\\" not in value


SAFE_MECHANIC_NAME = re.compile(r"^[A-Za-z0-9_-]+$")


def safe_mechanic_name(value: str) -> bool:
    """Filename-safe mechanic id (same rules as sheet ids: A-Za-z0-9_-)."""
    return bool(value) and bool(SAFE_MECHANIC_NAME.fullmatch(value))


def fresh_uid(prefix: str = "n") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def deep_copy_json(obj):
    return json.loads(json.dumps(obj))


def remap_mechanic_subgraph(nodes, edges, collapsed=None):
    """
    Deep-copy nodes/edges/(optional collapsed) with fresh ids.
    Entry node ``name`` is preserved. Returns (nodes, edges, collapsed, id_map).
    """
    nodes = deep_copy_json(nodes or [])
    edges = deep_copy_json(edges or [])
    collapsed = deep_copy_json(collapsed or []) if collapsed is not None else []
    id_map: dict[str, str] = {}
    for n in nodes:
        if not isinstance(n, dict):
            continue
        old = str(n.get("id") or "")
        if not old:
            old = fresh_uid("n")
        new = fresh_uid("n")
        id_map[old] = new
        n["id"] = new
    new_nodes = [n for n in nodes if isinstance(n, dict)]
    new_edges = []
    for e in edges:
        if not isinstance(e, dict):
            continue
        fr = str(e.get("from") or "")
        to = str(e.get("to") or "")
        if fr not in id_map or to not in id_map:
            continue
        ne = dict(e)
        ne["id"] = fresh_uid("e")
        ne["from"] = id_map[fr]
        ne["to"] = id_map[to]
        new_edges.append(ne)
    new_collapsed = []
    for c in collapsed:
        if not isinstance(c, dict):
            continue
        nc = dict(c)
        nc["id"] = fresh_uid("c")
        raw_ids = nc.get("nodeIds") if isinstance(nc.get("nodeIds"), list) else []
        nc["nodeIds"] = [id_map[str(i)] for i in raw_ids if str(i) in id_map]
        new_collapsed.append(nc)
    return new_nodes, new_edges, new_collapsed, id_map


def entry_names_in_nodes(nodes) -> set[str]:
    names: set[str] = set()
    for n in nodes or []:
        if not isinstance(n, dict):
            continue
        if n.get("kind") not in ("entry", "function"):
            continue
        name = n.get("name")
        if name is None:
            continue
        s = str(name).strip()
        if s:
            names.add(s)
    return names


AURA_MAX = 3
AURA_FIELDS = ("AURA1_RADIUS", "AURA2_RADIUS", "AURA3_RADIUS")
AURA_DEFAULT_COLORS = ("#4fc3f7", "#ffb74d", "#ba68c8")
_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def sanitize_auras(raw) -> list:
    """appearance.auras: max 3, unique slots 1..3, color #rrggbb, opacity 0..1, enabled."""
    if not isinstance(raw, list):
        return []
    out: list = []
    used: set[int] = set()
    for a in raw:
        if not isinstance(a, dict):
            continue
        try:
            slot = int(a.get("slot"))
        except (TypeError, ValueError):
            slot = 0
        if slot < 1 or slot > AURA_MAX or slot in used:
            free = [s for s in range(1, AURA_MAX + 1) if s not in used]
            if not free:
                break
            slot = free[0]
        used.add(slot)
        color = str(a.get("color") or "")
        if not _HEX_COLOR.match(color):
            color = AURA_DEFAULT_COLORS[slot - 1]
        try:
            opacity = float(a.get("opacity", 0.25))
        except (TypeError, ValueError):
            opacity = 0.25
        if opacity != opacity:  # NaN
            opacity = 0.25
        opacity = min(1.0, max(0.0, opacity))
        out.append(
            {
                "slot": slot,
                "color": color.lower(),
                "opacity": opacity,
                "enabled": a.get("enabled") is not False,
            }
        )
        if len(out) >= AURA_MAX:
            break
    out.sort(key=lambda x: x["slot"])
    return out


def sanitize_token_image(raw):
    """appearance.image = {asset: <sha256 in world/assets/by-hash>, crop: {x,y,w,h,flipX,flipY,rotation}}."""
    if not isinstance(raw, dict):
        return None
    asset = str(raw.get("asset") or "").strip()
    if not asset or not _safe_segment(asset):
        return None
    crop_in = raw.get("crop") if isinstance(raw.get("crop"), dict) else {}
    try:
        crop = {
            "x": float(crop_in.get("x", 0)),
            "y": float(crop_in.get("y", 0)),
            "w": float(crop_in.get("w", 1)),
            "h": float(crop_in.get("h", 1)),
        }
    except (TypeError, ValueError):
        return None
    if crop["w"] <= 0 or crop["h"] <= 0:
        return None
    crop["flipX"] = bool(crop_in.get("flipX"))
    crop["flipY"] = bool(crop_in.get("flipY"))
    try:
        rot = int(round(float(crop_in.get("rotation", 0)) / 90.0)) * 90
    except (TypeError, ValueError):
        rot = 0
    crop["rotation"] = rot % 360
    out = {"asset": asset, "crop": crop}
    name = raw.get("name")
    if isinstance(name, str) and name.strip():
        out["name"] = name.strip()[:200]
    return out


def library_appearance(appearance: dict, size_tiles: float) -> dict:
    """Appearance subset the map needs; old saves without image/auras load unchanged."""
    out: dict = {"size_tiles": size_tiles}
    img = appearance.get("image") if isinstance(appearance, dict) else None
    if img is not None:
        img = sanitize_token_image(img)
        if img is not None:
            out["image"] = img
    auras = appearance.get("auras") if isinstance(appearance, dict) else None
    if auras is not None:
        out["auras"] = sanitize_auras(auras)
    return out


def aura_field_values(fields) -> dict:
    out: dict = {}
    src = fields if isinstance(fields, dict) else {}
    for k in AURA_FIELDS:
        try:
            v = float(src.get(k, 0) or 0)
        except (TypeError, ValueError):
            v = 0.0
        out[k] = v
    return out


DEFAULT_SHEET_TEMPLATE = "player-sheet"


def default_sheet_template_paths(app_dir: Path | None = None) -> tuple[Path, Path]:
    """(yaml, builder.json) of the bundled default sheet template (frozen: _MEIPASS/gm-session/defaults)."""
    candidates = []
    if app_dir is not None:
        candidates.append(Path(app_dir) / "defaults")
    candidates.append(default_app_dir() / "defaults")
    candidates.append(Path(__file__).resolve().parent / "defaults")
    for d in candidates:
        y = d / f"{DEFAULT_SHEET_TEMPLATE}.yaml"
        b = d / f"{DEFAULT_SHEET_TEMPLATE}.builder.json"
        if y.is_file() or b.is_file():
            return y, b
    d = candidates[0]
    return d / f"{DEFAULT_SHEET_TEMPLATE}.yaml", d / f"{DEFAULT_SHEET_TEMPLATE}.builder.json"


def load_default_sheet_template(sheet_id: str, app_dir: Path | None = None) -> dict | None:
    """Builder document for a NEW sheet id (no YAML/scratch yet), from the bundled template.

    Prefers the builder JSON (full layout/graph); falls back to the compiled YAML.
    Returns None when no template is bundled (caller then returns the empty doc).
    """
    ypath, bpath = default_sheet_template_paths(app_dir)
    doc = None
    if bpath.is_file():
        try:
            data = json.loads(bpath.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            data = None
        if isinstance(data, dict):
            doc = data
    if doc is None and ypath.is_file():
        try:
            data = yaml.safe_load(ypath.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError:
            data = None
        if isinstance(data, dict):
            doc = data
    if doc is None:
        return None
    doc = deep_copy_json(doc)
    template_id = str(doc.get("sheet_id") or doc.get("id") or "")
    layout = doc.get("layout") if isinstance(doc.get("layout"), dict) else {}
    g = doc.get("graph") if isinstance(doc.get("graph"), dict) else {}
    return {
        "sheet_id": sheet_id,
        "name": (doc.get("name") or sheet_id) if sheet_id == template_id else sheet_id,
        "permissions": doc.get("permissions"),
        "fields": doc.get("fields") if isinstance(doc.get("fields"), dict) else {},
        "layout": {"widgets": layout.get("widgets") if isinstance(layout.get("widgets"), list) else []},
        "graph": {
            "nodes": g.get("nodes") if isinstance(g.get("nodes"), list) else [],
            "edges": g.get("edges") if isinstance(g.get("edges"), list) else [],
            "collapsed": g.get("collapsed") if isinstance(g.get("collapsed"), list) else [],
        },
        "_source": "template",
        "_template": DEFAULT_SHEET_TEMPLATE,
    }


class Handler(BaseHTTPRequestHandler):
    campaign_root: Path = Path(".")
    app_dir: Path = Path(".")
    quiet: bool = False

    def log_message(self, fmt: str, *args) -> None:
        if self.quiet:
            return
        print(f"[{self.address_string()}] {fmt % args}")

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, code: int, obj) -> None:
        data = json.dumps(obj, indent=2).encode("utf-8")
        self._send(code, data, "application/json; charset=utf-8")

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))

    def _json_object_or_400(self):
        try:
            body = self._read_json_body()
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid JSON body"})
            return None
        if not isinstance(body, dict):
            self._send_json(400, {"error": "body must be an object"})
            return None
        return body

    def _send_file(self, path: Path) -> None:
        if not path.is_file():
            self._send(404, b"Not found\n", "text/plain; charset=utf-8")
            return
        ctype, _ = mimetypes.guess_type(str(path))
        if ctype is None:
            head = path.read_bytes()[:16]
            if head.startswith(b"\x89PNG\r\n\x1a\n"):
                ctype = "image/png"
            elif head[:3] == b"\xff\xd8\xff":
                ctype = "image/jpeg"
            elif head[:4] == b"RIFF" and head[8:12] == b"WEBP":
                ctype = "image/webp"
            elif path.suffix.lower() in (".txt", ".md"):
                ctype = "text/plain; charset=utf-8"
            else:
                ctype = "application/octet-stream"
        body = path.read_bytes()
        self._send(200, body, ctype)

    def _resolve_under_campaign(self, rel: str) -> Path | None:
        """Resolve a campaign-relative path; reject escapes."""
        rel = rel.replace("\\", "/").lstrip("/")
        if ".." in rel.split("/"):
            return None
        candidate = (self.campaign_root / rel).resolve()
        root = self.campaign_root.resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            return None
        return candidate

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers", "Content-Type, X-Asset-Name"
        )
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        app = self.app_dir

        if path in ("/", "/index.html"):
            self._send_file(app / "index.html")
            return
        if path == "/session.js":
            self._send_file(app / "session.js")
            return
        if path == "/infer-grid-from-walls.js":
            self._send_file(app / "infer-grid-from-walls.js")
            return
        if path == "/image-xform.js":
            self._send_file(app / "image-xform.js")
            return
        if path == "/token-auras.js":
            self._send_file(app / "token-auras.js")
            return
        if path == "/org-tree.js":
            self._send_file(app / "org-tree.js")
            return

        if path == "/api/organization":
            org = cm.load_organization(self.campaign_root)
            self._send_json(200, org)
            return
        if path == "/api/maps":
            self._send_json(200, {"maps": cm.maps_summary(self.campaign_root)})
            return
        if path.startswith("/api/map/"):
            map_id = path[len("/api/map/") :].strip("/")
            m = cm.load_map(self.campaign_root, map_id) if _safe_segment(map_id) else None
            if m is None:
                self._send_json(404, {"error": f"map not found: {map_id}"})
                return
            self._send_json(200, m)
            return
        if path == "/api/players":
            self._send_json(200, self.player_hub.gm_status())
            return
        if path == "/api/migration":
            self._send_json(200, getattr(type(self), "migration_report", {}) or {})
            return
        if path == "/sheet.html":
            self._send_file(app / "sheet.html")
            return
        if path == "/sheet.js":
            self._send_file(app / "sheet.js")
            return
        if path == "/rolls.html":
            self._send_file(app / "rolls.html")
            return
        if path == "/rolls.js":
            self._send_file(app / "rolls.js")
            return
        if path == "/sheet-builder.html":
            self._send_file(app / "sheet-builder.html")
            return
        if path == "/sheet-builder.js":
            self._send_file(app / "sheet-builder.js")
            return
        if path == "/sheet-runtime.js":
            self._send_file(app / "sheet-runtime.js")
            return
        if path == "/favicon.ico":
            self._send(204, b"", "image/x-icon")
            return

        if path == "/api/library":
            self._api_library()
            return

        if path == "/api/mechanics" or path == "/api/mechanics/":
            self._api_mechanics_list()
            return

        if path.startswith("/api/mechanics/"):
            name = path[len("/api/mechanics/") :].strip("/")
            if "/" in name or not safe_mechanic_name(name):
                self._send_json(400, {"error": "invalid mechanic name"})
                return
            self._api_mechanics_get(name)
            return

        if path == "/api/sheet-builder" or path == "/api/sheet-builder/":
            self._api_sheet_builder_list()
            return

        if path.startswith("/api/sheet-builder/"):
            rest = path[len("/api/sheet-builder/") :].strip("/")
            if "/" in rest:
                self._send_json(404, {"error": "not found"})
                return
            sheet_id = rest
            if not _safe_segment(sheet_id):
                self._send_json(400, {"error": "invalid sheet id"})
                return
            self._api_sheet_builder_get(sheet_id)
            return

        if path.startswith("/api/scene/"):
            scene_id = path[len("/api/scene/") :].strip("/")
            if not _safe_segment(scene_id):
                self._send_json(400, {"error": "invalid scene id"})
                return
            scene_path = self.campaign_root / "world" / "scenes" / f"{scene_id}.yaml"
            if not scene_path.is_file():
                self._send_json(404, {"error": f"scene not found: {scene_id}"})
                return
            with scene_path.open("r", encoding="utf-8") as fh:
                scene = yaml.safe_load(fh)
            # Scene → referenced map (grid + image layers); legacy scenes unchanged
            self._send_json(200, cm.resolve_scene(self.campaign_root, scene))
            return

        if path.startswith("/api/sheet/") and path.endswith("/rev"):
            actor_id = path[len("/api/sheet/") : -len("/rev")].strip("/")
            if not _safe_segment(actor_id):
                self._send_json(400, {"error": "invalid actor id"})
                return
            self._send_json(200, {"rev": cm.actor_rev(self.campaign_root, actor_id)})
            return

        if path.startswith("/api/sheet/"):
            actor_id = path[len("/api/sheet/") :].strip("/")
            status, payload = self.sheet_payload(actor_id)
            self._send_json(status, payload)
            return

        if path.startswith("/api/tokens/"):
            scene_id = path[len("/api/tokens/") :].strip("/")
            if not _safe_segment(scene_id):
                self._send_json(400, {"error": "invalid scene id"})
                return
            tokens_path = (
                self.campaign_root / "state" / "tokens" / f"{scene_id}.json"
            )
            if not tokens_path.is_file():
                self._send_json(200, {"scene": scene_id, "tokens": []})
                return
            try:
                data = json.loads(tokens_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                data = {"scene": scene_id, "tokens": []}
            if not isinstance(data, dict):
                data = {"scene": scene_id, "tokens": []}
            data.setdefault("scene", scene_id)
            data.setdefault("tokens", [])
            self._send_json(200, data)
            return

        if path == "/api/ui" or path.startswith("/api/ui/"):
            scene_id = None
            if path.startswith("/api/ui/"):
                scene_id = path[len("/api/ui/") :].strip("/")
                if scene_id and not _safe_segment(scene_id):
                    self._send_json(400, {"error": "invalid scene id"})
                    return
            if scene_id:
                ui_path = self.campaign_root / "state" / "ui" / f"{scene_id}.json"
                defaults = {"scene": scene_id, "showGrid": True, "snapToGrid": True, "snapTarget": "center", "showNametags": True, "snapLayers": False}
            else:
                ui_path = self.campaign_root / "state" / "ui.json"
                defaults = {"showGrid": True, "snapToGrid": True, "snapTarget": "center", "showNametags": True, "snapLayers": False}
            if not ui_path.is_file():
                self._send_json(200, defaults)
                return
            try:
                data = json.loads(ui_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                data = {}
            if not isinstance(data, dict):
                data = {}
            out = {**defaults, **data}
            self._send_json(200, out)
            return

        if path.startswith("/assets/"):
            digest = path[len("/assets/") :].strip("/")
            if not _safe_segment(digest):
                self._send(400, b"bad asset id\n", "text/plain; charset=utf-8")
                return
            asset_path = (
                self.campaign_root / "world" / "assets" / "by-hash" / digest
            )
            self._send_file(asset_path)
            return

        rel = path.lstrip("/")
        candidate = (app / rel).resolve()
        try:
            candidate.relative_to(app.resolve())
        except ValueError:
            self._send(404, b"Not found\n", "text/plain; charset=utf-8")
            return
        if candidate.is_file():
            self._send_file(candidate)
            return

        self._send(404, b"Not found\n", "text/plain; charset=utf-8")

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path.startswith("/api/mechanics/"):
            name = path[len("/api/mechanics/") :].strip("/")
            if "/" in name or not safe_mechanic_name(name):
                self._send_json(400, {"error": "invalid mechanic name"})
                return
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid JSON body"})
                return
            self._api_mechanics_put(name, body)
            return

        if path.startswith("/api/sheet-builder/"):
            rest = path[len("/api/sheet-builder/") :].strip("/")
            if rest.endswith("/compile") or "/" in rest:
                self._send_json(404, {"error": "not found"})
                return
            sheet_id = rest
            if not _safe_segment(sheet_id):
                self._send_json(400, {"error": "invalid sheet id"})
                return
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid JSON body"})
                return
            self._api_sheet_builder_put(sheet_id, body)
            return

        if path.startswith("/api/sheet/"):
            actor_id = path[len("/api/sheet/") :].strip("/")
            if not _safe_segment(actor_id):
                self._send_json(400, {"error": "invalid actor id"})
                return
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid JSON body"})
                return
            if not isinstance(body, dict) or "text" not in body:
                self._send_json(400, {"error": "body must be {\"text\": \"...\"}"})
                return
            actor_path = self.campaign_root / "world" / "actors" / f"{actor_id}.yaml"
            if not actor_path.is_file():
                self._send_json(404, {"error": f"actor not found: {actor_id}"})
                return
            actor = yaml.safe_load(actor_path.read_text(encoding="utf-8")) or {}
            sheet_rel = actor.get("sheet_doc") or f"world/actors/{actor_id}.sheet.txt"
            sheet_path = self._resolve_under_campaign(sheet_rel)
            if sheet_path is None:
                self._send_json(400, {"error": "invalid sheet path"})
                return
            sheet_path.parent.mkdir(parents=True, exist_ok=True)
            text = body["text"]
            if not isinstance(text, str):
                self._send_json(400, {"error": "text must be a string"})
                return
            sheet_path.write_text(text, encoding="utf-8")
            self._send_json(
                200,
                {
                    "ok": True,
                    "actor_id": actor_id,
                    "path": sheet_rel,
                    "bytes": len(text.encode("utf-8")),
                },
            )
            return

        if path.startswith("/api/tokens/"):
            scene_id = path[len("/api/tokens/") :].strip("/")
            if not _safe_segment(scene_id):
                self._send_json(400, {"error": "invalid scene id"})
                return
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid JSON body"})
                return
            if not isinstance(body, dict):
                self._send_json(400, {"error": "body must be an object"})
                return
            tokens = body.get("tokens")
            if not isinstance(tokens, list):
                self._send_json(400, {"error": "tokens must be a list"})
                return
            cleaned = []
            for t in tokens:
                if not isinstance(t, dict):
                    continue
                try:
                    size_tiles = float(t.get("size_tiles", 1))
                except (TypeError, ValueError):
                    size_tiles = 1.0
                if size_tiles <= 0:
                    size_tiles = 1.0
                cleaned.append(
                    {
                        "id": str(t.get("id") or uuid.uuid4()),
                        "actor_id": t.get("actor_id"),
                        "name": t.get("name") or t.get("actor_id") or "Token",
                        "label": t.get("label") or "",
                        "x": float(t.get("x", 0)),
                        "y": float(t.get("y", 0)),
                        "size_tiles": size_tiles,
                    }
                )
            out = {"scene": scene_id, "tokens": cleaned}
            tokens_dir = self.campaign_root / "state" / "tokens"
            tokens_dir.mkdir(parents=True, exist_ok=True)
            tokens_path = tokens_dir / f"{scene_id}.json"
            tokens_path.write_text(
                json.dumps(out, indent=2) + "\n", encoding="utf-8"
            )
            self._send_json(200, {"ok": True, **out})
            return

        if path.startswith("/api/scene/") and path.endswith("/layers"):
            # /api/scene/<id>/layers
            mid = path[len("/api/scene/") : -len("/layers")].strip("/")
            scene_id = mid
            if not _safe_segment(scene_id):
                self._send_json(400, {"error": "invalid scene id"})
                return
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid JSON body"})
                return
            if not isinstance(body, dict) or "layers" not in body:
                self._send_json(400, {"error": "body must be {\"layers\": [...]}"})
                return
            layers = body["layers"]
            if not isinstance(layers, list):
                self._send_json(400, {"error": "layers must be a list"})
                return
            cleaned = []
            seen_ids = set()
            allowed_types = {"map", "tokens", "grid", "additions", "overlay"}
            for layer in layers:
                if not isinstance(layer, dict):
                    self._send_json(400, {"error": "each layer must be an object"})
                    return
                lid = layer.get("id")
                ltype = layer.get("type")
                if not isinstance(lid, str) or not lid.strip():
                    self._send_json(400, {"error": "layer.id required"})
                    return
                if not _safe_segment(lid):
                    self._send_json(400, {"error": f"invalid layer id: {lid}"})
                    return
                if lid in seen_ids:
                    self._send_json(400, {"error": f"duplicate layer id: {lid}"})
                    return
                seen_ids.add(lid)
                if not isinstance(ltype, str) or ltype not in allowed_types:
                    self._send_json(
                        400,
                        {
                            "error": f"invalid layer type: {ltype}",
                            "allowed": sorted(allowed_types),
                        },
                    )
                    return
                entry = {"id": lid, "type": ltype}
                if "name" in layer and layer["name"] is not None:
                    entry["name"] = str(layer["name"])
                if "asset" in layer and layer["asset"] is not None:
                    asset = str(layer["asset"])
                    if not re.fullmatch(r"[0-9a-fA-F]{64}", asset):
                        self._send_json(400, {"error": f"invalid asset hash: {asset}"})
                        return
                    entry["asset"] = asset.lower()
                if "visible" in layer:
                    entry["visible"] = bool(layer["visible"])
                for key in ("x", "y", "w", "h"):
                    if key in layer and layer[key] is not None:
                        try:
                            num = float(layer[key])
                        except (TypeError, ValueError):
                            self._send_json(400, {"error": f"layer.{key} must be a number"})
                            return
                        entry[key] = int(num) if num.is_integer() else num
                # Preserve any extra keys we don't understand (forward-compatible)
                for k, v in layer.items():
                    if k not in entry:
                        entry[k] = v
                cleaned.append(entry)

            scene_path = self.campaign_root / "world" / "scenes" / f"{scene_id}.yaml"
            if not scene_path.is_file():
                self._send_json(404, {"error": f"scene not found: {scene_id}"})
                return
            scene = yaml.safe_load(scene_path.read_text(encoding="utf-8")) or {}
            if not isinstance(scene, dict):
                self._send_json(500, {"error": "scene YAML is not a mapping"})
                return
            # Image layers belong to the scene's map (world/maps/<id>.yaml)
            layers_out = cm.write_scene_layers(self.campaign_root, scene_id, cleaned)
            self._send_json(200, {"ok": True, "scene": scene_id, "layers": layers_out})
            return

        if path.startswith("/api/scene/") and path.endswith("/map"):
            scene_id = path[len("/api/scene/") : -len("/map")].strip("/")
            if not _safe_segment(scene_id):
                self._send_json(400, {"error": "invalid scene id"})
                return
            body = self._json_object_or_400()
            if body is None:
                return
            map_id = body.get("map")
            if map_id is not None and not isinstance(map_id, str):
                self._send_json(400, {"error": "map must be a map id or null"})
                return
            try:
                scene = cm.set_scene_map(self.campaign_root, scene_id, map_id)
            except cm.OrgError as exc:
                self._send_json(400, {"error": str(exc)})
                return
            self._send_json(200, {"ok": True, "scene": scene_id, "map": scene.get("map")})
            return

        if path in ("/api/players/assign", "/api/players/settings"):
            body = self._json_object_or_400()
            if body is None:
                return
            try:
                if path.endswith("assign"):
                    got = self.player_hub.gm_assign(body.get("actor"), body.get("players"))
                    self._send_json(200, {"ok": True, "actor": body.get("actor"), "players": got})
                else:
                    self.player_hub.gm_set_join_code(body.get("join_code"))
                    self._send_json(200, {"ok": True})
            except sc.SyncError as exc:
                self._send_json(400, {"error": str(exc)})
            return

        if path.startswith("/api/organization/") and path != "/api/organization/rename":
            panel = path[len("/api/organization/") :].strip("/")
            body = self._json_object_or_400()
            if body is None:
                return
            try:
                tree = cm.set_panel_tree(self.campaign_root, panel, body.get("tree"))
            except cm.OrgError as exc:
                self._send_json(400, {"error": str(exc)})
                return
            self._send_json(200, {"ok": True, "panel": panel, "tree": tree})
            return

        if path == "/api/ui" or path.startswith("/api/ui/"):
            # Global: /api/ui  or per-scene: /api/ui/<scene_id>
            scene_id = None
            if path.startswith("/api/ui/"):
                scene_id = path[len("/api/ui/") :].strip("/")
                if scene_id and not _safe_segment(scene_id):
                    self._send_json(400, {"error": "invalid scene id"})
                    return
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid JSON body"})
                return
            if not isinstance(body, dict):
                self._send_json(400, {"error": "body must be an object"})
                return
            ui_dir = self.campaign_root / "state" / "ui"
            ui_dir.mkdir(parents=True, exist_ok=True)
            if scene_id:
                ui_path = ui_dir / f"{scene_id}.json"
                existing = {}
                if ui_path.is_file():
                    try:
                        existing = json.loads(ui_path.read_text(encoding="utf-8"))
                    except json.JSONDecodeError:
                        existing = {}
                if not isinstance(existing, dict):
                    existing = {}
                existing.update(body)
                existing["scene"] = scene_id
                ui_path.write_text(
                    json.dumps(existing, indent=2) + "\n", encoding="utf-8"
                )
                self._send_json(200, {"ok": True, **existing})
            else:
                ui_path = self.campaign_root / "state" / "ui.json"
                existing = {}
                if ui_path.is_file():
                    try:
                        existing = json.loads(ui_path.read_text(encoding="utf-8"))
                    except json.JSONDecodeError:
                        existing = {}
                if not isinstance(existing, dict):
                    existing = {}
                existing.update(body)
                ui_path.write_text(
                    json.dumps(existing, indent=2) + "\n", encoding="utf-8"
                )
                self._send_json(200, {"ok": True, **existing})
            return

        if path.startswith("/api/actor/") and path.endswith("/fields"):
            # /api/actor/<id>/fields
            mid = path[len("/api/actor/") : -len("/fields")].strip("/")
            actor_id = mid
            if not _safe_segment(actor_id):
                self._send_json(400, {"error": "invalid actor id"})
                return
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid JSON body"})
                return
            if not isinstance(body, dict):
                self._send_json(400, {"error": "body must be an object"})
                return
            fields_in = body.get("fields")
            if not isinstance(fields_in, dict):
                self._send_json(400, {"error": 'body must be {"fields": {...}}'})
                return
            actor_path = self.campaign_root / "world" / "actors" / f"{actor_id}.yaml"
            if not actor_path.is_file():
                self._send_json(404, {"error": f"actor not found: {actor_id}"})
                return
            actor = yaml.safe_load(actor_path.read_text(encoding="utf-8")) or {}
            if not isinstance(actor, dict):
                self._send_json(500, {"error": "actor YAML is not a mapping"})
                return
            existing = actor.get("fields") if isinstance(actor.get("fields"), dict) else {}
            merged = {**existing}
            for k, v in fields_in.items():
                key = str(k).strip()
                if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):
                    continue
                merged[key] = v
            actor["fields"] = merged
            actor_path.write_text(
                yaml.safe_dump(
                    actor,
                    sort_keys=False,
                    default_flow_style=False,
                    allow_unicode=True,
                ),
                encoding="utf-8",
            )
            self._send_json(
                200,
                {"ok": True, "actor_id": actor_id, "fields": merged},
            )
            return

        if path.startswith("/api/actor/") and path.endswith("/appearance"):
            # /api/actor/<id>/appearance
            mid = path[len("/api/actor/") : -len("/appearance")].strip("/")
            actor_id = mid
            if not _safe_segment(actor_id):
                self._send_json(400, {"error": "invalid actor id"})
                return
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid JSON body"})
                return
            if not isinstance(body, dict):
                self._send_json(400, {"error": "body must be an object"})
                return
            appearance_in = body.get("appearance")
            if appearance_in is None and "size_tiles" in body:
                appearance_in = {"size_tiles": body.get("size_tiles")}
            if not isinstance(appearance_in, dict):
                self._send_json(
                    400, {"error": 'body must be {"appearance": {"size_tiles": N}}'}
                )
                return
            actor_path = self.campaign_root / "world" / "actors" / f"{actor_id}.yaml"
            if not actor_path.is_file():
                self._send_json(404, {"error": f"actor not found: {actor_id}"})
                return
            actor = yaml.safe_load(actor_path.read_text(encoding="utf-8")) or {}
            if not isinstance(actor, dict):
                self._send_json(500, {"error": "actor YAML is not a mapping"})
                return
            existing = actor.get("appearance") if isinstance(actor.get("appearance"), dict) else {}
            merged = {**existing}
            if "size_tiles" in appearance_in:
                try:
                    size_tiles = float(appearance_in["size_tiles"])
                except (TypeError, ValueError):
                    self._send_json(400, {"error": "size_tiles must be a number"})
                    return
                if size_tiles <= 0:
                    self._send_json(400, {"error": "size_tiles must be > 0"})
                    return
                merged["size_tiles"] = size_tiles
            # Forward-compatible: merge other appearance keys except size_tiles handled above.
            # A null value removes the key (e.g. {"image": null} = Remove image).
            for k, v in appearance_in.items():
                if k == "size_tiles":
                    continue
                if k == "image" and v is not None:
                    v = sanitize_token_image(v)
                    if v is None:
                        self._send_json(400, {"error": "image must be {asset, crop}"})
                        return
                elif k == "auras" and v is not None:
                    v = sanitize_auras(v)
                if v is None:
                    merged.pop(k, None)
                    continue
                merged[k] = v
            if "size_tiles" not in merged:
                merged["size_tiles"] = 1.0
            actor["appearance"] = merged
            actor_path.write_text(
                yaml.safe_dump(
                    actor,
                    sort_keys=False,
                    default_flow_style=False,
                    allow_unicode=True,
                ),
                encoding="utf-8",
            )
            self._send_json(
                200,
                {"ok": True, "actor_id": actor_id, "appearance": merged},
            )
            return

        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path.startswith("/api/sheet-builder/") and path.endswith("/import-mechanic"):
            mid = path[len("/api/sheet-builder/") : -len("/import-mechanic")].strip("/")
            sheet_id = mid
            if not _safe_segment(sheet_id):
                self._send_json(400, {"error": "invalid sheet id"})
                return
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid JSON body"})
                return
            self._api_sheet_import_mechanic(sheet_id, body)
            return

        if path.startswith("/api/sheet-builder/") and path.endswith("/compile"):
            mid = path[len("/api/sheet-builder/") : -len("/compile")].strip("/")
            sheet_id = mid
            if not _safe_segment(sheet_id):
                self._send_json(400, {"error": "invalid sheet id"})
                return
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid JSON body"})
                return
            self._api_sheet_builder_compile(sheet_id, body)
            return

        if path == "/api/assets":
            self._api_post_asset()
            return

        if path == "/api/clipboard":
            # 0.7.1 fallback for "Copy join IP" when the webview's clipboard API is
            # unavailable: OS clipboard, join-address-shaped text only, same-origin only.
            origin = self.headers.get("Origin")
            if origin and urlparse(origin).hostname not in ("127.0.0.1", "localhost", "::1"):
                self._send_json(403, {"error": "cross-site request refused"})
                return
            body = self._json_object_or_400()
            if body is None:
                return
            text = body.get("text")
            if not (isinstance(text, str) and CLIP_TEXT_RE.match(text)):
                self._send_json(400, {"error": "only a host:port join address can be copied"})
                return
            ok = clipboard_os.set_text(text)
            self._send_json(200 if ok else 503, {"ok": ok, "text": text, "method": "os"})
            return

        if path == "/api/players/fullsync":
            body = self._json_object_or_400()
            if body is None:
                return
            try:
                fid = self.player_hub.gm_full_to_player(str(body.get("actor") or ""), str(body.get("player") or ""))
            except sc.SyncError as exc:
                self._send_json(400, {"error": str(exc)})
                return
            self._send_json(200, {"ok": True, "full_id": fid, "note": "sent on the player's next sync (every 2 s while connected)"})
            return

        if path in ("/api/actors", "/api/scenes", "/api/maps", "/api/organization/rename"):
            body = self._json_object_or_400()
            if body is None:
                return
            root = self.campaign_root
            folder = body.get("folder")
            if folder is not None and not (isinstance(folder, str) and cm.FOLDER_ID_RE.match(folder)):
                self._send_json(400, {"error": "invalid folder id"})
                return
            try:
                if path == "/api/actors":
                    out = {"ok": True, "actor": cm.create_actor(root, body.get("name"), folder)}
                elif path == "/api/scenes":
                    map_id = body.get("map")
                    if map_id is not None and not isinstance(map_id, str):
                        raise cm.OrgError("map must be a map id or null")
                    out = {"ok": True, "scene": cm.create_scene(root, body.get("name"), map_id, folder)}
                elif path == "/api/maps":
                    out = {
                        "ok": True,
                        "map": cm.create_map(root, body.get("name"), body.get("layers") or [], body.get("grid"), folder),
                    }
                else:
                    kind = body.get("kind")
                    panel = {"map": "maps", "actor": "actors", "scene": "scenes"}.get(kind)
                    if kind == "folder":
                        fpanel = body.get("panel")
                        name = cm.rename_folder(root, fpanel, str(body.get("id") or ""), body.get("name"))
                        out = {"ok": True, "panel": fpanel, "id": body.get("id"), "name": name}
                    elif panel:
                        out = cm.rename_entity(root, panel, body.get("id"), body.get("name"))
                    else:
                        raise cm.OrgError("kind must be map, actor, scene or folder")
            except cm.OrgError as exc:
                self._send_json(400, {"error": str(exc)})
                return
            self._send_json(200, out)
            return

        # Fall through to PUT handlers for any other POSTs that share semantics
        self.do_PUT()

    def _api_post_asset(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            self._send_json(400, {"error": "empty body"})
            return
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype and not ctype.startswith("image/") and ctype != "application/octet-stream":
            self._send_json(
                400,
                {"error": f"expected image/* Content-Type, got {ctype or '(missing)'}"},
            )
            return
        name = self.headers.get("X-Asset-Name") or ""
        name = name.strip()
        if not name:
            # Derive a logical name from content type
            ext = {
                "image/png": "png",
                "image/jpeg": "jpg",
                "image/jpg": "jpg",
                "image/webp": "webp",
                "image/gif": "gif",
            }.get(ctype, "bin")
            name = f"uploads/asset-{uuid.uuid4().hex[:8]}.{ext}"
        # Sanitize name path segments
        name = name.replace("\\", "/").lstrip("/")
        if ".." in name.split("/") or not name:
            self._send_json(400, {"error": "invalid X-Asset-Name"})
            return

        digest = hashlib.sha256(raw).hexdigest()
        by_hash = self.campaign_root / "world" / "assets" / "by-hash"
        by_hash.mkdir(parents=True, exist_ok=True)
        dest = by_hash / digest
        if not dest.exists():
            dest.write_bytes(raw)

        index_path = self.campaign_root / "world" / "assets" / "index.yaml"
        index = {"assets": {}}
        if index_path.is_file():
            loaded = yaml.safe_load(index_path.read_text(encoding="utf-8")) or {}
            if isinstance(loaded, dict) and isinstance(loaded.get("assets"), dict):
                index = loaded
            elif isinstance(loaded, dict):
                index = {"assets": loaded.get("assets") or {}}
        if not isinstance(index.get("assets"), dict):
            index["assets"] = {}
        index["assets"][name] = digest
        index_path.parent.mkdir(parents=True, exist_ok=True)
        index_path.write_text(
            yaml.safe_dump(index, sort_keys=False, default_flow_style=False),
            encoding="utf-8",
        )
        self._send_json(200, {"hash": digest, "name": name, "bytes": len(raw)})


    def sheet_payload(self, actor_id: str) -> tuple[int, dict]:
        """GET /api/sheet/<id> body (also the player sheet bundle source)."""
        if not _safe_segment(actor_id):
            return 400, {"error": "invalid actor id"}
        actor_path = self.campaign_root / "world" / "actors" / f"{actor_id}.yaml"
        if not actor_path.is_file():
            return 404, {"error": f"actor not found: {actor_id}"}
        actor = yaml.safe_load(actor_path.read_text(encoding="utf-8")) or {}
        if not isinstance(actor, dict):
            actor = {}
        sheet_rel = actor.get("sheet_doc") or f"world/actors/{actor_id}.sheet.txt"
        sheet_path = self._resolve_under_campaign(sheet_rel)
        sheet_text = ""
        if sheet_path is not None and sheet_path.is_file():
            sheet_text = sheet_path.read_text(encoding="utf-8")
        appearance = actor.get("appearance") if isinstance(actor.get("appearance"), dict) else {}
        size_tiles = appearance.get("size_tiles", 1)
        try:
            size_tiles = float(size_tiles)
        except (TypeError, ValueError):
            size_tiles = 1.0
        if size_tiles <= 0:
            size_tiles = 1.0
        appearance = {**appearance, "size_tiles": size_tiles}
        sheet_id = str(actor.get("sheet") or actor.get("sheet_id") or "").strip()
        schema_fields: dict = {}
        layout_widgets: list = []
        schema_graph: dict = {"nodes": [], "edges": [], "collapsed": []}
        schema_source = None
        if sheet_id and _safe_segment(sheet_id):
            schema_fields, layout_widgets, schema_graph, schema_source = (
                self._load_sheet_schema(sheet_id)
            )
        actor_fields = (
            actor.get("fields") if isinstance(actor.get("fields"), dict) else {}
        )
        return 200, {
                "actor_id": actor_id,
                "name": actor.get("name") or actor_id,
                "path": sheet_rel,
                "text": sheet_text,
                "appearance": appearance,
                "sheet_id": sheet_id or None,
                "fields": actor_fields,
                "schema": {
                    "fields": schema_fields,
                    "source": schema_source,
                },
                "layout": {"widgets": layout_widgets},
                "graph": schema_graph,
            }

    def _load_sheet_schema(self, sheet_id: str):
        """Return (schema_fields, layout_widgets, graph, source) from build yaml or editor-scratch."""
        fields: dict = {}
        widgets: list = []
        graph: dict = {"nodes": [], "edges": []}
        source: str | None = None
        ypath = self._sheet_yaml_path(sheet_id)
        if ypath.is_file():
            data = yaml.safe_load(ypath.read_text(encoding="utf-8")) or {}
            if isinstance(data, dict):
                if isinstance(data.get("fields"), dict):
                    fields = dict(data["fields"])
                layout = data.get("layout") if isinstance(data.get("layout"), dict) else {}
                if isinstance(layout.get("widgets"), list):
                    widgets = list(layout["widgets"])
                g = data.get("graph") if isinstance(data.get("graph"), dict) else {}
                nodes = g.get("nodes") if isinstance(g.get("nodes"), list) else []
                edges = g.get("edges") if isinstance(g.get("edges"), list) else []
                collapsed = g.get("collapsed") if isinstance(g.get("collapsed"), list) else []
                graph = {"nodes": list(nodes), "edges": list(edges), "collapsed": list(collapsed)}
                source = "yaml"
        scratch = self._builder_scratch_path(sheet_id)
        need_graph = not graph.get("nodes")
        if scratch.is_file() and (not fields or not widgets or need_graph or source is None):
            try:
                data = json.loads(scratch.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                data = None
            if isinstance(data, dict):
                if not fields and isinstance(data.get("fields"), dict):
                    fields = dict(data["fields"])
                layout = (
                    data.get("layout") if isinstance(data.get("layout"), dict) else {}
                )
                if not widgets and isinstance(layout.get("widgets"), list):
                    widgets = list(layout["widgets"])
                if need_graph:
                    g = data.get("graph") if isinstance(data.get("graph"), dict) else {}
                    nodes = g.get("nodes") if isinstance(g.get("nodes"), list) else []
                    edges = g.get("edges") if isinstance(g.get("edges"), list) else []
                    collapsed = g.get("collapsed") if isinstance(g.get("collapsed"), list) else []
                    if nodes or edges or collapsed:
                        graph = {
                            "nodes": list(nodes),
                            "edges": list(edges),
                            "collapsed": list(collapsed),
                        }
                if source is None:
                    source = "scratch"
        return fields, widgets, graph, source

    def _builder_scratch_path(self, sheet_id: str) -> Path:
        return (
            self.campaign_root
            / "editor-scratch"
            / "sheets"
            / f"{sheet_id}.builder.json"
        )

    def _sheet_yaml_path(self, sheet_id: str) -> Path:
        return self.campaign_root / "build" / "sheets" / f"{sheet_id}.yaml"

    def _seed_builder_from_yaml(self, sheet_id: str) -> dict | None:
        """Load build/sheets/<id>.yaml into a builder document skeleton."""
        ypath = self._sheet_yaml_path(sheet_id)
        if not ypath.is_file():
            return None
        data = yaml.safe_load(ypath.read_text(encoding="utf-8")) or {}
        if not isinstance(data, dict):
            return None
        fields = data.get("fields") if isinstance(data.get("fields"), dict) else {}
        layout = data.get("layout") if isinstance(data.get("layout"), dict) else {}
        widgets = layout.get("widgets") if isinstance(layout.get("widgets"), list) else []
        g = data.get("graph") if isinstance(data.get("graph"), dict) else {}
        nodes = g.get("nodes") if isinstance(g.get("nodes"), list) else []
        edges = g.get("edges") if isinstance(g.get("edges"), list) else []
        collapsed = g.get("collapsed") if isinstance(g.get("collapsed"), list) else []
        return {
            "sheet_id": data.get("id") or sheet_id,
            "name": data.get("name") or sheet_id,
            "permissions": data.get("permissions"),
            "fields": fields,
            "layout": {"widgets": widgets},
            "graph": {
                "nodes": list(nodes),
                "edges": list(edges),
                "collapsed": list(collapsed),
            },
            "_source": "yaml",
        }

    def _api_sheet_builder_list(self) -> None:
        sheets_dir = self.campaign_root / "build" / "sheets"
        scratch_dir = self.campaign_root / "editor-scratch" / "sheets"
        ids: set[str] = set()
        if sheets_dir.is_dir():
            for p in sheets_dir.glob("*.yaml"):
                ids.add(p.stem)
        if scratch_dir.is_dir():
            for p in scratch_dir.glob("*.builder.json"):
                ids.add(p.name[: -len(".builder.json")])
        out = []
        for sid in sorted(ids):
            out.append(
                {
                    "id": sid,
                    "has_yaml": self._sheet_yaml_path(sid).is_file(),
                    "has_builder": self._builder_scratch_path(sid).is_file(),
                }
            )
        self._send_json(200, {"sheets": out})

    def _api_sheet_builder_get(self, sheet_id: str) -> None:
        scratch = self._builder_scratch_path(sheet_id)
        if scratch.is_file():
            try:
                data = json.loads(scratch.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                self._send_json(500, {"error": "invalid builder JSON"})
                return
            if not isinstance(data, dict):
                self._send_json(500, {"error": "builder JSON must be an object"})
                return
            data.setdefault("sheet_id", sheet_id)
            data["_source"] = "scratch"
            self._send_json(200, data)
            return
        seeded = self._seed_builder_from_yaml(sheet_id)
        if seeded is not None:
            self._send_json(200, seeded)
            return
        template = load_default_sheet_template(sheet_id, self.app_dir)
        if template is not None:
            self._send_json(200, template)
            return
        self._send_json(
            200,
            {
                "sheet_id": sheet_id,
                "name": sheet_id,
                "fields": {},
                "layout": {"widgets": []},
                "graph": {"nodes": [], "edges": []},
                "_source": "empty",
            },
        )

    def _write_builder_scratch(self, sheet_id: str, body: dict) -> dict:
        out = {
            "sheet_id": sheet_id,
            "name": str(body.get("name") or sheet_id),
            "fields": body.get("fields") if isinstance(body.get("fields"), dict) else {},
            "permissions": body.get("permissions"),
            "layout": body.get("layout")
            if isinstance(body.get("layout"), dict)
            else {"widgets": []},
            "graph": body.get("graph")
            if isinstance(body.get("graph"), dict)
            else {"nodes": [], "edges": []},
        }
        scratch = self._builder_scratch_path(sheet_id)
        scratch.parent.mkdir(parents=True, exist_ok=True)
        scratch.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
        return out

    def _api_sheet_builder_put(self, sheet_id: str, body) -> None:
        if not isinstance(body, dict):
            self._send_json(400, {"error": "body must be an object"})
            return
        self._write_builder_scratch(sheet_id, body)
        self._send_json(
            200,
            {
                "ok": True,
                "sheet_id": sheet_id,
                "path": f"editor-scratch/sheets/{sheet_id}.builder.json",
            },
        )

    def _api_sheet_builder_compile(self, sheet_id: str, body) -> None:
        """Write/update build/sheets/<id>.yaml from builder document (fields + layout)."""
        if body is None:
            body = {}
        if not isinstance(body, dict):
            self._send_json(400, {"error": "body must be an object"})
            return

        if not body.get("fields") and not body.get("graph"):
            scratch = self._builder_scratch_path(sheet_id)
            if scratch.is_file():
                try:
                    body = json.loads(scratch.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    self._send_json(400, {"error": "invalid scratch JSON"})
                    return

        fields_in = body.get("fields") if isinstance(body.get("fields"), dict) else {}
        layout_in = body.get("layout") if isinstance(body.get("layout"), dict) else {}
        graph_in = body.get("graph") if isinstance(body.get("graph"), dict) else {}
        name = str(body.get("name") or sheet_id)
        permissions = body.get("permissions")

        ypath = self._sheet_yaml_path(sheet_id)
        existing: dict = {}
        if ypath.is_file():
            loaded = yaml.safe_load(ypath.read_text(encoding="utf-8")) or {}
            if isinstance(loaded, dict):
                existing = loaded

        if permissions is None:
            permissions = existing.get("permissions")
        if permissions is None:
            permissions = {
                "notes": (
                    "player_visible / player_editable / gm_only; "
                    "formula fields are read-only except recomputation"
                )
            }

        merged_fields: dict = {}
        if isinstance(existing.get("fields"), dict):
            for k, v in existing["fields"].items():
                if isinstance(v, dict):
                    merged_fields[k] = dict(v)
        for k, v in fields_in.items():
            if not isinstance(v, dict):
                continue
            base = merged_fields.get(k, {})
            entry = {**base, **v}
            if entry.get("formula"):
                entry["editable"] = False
            merged_fields[k] = entry

        out = {
            "id": sheet_id,
            "name": name,
            "permissions": permissions,
            "fields": merged_fields,
        }
        widgets = layout_in.get("widgets") if isinstance(layout_in.get("widgets"), list) else []
        if widgets:
            out["layout"] = {"widgets": widgets}
        elif isinstance(existing.get("layout"), dict):
            out["layout"] = existing["layout"]

        g_nodes = graph_in.get("nodes") if isinstance(graph_in.get("nodes"), list) else []
        g_edges = graph_in.get("edges") if isinstance(graph_in.get("edges"), list) else []
        g_collapsed = (
            graph_in.get("collapsed") if isinstance(graph_in.get("collapsed"), list) else []
        )
        if g_nodes or g_edges or g_collapsed:
            out["graph"] = {
                "nodes": g_nodes,
                "edges": g_edges,
                "collapsed": g_collapsed,
            }
        elif isinstance(existing.get("graph"), dict):
            out["graph"] = existing["graph"]

        ypath.parent.mkdir(parents=True, exist_ok=True)
        dumped = yaml.safe_dump(
            out,
            sort_keys=False,
            default_flow_style=False,
            allow_unicode=True,
        )
        header = (
            f"# {name} sheet — declarative fields + closed formulas.\n"
            f"# Compiled from editor-scratch/sheets/{sheet_id}.builder.json "
            f"(sheet builder).\n"
        )
        ypath.write_text(header + dumped, encoding="utf-8")

        # Keep scratch in sync
        self._write_builder_scratch(sheet_id, body if isinstance(body, dict) else {})

        self._send_json(
            200,
            {
                "ok": True,
                "sheet_id": sheet_id,
                "path": f"build/sheets/{sheet_id}.yaml",
                "fields": list(merged_fields.keys()),
            },
        )

    def _api_library(self) -> None:
        actors = []
        actors_dir = self.campaign_root / "world" / "actors"
        if actors_dir.is_dir():
            for path in sorted(actors_dir.glob("*.yaml")):
                try:
                    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
                except Exception as e:  # noqa: BLE001
                    actors.append(
                        {
                            "id": path.stem,
                            "name": path.stem,
                            "error": str(e),
                            "has_sheet": False,
                        }
                    )
                    continue
                actor_id = data.get("id") or path.stem
                sheet_rel = data.get("sheet_doc") or f"world/actors/{actor_id}.sheet.txt"
                sheet_path = self._resolve_under_campaign(sheet_rel)
                has_sheet = bool(sheet_path and sheet_path.is_file())
                appearance = data.get("appearance") if isinstance(data.get("appearance"), dict) else {}
                try:
                    size_tiles = float(appearance.get("size_tiles", 1))
                except (TypeError, ValueError):
                    size_tiles = 1.0
                if size_tiles <= 0:
                    size_tiles = 1.0
                actors.append(
                    {
                        "id": actor_id,
                        "name": data.get("name") or actor_id,
                        "sheet": data.get("sheet") or data.get("sheet_id"),
                        "sheet_doc": sheet_rel if has_sheet else None,
                        "has_sheet": has_sheet,
                        "token_capable": True,
                        "appearance": library_appearance(appearance, size_tiles),
                        "size_tiles": size_tiles,
                        "aura_fields": aura_field_values(data.get("fields")),
                    }
                )

        scenes = []
        scenes_dir = self.campaign_root / "world" / "scenes"
        if scenes_dir.is_dir():
            for path in sorted(scenes_dir.glob("*.yaml")):
                try:
                    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
                except Exception:  # noqa: BLE001
                    data = {}
                scenes.append(
                    {
                        "id": data.get("id") or path.stem,
                        "name": data.get("name") or path.stem,
                        "map": data.get("map") if isinstance(data, dict) else None,
                    }
                )

        org = cm.load_organization(self.campaign_root)
        self._send_json(
            200,
            {
                "campaign": str(self.campaign_root),
                "actors": actors,
                "scenes": scenes,
                "maps": cm.maps_summary(self.campaign_root),
                "organization": org,
            },
        )



    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path.startswith("/api/players/"):
            pid = path[len("/api/players/"):].strip("/")
            try:
                self.player_hub.gm_forget(pid)
            except LookupError as exc:
                self._send_json(404, {"error": str(exc)})
                return
            self._send_json(200, {"ok": True})
            return

        for prefix, panel in (("/api/actor/", "actors"), ("/api/map/", "maps"), ("/api/scene/", "scenes")):
            if path.startswith(prefix) and "/" not in path[len(prefix):].strip("/"):
                eid = path[len(prefix):].strip("/")
                try:
                    out = cm.delete_entity(self.campaign_root, panel, eid)
                except cm.OrgError as exc:
                    code = 404 if "not found" in str(exc) else 400
                    self._send_json(code, {"error": str(exc)})
                    return
                self._send_json(200, out)
                return

        if path.startswith("/api/mechanics/"):
            name = path[len("/api/mechanics/") :].strip("/")
            if "/" in name or not safe_mechanic_name(name):
                self._send_json(400, {"error": "invalid mechanic name"})
                return
            self._api_mechanics_delete(name)
            return

        self._send_json(404, {"error": "not found"})

    def _mechanics_dir(self) -> Path:
        return self.campaign_root / "editor-scratch" / "mechanics"

    def _mechanic_path(self, name: str) -> Path:
        return self._mechanics_dir() / f"{name}.json"

    def _api_mechanics_list(self) -> None:
        mdir = self._mechanics_dir()
        out = []
        if mdir.is_dir():
            for p in sorted(mdir.glob("*.json")):
                name = p.stem
                if not safe_mechanic_name(name):
                    continue
                out.append(
                    {
                        "name": name,
                        "path": f"editor-scratch/mechanics/{name}.json",
                    }
                )
        self._send_json(200, {"mechanics": out})

    def _api_mechanics_get(self, name: str) -> None:
        path = self._mechanic_path(name)
        if not path.is_file():
            self._send_json(404, {"error": f"mechanic not found: {name}"})
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            self._send_json(500, {"error": "invalid mechanic JSON"})
            return
        if not isinstance(data, dict):
            self._send_json(500, {"error": "mechanic JSON must be an object"})
            return
        self._send_json(200, data)

    def _api_mechanics_put(self, name: str, body) -> None:
        if not isinstance(body, dict):
            self._send_json(400, {"error": "body must be an object"})
            return
        body_name = str(body.get("name") or "").strip()
        if body_name != name:
            self._send_json(
                400,
                {
                    "error": (
                        f'body.name must match path name "{name}" '
                        f'(got "{body_name}")'
                    )
                },
            )
            return
        if not safe_mechanic_name(name):
            self._send_json(400, {"error": "invalid mechanic name"})
            return
        nodes = body.get("nodes") if isinstance(body.get("nodes"), list) else []
        edges = body.get("edges") if isinstance(body.get("edges"), list) else []
        collapsed = (
            body.get("collapsed") if isinstance(body.get("collapsed"), list) else []
        )
        doc = {"name": name, "nodes": nodes, "edges": edges}
        if collapsed:
            doc["collapsed"] = collapsed
        mdir = self._mechanics_dir()
        mdir.mkdir(parents=True, exist_ok=True)
        path = self._mechanic_path(name)
        path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        self._send_json(
            200,
            {
                "ok": True,
                "name": name,
                "path": f"editor-scratch/mechanics/{name}.json",
                "node_count": len(nodes),
            },
        )

    def _api_mechanics_delete(self, name: str) -> None:
        path = self._mechanic_path(name)
        if not path.is_file():
            self._send_json(404, {"error": f"mechanic not found: {name}"})
            return
        path.unlink()
        self._send_json(200, {"ok": True, "name": name})

    def _merge_graph_into_yaml(self, sheet_id: str, graph: dict) -> bool:
        """Update build yaml graph nodes/edges in place; preserve fields/layout."""
        ypath = self._sheet_yaml_path(sheet_id)
        if not ypath.is_file():
            return False
        loaded = yaml.safe_load(ypath.read_text(encoding="utf-8")) or {}
        if not isinstance(loaded, dict):
            return False
        sheet_name = str(loaded.get("name") or sheet_id)
        nodes = graph.get("nodes") if isinstance(graph.get("nodes"), list) else []
        edges = graph.get("edges") if isinstance(graph.get("edges"), list) else []
        loaded["graph"] = {"nodes": list(nodes), "edges": list(edges)}
        dumped = yaml.safe_dump(
            loaded,
            sort_keys=False,
            default_flow_style=False,
            allow_unicode=True,
        )
        header = (
            f"# {sheet_name} sheet — declarative fields + closed formulas.\n"
            f"# Compiled from editor-scratch/sheets/{sheet_id}.builder.json "
            f"(sheet builder).\n"
        )
        ypath.write_text(header + dumped, encoding="utf-8")
        return True

    def _api_sheet_import_mechanic(self, sheet_id: str, body) -> None:
        if not isinstance(body, dict):
            self._send_json(400, {"error": "body must be an object"})
            return
        name = str(body.get("name") or "").strip()
        if not safe_mechanic_name(name):
            self._send_json(400, {"error": "invalid or missing mechanic name"})
            return
        mpath = self._mechanic_path(name)
        if not mpath.is_file():
            self._send_json(404, {"error": f"mechanic not found: {name}"})
            return
        try:
            mech = json.loads(mpath.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            self._send_json(500, {"error": "invalid mechanic JSON"})
            return
        if not isinstance(mech, dict):
            self._send_json(500, {"error": "mechanic JSON must be an object"})
            return
        mech_nodes = mech.get("nodes") if isinstance(mech.get("nodes"), list) else []
        mech_edges = mech.get("edges") if isinstance(mech.get("edges"), list) else []
        mech_collapsed = (
            mech.get("collapsed") if isinstance(mech.get("collapsed"), list) else []
        )

        scratch = self._builder_scratch_path(sheet_id)
        doc = None
        if scratch.is_file():
            try:
                doc = json.loads(scratch.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                self._send_json(500, {"error": "invalid builder JSON"})
                return
        if not isinstance(doc, dict):
            seeded = self._seed_builder_from_yaml(sheet_id)
            doc = (
                seeded
                if isinstance(seeded, dict)
                else {
                    "sheet_id": sheet_id,
                    "name": sheet_id,
                    "fields": {},
                    "layout": {"widgets": []},
                    "graph": {"nodes": [], "edges": [], "collapsed": []},
                }
            )

        g = doc.get("graph") if isinstance(doc.get("graph"), dict) else {}
        existing_nodes = list(
            g.get("nodes") if isinstance(g.get("nodes"), list) else []
        )
        existing_edges = list(
            g.get("edges") if isinstance(g.get("edges"), list) else []
        )
        existing_collapsed = list(
            g.get("collapsed") if isinstance(g.get("collapsed"), list) else []
        )

        if name in entry_names_in_nodes(existing_nodes):
            self._send_json(
                409,
                {
                    "error": (
                        f'Sheet already has an entry function named "{name}". '
                        "Rename or remove it before importing."
                    )
                },
            )
            return

        new_nodes, new_edges, new_collapsed, _id_map = remap_mechanic_subgraph(
            mech_nodes, mech_edges, mech_collapsed
        )

        max_x = 0.0
        for n in existing_nodes:
            if isinstance(n, dict):
                try:
                    max_x = max(max_x, float(n.get("x") or 0) + 140)
                except (TypeError, ValueError):
                    pass
        ox = max(40.0, max_x + 40.0) if existing_nodes else 40.0
        oy = 40.0
        min_x = min(
            (float(n.get("x") or 0) for n in new_nodes if isinstance(n, dict)),
            default=0.0,
        )
        min_y = min(
            (float(n.get("y") or 0) for n in new_nodes if isinstance(n, dict)),
            default=0.0,
        )
        dx = ox - min_x
        dy = oy - min_y
        for n in new_nodes:
            if isinstance(n, dict):
                try:
                    n["x"] = float(n.get("x") or 0) + dx
                    n["y"] = float(n.get("y") or 0) + dy
                except (TypeError, ValueError):
                    n["x"] = ox
                    n["y"] = oy
        for c in new_collapsed:
            if isinstance(c, dict):
                try:
                    c["x"] = float(c.get("x") or 0) + dx
                    c["y"] = float(c.get("y") or 0) + dy
                except (TypeError, ValueError):
                    c["x"] = ox
                    c["y"] = oy
        merged_nodes = existing_nodes + new_nodes
        merged_edges = existing_edges + new_edges
        merged_collapsed = existing_collapsed + new_collapsed
        doc["graph"] = {
            "nodes": merged_nodes,
            "edges": merged_edges,
            "collapsed": merged_collapsed,
        }
        doc.setdefault("sheet_id", sheet_id)
        self._write_builder_scratch(sheet_id, doc)
        self._merge_graph_into_yaml(
            sheet_id, {"nodes": merged_nodes, "edges": merged_edges}
        )

        self._send_json(
            200,
            {
                "ok": True,
                "sheet_id": sheet_id,
                "name": name,
                "graph_node_count": len(merged_nodes),
            },
        )



CLIP_TEXT_RE = re.compile(r"^[0-9A-Za-z.\-\[\]:]{1,80}$")


def create_server(
    campaign: Path,
    host: str = "127.0.0.1",
    port: int = 8765,
    *,
    app_dir: Path | None = None,
    quiet: bool = False,
    player_host: str | None = None,
    player_port: int | None = None,
) -> tuple[ThreadingHTTPServer, str]:
    """Bind and return (server, base_url). Does not serve_forever."""
    campaign = campaign.resolve()
    if not (campaign / "world" / "scenes").is_dir():
        raise FileNotFoundError(
            f"Not a campaign root (missing world/scenes): {campaign}"
        )

    Handler.campaign_root = campaign
    Handler.app_dir = (app_dir or default_app_dir()).resolve()
    Handler.quiet = quiet
    # 0.6.19 load-time migration (idempotent, backs up rewritten scenes)
    Handler.migration_report = cm.migrate_campaign(campaign)
    # 0.7.0 player session: hub always (GM endpoints); LAN listener only when asked.
    hub = ph.PlayerHub(campaign, sheet_payload=lambda aid: Handler.__new__(Handler).sheet_payload(aid))
    Handler.player_hub = hub
    Handler.player_server = None
    if player_port is not None:
        version = "0.0.0"
        try:
            version = (Handler.app_dir / "VERSION").read_text(encoding="utf-8").strip()
        except OSError:
            pass
        Handler.player_server = ph.start_player_listener(hub, player_host or "0.0.0.0", player_port, version, quiet=quiet)
        ph.net_addrs.warm()  # 0.7.1: rank join addresses in the background

    server = ThreadingHTTPServer((host, port), Handler)
    # If port was 0, pick the assigned one
    bound_host, bound_port = server.server_address[:2]
    base = f"http://{bound_host}:{bound_port}"
    return server, base
