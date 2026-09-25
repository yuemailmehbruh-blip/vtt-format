"""Local (loopback-only) HTTP server for GM Session Player: serves the player UI
and the shared sheet renderer (sheet.html / sheet.js / sheet-runtime.js from
gm-session) against the local store, plus /papi/* for connection + sync status."""

from __future__ import annotations

import json
import mimetypes
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from player_client import GMError, SyncClient
from player_store import PlayerStore, sc

ACTOR_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
SHARED_UI = ("sheet.html", "sheet.js", "sheet-runtime.js", "image-xform.js", "token-auras.js",
             "session.js", "org-tree.js", "infer-grid-from-walls.js")
PLAYER_FLAG = '<script>window.GM_PLAYER_MODE = true;</script>'
UI_DEFAULTS = {"showGrid": True, "snapToGrid": True, "snapTarget": "center", "showNametags": True, "snapLayers": False}


def ui_dirs() -> tuple[Path, Path]:
    """(player ui dir, gm-session ui dir) for dev tree or a PyInstaller bundle."""
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        return base / "player-session", base / "gm-session"
    here = Path(__file__).resolve().parent
    return here, here.parent / "gm-session"


def app_version() -> str:
    for d in ui_dirs():
        p = d / "VERSION"
        if p.is_file():
            return p.read_text(encoding="utf-8").strip()
    return "0.0.0"


