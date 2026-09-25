"""GM ⇄ player sheet sync core (0.7.0). Pure logic shared by the GM server
(player_host.py) and the player app (apps/player-session); no I/O except the
small JSON helpers at the bottom.

Model
-----
A synced sheet is a map of *keys* → values:
  ``fields.<FIELD_ID>``  sheet field values           (GM ⇄ player)
  ``notes``              the sheet's free-text notes   (GM ⇄ player)
  ``name``               character name                (GM → player only)

Each side keeps, per sheet:
  * ``registers``  {key: {"v": value, "t": stamp, "o": origin}} — last-writer-wins
    registers (value + the hybrid-logical-clock stamp of the write that set it);
  * ``log``        [{"seq", "k", "v", "t", "o"}] — field-level changes the other side
    has not acknowledged yet (compacted: only the newest entry per key is kept, older
    ones are superseded);
  * ``seq``        last sequence number used in that log.

A sync exchanges only unacknowledged log entries plus acks (highest peer seq
applied). Acks trim logs. Applying a change is idempotent.

Conflict rule: for the same key, the write with the larger HLC stamp wins,
regardless of arrival order. Stamps compare as (wall_ms, counter, node).

Hybrid logical clock
--------------------
Stamp = (l, c, node): l = max physical ms seen, c = counter for events within the
same l. ``now()`` and ``recv(remote)`` follow Kulkarni et al. (2014): stamps are
monotonic per node and always greater than every stamp received, so an edit made
*after* seeing another edit always wins even if the two machines' wall clocks
disagree. Wall-clock skew only matters for truly concurrent edits (neither side had
seen the other's), where the machine whose clock runs ahead wins — bounded because
the GM refuses to trust stamps more than MAX_DRIFT_MS ahead of its own clock
(such changes are re-stamped with the GM's time on arrival).
Serialized as ``"%013d.%05d.%s" % (l, c, node)`` so string order == stamp order.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

FIELD_ID_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
PLAYER_ID_RE = re.compile(r"^[a-f0-9]{16,64}$")
NODE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_VALUE_CHARS = 20000
MAX_NOTES_CHARS = 200000
MAX_CHANGES_PER_SHEET = 2000
MAX_DRIFT_MS = 5 * 60 * 1000
GM_NODE = "gm"
PLAYER_WRITABLE = ("fields.", "notes")  # prefixes/keys a player may change


class SyncError(ValueError):
    """Invalid sync input (caller maps to HTTP 400)."""


# ------------------------------------------------------------------ HLC

def make_stamp(l: int, c: int, node: str) -> str:
    return f"{int(l):013d}.{int(c):05d}.{node}"


def parse_stamp(s) -> tuple[int, int, str]:
    if not isinstance(s, str):
        raise SyncError("stamp must be a string")
    parts = s.split(".", 2)
    if len(parts) != 3 or not parts[0].isdigit() or not parts[1].isdigit() or not NODE_RE.match(parts[2]):
        raise SyncError(f"bad stamp: {s!r}")
    if len(parts[0]) != 13 or len(parts[1]) != 5:
        raise SyncError(f"bad stamp width: {s!r}")
    return int(parts[0]), int(parts[1]), parts[2]


class HLC:
    """Hybrid logical clock for one node. ``physical`` is injectable for tests."""

    def __init__(self, node: str, l: int = 0, c: int = 0, physical=None) -> None:
        if not NODE_RE.match(node):
            raise SyncError("bad node id")
        self.node = node
        self.l = int(l)
        self.c = int(c)
        self._phys = physical or (lambda: int(time.time() * 1000))

    def physical(self) -> int:
        return int(self._phys())

    def now(self) -> str:
        pt = self.physical()
        if pt > self.l:
            self.l, self.c = pt, 0
        else:
            self.c += 1
        return make_stamp(self.l, self.c, self.node)

    def recv(self, remote: str) -> str:
        rl, rc, _ = parse_stamp(remote)
        pt = self.physical()
        l_new = max(self.l, rl, pt)
        if l_new == self.l and l_new == rl:
            c_new = max(self.c, rc) + 1
        elif l_new == self.l:
            c_new = self.c + 1
        elif l_new == rl:
            c_new = rc + 1
        else:
            c_new = 0
        self.l, self.c = l_new, c_new
        return make_stamp(self.l, self.c, self.node)

    def state(self) -> dict:
        return {"l": self.l, "c": self.c}


# ------------------------------------------------------------------ values

def canon(v) -> str:
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def same(a, b) -> bool:
    return canon(a) == canon(b)


def valid_key(k) -> bool:
    if k in ("name", "notes"):
        return True
    return isinstance(k, str) and k.startswith("fields.") and bool(FIELD_ID_RE.match(k[7:]))


def player_may_write(k: str) -> bool:
    return k == "notes" or (k.startswith("fields.") and valid_key(k))


def check_value(k: str, v) -> None:
    try:
        text = canon(v)
    except (TypeError, ValueError) as exc:
        raise SyncError(f"{k}: value is not JSON") from exc
    if k == "notes":
        if not isinstance(v, str):
            raise SyncError("notes must be a string")
        if len(v) > MAX_NOTES_CHARS:
            raise SyncError("notes too long")
    elif k == "name":
        if not isinstance(v, str) or not v.strip() or len(v) > 120:
            raise SyncError("bad name")
    elif len(text) > MAX_VALUE_CHARS:
        raise SyncError(f"{k}: value too large")


def validate_changes(changes, *, writer: str) -> list[dict]:
    """Boundary check for a list of incoming changes. ``writer`` = "player" limits keys
    to player-writable ones. Returns cleaned entries; raises SyncError on malformed
    input (the whole request is rejected, nothing applied)."""
    if not isinstance(changes, list):
        raise SyncError("changes must be a list")
    if len(changes) > MAX_CHANGES_PER_SHEET:
        raise SyncError("too many changes")
    out = []
    for ch in changes:
        if not isinstance(ch, dict):
            raise SyncError("change must be an object")
        k, t, seq = ch.get("k"), ch.get("t"), ch.get("seq")
        if not valid_key(k):
            raise SyncError(f"invalid key: {k!r}")
        if writer == "player" and not player_may_write(k):
            raise SyncError(f"players cannot change {k}")
        parse_stamp(t)
        if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
            raise SyncError("seq must be a positive integer")
        check_value(k, ch.get("v"))
        out.append({"seq": seq, "k": k, "v": ch.get("v"), "t": t})
    return out


# ------------------------------------------------------------------ sheet log state

def new_state() -> dict:
    return {"registers": {}, "log": [], "seq": 0}


def record_local(state: dict, key: str, value, stamp: str, origin: str) -> dict | None:
    """A local edit: update the register and queue a log entry (older queued entries
    for the same key are dropped — superseded). No-op if the value is unchanged."""
    reg = state["registers"].get(key)
    if reg is not None and same(reg.get("v"), value):
        return None
    state["registers"][key] = {"v": value, "t": stamp, "o": origin}
    return _append(state, key, value, stamp, origin)


def _append(state: dict, key: str, value, stamp: str, origin: str) -> dict:
    state["seq"] = int(state.get("seq", 0)) + 1
    entry = {"seq": state["seq"], "k": key, "v": value, "t": stamp, "o": origin}
    state["log"] = [e for e in state["log"] if e["k"] != key] + [entry]
    return entry


def apply_remote(state: dict, change: dict, origin: str, *, relog: bool = False) -> bool:
    """Apply a peer's change with last-writer-wins by stamp. Returns True if it won
    (register updated). ``relog`` re-queues winners in this side's log (the GM does
    this so other players assigned to the same sheet receive the change)."""
    k, v, t = change["k"], change.get("v"), change["t"]
    reg = state["registers"].get(k)
    if reg is not None and reg.get("t", "") >= t:
        return False
    state["registers"][k] = {"v": v, "t": t, "o": origin}
    if relog:
        _append(state, k, v, t, origin)
    else:
        # a pending local entry for k is now superseded by the newer remote write
        state["log"] = [e for e in state["log"] if e["k"] != k]
    return True


def trim_acked(state: dict, acked_seq: int) -> int:
    before = len(state["log"])
    state["log"] = [e for e in state["log"] if e["seq"] > int(acked_seq)]
    return before - len(state["log"])


def pending_since(state: dict, since_seq: int, exclude_origin: str | None = None) -> list[dict]:
    return [
        {"seq": e["seq"], "k": e["k"], "v": e["v"], "t": e["t"]}
        for e in state["log"]
        if e["seq"] > int(since_seq) and (exclude_origin is None or e.get("o") != exclude_origin)
    ]


def values_of(state: dict) -> dict:
    return {k: r.get("v") for k, r in state["registers"].items()}


# ------------------------------------------------------------------ JSON files

def load_json(path: Path, default):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, type(default)) else default
    except (OSError, ValueError):
        return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)
