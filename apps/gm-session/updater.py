"""Check GitHub Releases for a GM Session installer, run it, and relaunch."""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

logger = logging.getLogger("gm_session.updater")

REPO = "yuemailmehbruh-blip/vtt-format"
RELEASES_LATEST = f"https://api.github.com/repos/{REPO}/releases/latest"
RELEASES_LIST = f"https://api.github.com/repos/{REPO}/releases?per_page=15"
SETUP_ASSET_NAME = "GM-Session-Setup.exe"
USER_AGENT = "GM-Session-Updater"
TOKEN_FILE_HINT = r"%LOCALAPPDATA%\GM Session\github_token.txt"

CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000
CREATE_BREAKAWAY_FROM_JOB = 0x01000000


def _log(msg: str) -> None:
    logger.info("%s", msg)
    try:
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("TEMP") or str(Path.home())
        log_dir = Path(base) / "GM Session"
        log_dir.mkdir(parents=True, exist_ok=True)
        with (log_dir / "update.log").open("a", encoding="utf-8") as fh:
            fh.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
    except OSError:
        pass


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
    m = re.match(r"^(\d+(?:\.\d+)*)", raw)
    if not m:
        return (0,)
    return tuple(int(p) for p in m.group(1).split("."))


def version_is_newer(remote: str, local: str) -> bool:
    return _normalize_semver(remote) > _normalize_semver(local)


