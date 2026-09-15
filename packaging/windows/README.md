# Windows packaging — GM Session

Build a double-clickable **GM Session** installer for Windows 10/11 using **PyInstaller** (onedir) + **Inno Setup**. No Node/Electron.

## Prerequisites (build machine)

- Windows 10/11
- [Python 3.10+](https://www.python.org/downloads/) (check “Add python.exe to PATH”)
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
2. `pip install pyinstaller pyyaml`
3. Runs PyInstaller with `gm-session.spec` → `dist\GM Session\GM Session.exe`
4. Stages the sample campaign for the installer
5. If `ISCC.exe` is available, builds `output\GM-Session-Setup.exe`

### Outputs

| Path | What |
|------|------|
| `dist\GM Session\GM Session.exe` | Runnable onedir app (needs the whole folder) |
| `output\GM-Session-Setup.exe` | Installer (when Inno Setup is installed) |

## Install (end user)

1. Double-click **GM-Session-Setup.exe**
2. Accept defaults (installs under `%LocalAppData%\Programs\GM Session` when privileges are lowest, or Program Files if elevated)
3. Launch **GM Session** from the Start Menu (optional Desktop shortcut)

On first launch the app:

- Starts a local HTTP server on `http://127.0.0.1:8765`
- Opens your default browser to the session UI
- Shows a small status window (URL + campaign path) with **Quit**
- Uses `{install}\campaign\` (sample campaign copied by the installer). Edit that folder to change the game.

## Dev without packaging

From the repo root (Linux/macOS/Windows):

```bash
pip install -r packages/campaign-format/requirements.txt
python apps/gm-session/serve.py
```

Or the desktop launcher (needs a display / tkinter):

```bash
python apps/gm-session/desktop_app.py --no-browser
```

## Notes

- Windowed build (`console=False`) — no console flash on Windows.
- UI files (`index.html`, `session.js`) and a fallback `sample-campaign` are bundled inside the app.
- Prefer the installer-copied `campaign\` folder next to the exe for day-to-day edits.
