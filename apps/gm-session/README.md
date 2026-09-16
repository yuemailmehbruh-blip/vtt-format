# GM Session (offline)

Local, offline **DM session** foundation: tile-grid map canvas, library sidebar of campaign actors/sheets, and drag-to-place white-circle tokens.

No AI, no listen-server / multiplayer, no Prep/Editor apps — just the play-side map + library loop against a campaign folder on disk.

## Requirements

- Python 3.10+
- PyYAML (`pip install -r ../../packages/campaign-format/requirements.txt`)
- **Desktop app:** `pywebview` (`pip install pywebview`) — Edge WebView2 on Windows
- **Browser debug only:** `serve.py` (no sheet windows)

Version is in `VERSION` (currently **0.5.0**).

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
  - **Map layers** — eye, **Edit**, reorder ↑ bring forward / ↓ send back, delete; list shows topmost first (array stays bottom→top); **Add layer** uploads png/jpg/webp/gif into `world/assets/by-hash/` and appends as new topmost. **Has grid** (beside Add layer): when checked, detect the image’s drawn grid pitch, scale so 1 image cell = 1 map cell, align the image center to the nearest 5th-square lattice point, crop to whole map squares, and store the cropped PNG as the layer asset (original upload is kept too). When unchecked, import at natural size at (0,0). Map images draw fully opaque.
  - **Edit mode** (one layer at a time) — drag to move, corner/edge handles to resize. Resize modes: **Aspect** (uniform scale on corners), **H only**, **V only**. **Snap layers** (sidebar) snaps position/size to grid on release (not while dragging), independent of token snap.
- **Token snap** — free movement while dragging; on pointerup, if Snap to grid is ON, snap to cell center (`floor(x/g)*g + g/2`). Library drop / place still snaps on place.
- **Canvas draw order** — map images → grid (if on) → tokens → additions stub → layer edit chrome (play view does not draw walls/doors/lights/spawns)
- **Pan / zoom** — drag empty map to pan, wheel to zoom, double-click to fit. Hit-test: edit handles/body → tokens → pan
- **Update app** — fixed button bottom-left of the canvas; upgrades the installed program (not the map). Calls `window.pywebview.api.check_update()` which downloads and launches the installer if a newer release exists (the click is consent). Status text under the button shows the probe/install result, including errors. Browser `serve.py` shows that Update app needs the desktop app.

## Auto-update

On launch (unless `--skip-update`), the desktop app checks GitHub Releases for [`yuemailmehbruh-blip/vtt-format`](https://github.com/yuemailmehbruh-blip/vtt-format) and may show a confirm dialog. The in-session **Update app** button does the same check, but **the click is consent**: if a newer release exists it immediately downloads and launches the installer (no tkinter yes/no).

1. `GET /repos/.../releases/latest` (Bearer token when present)
2. Compare release tag (strip leading `v`) to local `VERSION`
3. Prefer the GitHub API asset URL (`asset["url"]`) with `Accept: application/octet-stream` (private-repo `browser_download_url` 404s)
4. Launch: native “Download and install?” dialog (if tkinter fails, skip with a visible log — use **Update app**)
5. **Update app** button: download + launch Inno silently (`/SILENT /NORESTART /CLOSEAPPLICATIONS`), then quit so files can be replaced

Auth (for private repos): `GM_SESSION_GH_TOKEN` / `GITHUB_TOKEN`, `%LOCALAPPDATA%\GM Session\github_token.txt`, or GitHub CLI `hosts.yml`. Unauthenticated `/releases/latest` 404s on a private repo; the UI then says to put a token in that file. Failures are shown under **Update app**, not swallowed.

Publish after a Windows build:

```bash
gh release create v0.5.0 packaging/windows/output/GM-Session-Setup.exe \
  --title "GM Session v0.5.0" \
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
