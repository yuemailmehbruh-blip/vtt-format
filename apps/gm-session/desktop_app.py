#!/usr/bin/env python3
"""GM Session desktop app: local HTTP server + pywebview windows (no system browser)."""

from __future__ import annotations

import argparse
import json
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
from updater import check_and_offer_update, install_latest_release, load_version

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
    """JS bridge: open_sheet, open_rolls, appearance_saved, check_update."""

    def __init__(self, base_url: str, campaign_root: Path) -> None:
        self.base_url = base_url.rstrip("/")
        self.campaign_root = campaign_root
        self._sheets: dict[str, object] = {}
        self._rolls_window: object | None = None

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
            js_api=self,
            width=520,
            height=700,
            min_size=(360, 420),
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


    def open_rolls(self) -> str:
        """Open or focus a single reusable Rolls pop-out window."""
        existing = self._rolls_window
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

        url = f"{self.base_url}/rolls.html"
        window = webview.create_window(
            "Rolls",
            url,
            js_api=self,
            width=420,
            height=560,
            min_size=(320, 420),
        )
        self._rolls_window = window

        def _on_closed() -> None:
            if self._rolls_window is window:
                self._rolls_window = None

        try:
            window.events.closed += _on_closed
        except Exception:  # noqa: BLE001
            pass

        return "opened"

    def appearance_saved(self, actor_id: str, appearance=None) -> str:
        """Notify the main map window that an actor's appearance changed.

        Sheet window calls this after PUT /api/actor/<id>/appearance so tokens
        update without reload. Also safe if called with appearance from JS.
        """
        actor_id = (actor_id or "").strip()
        if not actor_id:
            return "error: missing actor_id"
        if appearance is None:
            appearance = {}
        if not isinstance(appearance, dict):
            try:
                appearance = dict(appearance)
            except Exception:  # noqa: BLE001
                appearance = {}
        payload_actor = json.dumps(actor_id)
        payload_app = json.dumps(appearance)
        js = (
            "window.__gmSessionApplyAppearance && "
            f"window.__gmSessionApplyAppearance({payload_actor}, {payload_app})"
        )
        # Prefer the main window (first); also try all in case ordering differs.
        notified = 0
        for win in list(webview.windows):
            try:
                win.evaluate_js(js)
                notified += 1
            except Exception:  # noqa: BLE001
                pass
        return f"notified:{notified}"

    def _push_update_status(self, message: str, done: bool = False) -> None:
        payload = json.dumps(message)
        flag = "true" if done else "false"
        js = f"window.__gmUpdateStatus && window.__gmUpdateStatus({payload}, {flag})"
        for win in list(webview.windows):
            try:
                win.evaluate_js(js)
            except Exception:  # noqa: BLE001
                pass

    def check_update(self) -> str:
        """JS bridge: Update app button — download latest Setup.exe, install, relaunch.

        Returns immediately so pywebview does not time out the JS call. Work runs
        on a background thread; status is pushed via window.__gmUpdateStatus.
        """
        if getattr(self, "_update_running", False):
            return "Update already running…"
        self._update_running = True

        def worker() -> None:
            import time

            def progress(msg: str) -> None:
                self._push_update_status(msg, done=False)

            try:
                # Dedicated button path — never short-circuits on version equality.
                quitting, message = install_latest_release(
                    local_version=load_version(default_app_dir()),
                    app_dir=default_app_dir(),
                    progress=progress,
                )
            except Exception as exc:  # noqa: BLE001
                logger.info("Update check error: %s", exc)
                message = f"Update failed: {exc}"
                quitting = False
            self._push_update_status(message, done=not quitting)
            self._update_running = False
            if quitting:
                time.sleep(0.6)
                for win in list(webview.windows):
                    try:
                        win.destroy()
                    except Exception:  # noqa: BLE001
                        pass

        threading.Thread(target=worker, name="gm-session-update", daemon=True).start()
        return "Looking for installer on GitHub…"


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
        # Closing the main window ends the app; sheet/rolls windows go with the process.
        for actor_id, win in list(api._sheets.items()):
            try:
                win.destroy()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                pass
            api._sheets.pop(actor_id, None)
        if api._rolls_window is not None:
            try:
                api._rolls_window.destroy()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                pass
            api._rolls_window = None
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