def _token_from_gh_hosts(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    in_github = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("github.com"):
            in_github = True
            continue
        if in_github and stripped and not line[:1].isspace() and ":" in stripped:
            if not stripped.startswith("oauth_token"):
                in_github = False
        if in_github and "oauth_token" in stripped:
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

    candidates: list[Path] = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(Path(appdata) / "GitHub CLI" / "hosts.yml")
    candidates.append(Path.home() / ".config" / "gh" / "hosts.yml")
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
    """Follow redirects. Keep Accept. Drop Authorization off api.github.com (S3 400s)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is None:
            return None
        new.add_header("Accept", "application/octet-stream")
        old_host = urlparse(req.full_url).netloc.lower()
        new_host = urlparse(new.full_url).netloc.lower()
        if new_host != old_host:
            for key in list(new.headers):
                if key.lower() == "authorization":
                    del new.headers[key]
            unredir = getattr(new, "unredirected_hdrs", None)
            if isinstance(unredir, dict):
                for key in list(unredir):
                    if key.lower() == "authorization":
                        del unredir[key]
        return new


def _opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(_OctetStreamRedirectHandler)


def _http_json(url: str, token: str | None) -> tuple[object | None, int | None, str | None]:
    """GET JSON. Returns (data, http_status, error_message)."""
    req = urllib.request.Request(url)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", USER_AGENT)
    if token:
        req.add_unredirected_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            status = getattr(resp, "status", None) or resp.getcode()
            return json.loads(resp.read().decode("utf-8")), int(status), None
    except urllib.error.HTTPError as exc:
        _log(f"Release check failed: HTTP {exc.code} {exc.reason}")
        try:
            exc.read()
        except Exception:  # noqa: BLE001
            pass
        return None, int(exc.code), f"HTTP {exc.code}"
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        _log(f"Release check failed: {exc}")
        return None, None, str(exc)


def _cleanup_dest(dest: Path) -> None:
    try:
        if dest.exists():
            dest.unlink()
    except OSError:
        pass


def _download_one(url: str, dest: Path, token: str | None) -> tuple[bool, str | None, int | None]:
    req = urllib.request.Request(url)
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Accept", "application/octet-stream")
    if token:
        # First hop (api.github.com) needs auth; S3 redirect must not see it.
        req.add_unredirected_header("Authorization", f"Bearer {token}")
    try:
        opener = _opener()
        with opener.open(req, timeout=180) as resp, dest.open("wb") as out:
            status = getattr(resp, "status", None) or resp.getcode()
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                out.write(chunk)
        size = dest.stat().st_size if dest.is_file() else 0
        if size > 1024:
            _log(f"Downloaded {size} bytes from {url}")
            return True, None, int(status) if status else 200
        _cleanup_dest(dest)
        return False, "empty download", int(status) if status else None
    except urllib.error.HTTPError as exc:
        _log(f"Download failed: HTTP {exc.code} {exc.reason} from {url}")
        try:
            exc.read()
        except Exception:  # noqa: BLE001
            pass
        _cleanup_dest(dest)
        return False, f"HTTP {exc.code}", int(exc.code)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        _log(f"Download failed: {exc}")
        _cleanup_dest(dest)
        return False, str(exc), None


def _download(
    url: str,
    dest: Path,
    token: str | None,
    *,
    fallback_url: str | None = None,
) -> tuple[bool, str | None, int | None]:
    ok, err, status = _download_one(url, dest, token)
    if ok:
        return ok, err, status
    if fallback_url and fallback_url != url:
        _log("Primary download failed; trying browser_download_url")
        return _download_one(fallback_url, dest, token)
    return ok, err, status


def _asset_is_setup(name: str) -> bool:
    n = (name or "").strip()
    if not n.lower().endswith(".exe"):
        return False
    lower = n.lower()
    if lower == SETUP_ASSET_NAME.lower():
        return True
    if "player" in lower:
        return False  # 0.7.0+: GM-Session-Player-Setup.exe is the separate player app
    if lower.startswith("gm-session-setup"):
        return True
    if lower.endswith("-setup.exe") or lower.endswith("setup.exe"):
        if "unins" in lower:
            return False
        return True
    return False


def find_setup_asset(release: dict) -> dict | None:
    """Return setup asset: url (API), id, name, browser_download_url."""
    exact = None
    fuzzy = None
    for asset in release.get("assets") or []:
        name = asset.get("name") or ""
        if not _asset_is_setup(str(name)):
            continue
        api_url = asset.get("url")
        browser_url = asset.get("browser_download_url")
        if not api_url and not browser_url:
            continue
        out = {
            "url": str(api_url or browser_url),
            "id": asset.get("id"),
            "name": str(name),
            "browser_download_url": str(browser_url) if browser_url else None,
        }
        if str(name).lower() == SETUP_ASSET_NAME.lower():
            exact = out
            break
        if fuzzy is None:
            fuzzy = out
    return exact or fuzzy


def current_app_exe() -> Path | None:
    if getattr(sys, "frozen", False):
        try:
            return Path(sys.executable).resolve()
        except OSError:
            return None
    return None


def _ask_user(remote_tag: str, local_version: str) -> bool | None:
    message = (
        f"Update {remote_tag} is available (you have {local_version}).\n\n"
        "Download and install? The app will quit, the installer will run, "
        "then GM Session will reopen."
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
        _log("Could not show update dialog; skipping launch-time prompt")
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
        _log(f"Could not show error dialog: {message}")


def _gm_session_data_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("TEMP") or str(Path.home())
    return Path(base) / "GM Session"


def spawn_install_and_relaunch(installer: Path, exe_path: Path | None) -> None:
    """Detach a helper that waits for this process to exit, runs Setup, relaunches.

    Writes a .ps1 under %LOCALAPPDATA%\\GM Session\\ so the helper is inspectable
    and can append steps to update.log (not EncodedCommand-only).
    """
    installer = installer.resolve()
    if sys.platform != "win32":
        subprocess.Popen([str(installer)], start_new_session=True)
        return

    exe = str(exe_path.resolve()) if exe_path else ""
    setup = str(installer)
    data_dir = _gm_session_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    script_path = data_dir / "install_update.ps1"
    log_path = data_dir / "update.log"

    # PowerShell: wait for GM Session.exe to vanish, run Inno silently, start the app.
    ps = (
        f"$ErrorActionPreference = 'Continue'\n"
        f"$log = {json.dumps(str(log_path))}\n"
        f"$setup = {json.dumps(setup)}\n"
        f"$exe = {json.dumps(exe)}\n"
        "function Write-UpdateLog([string]$msg) {\n"
        "  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $msg\n"
        "  Add-Content -LiteralPath $log -Value $line -Encoding UTF8\n"
        "}\n"
        "Write-UpdateLog 'Helper started'\n"
        "Start-Sleep -Seconds 2\n"
        "Write-UpdateLog 'Waiting for GM Session to exit…'\n"
        "$deadline = (Get-Date).AddMinutes(2)\n"
        "while (Get-Process -Name 'GM Session' -ErrorAction SilentlyContinue) {\n"
        "  if ((Get-Date) -gt $deadline) { Write-UpdateLog 'Wait deadline reached'; break }\n"
        "  Start-Sleep -Seconds 1\n"
        "}\n"
        "Write-UpdateLog ('Running installer: ' + $setup)\n"
        "Start-Process -FilePath $setup -ArgumentList "
        "'/SILENT','/NORESTART','/FORCECLOSEAPPLICATIONS' -Wait\n"
        "Write-UpdateLog 'Installer finished'\n"
        "if ($exe -and (Test-Path -LiteralPath $exe)) {\n"
        "  Start-Sleep -Seconds 1\n"
        "  Write-UpdateLog ('Relaunching: ' + $exe)\n"
        "  Start-Process -FilePath $exe\n"
        "} else {\n"
        "  Write-UpdateLog 'No exe to relaunch (missing path)'\n"
        "}\n"
        "Write-UpdateLog 'Helper done'\n"
    )
    script_path.write_text(ps, encoding="utf-8")
    _log(f"Wrote install helper script {script_path}")

    flags = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB
    si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    subprocess.Popen(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
            str(script_path),
        ],
        close_fds=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=flags,
        startupinfo=si,
    )
    _log(f"Spawned install helper for {setup} relaunch={exe or '(none)'}")


def launch_installer(path: Path) -> None:
    """Back-compat wrapper: detached silent install + relaunch when frozen."""
    spawn_install_and_relaunch(path, current_app_exe())


def _release_tag(release: dict) -> str:
    return str(release.get("tag_name") or release.get("name") or "").strip()


def _latest_release_with_setup(token: str | None) -> tuple[dict | None, dict | None, int | None, str | None]:
    """Return (release, asset, http_status, error)."""
    data, http_status, err = _http_json(RELEASES_LATEST, token)
    if isinstance(data, dict):
        asset = find_setup_asset(data)
        if asset:
            return data, asset, http_status, None
        tag = _release_tag(data)
        _log(f"Latest {tag or '(untagged)'} has no Setup.exe; listing releases")
    listed, list_status, list_err = _http_json(RELEASES_LIST, token)
    if isinstance(listed, list):
        for rel in listed:
            if not isinstance(rel, dict):
                continue
            if rel.get("draft"):
                continue
            asset = find_setup_asset(rel)
            if asset:
                return rel, asset, list_status, None
        return None, None, list_status, "No GitHub release has a Setup.exe"
    if data is None:
        return None, None, http_status, err
    return None, None, http_status or list_status, "Latest release has no installer asset"


def probe_update(*, local_version: str | None = None, app_dir: Path | None = None) -> dict:
    """
    Check GitHub Releases without prompting.
    status: up_to_date | available | skipped
    """
    local = local_version or load_version(app_dir)
    token = find_github_token()
    release, asset, http_status, err = _latest_release_with_setup(token)
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
    tag = _release_tag(release)
    if not tag:
        return {
            "status": "skipped",
            "local": local,
            "message": f"No release tag (local {local})",
        }
    if asset is None:
        return {
            "status": "skipped",
            "local": local,
            "remote": tag,
            "message": f"Update {tag} has no installer asset",
        }
    if not version_is_newer(tag, local):
        return {
            "status": "up_to_date",
            "local": local,
            "remote": tag,
            "asset_url": asset["url"],
            "asset_id": asset.get("id"),
            "asset_name": asset.get("name"),
            "browser_download_url": asset.get("browser_download_url"),
            "message": f"Up to date ({local}); latest is {tag}",
        }
    return {
        "status": "available",
        "local": local,
        "remote": tag,
        "asset_url": asset["url"],
        "asset_id": asset.get("id"),
        "asset_name": asset.get("name"),
        "browser_download_url": asset.get("browser_download_url"),
        "message": f"Update available ({tag})…",
    }


def check_and_offer_update(*, local_version: str | None = None, app_dir: Path | None = None) -> bool:
    quitting, _msg = check_and_offer_update_with_status(
        local_version=local_version, app_dir=app_dir, prompt=True, force=False
    )
    return quitting


def check_and_offer_update_with_status(
    *,
    local_version: str | None = None,
    app_dir: Path | None = None,
    prompt: bool = True,
    force: bool = False,
    progress=None,
) -> tuple[bool, str]:
    """
    Download the latest Setup.exe, spawn a detached installer+relaunch helper.

    Returns (should_quit, message).
    prompt=True: launch-time yes/no (skip if tkinter fails).
    prompt=False: Update app button — the click is consent.
    force=True: run the latest installer even if the version matches.
    progress: optional callable(str) for UI status while downloading.
    """

    def _progress(msg: str) -> None:
        _log(msg)
        if progress:
            try:
                progress(msg)
            except Exception:  # noqa: BLE001
                pass

    local = local_version or load_version(app_dir)
    token = find_github_token()
    if not token:
        msg = token_missing_message()
        _progress(msg)
        return False, msg

    _progress("Looking for installer on GitHub…")
    release, asset, http_status, err = _latest_release_with_setup(token)
    if release is None or asset is None:
        if _needs_token(http_status, token):
            msg = token_missing_message()
        elif http_status is not None:
            msg = f"Could not check updates: HTTP {http_status}"
        else:
            msg = f"Could not check updates: {err or 'network error'} (local {local})"
        _progress(msg)
        return False, msg

    tag = _release_tag(release) or "latest"
    if prompt and not force and not version_is_newer(tag, local):
        msg = f"Up to date ({local}); latest is {tag}"
        _progress(msg)
        return False, msg
    if prompt and not force:
        answer = _ask_user(tag, local)
        if answer is None:
            msg = "Could not show update dialog; skipped (use Update app to install)"
            _progress(msg)
            return False, msg
        if not answer:
            msg = f"Update available ({tag}) — declined"
            _progress(msg)
            return False, msg

    url = str(asset["url"])
    fallback = asset.get("browser_download_url")
    fallback_url = str(fallback) if fallback else None
    asset_name = str(asset.get("name") or SETUP_ASSET_NAME)

    _progress(f"Downloading {asset_name} ({tag})…")
    tmp_dir = Path(tempfile.mkdtemp(prefix="gm-session-update-"))
    dest = tmp_dir / (asset_name if asset_name.lower().endswith(".exe") else SETUP_ASSET_NAME)
    ok, err, http_status = _download(url, dest, token, fallback_url=fallback_url)
    if not ok:
        if _needs_token(http_status, token):
            msg = token_missing_message()
        elif http_status is not None:
            msg = f"Download failed: HTTP {http_status}"
        else:
            msg = f"Download failed: {err or 'unknown error'}"
        _progress(msg)
        if prompt:
            _show_error_dialog(msg)
        return False, msg

    _progress(f"Running installer {tag} — app will close and reopen…")
    try:
        spawn_install_and_relaunch(dest, current_app_exe())
    except OSError as exc:
        msg = f"Could not launch installer: {exc}"
        _progress(msg)
        return False, msg

    return True, f"Installing {tag} — closing so the installer can replace files…"


def install_latest_release(
    *,
    local_version: str | None = None,
    app_dir: Path | None = None,
    progress=None,
) -> tuple[bool, str]:
    """Update-app button path: always download + install latest Setup.exe.

    Never compares versions and never returns/logs "Up to date". The button click
    is consent. Launch-time still uses check_and_offer_update (prompt=True).
    """

    def _progress(msg: str) -> None:
        _log(msg)
        if progress:
            try:
                progress(msg)
            except Exception:  # noqa: BLE001
                pass

    local = local_version or load_version(app_dir)
    token = find_github_token()
    if not token:
        msg = token_missing_message()
        _progress(msg)
        return False, msg

    _progress("Looking for installer on GitHub…")
    release, asset, http_status, err = _latest_release_with_setup(token)
    if release is None or asset is None:
        if _needs_token(http_status, token):
            msg = token_missing_message()
        elif http_status is not None:
            msg = f"Could not check updates: HTTP {http_status}"
        else:
            msg = f"Could not check updates: {err or 'network error'} (local {local})"
        _progress(msg)
        return False, msg

    tag = _release_tag(release) or "latest"
    # Deliberately no version_is_newer / "Up to date" short-circuit here.
    _progress(f"Installing release {tag} (local {local}; button always reinstalls)…")

    url = str(asset["url"])
    fallback = asset.get("browser_download_url")
    fallback_url = str(fallback) if fallback else None
    asset_name = str(asset.get("name") or SETUP_ASSET_NAME)

    _progress(f"Downloading {asset_name} ({tag})…")
    tmp_dir = Path(tempfile.mkdtemp(prefix="gm-session-update-"))
    dest = tmp_dir / (asset_name if asset_name.lower().endswith(".exe") else SETUP_ASSET_NAME)
    ok, err, http_status = _download(url, dest, token, fallback_url=fallback_url)
    if not ok:
        if _needs_token(http_status, token):
            msg = token_missing_message()
        elif http_status is not None:
            msg = f"Download failed: HTTP {http_status}"
        else:
            msg = f"Download failed: {err or 'unknown error'}"
        _progress(msg)
        return False, msg

    _progress(f"Running installer {tag} — app will close and reopen…")
    try:
        spawn_install_and_relaunch(dest, current_app_exe())
    except OSError as exc:
        msg = f"Could not launch installer: {exc}"
        _progress(msg)
        return False, msg

    return True, f"Installing {tag} — closing so the installer can replace files…"
