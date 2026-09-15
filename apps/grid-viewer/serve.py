#!/usr/bin/env python3
"""Static grid viewer + sample-campaign asset/scene server."""

from __future__ import annotations

import argparse
import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

try:
    import yaml
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "PyYAML is required. Install with: pip install -r "
        "../../packages/campaign-format/requirements.txt"
    ) from exc

APP_DIR = Path(__file__).resolve().parent
DEFAULT_CAMPAIGN = (
    APP_DIR.parent.parent / "examples" / "sample-campaign"
).resolve()


class Handler(BaseHTTPRequestHandler):
    campaign_root: Path = DEFAULT_CAMPAIGN

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.address_string()}] {fmt % args}")

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, code: int, obj) -> None:
        data = json.dumps(obj, indent=2).encode("utf-8")
        self._send(code, data, "application/json; charset=utf-8")

    def _send_file(self, path: Path) -> None:
        if not path.is_file():
            self._send(404, b"Not found\n", "text/plain; charset=utf-8")
            return
        ctype, _ = mimetypes.guess_type(str(path))
        if ctype is None:
            # Hash assets often have no extension.
            head = path.read_bytes()[:8]
            if head.startswith(b"\x89PNG\r\n\x1a\n"):
                ctype = "image/png"
            elif head[:3] == b"\xff\xd8\xff":
                ctype = "image/jpeg"
            elif head[:4] == b"RIFF" and head[8:12] == b"WEBP":
                ctype = "image/webp"
            else:
                ctype = "application/octet-stream"
        body = path.read_bytes()
        self._send(200, body, ctype)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path in ("/", "/index.html"):
            self._send_file(APP_DIR / "index.html")
            return
        if path == "/viewer.js":
            self._send_file(APP_DIR / "viewer.js")
            return
        if path == "/favicon.ico":
            self._send(204, b"", "image/x-icon")
            return

        if path.startswith("/api/scene/"):
            scene_id = path[len("/api/scene/") :].strip("/")
            if not scene_id or "/" in scene_id or ".." in scene_id:
                self._send_json(400, {"error": "invalid scene id"})
                return
            scene_path = (
                self.campaign_root / "world" / "scenes" / f"{scene_id}.yaml"
            )
            if not scene_path.is_file():
                self._send_json(404, {"error": f"scene not found: {scene_id}"})
                return
            with scene_path.open("r", encoding="utf-8") as fh:
                scene = yaml.safe_load(fh)
            self._send_json(200, scene)
            return

        if path.startswith("/assets/"):
            digest = path[len("/assets/") :].strip("/")
            if not digest or "/" in digest or ".." in digest:
                self._send(400, b"bad asset id\n", "text/plain; charset=utf-8")
                return
            asset_path = (
                self.campaign_root / "world" / "assets" / "by-hash" / digest
            )
            self._send_file(asset_path)
            return

        # Allow other static files from the app dir (e.g. README is not needed).
        rel = path.lstrip("/")
        candidate = (APP_DIR / rel).resolve()
        if candidate.is_file() and str(candidate).startswith(str(APP_DIR)):
            self._send_file(candidate)
            return

        self._send(404, b"Not found\n", "text/plain; charset=utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the grid viewer")
    parser.add_argument(
        "--campaign",
        type=Path,
        default=DEFAULT_CAMPAIGN,
        help="Path to campaign root (default: sample-campaign)",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--scene",
        default="docks",
        help="Default scene id opened by the viewer UI",
    )
    args = parser.parse_args()

    campaign = args.campaign.resolve()
    if not (campaign / "world" / "scenes").is_dir():
        raise SystemExit(f"Not a campaign root (missing world/scenes): {campaign}")

    Handler.campaign_root = campaign
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}/?scene={args.scene}"
    print(f"Campaign: {campaign}")
    print(f"Open:     {url}")
    print("Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
