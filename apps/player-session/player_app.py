#!/usr/bin/env python3
"""GM Session Player: connect to a GM's session, receive the character sheets the
GM assigns to you, edit them (offline too), and stay in sync every 2 seconds."""

from __future__ import annotations

import argparse
import logging
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
    webview.create_window(f"GM Session Player {app_version()}", base + "/", width=1200, height=820, min_size=(800, 560))
    webview.start()
    client.stop()
    srv.shutdown()


if __name__ == "__main__":
    main()
