# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for GM Session (onedir, windowed, pywebview).
# Run from packaging/windows/ via build.ps1 (paths are relative to SPECPATH).

import os
from pathlib import Path

SPECDIR = Path(SPECPATH).resolve()
REPO = SPECDIR.parent.parent
APP = REPO / "apps" / "gm-session"
SAMPLE = REPO / "examples" / "sample-campaign"

block_cipher = None

ui_datas = [
    (str(APP / "index.html"), "gm-session"),
    (str(APP / "session.js"), "gm-session"),
    (str(APP / "sheet.html"), "gm-session"),
    (str(APP / "sheet.js"), "gm-session"),
    (str(APP / "rolls.html"), "gm-session"),
    (str(APP / "rolls.js"), "gm-session"),
    (str(APP / "sheet-builder.html"), "gm-session"),
    (str(APP / "sheet-builder.js"), "gm-session"),
    (str(APP / "sheet-runtime.js"), "gm-session"),
    (str(APP / "infer-grid-from-walls.js"), "gm-session"),
    (str(APP / "VERSION"), "gm-session"),
]

# Bundle sample campaign under sample-campaign/ in the archive (fallback + installer source)
sample_datas = [(str(SAMPLE), "sample-campaign")]

a = Analysis(
    [str(APP / "desktop_app.py")],
    pathex=[str(APP)],
    binaries=[],
    datas=ui_datas + sample_datas,
    hiddenimports=[
        "yaml",
        "webview",
        "webview.platforms.edgechromium",
        "webview.platforms.winforms",
        "bottle",
        "proxy_tools",
        "clr_loader",
        "pythonnet",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="GM Session",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,  # --noconsole / windowed
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="GM Session",
)
