#!/usr/bin/env python3
"""Offline GM Session CLI: static UI + campaign library / sheet / token API."""

from __future__ import annotations

import argparse
from pathlib import Path

from server_lib import bundled_sample_campaign, create_server, default_app_dir


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the offline GM Session app")
    parser.add_argument(
        "--campaign",
        type=Path,
        default=None,
        help="Path to campaign root (default: sample-campaign)",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--player-host", default="0.0.0.0", help="player listener bind address")
    parser.add_argument("--player-port", type=int, default=None, help="enable the player listener on this port (e.g. 8766)")
    parser.add_argument(
        "--scene",
        default="docks",
        help="Default scene id opened by the UI",
    )
    args = parser.parse_args()

    campaign = (args.campaign or bundled_sample_campaign()).resolve()
    if not (campaign / "world" / "scenes").is_dir():
        raise SystemExit(f"Not a campaign root (missing world/scenes): {campaign}")

    server, base = create_server(
        campaign,
        host=args.host,
        port=args.port,
        app_dir=default_app_dir(),
        quiet=False,
        player_host=args.player_host,
        player_port=args.player_port,
    )
    url = f"{base}/?scene={args.scene}"
    print("GM Session (offline)")
    print(f"Campaign: {campaign}")
    print(f"Open:     {url}")
    print("Tokens persist under state/tokens/<scene>.json")
    if args.player_port is not None:
        print(f"Players:  {args.player_host}:{args.player_port} (/player/api/*)")
    print("Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