class LocalHandler(BaseHTTPRequestHandler):
    store: PlayerStore = None  # type: ignore[assignment]
    client: SyncClient = None  # type: ignore[assignment]
    quiet = True

    def log_message(self, fmt, *args):
        if not self.quiet:
            super().log_message(fmt, *args)

    def _json(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _file(self, path: Path):
        if not path.is_file():
            self._json(404, {"error": "not found"})
            return
        data = path.read_bytes()
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix == ".js":
            ctype = "application/javascript"
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith(("text/", "application/javascript")) else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 2_000_000:
            raise ValueError("too large")
        body = json.loads((self.rfile.read(n) if n else b"{}").decode("utf-8") or "{}")
        if not isinstance(body, dict):
            raise ValueError("body must be an object")
        return body

    def _html(self, text: str):
        data = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _bytes(self, data: bytes):
        ctype = "application/octet-stream"
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            ctype = "image/png"
        elif data[:3] == b"\xff\xd8\xff":
            ctype = "image/jpeg"
        elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            ctype = "image/webp"
        elif data[:6] in (b"GIF87a", b"GIF89a"):
            ctype = "image/gif"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    def _library(self) -> dict:
        """Same shape as the GM's /api/library, from the local cache: token actors of
        the current scene (for drawing) + this player's assigned sheets."""
        view = self.store.load_view()
        mine = {x["id"]: x for x in self.store.list_sheets()}
        actors = []
        for aid, a in (view.get("actors") or {}).items():
            actors.append({**a, "assigned": aid in mine, "has_sheet": aid in mine, "token_capable": False})
        for aid, x in mine.items():
            if aid not in (view.get("actors") or {}):
                actors.append({"id": aid, "name": x["name"], "assigned": True, "has_sheet": True,
                               "token_capable": False, "appearance": {"size_tiles": 1}, "size_tiles": 1,
                               "aura_fields": {}})
            else:
                for a in actors:
                    if a["id"] == aid:
                        a["name"] = x["name"]
        for a in actors:
            a["pending"] = (mine.get(a["id"]) or {}).get("pending", 0)
        scn = view.get("scene")
        return {"campaign": self.store.cfg.get("campaign_name") or "", "actors": actors,
                "scenes": [{"id": scn["id"], "name": scn.get("name")}] if scn else [],
                "maps": [], "organization": {"actors": [], "maps": [], "scenes": []},
                "player": True}

    def _status(self):
        st = dict(self.client.status)
        cfg = self.store.cfg
        return {
            **st,
            "player_id": self.store.player_id,
            "name": cfg.get("name"),
            "gm": cfg.get("gm"),
            "last_gm": cfg.get("last_gm") or cfg.get("gm"),
            "join_code_set": bool(cfg.get("join_code")),
            "campaign_name": cfg.get("campaign_name"),
            "sheets": self.store.list_sheets(),
            "version": app_version(),
            "now": time.time(),
        }

    def _local_only(self) -> bool:
        """Loopback server, but a web page in some browser could still aim requests at
        it: require a loopback Host (blocks DNS rebinding) and, for writes, no
        foreign Origin (blocks cross-site form/fetch posts)."""
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        if host not in ("127.0.0.1", "localhost", "::1"):
            self._json(403, {"error": "local access only"})
            return False
        origin = self.headers.get("Origin")
        if self.command != "GET" and origin and urlparse(origin).hostname not in ("127.0.0.1", "localhost", "::1"):
            self._json(403, {"error": "cross-site request refused"})
            return False
        return True

    def do_GET(self):  # noqa: N802
        if not self._local_only():
            return
        path = unquote(urlparse(self.path).path)
        pdir, gdir = ui_dirs()
        if path in ("/", "/join.html"):
            return self._file(pdir / "join.html")
        if path == "/join.js":
            return self._file(pdir / "join.js")
        if path in ("/index.html", "/session.html"):
            # 0.7.1: the player main window IS the GM window (same index.html +
            # session.js) in player mode: read-only map, Characters + Chat sidebar.
            return self._html((gdir / "index.html").read_text(encoding="utf-8").replace("<head>", "<head>" + PLAYER_FLAG, 1))
        if path == "/player.html":
            return self._file(pdir / "player.html")
        if path == "/player.js":
            return self._file(pdir / "player.js")
        if path.lstrip("/") in SHARED_UI:
            return self._file(gdir / path.lstrip("/"))
        if path == "/papi/status":
            return self._json(200, self._status())
        q = parse_qs(urlparse(self.path).query)
        if path == "/papi/live":
            try:
                since = int(q.get("since", ["-1"])[0])
                timeout = float(q.get("timeout", ["20"])[0])
            except ValueError:
                return self._json(400, {"error": "bad since/timeout"})
            rev = self.client.wait_local(since, timeout)
            chat = self.store.load_chat()
            view = self.store.load_view()
            return self._json(200, {"rev": rev, "live": self.client.live, "status": self._status(),
                                    "scene_id": (view.get("scene") or {}).get("id"),
                                    "map_rev": view.get("rev"), "chat_seq": chat.get("seq"), "chat_epoch": chat.get("epoch")})
        if path == "/api/library":
            return self._json(200, self._library())
        if path.startswith("/api/scene/"):
            sid = path[len("/api/scene/"):].strip("/")
            sc_ = self.store.load_view().get("scene")
            if not sc_ or sc_.get("id") != sid:
                return self._json(404, {"error": "not the GM's current scene"})
            return self._json(200, sc_)
        if path.startswith("/api/tokens/"):
            sid = path[len("/api/tokens/"):].strip("/")
            v = self.store.load_view()
            toks = v.get("tokens") if (v.get("scene") or {}).get("id") == sid else []
            return self._json(200, {"scene": sid, "tokens": toks})
        if path == "/api/ui" or path.startswith("/api/ui/"):
            return self._json(200, dict(UI_DEFAULTS))
        if path.startswith("/assets/"):
            data = self.store.asset_bytes(path[len("/assets/"):].strip("/"))
            if data is None:
                return self._json(404, {"error": "asset not cached"})
            return self._bytes(data)
        if path == "/api/chat":
            chat = self.store.load_chat()
            try:
                after = int(q.get("after", ["0"])[0])
            except ValueError:
                after = 0
            if q.get("epoch", [None])[0] not in (None, chat.get("epoch")):
                after = 0
            return self._json(200, {"epoch": chat.get("epoch"), "seq": chat.get("seq"),
                                    "entries": [e for e in chat["entries"] if e.get("seq", 0) > after]})
        if path == "/api/mechanics":
            return self._json(200, {"mechanics": []})
        if path.startswith("/api/sheet/") and path.endswith("/rev"):
            aid = path[len("/api/sheet/"):-len("/rev")].strip("/")
            return self._json(200, {"rev": self.store.rev(aid) if ACTOR_ID_RE.match(aid) else "-"})
        if path.startswith("/api/sheet/"):
            aid = path[len("/api/sheet/"):].strip("/")
            payload = self.store.sheet_payload(aid) if ACTOR_ID_RE.match(aid) else None
            if payload is None:
                return self._json(404, {"error": "sheet not on this computer (not assigned yet?)"})
            return self._json(200, payload)
        self._json(404, {"error": "not found"})

    def do_PUT(self):  # noqa: N802
        if not self._local_only():
            return
        path = unquote(urlparse(self.path).path)
        if path == "/api/ui" or path.startswith("/api/ui/"):
            return self._json(200, {"ok": True, "note": "view settings stay in this window"})
        try:
            if path.startswith("/api/actor/") and path.endswith("/fields"):
                aid = path[len("/api/actor/"):-len("/fields")].strip("/")
                fields = self._body().get("fields")
                if not ACTOR_ID_RE.match(aid) or not isinstance(fields, dict):
                    return self._json(400, {"error": 'body must be {"fields": {...}}'})
                vals = {f"fields.{k}": v for k, v in fields.items() if sc.FIELD_ID_RE.match(str(k))}
                out = self.store.local_edit(aid, vals)
                self.client.wake()
                return self._json(200, {"ok": True, "actor_id": aid, "fields": self.store.sheet_payload(aid)["fields"], **out})
            if path.startswith("/api/sheet/"):
                aid = path[len("/api/sheet/"):].strip("/")
                text = self._body().get("text")
                if not ACTOR_ID_RE.match(aid) or not isinstance(text, str):
                    return self._json(400, {"error": 'body must be {"text": "..."}'})
                out = self.store.local_edit(aid, {"notes": text})
                self.client.wake()
                return self._json(200, {"ok": True, "path": "synced to the GM", **out})
        except LookupError as exc:
            return self._json(404, {"error": str(exc)})
        except (ValueError, sc.SyncError) as exc:
            return self._json(400, {"error": str(exc)})
        self._json(403, {"error": "read-only in the player app"})

    def do_POST(self):  # noqa: N802
        if not self._local_only():
            return
        path = unquote(urlparse(self.path).path)
        try:
            if path == "/api/token-move":
                try:
                    return self._json(200, self.client.move_token(self._body()))
                except GMError as exc:
                    return self._json(exc.status if 400 <= exc.status < 500 else 502, {"error": str(exc)})
                except OSError:
                    return self._json(503, {"error": "not connected to the GM"})
            if path == "/api/chat":
                body = self._body()
                try:
                    out = self.client.post_chat(body)
                except GMError as exc:
                    return self._json(exc.status if 400 <= exc.status < 500 else 502, {"error": str(exc)})
                except (OSError, ValueError):
                    return self._json(503, {"error": "not connected to the GM — message not sent"})
                return self._json(200, out)
            if path == "/papi/connect":
                b = self._body()
                self.client.configure(str(b.get("gm") or ""), str(b.get("name") or ""), str(b.get("join_code") or ""))
                return self._json(200, {"ok": True, **self._status()})
            if path == "/papi/disconnect":
                self.client.disconnect()
                return self._json(200, {"ok": True})
            if path == "/papi/sync-now":
                ok = self.client.sync_once()
                return self._json(200 if ok else 502, self._status())
            if path.startswith("/papi/fullsync/"):
                aid = path[len("/papi/fullsync/"):].strip("/")
                if not ACTOR_ID_RE.match(aid):
                    return self._json(400, {"error": "bad sheet id"})
                return self._json(200, self.client.full_push(aid))
        except GMError as exc:
            return self._json(502, {"error": f"GM: {exc}"})
        except LookupError as exc:
            return self._json(404, {"error": str(exc)})
        except (ValueError, sc.SyncError, OSError) as exc:
            return self._json(400, {"error": str(exc)})
        self._json(403, {"error": "read-only in the player app"})

    do_DELETE = do_POST


def create_local_server(store: PlayerStore, client: SyncClient, port: int = 0, quiet: bool = True):
    handler = type("BoundLocalHandler", (LocalHandler,), {"store": store, "client": client, "quiet": quiet})
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler)
    srv.daemon_threads = True
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"
