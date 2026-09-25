#!/usr/bin/env python3
"""0.7.1 unit tests: chat boundary cleaning, chat log/epochs, snap parity with session.js."""
import json
import sys
import tempfile
import threading
import time
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
from live_session import ChatError, LiveSession, clean_chat  # noqa: E402
from server_lib import snap_point  # noqa: E402


def check(c, m):
    if not c:
        raise AssertionError(m)
    print("ok -", m)


def raises(fn, exc=ChatError):
    try:
        fn()
    except exc:
        return True
    return False


check(clean_chat({"kind": "message", "text": "  hi  "}) == {"kind": "message", "text": "hi"}, "message trimmed")
check(clean_chat({"text": "<b>x</b>"})["text"] == "<b>x</b>", "HTML kept verbatim (escaped at render time, never parsed)")
for bad in (None, [], {"kind": "x", "text": "a"}, {"text": ""}, {"text": 5}, {"text": "a" * 501},
            {"kind": "roll", "result": None}, {"kind": "roll", "result": True}, {"kind": "roll", "result": float("inf")},
            {"kind": "roll", "result": float("nan")}, {"kind": "roll", "result": 1, "label": "x" * 201},
            {"kind": "roll", "result": "x" * 41}):
    check(raises(lambda b=bad: clean_chat(b)), f"rejected: {str(bad)[:50]}")
check(clean_chat({"kind": "roll", "label": "d20", "result": 7, "detail": "1d20"})["result"] == 7, "roll accepted")

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    live = LiveSession(root)
    e1 = live.post_chat({"id": "gm", "name": "GM", "role": "gm"}, {"text": "one"})
    e2 = live.post_chat({"id": "p", "name": "P", "role": "player"}, {"kind": "roll", "label": "d6", "result": 3})
    check((e1["seq"], e2["seq"]) == (1, 2), "sequence ids increase")
    check([e["seq"] for e in live.chat_since(1)["entries"]] == [2], "chat_since returns only newer entries")
    again = LiveSession(root)
    check(again.chat_seq == 2 and len(again.chat) == 2 and again.chat_epoch == live.chat_epoch, "log reloads from state/chat/session.jsonl")
    got = {}
    t = threading.Thread(target=lambda: got.setdefault("s", live.wait(None, live.chat_seq, live.chat_epoch, 5)))
    t.start()
    time.sleep(0.1)
    t0 = time.time()
    live.post_chat({"id": "gm", "name": "GM", "role": "gm"}, {"text": "wake"})
    t.join(3)
    check(got.get("s", {}).get("chat_seq") == 3 and time.time() - t0 < 0.3, "long-poll wakes immediately on a new message")
    old = live.chat_epoch
    live.clear_chat()
    check(live.chat_epoch != old and live.chat_since(0)["entries"] == [], "clear starts a new epoch")
    check(any((root / "state" / "trash").rglob("session.jsonl")), "cleared log moved to the campaign trash")

# snap parity with session.js snapWorld (center + corner)
c = {"snapToGrid": True, "snapTarget": "center"}
k = {"snapToGrid": True, "snapTarget": "corner"}
check(snap_point(250, 260, 70, c) == (245, 245), "centre snap")
check(snap_point(-1, 0, 70, c) == (-35, 35), "centre snap negative")
check(snap_point(180, 100, 70, k) == (210, 70), "corner snap")
check(snap_point(181.5, 99, 70, {"snapToGrid": False}) == (181.5, 99), "snap off")
print("all live-session checks passed")
