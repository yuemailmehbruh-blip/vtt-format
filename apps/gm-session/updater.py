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
TOKEN_FILE_HINT = r"%LOCALAPPDATA%\GM Session\github_token.txt"


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


def token_missing_message() -> str:
    return (
        "Update failed: GitHub token missing. "
        f"Put a token in {TOKEN_FILE_HINT}"
    )


def _needs_token(http_status: int | None, token: str | None) -> bool:
    return (not token) and http_status in (401, 403, 404)


class _OctetStreamRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follow redirects; keep Accept: application/octet-stream."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is None:
            return None
        new.add_unredirected_header("Accept", "application/octet-stream")
        return new


def _opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(_OctetStreamRedirectHandler)


def _http_json(url: str, token: str | None) -> tuple[dict | None, int | None, str | None]:
    """GET JSON. Returns (data, http_status, error_message)."""
    headers = {"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            status = getattr(resp, "status", None) or resp.getcode()
            return json.loads(resp.read().decode("utf-8")), int(status), None
    except urllib.error.HTTPError as exc:
        logger.info("Release check failed: HTTP %s %s", exc.code, exc.reason)
        try:
            exc.read()
        except Exception:  # noqa: BLE001
            pass
        return None, int(exc.code), f"HTTP {exc.code}"
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        logger.info("Release check failed: %s", exc)
        return None, None, str(exc)


def _cleanup_dest(dest: Path) -> None:
    try:
        if dest.exists():
            dest.unlink()
    except OSError:
        pass


def _download_one(url: str, dest: Path, token: str | None) -> tuple[bool, str | None, int | None]:
    """GET url (Accept: application/octet-stream, Bearer token); follow redirects."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/octet-stream"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        opener = _opener()
        with opener.open(req, timeout=120) as resp, dest.open("wb") as out:
            status = getattr(resp, "status", None) or resp.getcode()
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                out.write(chunk)
        if dest.is_file() and dest.stat().st_size > 0:
            return True, None, int(status) if status else 200
        _cleanup_dest(dest)
        return False, "empty download", int(status) if status else None
    except urllib.error.HTTPError as exc:
        logger.info("Download failed: HTTP %s %s from %s", exc.code, exc.reason, url)
        try:
            exc.read()
        except Exception:  # noqa: BLE001
            pass
        _cleanup_dest(dest)
        return False, f"HTTP {exc.code}", int(exc.code)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        logger.info("Download failed: %s", exc)
        _cleanup_dest(dest)
        return False, str(exc), None


def _download(
    url: str,
    dest: Path,
    token: str | None,
    *,
    fallback_url: str | None = None,
) -> tuple[bool, str | None, int | None]:
    """Download via API asset URL; fall back to browser_download_url if needed."""
    ok, err, status = _download_one(url, dest, token)
    if ok:
        return ok, err, status
    if fallback_url and fallback_url != url:
        logger.info("Primary download failed; trying browser_download_url")
        return _download_one(fallback_url, dest, token)
    return ok, err, status


def find_setup_asset(release: dict) -> dict | None:
    """Return setup asset info preferring the API asset URL plus id.

    Keys: url (API ``asset["url"]``), id, name, browser_download_url (optional).
    """
    for asset in release.get("assets") or []:
        name = asset.get("name") or ""
        if name != SETUP_ASSET_NAME and name.lower() != SETUP_ASSET_NAME.lower():
            continue
        api_url = asset.get("url")
        browser_url = asset.get("browser_download_url")
        if not api_url and not browser_url:
            continue
        out: dict = {
            "url": str(api_url or browser_url),
            "id": asset.get("id"),
            "name": str(name),
            "browser_download_url": str(browser_url) if browser_url else None,
        }
        return out
    return None


def _ask_user(remote_tag: str, local_version: str) -> bool | None:
    """Native yes/no dialog.

    Returns True/False if the user answered, or None if the dialog could not be shown
    (tkinter often fails on the pywebview JS-bridge thread).
    """
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
        return None


def _show_error_dialog(message: str) -> None:
    try:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.withdraw()
        messagebox.showerror("GM Session — Update", message)
        root.destroy()
    except Exception:  # noqa: BLE001
        logger.info("Could not show error dialog: %s", message)


def launch_installer(path: Path) -> None:
    path = path.resolve()
    if sys.platform == "win32":
        try:
            subprocess.Popen(
                [str(path), "/SILENT", "/NORESTART", "/CLOSEAPPLICATIONS"],
                close_fds=True,
            )
        except OSError as exc:
            logger.info("Silent installer launch failed (%s); falling back to startfile", exc)
            os.startfile(str(path))  # type: ignore[attr-defined]
    else:
        subprocess.Popen([str(path)], start_new_session=True)


def probe_update(*, local_version: str | None = None, app_dir: Path | None = None) -> dict:
    """
    Check GitHub Releases without prompting.
    Returns dict with keys: status, local, message, and optionally remote, asset_url.
    status: up_to_date | available | skipped
    """
    local = local_version or load_version(app_dir)
    token = find_github_token()
    release, http_status, err = _http_json(RELEASES_LATEST, token)
    if release is None:
        if _needs_token(http_status, token):
            message = (
                f"Could not check updates: HTTP {http_status} — private repo needs a token"
            )
        elif http_status is not None:
            message = f"Could not check updates: HTTP {http_status}"
        else:
            message = f"Could not check updates: {err or 'network error'} (local {local})"
        return {
            "status": "skipped",
            "local": local,
            "http_status": http_status,
            "needs_token": _needs_token(http_status, token),
            "message": message,
        }
    tag = str(release.get("tag_name") or release.get("name") or "").strip()
    if not tag:
        return {
            "status": "skipped",
            "local": local,
            "message": f"No release tag (local {local})",
        }
    if not version_is_newer(tag, local):
        return {
            "status": "up_to_date",
            "local": local,
            "remote": tag,
            "message": f"Up to date ({local}); latest is {tag}",
        }
    asset = find_setup_asset(release)
    if asset is None:
        return {
            "status": "skipped",
            "local": local,
            "remote": tag,
            "message": f"Update {tag} has no installer asset",
        }
    return {
        "status": "available",
        "local": local,
        "remote": tag,
        "asset_url": asset["url"],
        "asset_id": asset.get("id"),
        "browser_download_url": asset.get("browser_download_url"),
        "message": f"Update available ({tag})…",
    }


def check_and_offer_update(*, local_version: str | None = None, app_dir: Path | None = None) -> bool:
    """
    Check GitHub Releases for a newer Setup.exe. If the user accepts, download,
    launch the installer, and return True (caller should quit). Otherwise False.

    Launch-time path: prompts with a confirm dialog (prompt=True).
    """
    _quitting, _msg = check_and_offer_update_with_status(
        local_version=local_version, app_dir=app_dir, prompt=True
    )
    return _quitting


def check_and_offer_update_with_status(
    *,
    local_version: str | None = None,
    app_dir: Path | None = None,
    prompt: bool = True,
) -> tuple[bool, str]:
    """
    Same as check_and_offer_update, but also returns a short status string for the UI.
    Returns (should_quit, message).

    prompt=True (launch): native yes/no dialog. If tkinter fails, skip with a visible log.
    prompt=False (Update app button): the click is consent — download and launch immediately,
    never using tkinter.
    """
    info = probe_update(local_version=local_version, app_dir=app_dir)
    local = str(info.get("local") or load_version(app_dir))
    if info.get("needs_token"):
        msg = token_missing_message()
        logger.info("%s", msg)
        return False, msg
    if info["status"] == "up_to_date":
        msg = str(info.get("message") or f"Up to date ({local})")
        logger.info("%s", msg)
        return False, msg
    if info["status"] != "available":
        msg = str(info.get("message") or f"Could not check updates (local {local})")
        logger.info("%s", msg)
        return False, msg

    tag = str(info["remote"])
    url = str(info["asset_url"])
    fallback = info.get("browser_download_url")
    fallback_url = str(fallback) if fallback else None

    if prompt:
        answer = _ask_user(tag, local)
        if answer is None:
            msg = "Could not show update dialog; skipped (use Update app to install)"
            logger.info("%s", msg)
            return False, msg
        if not answer:
            logger.info("User declined update %s", tag)
            return False, f"Update available ({tag}) — declined"
    else:
        logger.info("Update app clicked; installing %s without dialog", tag)

    token = find_github_token()
    tmp_dir = Path(tempfile.mkdtemp(prefix="gm-session-update-"))
    dest = tmp_dir / SETUP_ASSET_NAME
    ok, err, http_status = _download(url, dest, token, fallback_url=fallback_url)
    if not ok:
        if _needs_token(http_status, token):
            msg = token_missing_message()
        elif http_status is not None:
            msg = f"Download failed: HTTP {http_status}"
        else:
            msg = f"Download failed: {err or 'unknown error'}"
        logger.info("%s", msg)
        if prompt:
            _show_error_dialog(msg)
        return False, msg

    try:
        launch_installer(dest)
    except OSError as exc:
        logger.info("Could not launch installer: %s", exc)
        return False, f"Could not launch installer: {exc}"

    return True, f"Installing {tag} — app will quit…"

