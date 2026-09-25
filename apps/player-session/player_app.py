#!/usr/bin/env python3
"""GM Session Player: connect to a GM's session, receive the character sheets the
GM assigns to you, edit them (offline too), and stay in sync every 2 seconds."""

from __future__ import annotations

import argparse
import logging
import re
import sys
import threading
from pathlib import Path

from player_client import SyncClient
from player_server import app_version, create_local_server
from player_store import PlayerStore, default_data_dir

logger = logging.getLogger("gm_session_player")


def main() -> None:
    ap = argparse.ArgumentParser(description="GM Session Player")
    ap.add_argument("--data-dir", type=Path, default=None, help="local data dir (default: per-user app data)")
    ap.add_argument("--port", type=int, default=0, help="local UI port (loopback; 0 = any free port)")
    ap.add_argument("--gm", default=None, help="GM address host:port to connect to")
    ap.add_argument("--name", default=None, help="display name")
    ap.add_argument("--join-code", default="", help="optional join code")
    ap.add_argument("--headless", action="store_true", help="no window: local server + sync only (tests)")
    args = ap.parse_args()

    store = PlayerStore(args.data_dir or default_data_dir())
    client = SyncClient(store)
    if args.gm and args.name:
        client.configure(args.gm, args.name, args.join_code)
    elif store.cfg.get("gm") and store.cfg.get("name"):
        client.status["state"] = "connecting"
    srv, base = create_local_server(store, client, args.port)
    threading.Thread(target=srv.serve_forever, name="player-ui", daemon=True, kwargs={"poll_interval": 0.5}).start()
    client.start()
    print(f"GM Session Player {app_version()} · UI {base} · data {store.dir}", flush=True)

    if args.headless:
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass
        return

    try:
        import webview
    except ImportError:
        print("pywebview not installed; open the URL above in a browser", file=sys.stderr)
        threading.Event().wait()
        return
    if not args.gm:
        # 0.7.1: always start at the join window (name/address remembered for the form)
        client.disconnect()
    api = PlayerWindows(webview, base, client)
    if client.status.get("state") in ("connecting", "connected"):
        api._main = webview.create_window(f"GM Session Player {app_version()}", base + "/index.html", js_api=api,
                                         width=1280, height=840, min_size=(900, 600))
    else:
        api._join = webview.create_window(f"Join — GM Session Player {app_version()}", base + "/join.html", js_api=api,
                                         width=420, height=470, resizable=False)
    webview.start()
    client.stop()
    srv.shutdown()


class PlayerWindows:
    """JS bridge: join window → main window, sheet pop-outs, leave."""

    def __init__(self, webview, base: str, client: SyncClient) -> None:
        self._wv = webview
        self._base = base
        self._client = client
        self._join = None
        self._main = None
        self._sheets: dict[str, object] = {}

    def joined(self) -> str:
        if self._main is None or self._main not in self._wv.windows:
            self._main = self._wv.create_window(f"GM Session Player {app_version()}", self._base + "/index.html",
                                               js_api=self, width=1280, height=840, min_size=(900, 600))
        old, self._join = self._join, None
        if old is not None:
            threading.Timer(0.3, old.destroy).start()
        return "ok"

    def leave(self) -> str:
        self._client.disconnect()
        if self._join is None or self._join not in self._wv.windows:
            self._join = self._wv.create_window(f"Join — GM Session Player {app_version()}", self._base + "/join.html",
                                               js_api=self, width=420, height=470, resizable=False)
        for w in list(self._sheets.values()) + [self._main]:
            if w is not None and w in self._wv.windows:
                threading.Timer(0.3, w.destroy).start()
        self._sheets.clear()
        self._main = None
        return "ok"

    def open_sheet(self, actor_id: str) -> str:
        actor_id = str(actor_id or "").strip()
        if not re.match(r"^[A-Za-z0-9_.-]{1,120}$", actor_id):
            return "error: bad id"
        w = self._sheets.get(actor_id)
        if w is not None and w in self._wv.windows:
            try:
                w.restore()
                w.show()
            except Exception:  # noqa: BLE001
                pass
            return "focused"
        self._sheets[actor_id] = self._wv.create_window(
            f"Sheet — {actor_id}", f"{self._base}/sheet.html?actor={actor_id}&mode=player", js_api=self,
            width=920, height=780)
        return "ok"


if __name__ == "__main__":
    main()
