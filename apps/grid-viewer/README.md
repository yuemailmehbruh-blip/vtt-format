# Grid viewer

Minimal static web viewer for campaign scene tile grids. Loads a scene YAML (via a tiny local server), draws the square grid, and overlays walls, doors, lights, and spawns. Optionally shows the content-addressed background PNG under a semi-transparent grid.

> **Note:** For the offline DM session (library sidebar + tokens), use [`apps/gm-session`](../gm-session/) instead. This app remains a map-only preview.

No VTT, netcode, or AI — just a map preview.

## Requirements

- Python 3.10+
- PyYAML (`pip install -r ../../packages/campaign-format/requirements.txt`)

## Run (sample docks scene)

From the **repo root** (`vtt-format/`):

```bash
pip install -r packages/campaign-format/requirements.txt
python apps/grid-viewer/serve.py
```

Then open the URL printed in the terminal (default):

[http://127.0.0.1:8765/?scene=docks](http://127.0.0.1:8765/?scene=docks)

Or from this directory:

```bash
python serve.py --campaign ../../examples/sample-campaign --scene docks
```

### Options

| Flag | Default | Meaning |
|------|---------|---------|
| `--campaign` | `examples/sample-campaign` | Campaign root with `world/scenes/` |
| `--scene` | `docks` | Scene id in the printed URL |
| `--host` | `127.0.0.1` | Bind address |
| `--port` | `8765` | Bind port |

## Controls

- **Drag** — pan
- **Mouse wheel** — zoom toward cursor
- **Double-click** — fit scene to view

## What is drawn

- Header: scene `name`
- Background image from `world/assets/by-hash/<scene.background>` when present (stretched if the sample placeholder is smaller than the map)
- Square tile grid from `grid.size` and map extent (geometry bounds + padding, or image size when large enough, else 20×20)
- **Walls** — solid light lines
- **Doors** — gold (closed), green dashed (open), red (locked), with a mid-point marker
- **Lights** — soft radial circles (`radius` / `bright`)
- **Spawns** — diamond markers with `label` / `id`

## Endpoints

| Path | Purpose |
|------|---------|
| `/` | Viewer UI |
| `/api/scene/<id>` | Scene YAML as JSON |
| `/assets/<sha256>` | File from `world/assets/by-hash/` |
