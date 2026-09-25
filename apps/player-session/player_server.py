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
from urllib.parse import unquote, urlparse

from player_client import GMError, SyncClient
from player_store import PlayerStore, sc

ACTOR_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
SHARED_UI = ("sheet.html", "sheet.js", "sheet-runtime.js", "image-xform.js", "token-auras.js")


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

    def _status(self):
        st = dict(self.client.status)
        cfg = self.store.cfg
        return {
            **st,
            "player_id": self.store.player_id,
            "name": cfg.get("name"),
            "gm": cfg.get("gm"),
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
        if path in ("/", "/index.html", "/player.html"):
            return self._file(pdir / "player.html")
        if path == "/player.js":
            return self._file(pdir / "player.js")
        if path.lstrip("/") in SHARED_UI:
            return self._file(gdir / path.lstrip("/"))
        if path == "/papi/status":
            return self._json(200, self._status())
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
