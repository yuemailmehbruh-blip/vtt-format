"""Validate a VTT campaign directory layout and content invariants."""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:  # pragma: no cover
    print("PyYAML required: pip install -r requirements.txt", file=sys.stderr)
    sys.exit(2)


REQUIRED_DIRS = [
    "build",
    "build/ruleset",
    "build/sheets",
    "build/bindings",
    "world",
    "world/scenes",
    "world/actors",
    "world/journals",
    "world/encounters",
    "world/assets",
    "world/assets/by-hash",
    "state",
    "state/fog",
    "state/combat",
    "state/chat-log",
    "state/autosave",
    "state/tokens",
]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_yaml(path: Path) -> Any:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def sheet_field_names(sheet: dict) -> set[str]:
    fields = sheet.get("fields") or {}
    if isinstance(fields, dict):
        return set(fields.keys())
    if isinstance(fields, list):
        names = set()
        for item in fields:
            if isinstance(item, dict) and "name" in item:
                names.add(item["name"])
            elif isinstance(item, str):
                names.add(item)
        return names
    return set()


def actor_field_names(actor: dict) -> set[str]:
    values = actor.get("fields") or actor.get("values") or {}
    if isinstance(values, dict):
        return set(values.keys())
    return set()


def collect_scene_hashes(scene: dict) -> set[str]:
    found: set[str] = set()
    bg = scene.get("background")
    if isinstance(bg, str) and len(bg) == 64 and all(c in "0123456789abcdef" for c in bg.lower()):
        found.add(bg.lower())
    elif isinstance(bg, dict):
        h = bg.get("hash") or bg.get("sha256")
        if isinstance(h, str):
            found.add(h.lower())

    for layer in scene.get("layers") or []:
        if isinstance(layer, dict):
            h = layer.get("asset") or layer.get("hash") or layer.get("sha256")
            if isinstance(h, str) and len(h) == 64:
                found.add(h.lower())

    for token in scene.get("tokens") or []:
        if isinstance(token, dict):
            h = token.get("asset") or token.get("hash")
            if isinstance(h, str) and len(h) == 64:
                found.add(h.lower())
    return found


def validate(campaign: Path) -> list[str]:
    errors: list[str] = []

    for rel in REQUIRED_DIRS:
        if not (campaign / rel).is_dir():
            errors.append(f"missing required directory: {rel}")

    sheets_dir = campaign / "build" / "sheets"
    sheets: dict[str, dict] = {}
    if sheets_dir.is_dir():
        for path in sorted(sheets_dir.glob("*.yaml")):
            try:
                data = load_yaml(path)
            except Exception as e:  # noqa: BLE001
                errors.append(f"sheet parse error {path.relative_to(campaign)}: {e}")
                continue
            if not isinstance(data, dict):
                errors.append(f"sheet must be a mapping: {path.name}")
                continue
            sheets[path.stem] = data
            if "fields" not in data:
                errors.append(f"sheet missing 'fields': {path.name}")

    actors_dir = campaign / "world" / "actors"
    if actors_dir.is_dir():
        for path in sorted(actors_dir.glob("*.yaml")):
            try:
                actor = load_yaml(path)
            except Exception as e:  # noqa: BLE001
                errors.append(f"actor parse error {path.relative_to(campaign)}: {e}")
                continue
            if not isinstance(actor, dict):
                errors.append(f"actor must be a mapping: {path.name}")
                continue
            sheet_id = actor.get("sheet") or actor.get("sheet_id")
            if not sheet_id:
                errors.append(f"actor missing sheet: {path.name}")
                continue
            if sheet_id not in sheets:
                errors.append(f"actor {path.name}: unknown sheet '{sheet_id}'")
                continue
            allowed = sheet_field_names(sheets[sheet_id])
            given = actor_field_names(actor)
            extra = given - allowed
            if extra:
                errors.append(
                    f"actor {path.name}: fields not in sheet '{sheet_id}': {sorted(extra)}"
                )

    by_hash = campaign / "world" / "assets" / "by-hash"
    existing_hashes: set[str] = set()
    if by_hash.is_dir():
        for p in by_hash.iterdir():
            if p.is_file() and not p.name.startswith("."):
                existing_hashes.add(p.name.lower())

    scenes_dir = campaign / "world" / "scenes"
    if scenes_dir.is_dir():
        for path in sorted(scenes_dir.glob("*.yaml")):
            try:
                scene = load_yaml(path)
            except Exception as e:  # noqa: BLE001
                errors.append(f"scene parse error {path.relative_to(campaign)}: {e}")
                continue
            if not isinstance(scene, dict):
                errors.append(f"scene must be a mapping: {path.name}")
                continue
            for h in collect_scene_hashes(scene):
                if h not in existing_hashes:
                    errors.append(
                        f"scene {path.name}: asset hash not in library: {h}"
                    )

    manifest_path = campaign / "build" / "manifest.json"
    if not manifest_path.is_file():
        errors.append("missing build/manifest.json")
    else:
        import json

        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            errors.append(f"manifest.json parse error: {e}")
            manifest = None

        if isinstance(manifest, dict):
            for key in ("format_version", "compiler_version", "build_id", "files"):
                if key not in manifest:
                    errors.append(f"manifest.json missing '{key}'")
            files = manifest.get("files") or {}
            if not isinstance(files, dict):
                errors.append("manifest.json 'files' must be an object")
            else:
                for rel, expected in files.items():
                    fp = campaign / "build" / rel
                    # Allow paths relative to build/ or campaign-root style build/...
                    if not fp.is_file():
                        alt = campaign / rel
                        fp = alt if alt.is_file() else fp
                    if not fp.is_file():
                        # try as path already under build in the key
                        if rel.startswith("build/"):
                            fp = campaign / rel
                        if not fp.is_file():
                            errors.append(f"manifest lists missing file: {rel}")
                            continue
                    actual = sha256_file(fp)
                    if actual.lower() != str(expected).lower():
                        errors.append(
                            f"manifest hash mismatch for {rel}: "
                            f"expected {expected}, got {actual}"
                        )

    return errors


def main() -> None:
    p = argparse.ArgumentParser(description="Validate a VTT campaign path")
    p.add_argument("--campaign", required=True, type=Path, help="Campaign root path")
    args = p.parse_args()

    campaign = args.campaign.resolve()
    if not campaign.is_dir():
        print(f"campaign not found: {campaign}", file=sys.stderr)
        sys.exit(1)

    errors = validate(campaign)
    if errors:
        print(f"INVALID: {len(errors)} error(s)", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    print(f"OK: {campaign}")
    sys.exit(0)


if __name__ == "__main__":
    main()
