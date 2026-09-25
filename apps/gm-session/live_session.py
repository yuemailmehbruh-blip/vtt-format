"""0.7.1 live session shared with players: the GM's active scene (map view) and
the session chat.

- **Active scene / map view.** The GM map window reports which scene it shows
  (``set_active``). A watcher thread stats the files that make up that view (scene,
  its map, its tokens, the actors on it) every 0.25 s; when anything changed it
  rebuilds the *player view* (a whitelisted, render-only bundle: visible map
  layers, grid, tokens, token actors' appearance/aura radii) and bumps
  ``map_rev`` only if the bundle really differs.
- **Chat.** One chat per campaign, authoritative on the GM:
  ``state/chat/session.jsonl`` (one JSON object per line: seq, t (server ms),
  sender {id, name, role}, kind message|roll, text | label/result/detail).
  ``epoch`` changes when the GM clears the chat (old log moves to the trash).
- **Push.** Every change notifies ``cond``; the GM's rolls window and the player
  listener long-poll (``wait``) on it, so updates go out immediately.
"""

from __future__ import annotations

import hashlib
import json
import math
import secrets
import shutil
import threading
import time
from pathlib import Path

CHAT_MAX_TEXT = 500
CHAT_MAX_LABEL = 200
CHAT_MAX_DETAIL = 300
CHAT_MAX_RESULT = 40
CHAT_KEEP = 1000  # entries kept in memory / served
CHAT_KINDS = ("message", "roll")


class ChatError(ValueError):
    pass


def clean_chat(body) -> dict:
    """Boundary check for one chat post (GM or player). Raises ChatError."""
    if not isinstance(body, dict):
        raise ChatError("body must be an object")
    kind = body.get("kind", "message")
    if kind not in CHAT_KINDS:
        raise ChatError("kind must be message or roll")
    out: dict = {"kind": kind}
    if kind == "message":
        text = body.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ChatError("text required")
        text = text.strip()
        if len(text) > CHAT_MAX_TEXT:
            raise ChatError(f"message too long (max {CHAT_MAX_TEXT} characters)")
        out["text"] = text
        return out
    label = body.get("label", "")
    detail = body.get("detail", "")
    result = body.get("result")
    if not isinstance(label, str) or len(label) > CHAT_MAX_LABEL:
        raise ChatError("bad roll label")
    if not isinstance(detail, str) or len(detail) > CHAT_MAX_DETAIL:
        raise ChatError("bad roll detail")
    if isinstance(result, bool) or not isinstance(result, (int, float, str)):
        raise ChatError("roll result must be a number or short text")
    if isinstance(result, float) and not math.isfinite(result):  # NaN / inf
        raise ChatError("bad roll result")
    if isinstance(result, str) and len(result) > CHAT_MAX_RESULT:
        raise ChatError("roll result too long")
    out.update(label=label.strip(), result=result, detail=detail.strip())
    return out


