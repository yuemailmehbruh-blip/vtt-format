"""0.7.1: put short text on the OS clipboard (used when the webview's
navigator.clipboard is unavailable/denied). Windows: Win32 API via ctypes
(CF_UNICODETEXT); macOS: pbcopy; Linux: wl-copy / xclip / xsel if installed."""

from __future__ import annotations

import os
import shutil
import subprocess
import time


def _windows_set(text: str) -> bool:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.EmptyClipboard.restype = wintypes.BOOL
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE
    user32.CloseClipboard.restype = wintypes.BOOL
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]
    CF_UNICODETEXT, GMEM_MOVEABLE = 13, 0x0002

    data = (text + "\0").encode("utf-16-le")
    for _ in range(10):  # another app may hold the clipboard briefly
        if user32.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        return False
    try:
        user32.EmptyClipboard()
        h = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not h:
            return False
        p = kernel32.GlobalLock(h)
        ctypes.memmove(p, data, len(data))
        kernel32.GlobalUnlock(h)
        if not user32.SetClipboardData(CF_UNICODETEXT, h):
            kernel32.GlobalFree(h)
            return False
        return True  # the clipboard owns h now
    finally:
        user32.CloseClipboard()


def set_text(text: str) -> bool:
    try:
        if os.name == "nt":
            return _windows_set(text)
        for cmd in (["pbcopy"], ["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]):
            if shutil.which(cmd[0]):
                r = subprocess.run(cmd, input=text, text=True, timeout=5)
                return r.returncode == 0
    except Exception:  # noqa: BLE001
        return False
    return False
