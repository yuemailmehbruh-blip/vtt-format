# GM Session (offline)

Local, offline **DM session** foundation: tile-grid map canvas, library sidebar of campaign actors/sheets, and drag-to-place white-circle tokens.

No AI, no listen-server / multiplayer, no Prep/Editor apps — just the play-side map + library loop against a campaign folder on disk.

## Requirements

- Python 3.10+
- PyYAML (`pip install -r ../../packages/campaign-format/requirements.txt`)
- **Desktop app:** `pywebview` (`pip install pywebview`) — Edge WebView2 on Windows
- **Browser debug only:** `serve.py` (no sheet windows)

Version is in `VERSION` (currently **0.5.6**).

## Run — desktop app (recommended)

From the **repo root** (`vtt-format/`):

```bash
pip install -r packages/campaign-format/requirements.txt
pip install pywebview
python apps/gm-session/desktop_app.py --skip-update
```

Opens a **pywebview** window titled “GM Session” (not Chrome / the system browser). Character sheets open as **additional desktop windows** via `window.pywebview.api.open_sheet(actor_id)`.

| Flag | Default | Meaning |
|------|---------|---------|
| `--campaign` | beside-exe `campaign/` or sample | Campaign root with `world/` + `state/` |
| `--scene` | `docks` | Initial scene id |
| `--host` | `127.0.0.1` | Bind address |
| `--port` | `8765` | Bind port |
| `--skip-update` | off | Skip GitHub Releases update check |

Closing the main window stops the local HTTP server and exits. Closing a sheet window only closes that sheet. Re-clicking the same actor focuses the existing sheet window.

## Run — browser debug (`serve.py`)

```bash
python apps/gm-session/serve.py
```