class LiveSession:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.cond = threading.Condition()
        self.view_builder = None  # callable(scene_id) -> (view dict, [paths to watch])
        self.active_scene: str | None = self._load_active()
        self.map_rev = 0
        self.view: dict = {"scene": None, "tokens": [], "actors": {}, "assets": []}
        self._view_hash = ""
        self._watch: list[Path] = []
        self._stat_sig = None
        self._watcher: threading.Thread | None = None
        self.chat: list[dict] = []
        self.chat_seq = 0
        self.chat_epoch = ""
        self._load_chat()

    # ------------------------------------------------------------ active scene
    def _session_path(self) -> Path:
        return self.root / "state" / "session.json"

    def _load_active(self) -> str | None:
        try:
            v = json.loads(self._session_path().read_text(encoding="utf-8")).get("active_scene")
            return v if isinstance(v, str) and v else None
        except (OSError, ValueError, AttributeError):
            return None

    def set_active(self, scene_id: str | None) -> None:
        scene_id = scene_id or None
        if scene_id == self.active_scene:
            return
        self.active_scene = scene_id
        try:
            p = self._session_path()
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_name(p.name + ".tmp")
            tmp.write_text(json.dumps({"active_scene": scene_id}) + "\n", encoding="utf-8")
            tmp.replace(p)
        except OSError:
            pass
        self.refresh(force=True)

    # ------------------------------------------------------------ map view
    def _stats(self) -> tuple:
        sig = [self.active_scene]
        for p in self._watch:
            try:
                s = p.stat()
                sig.append((str(p), s.st_mtime_ns, s.st_size))
            except OSError:
                sig.append((str(p), None))
        return tuple(sig)

    def refresh(self, force: bool = False) -> bool:
        """Rebuild the player view if its inputs changed; bump map_rev if it differs."""
        if self.view_builder is None:
            return False
        sig = self._stats()
        if not force and sig == self._stat_sig:
            return False
        try:
            view, watch = self.view_builder(self.active_scene)
        except Exception:  # noqa: BLE001 - a half-written file: retry next tick
            return False
        self._watch = [Path(p) for p in watch]
        self._stat_sig = self._stats()
        h = hashlib.sha256(json.dumps(view, sort_keys=True, default=str).encode()).hexdigest()
        if h == self._view_hash:
            return False
        with self.cond:
            self._view_hash = h
            self.view = view
            self.map_rev += 1
            self.cond.notify_all()
        return True

    def start_watcher(self, interval: float = 0.25) -> None:
        if self._watcher is not None:
            return
        self.refresh(force=True)

        def loop():
            while True:
                time.sleep(interval)
                try:
                    self.refresh()
                except Exception:  # noqa: BLE001
                    pass

        self._watcher = threading.Thread(target=loop, name="gm-live-watch", daemon=True)
        self._watcher.start()

    def view_assets(self) -> set[str]:
        return set(self.view.get("assets") or [])

    # ------------------------------------------------------------ chat
    def _chat_path(self) -> Path:
        return self.root / "state" / "chat" / "session.jsonl"

    def _load_chat(self) -> None:
        p = self._chat_path()
        entries: list[dict] = []
        epoch = ""
        try:
            for line in p.read_text(encoding="utf-8").splitlines():
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if isinstance(e, dict) and e.get("type") == "epoch":
                    epoch = str(e.get("epoch") or "")
                elif isinstance(e, dict) and isinstance(e.get("seq"), int):
                    entries.append(e)
        except OSError:
            pass
        self.chat = entries[-CHAT_KEEP:]
        self.chat_seq = entries[-1]["seq"] if entries else 0
        self.chat_epoch = epoch or "e0"

    def post_chat(self, sender: dict, body) -> dict:
        clean = clean_chat(body)
        with self.cond:
            self.chat_seq += 1
            entry = {"seq": self.chat_seq, "t": int(time.time() * 1000), "sender": sender, **clean}
            p = self._chat_path()
            p.parent.mkdir(parents=True, exist_ok=True)
            with p.open("a", encoding="utf-8") as fh:
                if p.stat().st_size == 0:
                    fh.write(json.dumps({"type": "epoch", "epoch": self.chat_epoch}) + "\n")
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
            self.chat.append(entry)
            del self.chat[:-CHAT_KEEP]
            self.cond.notify_all()
        return entry

    def chat_since(self, after: int, limit: int = 300) -> dict:
        with self.cond:
            items = [e for e in self.chat if e["seq"] > after][-limit:]
            return {"epoch": self.chat_epoch, "seq": self.chat_seq, "entries": items}

    def clear_chat(self) -> str | None:
        """GM: start a fresh chat for everyone; the old log moves to state/trash."""
        with self.cond:
            p = self._chat_path()
            moved = None
            if p.is_file():
                stamp = time.strftime("%Y%m%d-%H%M%S")
                dest = self.root / "state" / "trash" / f"{stamp}-chat" / "files" / "state" / "chat" / "session.jsonl"
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(p), str(dest))
                moved = dest.relative_to(self.root).as_posix()
            self.chat = []
            self.chat_epoch = secrets.token_hex(4)
            self.cond.notify_all()
            return moved

    # ------------------------------------------------------------ push
    def state(self) -> dict:
        return {"map_rev": self.map_rev, "scene_id": self.active_scene,
                "chat_seq": self.chat_seq, "chat_epoch": self.chat_epoch}

    def wait(self, map_rev, chat_seq, chat_epoch, timeout: float) -> dict:
        """Return as soon as the map revision or chat differs from what the caller has."""
        deadline = time.time() + max(0.0, min(float(timeout), 25.0))

        def changed():
            return (map_rev is not None and map_rev != self.map_rev) or \
                   (chat_seq is not None and chat_seq != self.chat_seq) or \
                   (chat_epoch is not None and chat_epoch != self.chat_epoch)

        with self.cond:
            while not changed():
                left = deadline - time.time()
                if left <= 0:
                    break
                self.cond.wait(left)
            return self.state()
