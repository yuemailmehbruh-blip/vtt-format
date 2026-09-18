# Windows packaging — GM Session

Build a double-clickable **GM Session** installer for Windows 10/11 using **PyInstaller** (onedir) + **Inno Setup** + **pywebview**. No Node/Electron / system browser.

## Prerequisites (build machine)

- Windows 10/11
- [Python 3.10+](https://www.python.org/downloads/) (check “Add python.exe to PATH”)
- [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (usually preinstalled on Win10/11)
- [Inno Setup 6](https://jrsoftware.org/isinfo.php) (optional but recommended for `GM-Session-Setup.exe`)

## Build

From a PowerShell prompt at the **repo root**:

```powershell
powershell -ExecutionPolicy Bypass -File packaging\windows\build.ps1
```

Or from this folder:

```powershell
.\build.ps1
```

The script:

1. Creates `.venv` if needed
2. `pip install pyinstaller pyyaml pywebview`
3. Runs PyInstaller with `gm-session.spec` → `dist\GM Session\GM Session.exe`
4. Stages the sample campaign for the installer
5. If `ISCC.exe` is available, builds `output\GM-Session-Setup.exe`
6. Prints a `gh release create …` command for auto-update publishing

### Outputs

| Path | What |
|------|------|
| `dist\GM Session\GM Session.exe` | Runnable onedir app (needs the whole folder) |
| `output\GM-Session-Setup.exe` | Installer (when Inno Setup is installed) |

### Bundled UI (important)

`gm-session.spec` must include **`index.html`, `session.js`, `sheet.html`, `sheet.js`, `rolls.html`, `rolls.js`, `sheet-builder.html`, `sheet-builder.js`, `sheet-runtime.js`, and `VERSION`** under `gm-session/`. Older builds that only shipped `index.html` + `session.js` caused sheet windows to **404**.

## Install (end user)

1. Double-click **GM-Session-Setup.exe**
2. Accept defaults (installs under `%LocalAppData%\Programs\GM Session` when privileges are lowest, or Program Files if elevated)
3. Launch **GM Session** from the Start Menu (optional Desktop shortcut)

On launch the app:

- Checks GitHub Releases for a newer `GM-Session-Setup.exe` (see Auto-update below)
- Starts a local HTTP server on `http://127.0.0.1:8765`
- Opens the **main UI in a pywebview window** (not Chrome)
- Sheet clicks open **additional pywebview windows**
- Uses `{install}\campaign\` (sample campaign copied by the installer). Edit that folder to change the game.

## Auto-update / publishing releases

The client reads `apps/gm-session/VERSION` and compares it to the latest GitHub Release tag for `yuemailmehbruh-blip/vtt-format`. After you build the installer on Windows:

```powershell
gh release create v0.2.0 packaging\windows\output\GM-Session-Setup.exe `
  --title "GM Session v0.2.0" `
  --notes "Desktop pywebview app, sheet windows, auto-update."
```

Bump `apps/gm-session/VERSION` and `#define MyAppVersion` in `gm-session.iss` together when cutting a release.

Private-repo tokens for the updater: env `GM_SESSION_GH_TOKEN`, or `%LOCALAPPDATA%\GM Session\github_token.txt`, or GitHub CLI config. Pass `--skip-update` to the exe while debugging.

## Dev without packaging

From the repo root (Linux/macOS/Windows):

```bash
pip install -r packages/campaign-format/requirements.txt
pip install pywebview
python apps/gm-session/desktop_app.py --skip-update
```

Browser-only debug (no sheet windows):

```bash
python apps/gm-session/serve.py
```

## Notes

- Windowed build (`console=False`) — no console flash on Windows.
- Hidden imports cover pywebview’s Edge/WebView2 (Edge Chromium) backend.
- Prefer the installer-copied `campaign\` folder next to the exe for day-to-day edits.
