#!/usr/bin/env python3
"""GM Session desktop app: local HTTP server + pywebview windows (no system browser)."""

from __future__ import annotations

import argparse
import logging
import shutil
import sys
import threading
from pathlib import Path
from urllib.parse import quote

from server_lib import (
    bundled_sample_campaign,
    create_server,
    default_app_dir,
    exe_dir,
    is_frozen,
    resolve_campaign_path,
)
from updater import check_and_offer_update, check_and_offer_update_with_status, load_version

try:
    import webview
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "pywebview is required for the desktop app.\n"
        "Install with: pip install pywebview\n"
        "(For browser-only debugging, use serve.py instead.)"
    ) from exc

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None  # type: ignore[assignment]


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_SCENE = "docks"

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("gm_session.desktop")


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


def _show_error(message: str) -> None:
    try:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.withdraw()
        messagebox.showerror("GM Session", message)
        root.destroy()
    except Exception:  # noqa: BLE001
        print(message, file=sys.stderr)


def _actor_title(campaign_root: Path, actor_id: str) -> str:
    path = campaign_root / "world" / "actors" / f"{actor_id}.yaml"
    if yaml is not None and path.is_file():
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            name = data.get("name")
            if name:
                return str(name)
        except Exception:  # noqa: BLE001
            pass
    return actor_id


class DesktopApi:
    """JS bridge: window.pywebview.api.open_sheet(actor_id)."""

    def __init__(self, base_url: str, campaign_root: Path) -> None:
        self.base_url = base_url.rstrip("/")
        self.campaign_root = campaign_root
        self._sheets: dict[str, object] = {}

    def open_sheet(self, actor_id: str) -> str:
        actor_id = (actor_id or "").strip()
        if not actor_id:
            return "error: missing actor_id"

        existing = self._sheets.get(actor_id)
        if existing is not None and existing in webview.windows:
            try:
                existing.show()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                pass
            try:
                existing.restore()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                pass
            return "focused"

        title = _actor_title(self.campaign_root, actor_id)
        url = f"{self.base_url}/sheet.html?actor={quote(actor_id, safe='')}"
        window = webview.create_window(
            title,
            url,
            width=480,
            height=640,
            min_size=(320, 400),
        )
        self._sheets[actor_id] = window

        def _on_closed() -> None:
            if self._sheets.get(actor_id) is window:
                del self._sheets[actor_id]

        try:
            window.events.closed += _on_closed
        except Exception:  # noqa: BLE001
            pass

        return "opened"

    def check_update(self) -> str:
        """JS bridge: window.pywebview.api.check_update() — same check as launch."""
        app_dir = default_app_dir()
        version = load_version(app_dir)
        try:
            quitting, message = check_and_offer_update_with_status(
                local_version=version, app_dir=app_dir
            )
        except Exception as exc:  # noqa: BLE001
            logger.info("Update check error: %s", exc)
            return f"Update check failed: {exc}"

        if quitting:
            def _quit_soon() -> None:
                import time

                time.sleep(0.4)
                for win in list(webview.windows):
                    try:
                        win.destroy()
                    except Exception:  # noqa: BLE001
                        pass

            threading.Thread(target=_quit_soon, name="gm-session-quit", daemon=True).start()
        return message


def _shutdown_server(server) -> None:
    try:
        server.shutdown()
    except Exception:  # noqa: BLE001
        pass
    try:
        server.server_close()
    except Exception:  # noqa: BLE001
        pass


def run_desktop(
    *,
    campaign: Path | None = None,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    scene: str = DEFAULT_SCENE,
    skip_update: bool = False,
) -> None:
    ensure_campaign_beside_exe()

    try:
        campaign_root = resolve_campaign_path(campaign)
    except FileNotFoundError as exc:
        _show_error(str(exc))
        raise SystemExit(1) from exc

    app_dir = default_app_dir()
    version = load_version(app_dir)
    logger.info("GM Session %s", version)

    try:
        server, base = create_server(
            campaign_root,
            host=host,
            port=port,
            app_dir=app_dir,
            quiet=True,
        )
    except OSError as exc:
        _show_error(f"Could not start server on {host}:{port}\n{exc}")
        raise SystemExit(1) from exc

    thread = threading.Thread(
        target=server.serve_forever,
        name="gm-session-http",
        daemon=True,
        kwargs={"poll_interval": 0.5},
    )
    thread.start()

    if not skip_update:
        try:
            if check_and_offer_update(local_version=version, app_dir=app_dir):
                _shutdown_server(server)
                raise SystemExit(0)
        except SystemExit:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.info("Update check error (continuing): %s", exc)

    url = f"{base}/?scene={quote(scene, safe='')}"
    api = DesktopApi(base, campaign_root)

    main = webview.create_window(
        "GM Session",
        url,
        js_api=api,
        width=1280,
        height=800,
        min_size=(800, 600),
    )

    def on_main_closed() -> None:
        # Closing the main window ends the app; sheet windows go with the process.
        for actor_id, win in list(api._sheets.items()):
            try:
                win.destroy()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                pass
            api._sheets.pop(actor_id, None)
        _shutdown_server(server)

    try:
        main.events.closed += on_main_closed
    except Exception:  # noqa: BLE001
        pass

    try:
        webview.start()
    finally:
        _shutdown_server(server)


def main() -> None:
    parser = argparse.ArgumentParser(description="GM Session desktop app (pywebview)")
    parser.add_argument("--campaign", type=Path, default=None)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--scene", default=DEFAULT_SCENE)
    parser.add_argument(
        "--skip-update",
        action="store_true",
        help="Skip GitHub Releases update check (debugging)",
    )
    # Kept for backward compatibility with old launchers; ignored (no system browser).
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    args = parser.parse_args()
    run_desktop(
        campaign=args.campaign,
        host=args.host,
        port=args.port,
        scene=args.scene,
        skip_update=args.skip_update,
    )


if __name__ == "__main__":
    main()
