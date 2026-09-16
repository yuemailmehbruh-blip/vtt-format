"""Check GitHub Releases for a newer GM Session installer and offer to install it."""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

logger = logging.getLogger("gm_session.updater")

REPO = "yuemailmehbruh-blip/vtt-format"
RELEASES_LATEST = f"https://api.github.com/repos/{REPO}/releases/latest"
SETUP_ASSET_NAME = "GM-Session-Setup.exe"
USER_AGENT = "GM-Session-Updater"


def load_version(app_dir: Path | None = None) -> str:
    """Read local VERSION (plain text semver)."""
    candidates: list[Path] = []
    if app_dir is not None:
        candidates.append(Path(app_dir) / "VERSION")
    here = Path(__file__).resolve().parent
    candidates.append(here / "VERSION")
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        root = Path(sys._MEIPASS)  # type: ignore[attr-defined]
        candidates.append(root / "gm-session" / "VERSION")
        candidates.append(root / "VERSION")
    for path in candidates:
        try:
            if path.is_file():
                return path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
    return "0.0.0"


def _normalize_semver(tag: str) -> tuple[int, ...]:
    raw = (tag or "").strip()
    if raw.lower().startswith("v"):
        raw = raw[1:]
    # Take leading dotted numeric part (ignore -beta etc. for comparison)
    m = re.match(r"^(\d+(?:\.\d+)*)", raw)
    if not m:
        return (0,)
    return tuple(int(p) for p in m.group(1).split("."))


def version_is_newer(remote: str, local: str) -> bool:
    return _normalize_semver(remote) > _normalize_semver(local)


def _token_from_gh_hosts(path: Path) -> str | None:
    """Best-effort parse of GitHub CLI hosts.yml for an oauth_token."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    # Minimal YAML-ish: look for oauth_token: value under github.com
    in_github = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("github.com"):
            in_github = True
            continue
        if in_github and stripped and not line[:1].isspace() and ":" in stripped:
            # New top-level key
            if not stripped.startswith("oauth_token"):
                in_github = False
        if in_github and "oauth_token" in stripped:
            # oauth_token: gho_...
            parts = stripped.split(":", 1)
            if len(parts) == 2:
                tok = parts[1].strip().strip("'\"")
                if tok:
                    return tok
    return None


def find_github_token() -> str | None:
    env = os.environ.get("GM_SESSION_GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if env and env.strip():
        return env.strip()

    local_app = os.environ.get("LOCALAPPDATA")
    if local_app:
        token_file = Path(local_app) / "GM Session" / "github_token.txt"
        try:
            if token_file.is_file():
                tok = token_file.read_text(encoding="utf-8").strip()
                if tok:
                    return tok
        except OSError:
            pass

    # Windows gh config; also try XDG / home for Linux/macOS
    candidates: list[Path] = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(Path(appdata) / "GitHub CLI" / "hosts.yml")
    home = Path.home()
    candidates.append(home / ".config" / "gh" / "hosts.yml")
    for path in candidates:
        tok = _token_from_gh_hosts(path)
        if tok:
            return tok
    return None


def _http_json(url: str, token: str | None) -> dict | None:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        logger.info("Release check failed: %s", exc)
        return None


def _download(url: str, dest: Path, token: str | None) -> bool:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/octet-stream"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp, dest.open("wb") as out:
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                out.write(chunk)
        return dest.is_file() and dest.stat().st_size > 0
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as exc:
        logger.info("Download failed: %s", exc)
        try:
            if dest.exists():
                dest.unlink()
        except OSError:
            pass
        return False


def find_setup_asset(release: dict) -> tuple[str, str] | None:
    """Return (browser_download_url, name) for GM-Session-Setup.exe if present."""
    for asset in release.get("assets") or []:
        name = asset.get("name") or ""
        if name == SETUP_ASSET_NAME or name.lower() == SETUP_ASSET_NAME.lower():
            url = asset.get("browser_download_url")
            if url:
                return str(url), str(name)
    return None


def _ask_user(remote_tag: str, local_version: str) -> bool:
    """Native yes/no dialog. Returns True if user wants to update."""
    message = (
        f"Update {remote_tag} is available (you have {local_version}).\n\n"
        "Download and install? The installer will open; this app will quit "
        "so files can be replaced."
    )
    try:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        result = messagebox.askyesno("GM Session — Update", message)
        root.destroy()
        return bool(result)
    except Exception:  # noqa: BLE001
        logger.info("Could not show update dialog; skipping update prompt")
        return False


def launch_installer(path: Path) -> None:
    path = path.resolve()
    if sys.platform == "win32":
        os.startfile(str(path))  # type: ignore[attr-defined]
    else:
        subprocess.Popen([str(path)], start_new_session=True)


def check_and_offer_update(*, local_version: str | None = None, app_dir: Path | None = None) -> bool:
    """
    Check GitHub Releases for a newer Setup.exe. If the user accepts, download,
    launch the installer, and return True (caller should quit). Otherwise False.

    On auth/network failure, skip silently (log only).
    """
    local = local_version or load_version(app_dir)
    token = find_github_token()

    release = _http_json(RELEASES_LATEST, token)
    if release is None and token is None:
        # Private repo likely — try again is pointless without token
        logger.info("No release info (unauthenticated); skipping update")
        return False
    if release is None:
        logger.info("No release info with token; skipping update")
        return False

    tag = str(release.get("tag_name") or release.get("name") or "").strip()
    if not tag:
        logger.info("Release has no tag; skipping update")
        return False

    if not version_is_newer(tag, local):
        logger.info("Up to date (local=%s remote=%s)", local, tag)
        return False

    asset = find_setup_asset(release)
    if asset is None:
        logger.info("Release %s has no %s asset; skipping", tag, SETUP_ASSET_NAME)
        return False

    url, _name = asset
    if not _ask_user(tag, local):
        logger.info("User declined update %s", tag)
        return False

    tmp_dir = Path(tempfile.mkdtemp(prefix="gm-session-update-"))
    dest = tmp_dir / SETUP_ASSET_NAME
    if not _download(url, dest, token):
        try:
            import tkinter as tk
            from tkinter import messagebox

            root = tk.Tk()
            root.withdraw()
            messagebox.showerror(
                "GM Session — Update",
                "Could not download the update. Try again later.",
            )
            root.destroy()
        except Exception:  # noqa: BLE001
            pass
        return False

    try:
        launch_installer(dest)
    except OSError as exc:
        logger.info("Could not launch installer: %s", exc)
        return False

    return True
