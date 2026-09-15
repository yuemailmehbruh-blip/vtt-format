# campaign-format

Minimal Python tooling for content-addressed VTT campaigns.

## Install

```bash
pip install -r requirements.txt
```

Stdlib + PyYAML only. No AI SDKs.

## Commands

### hash-and-store

Put a file into the campaign asset library by SHA-256 and update `world/assets/index.yaml`.

```bash
python -m campaign_format.hash_and_store \
  --campaign /path/to/campaign \
  --file /path/to/asset.png \
  --name maps/docks-bg
```

### validate-campaign

Validate required layout, sheets, actors, scene asset refs, and `build/manifest.json` hashes.

```bash
python -m campaign_format.validate_campaign \
  --campaign /path/to/campaign
```

Exit code `0` = green; non-zero prints errors to stderr.

## Package layout

```
campaign_format/
  __init__.py
  __main__.py          # python -m campaign_format …
  hash_and_store.py
  validate_campaign.py
```
