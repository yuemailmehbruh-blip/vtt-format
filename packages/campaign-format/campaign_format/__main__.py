"""Allow: python -m campaign_format <subcommand> …"""

from __future__ import annotations

import sys


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(
            "usage: python -m campaign_format <hash-and-store|validate-campaign> …\n"
            "  hash-and-store      Store file by sha256 into campaign library\n"
            "  validate-campaign   Validate a campaign path",
            file=sys.stderr,
        )
        sys.exit(0 if len(sys.argv) > 1 else 1)

    cmd = sys.argv[1].replace("_", "-")
    sys.argv = [sys.argv[0] + " " + cmd] + sys.argv[2:]

    if cmd == "hash-and-store":
        from campaign_format.hash_and_store import main as run

        run()
    elif cmd == "validate-campaign":
        from campaign_format.validate_campaign import main as run

        run()
    else:
        print(f"unknown subcommand: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
