# GM Session (offline)

Local, offline **DM session** foundation: tile-grid map canvas, library sidebar of campaign actors/sheets, and drag-to-place white-circle tokens.

No AI, no listen-server / multiplayer, no Prep/Editor apps — just the play-side map + library loop against a campaign folder on disk.

## Requirements

- Python 3.10+
- PyYAML (`pip install -r ../../packages/campaign-format/requirements.txt`)

## Run (sample campaign)

From the **repo root** (`vtt-format/`):

```bash
pip install -r packages/campaign-format/requirements.txt
python apps/gm-session/serve.py
```

Open the URL printed in the terminal (default):

[http://127.0.0.1:8765/?scene=docks](http://127.0.0.1:8765/?scene=docks)

Or from this directory:

```bash
python serve.py --campaign ../../examples/sample-campaign --scene docks
```

### Options

| Flag | Default | Meaning |
|------|---------|---------|
| `--campaign` | `examples/sample-campaign` | Campaign root with `world/` + `state/` |
| `--scene` | `docks` | Scene id in the printed URL |
| `--host` | `127.0.0.1` | Bind address (localhost only is fine) |
| `--port` | `8765` | Bind port |

## UI

- **Header** — scene name + “GM Session (offline)”
- **Left library** — Characters/Actors from `world/actors/*.yaml`; Scenes from `world/scenes/`
  - Entries with a human sheet file show a **sheet** badge
  - **Click** an actor → open its `.sheet.txt` in the right panel (editable; Save writes back to disk)
  - **Drag** an actor onto the map → place a white circle token labeled with initials + name
- **Canvas** — grid, walls, doors, lights, spawns (same overlays as the grid viewer), plus placed tokens
- **Pan / zoom** — drag to pan, wheel to zoom, double-click to fit

## Disk layout (sheets & tokens)

| Concern | Path | Who writes |
|---------|------|------------|
| Sheet **schemas** (YAML) | `build/sheets/*.yaml` | Editor |
| Actor instances | `world/actors/<id>.yaml` | Prep |
| Human sheet docs (blank `.txt` for now) | `world/actors/<id>.sheet.txt` (via actor `sheet_doc`) | Prep / GM session save |
| Placed tokens (session) | `state/tokens/<scene-id>.json` | GM Session (play) |

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
| GET | `/api/library` | Actors + scenes for the sidebar |
| GET | `/api/scene/<id>` | Scene YAML as JSON |
| GET | `/api/sheet/<actor_id>` | Sheet text + campaign-relative path |
| PUT | `/api/sheet/<actor_id>` | Body `{"text":"…"}` → write `.sheet.txt` |
| GET | `/api/tokens/<scene_id>` | Placed tokens JSON |
| PUT | `/api/tokens/<scene_id>` | Body `{"tokens":[…]}` → write `state/tokens/<id>.json` |
| GET | `/assets/<sha256>` | Content-addressed asset |

## Relation to `apps/grid-viewer`

`grid-viewer` remains a minimal map-only preview. **GM Session is the primary play entry** for this scaffold.

## Windows desktop / installer

For a Start Menu app without using the terminal, see `packaging/windows/` (PyInstaller + Inno Setup). The desktop entry point is `desktop_app.py` (shared server code lives in `server_lib.py`).

