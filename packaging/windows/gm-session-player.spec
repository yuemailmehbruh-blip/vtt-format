# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for GM Session Player (0.7.0+; onedir, windowed, pywebview).
# Reuses the GM app's sheet renderer (sheet.html/sheet.js/sheet-runtime.js) and the
# shared sync core (sync_core.py). Run from packaging/windows/ via build.ps1.

from pathlib import Path

SPECDIR = Path(SPECPATH).resolve()
REPO = SPECDIR.parent.parent
GM = REPO / "apps" / "gm-session"
PL = REPO / "apps" / "player-session"

block_cipher = None

datas = [
    (str(PL / "player.html"), "player-session"),
    (str(PL / "player.js"), "player-session"),
    (str(PL / "join.html"), "player-session"),
    (str(PL / "join.js"), "player-session"),
    (str(GM / "index.html"), "gm-session"),
    (str(GM / "session.js"), "gm-session"),
    (str(GM / "org-tree.js"), "gm-session"),
    (str(GM / "infer-grid-from-walls.js"), "gm-session"),
    (str(GM / "sheet.html"), "gm-session"),
    (str(GM / "sheet.js"), "gm-session"),
    (str(GM / "sheet-runtime.js"), "gm-session"),
    (str(GM / "image-xform.js"), "gm-session"),
    (str(GM / "token-auras.js"), "gm-session"),
    (str(GM / "VERSION"), "gm-session"),
]

a = Analysis(
    [str(PL / "player_app.py")],
    pathex=[str(PL), str(GM)],
    binaries=[],
    datas=datas,
    hiddenimports=[
        "sync_core",
        "player_store",
        "player_client",
        "player_server",
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
    name="GM Session Player",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
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
    name="GM Session Player",
)
