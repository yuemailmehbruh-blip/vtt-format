# GM Session (offline)

Local, offline **DM session** foundation: tile-grid map canvas, library sidebar of campaign actors/sheets, and drag-to-place white-circle tokens.

No AI, no listen-server / multiplayer, no Prep/Editor apps — just the play-side map + library loop against a campaign folder on disk.

## Requirements

- Python 3.10+
- PyYAML (`pip install -r ../../packages/campaign-format/requirements.txt`)
- **Desktop app:** `pywebview` (`pip install pywebview`) — Edge WebView2 on Windows
- **Browser debug only:** `serve.py` (no sheet windows)

Version is in `VERSION` (currently **0.3.0**).

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

- **Header** — scene name + “GM Session (offline)” + **Grid** / **Snap to grid** toggles (independent; default both ON; persisted in `state/ui/<scene-id>.json`)
- **Left library** — Characters/Actors from `world/actors/*.yaml`; Scenes from `world/scenes/`; **Map layers** list
  - Entries with a human sheet file show a **sheet** badge
  - **Click** an actor → open its `.sheet.txt` in a **desktop sheet window** (editable; Save writes back to disk)
  - **Drag** an actor onto the map → place a white circle token labeled with initials + name (snaps to cell centers when Snap is on)
  - **Map layers** — eye toggle per layer; **Add layer** uploads png/jpg/webp/gif into `world/assets/by-hash/` and appends a `type: map` layer
- **Canvas draw order** — map images → walls/doors/lights/spawns → grid (if on) → tokens → additions stub
- **Pan / zoom** — drag empty map to pan, wheel to zoom, double-click to fit; token drag wins over pan

## Auto-update

On launch (unless `--skip-update`), the desktop app checks GitHub Releases for [`yuemailmehbruh-blip/vtt-format`](https://github.com/yuemailmehbruh-blip/vtt-format):

1. `GET /repos/.../releases/latest`
2. Compare release tag (strip leading `v`) to local `VERSION`
3. If newer and asset `GM-Session-Setup.exe` exists → native “Download and install?” dialog
4. On yes → download to a temp file, launch the installer, quit so files can be replaced

Auth (for private repos): try unauthenticated first; else `GM_SESSION_GH_TOKEN` / `GITHUB_TOKEN`, `%LOCALAPPDATA%\GM Session\github_token.txt`, or GitHub CLI `hosts.yml`. If there is no access, the check is skipped silently.

Publish after a Windows build:

```bash
gh release create v0.3.0 packaging/windows/output/GM-Session-Setup.exe \
  --title "GM Session v0.3.0" \
  --notes "Map layers, grid/snap toggles, asset upload, sheet windows, auto-update."
```

(`build.ps1` prints the exact command for the current `VERSION`.)

## Disk layout (sheets & tokens)

| Concern | Path | Who writes |
|---------|------|------------|
| Sheet **schemas** (YAML) | `build/sheets/*.yaml` | Editor |
| Actor instances | `world/actors/<id>.yaml` | Prep |
| Human sheet docs (blank `.txt` for now) | `world/actors/<id>.sheet.txt` (via actor `sheet_doc`) | Prep / GM session save |
| Placed tokens (session) | `state/tokens/<scene-id>.json` | GM Session (play) |
| UI prefs (grid/snap) | `state/ui/<scene-id>.json` | GM Session (play) |

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
| GET | `/api/ui/<scene_id>` | UI prefs (`showGrid`, `snapToGrid`) |
| PUT | `/api/ui/<scene_id>` | Persist UI prefs to `state/ui/<id>.json` |
| GET | `/assets/<sha256>` | Content-addressed asset |

## Relation to `apps/grid-viewer`

`grid-viewer` remains a minimal map-only preview. **GM Session is the primary play entry** for this scaffold.

## Windows desktop / installer

See `packaging/windows/` (PyInstaller + Inno Setup + pywebview). Entry point: `desktop_app.py`; shared HTTP APIs in `server_lib.py`; updater in `updater.py`.