Open the printed URL (e.g. [http://127.0.0.1:8765/?scene=docks](http://127.0.0.1:8765/?scene=docks)). Sheets **do not** pop out in the browser; the status line explains that the desktop app is required.

## UI

- **Header** — scene name + “GM Session (offline)” + **Grid** / **Snap to grid** / **Nametags** toggles (independent; default all ON; persisted in `state/ui/<scene-id>.json` as `showGrid`, `snapToGrid`, `showNametags`)
- **Left library** — Characters/Actors from `world/actors/*.yaml`; Scenes from `world/scenes/`; **Map layers** list
  - Entries with a human sheet file show a **sheet** badge
  - **Click** an actor → open its `.sheet.txt` in a **desktop sheet window** (editable; Save writes back to disk)
  - **Drag** an actor onto the map → place a white circle token labeled with initials + name (snaps to cell centers when Snap is on)
  - **Map layers** — eye, **Edit**, reorder ↑ bring forward / ↓ send back, delete; list shows topmost first (array stays bottom→top); **Add layer** uploads png/jpg/webp/gif into `world/assets/by-hash/` and appends as new topmost. **Has grid** (beside Add layer): when checked, search from the image center for at least a 3×3 of printed squares (so a faded edge or second decorative border cannot win). If the locked cell looks like it contains a 2×2 (a cross / half-grid inside most of a few center squares) and half-size is still a valid cell, the pitch is halved before fitting. If a 3×3 cannot be found, the fit fails and the image imports at natural size at (0,0). Otherwise scale so 1 printed cell = 1 map cell, put those lines on the map grid, crop to whole squares, and store the cropped PNG (original upload is kept too). When unchecked, import at natural size at (0,0). Map images draw fully opaque.
  - **Edit mode** (one layer at a time) — drag to move, corner/edge handles to resize. Resize modes: **Aspect** (uniform scale on corners), **H only**, **V only**. **Snap layers** (sidebar) snaps position/size to grid on release (not while dragging), independent of token snap.
- **Token snap** — free movement while dragging; on pointerup, if Snap to grid is ON, snap to cell center (`floor(x/g)*g + g/2`). Library drop / place still snaps on place.
- **Canvas draw order** — map images → grid (if on) → tokens → additions stub → layer edit chrome (play view does not draw walls/doors/lights/spawns)
- **Pan / zoom** — drag empty map to pan, wheel to zoom, double-click to fit. Hit-test: edit handles/body → tokens → pan
- **Update app** — fixed button bottom-left of the canvas; upgrades the installed program (not the map). Looks on GitHub Releases for a Setup.exe, downloads it, runs the installer, quits, then relaunches. Status text under the button tracks that. Browser `serve.py` has no updater API.

## Auto-update

On launch (unless `--skip-update`), the desktop app checks GitHub Releases for [`yuemailmehbruh-blip/vtt-format`](https://github.com/yuemailmehbruh-blip/vtt-format) and may show a confirm dialog if a *newer* version exists. The in-session **Update app** button **always** downloads and silently installs the latest Setup.exe (then relaunches), even when the local version already matches the release tag — it never reports “Up to date”.

1. `GET /repos/.../releases/latest` (then `/releases` if that has no Setup.exe)
2. Download the installer via the GitHub **API asset URL** (`Accept: application/octet-stream`). Auth is sent only to `api.github.com` — not to the S3 redirect (that 400s).
3. Write `%LOCALAPPDATA%\GM Session\install_update.ps1` and spawn it: wait for `GM Session.exe` to exit, run Inno `/SILENT /NORESTART /FORCECLOSEAPPLICATIONS`, then start the installed exe again (helper logs to `update.log`).
4. Quit the current app so files can be replaced.
5. Progress is written under the button and to `%LOCALAPPDATA%\GM Session\update.log`.

Launch-time still skips when already up to date. **Update app** never skips on version equality.

**0.5.6:** Update button always reinstalls; token draw/hit radius tracks the map grid (`≈0.45 × gridSize` in world, times zoom on screen).

Auth (for private repos): `GM_SESSION_GH_TOKEN` / `GITHUB_TOKEN`, `%LOCALAPPDATA%\GM Session\github_token.txt`, or GitHub CLI `hosts.yml`. Unauthenticated `/releases/latest` 404s on a private repo; the UI then says to put a token in that file. Failures are shown under **Update app**, not swallowed.

Publish after a Windows build:

```bash
gh release create v0.5.1 packaging/windows/output/GM-Session-Setup.exe \
  --title "GM Session 0.5.1" \
  --notes "Nametags toggle, opaque map layers, Has-grid import fit."
```

(`build.ps1` prints the exact command for the current `VERSION`.)

## Disk layout (sheets & tokens)

| Concern | Path | Who writes |
|---------|------|------------|
| Sheet **schemas** (YAML) | `build/sheets/*.yaml` | Editor |
| Actor instances | `world/actors/<id>.yaml` | Prep |
| Human sheet docs (blank `.txt` for now) | `world/actors/<id>.sheet.txt` (via actor `sheet_doc`) | Prep / GM session save |
| Placed tokens (session) | `state/tokens/<scene-id>.json` | GM Session (play) |
| UI prefs (grid/snap/nametags/snapLayers) | `state/ui/<scene-id>.json` | GM Session (play) |

Sample actors with sheet docs:

- `world/actors/dock-tough.yaml` + `dock-tough.sheet.txt`
- `world/actors/party-fighter.yaml` + `party-fighter.sheet.txt`
- `world/actors/blank-npc.yaml` + `blank-npc.sheet.txt`

Token file shape:

```json
{
  "scene": "docks",
  "tokens": [
    {
      "id": "dock-tough-…",
      "actor_id": "dock-tough",
      "name": "Dock Tough",
      "label": "DT",
      "x": 210,
      "y": 280
    }
  ]
}
```

Tokens reload from `state/tokens/` on refresh. Scene YAML may still declare `tokens: []` as a schema placeholder; **runtime placements live under `state/`** so play does not rewrite Prep-owned scene files.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | App UI |
| GET | `/sheet.html` | Sheet pop-out UI (desktop window) |
| GET | `/api/library` | Actors + scenes for the sidebar |
| GET | `/api/scene/<id>` | Scene YAML as JSON |
| PUT | `/api/scene/<id>/layers` | Body `{"layers":[…]}` → rewrite only the `layers` key |
| POST | `/api/assets` | Raw image body + `Content-Type` + optional `X-Asset-Name` → hash into `world/assets/` |
| GET | `/api/sheet/<actor_id>` | Sheet text + campaign-relative path |
| PUT | `/api/sheet/<actor_id>` | Body `{"text":"…"}` → write `.sheet.txt` |
| GET | `/api/tokens/<scene_id>` | Placed tokens JSON |
| PUT | `/api/tokens/<scene_id>` | Body `{"tokens":[…]}` → write `state/tokens/<id>.json` |
| GET | `/api/ui/<scene_id>` | UI prefs (`showGrid`, `snapToGrid`, `showNametags`, `snapLayers`) |
| PUT | `/api/ui/<scene_id>` | Persist UI prefs to `state/ui/<id>.json` |
| GET | `/assets/<sha256>` | Content-addressed asset |

## Relation to `apps/grid-viewer`

`grid-viewer` remains a minimal map-only preview. **GM Session is the primary play entry** for this scaffold.

## Windows desktop / installer

See `packaging/windows/` (PyInstaller + Inno Setup + pywebview). Entry point: `desktop_app.py`; shared HTTP APIs in `server_lib.py`; updater in `updater.py`.

## 0.5.7

- Has-grid: stronger doubled-pitch detection (mid-line sweep) and promote a bold every-5th major grid (e.g. Yester Hill 50ft squares) when present.
