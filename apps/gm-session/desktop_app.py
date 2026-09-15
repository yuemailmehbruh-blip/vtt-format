#!/usr/bin/env python3
"""Windows-friendly GM Session desktop launcher (tkinter + embedded HTTP server)."""

from __future__ import annotations

import argparse
import shutil
import threading
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import messagebox

from server_lib import (
    bundled_sample_campaign,
    create_server,
    default_app_dir,
    exe_dir,
    is_frozen,
    resolve_campaign_path,
)


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_SCENE = "docks"


def ensure_campaign_beside_exe() -> Path | None:
    """
    If frozen and campaign/ is missing beside the exe, copy the bundled sample
    there so the user has an editable campaign folder.
    Returns the campaign path when copied or already present; None if not frozen.
    """
    if not is_frozen():
        return None

    dest = exe_dir() / "campaign"
    if (dest / "world" / "scenes").is_dir():
        return dest.resolve()

    sample = bundled_sample_campaign()
    if not (sample / "world" / "scenes").is_dir():
        return None

    try:
        if dest.exists():
            # Incomplete/corrupt — leave alone and fall back to bundled
            return None
        shutil.copytree(sample, dest)
        return dest.resolve()
    except OSError:
        return None


def run_desktop(
    *,
    campaign: Path | None = None,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    scene: str = DEFAULT_SCENE,
    open_browser: bool = True,
) -> None:
    ensure_campaign_beside_exe()

    try:
        campaign_root = resolve_campaign_path(campaign)
    except FileNotFoundError as exc:
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror("GM Session", str(exc))
        root.destroy()
        raise SystemExit(1) from exc

    app_dir = default_app_dir()
    try:
        server, base = create_server(
            campaign_root,
            host=host,
            port=port,
            app_dir=app_dir,
            quiet=True,
        )
    except OSError as exc:
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(
            "GM Session",
            f"Could not start server on {host}:{port}\n{exc}",
        )
        root.destroy()
        raise SystemExit(1) from exc

    url = f"{base}/?scene={scene}"

    thread = threading.Thread(
        target=server.serve_forever,
        name="gm-session-http",
        daemon=True,
        kwargs={"poll_interval": 0.5},
    )
    thread.start()

    root = tk.Tk()
    root.title("GM Session")
    root.resizable(False, False)
    root.minsize(420, 140)

    frame = tk.Frame(root, padx=16, pady=14)
    frame.pack(fill=tk.BOTH, expand=True)

    tk.Label(frame, text="GM Session", font=("Segoe UI", 14, "bold")).pack(
        anchor="w"
    )
    tk.Label(
        frame,
        text=f"URL: {url}\nCampaign: {campaign_root}",
        justify=tk.LEFT,
        font=("Segoe UI", 9),
        wraplength=480,
    ).pack(anchor="w", pady=(8, 12))

    btn_row = tk.Frame(frame)
    btn_row.pack(anchor="e", fill=tk.X)

    def open_ui() -> None:
        webbrowser.open(url)

    def quit_app() -> None:
        try:
            server.shutdown()
        except Exception:  # noqa: BLE001
            pass
        try:
            server.server_close()
        except Exception:  # noqa: BLE001
            pass
        root.destroy()

    tk.Button(btn_row, text="Open in browser", command=open_ui).pack(
        side=tk.LEFT, padx=(0, 8)
    )
    tk.Button(btn_row, text="Quit", width=10, command=quit_app).pack(side=tk.RIGHT)

    root.protocol("WM_DELETE_WINDOW", quit_app)

    if open_browser:
        root.after(300, open_ui)

    try:
        root.mainloop()
    finally:
        try:
            server.shutdown()
        except Exception:  # noqa: BLE001
            pass
        try:
            server.server_close()
        except Exception:  # noqa: BLE001
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="GM Session desktop launcher")
    parser.add_argument("--campaign", type=Path, default=None)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--scene", default=DEFAULT_SCENE)
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Do not open the default browser automatically",
    )
    args = parser.parse_args()
    run_desktop(
        campaign=args.campaign,
        host=args.host,
        port=args.port,
        scene=args.scene,
        open_browser=not args.no_browser,
    )


if __name__ == "__main__":
    main()
