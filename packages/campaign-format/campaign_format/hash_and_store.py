"""Store a file into a campaign's content-addressed asset library."""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    print("PyYAML required: pip install -r requirements.txt", file=sys.stderr)
    sys.exit(2)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_index(index_path: Path) -> dict:
    if not index_path.exists():
        return {"assets": {}}
    data = yaml.safe_load(index_path.read_text(encoding="utf-8")) or {}
    if "assets" not in data or data["assets"] is None:
        data["assets"] = {}
    return data


def store(campaign: Path, file_path: Path, name: str) -> str:
    if not file_path.is_file():
        raise FileNotFoundError(f"not a file: {file_path}")

    digest = sha256_file(file_path)
    by_hash = campaign / "world" / "assets" / "by-hash"
    by_hash.mkdir(parents=True, exist_ok=True)
    dest = by_hash / digest
    if not dest.exists():
        shutil.copy2(file_path, dest)

    index_path = campaign / "world" / "assets" / "index.yaml"
    index = load_index(index_path)
    index["assets"][name] = digest
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(
        yaml.safe_dump(index, sort_keys=False, default_flow_style=False),
        encoding="utf-8",
    )
    return digest


def main() -> None:
    p = argparse.ArgumentParser(description="Hash a file into world/assets/by-hash and update index.yaml")
    p.add_argument("--campaign", required=True, type=Path, help="Campaign root path")
    p.add_argument("--file", required=True, type=Path, help="File to store")
    p.add_argument("--name", required=True, help="Logical name, e.g. maps/docks-bg")
    args = p.parse_args()

    campaign = args.campaign.resolve()
    if not campaign.is_dir():
        print(f"campaign not found: {campaign}", file=sys.stderr)
        sys.exit(1)

    try:
        digest = store(campaign, args.file.resolve(), args.name)
    except Exception as e:  # noqa: BLE001 — CLI surface
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)

    print(digest)
    print(f"stored as {args.name} -> {digest}", file=sys.stderr)


if __name__ == "__main__":
    main()
