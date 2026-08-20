#!/usr/bin/env python3
"""Generate macOS app and tray icons from the Headstate splash art.

Requires Pillow (see scripts/requirements.txt): pip install -r scripts/requirements.txt

Source art defaults to the committed `public/splash.png`, falling back to
`~/Downloads/Headstate-Splash-1600x1000.png` if present (useful for
regenerating icons from a freshly-exported splash before it's committed).

Two very different targets:

* App icon: 1024x1024 sRGB PNG with alpha. macOS does NOT mask app icons
  (unlike iOS), so the squircle is baked in here -- and it must be Apple's
  continuous-curvature squircle, not a CSS-style rounded rect, or it reads
  wrong beside every other Dock icon. Art fills the inner 824x824.

* Tray icon: a template image. Pure black artwork plus alpha, no color at
  all. The `Template` filename suffix is what tells macOS to invert it for
  light/dark menu bars and highlight it on click.

This script also writes a stable `icon-master.png` (the 1024x1024 app icon,
identical to `icon.png` at the time this script runs). That's needed because
the required next step, `yarn tauri icon src-tauri/icons/icon.png`, reads
`icon.png` as its source and then overwrites that same path with its own
512x512 render while generating the sized PNG/icns set. Since the brief
requires `icon.png` itself to remain the 1024x1024 master, the `icons` Make
target restores it from `icon-master.png` after `yarn tauri icon` runs.
"""

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"
PUBLIC = ROOT / "public"

# The committed public/splash.png is a copy of the original source art (this
# script writes it there itself, below), so it's the primary, portable
# source -- any contributor who clones the repo already has it. The
# ~/Downloads path is a fallback for the original workflow of dropping a
# freshly-exported splash there to regenerate icons from a new source.
SPLASH_CANDIDATES = [
    PUBLIC / "splash.png",
    Path.home() / "Downloads" / "Headstate-Splash-1600x1000.png",
]

CANVAS = 1024
ART = 824


def squircle_mask(size: int, radius_ratio: float = 0.2225) -> Image.Image:
    """Apple's icon shape, approximated by a superellipse.

    n=5 matches the macOS Big Sur+ icon curvature far better than a
    circular-corner rounded rectangle does.
    """
    mask = Image.new("L", (size * 4, size * 4), 0)
    draw = ImageDraw.Draw(mask)
    n = 5.0
    half = size * 2
    pts = []
    steps = 2048
    for i in range(steps):
        t = 2.0 * 3.141592653589793 * i / steps
        import math
        c, s = math.cos(t), math.sin(t)
        x = half * (abs(c) ** (2.0 / n)) * (1 if c >= 0 else -1)
        y = half * (abs(s) ** (2.0 / n)) * (1 if s >= 0 else -1)
        pts.append((half + x, half + y))
    draw.polygon(pts, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def crop_glyph(splash: Image.Image) -> Image.Image:
    """Cut the branch mark out of the splash, above the wordmark.

    The source splash is a flat, fully-opaque RGB(A) image -- there is no
    transparency around the glyph. A naive crop therefore carries its own
    near-black background rectangle as opaque pixels, which shows up as a
    visible seam on the app icon and turns the tray silhouette into a solid
    black square. Key the near-black background out to alpha=0 so only the
    glyph strokes/nodes survive.
    """
    w, h = splash.size
    # The mark sits centered in the upper ~62% of the 1600x1000 art.
    box = (int(w * 0.32), int(h * 0.13), int(w * 0.68), int(h * 0.66))
    glyph = splash.crop(box).convert("RGBA")
    px = glyph.load()
    gw, gh = glyph.size
    bg_thresh = 45  # max(r, g, b) below this is background, not glyph.
    for y in range(gh):
        for x in range(gw):
            r, g, b, a = px[x, y]
            if max(r, g, b) <= bg_thresh:
                px[x, y] = (r, g, b, 0)
    return glyph


def make_app_icon(glyph: Image.Image) -> None:
    bg = Image.new("RGBA", (CANVAS, CANVAS), (13, 17, 23, 255))
    art = glyph.copy()
    art.thumbnail((ART, ART), Image.LANCZOS)
    bg.paste(art, ((CANVAS - art.width) // 2, (CANVAS - art.height) // 2), art)
    bg.putalpha(squircle_mask(CANVAS))
    ICONS.mkdir(parents=True, exist_ok=True)
    bg.save(ICONS / "icon.png")
    print(f"wrote {ICONS / 'icon.png'} ({CANVAS}x{CANVAS})")
    # `yarn tauri icon src-tauri/icons/icon.png` (the required next step) reads
    # this file and then OVERWRITES it with its own 512x512 render as part of
    # generating the sized PNG/icns set. The brief requires icon.png to remain
    # the 1024x1024 master, so stash a copy at a stable path the Makefile's
    # `icons` target restores from after `yarn tauri icon` has run.
    bg.save(ICONS / "icon-master.png")
    print(f"wrote {ICONS / 'icon-master.png'} ({CANVAS}x{CANVAS}) -- 1024 master, restored over icon.png after `yarn tauri icon`")


def make_tray_icons(glyph: Image.Image) -> None:
    """Template image: silhouette in black, everything else transparent."""
    for scale, name in ((1, "trayTemplate.png"), (2, "trayTemplate@2x.png"),
                        (3, "trayTemplate@3x.png")):
        size = 22 * scale
        g = glyph.copy().convert("RGBA")
        g.thumbnail((size, size), Image.LANCZOS)
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out.paste(g, ((size - g.width) // 2, (size - g.height) // 2), g)
        # Any pixel with meaningful alpha becomes opaque black.
        px = out.load()
        for y in range(size):
            for x in range(size):
                r, gg, b, a = px[x, y]
                px[x, y] = (0, 0, 0, 255 if a > 40 else 0)
        out.save(ICONS / name)
        print(f"wrote {ICONS / name} ({size}x{size})")


def icns_unpack(path: Path, dest: Path) -> None:
    subprocess.run(
        ["iconutil", "-c", "iconset", "-o", str(dest), str(path)],
        check=True, capture_output=True,
    )


def icns_content_unchanged(candidate: Path, committed_rev: str = "HEAD") -> bool:
    """True if `candidate` decodes to the same images as the committed icns.

    `yarn tauri icon`'s ICNS encoder is non-deterministic: re-running it on
    unchanged source art re-packs icon.icns with different compressed-stream
    bytes even though every embedded image is pixel-identical. Comparing
    raw bytes would treat that as a real change and cause a spurious `git
    status` diff on every `make icons` run. Comparing the unpacked PNGs
    (via `iconutil -c iconset`) tells the two cases apart.
    """
    show = subprocess.run(
        ["git", "show", f"{committed_rev}:src-tauri/icons/icon.icns"],
        capture_output=True,
    )
    if show.returncode != 0:
        return False  # no committed version to compare against
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        committed_icns = tmp_path / "committed.icns"
        committed_icns.write_bytes(show.stdout)
        try:
            icns_unpack(candidate, tmp_path / "candidate.iconset")
            icns_unpack(committed_icns, tmp_path / "committed.iconset")
        except (subprocess.CalledProcessError, FileNotFoundError):
            return False  # iconutil unavailable or unpack failed; don't guess
        candidate_files = sorted((tmp_path / "candidate.iconset").iterdir())
        committed_files = sorted((tmp_path / "committed.iconset").iterdir())
        if [p.name for p in candidate_files] != [p.name for p in committed_files]:
            return False
        return all(
            a.read_bytes() == b.read_bytes()
            for a, b in zip(candidate_files, committed_files)
        )


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--restore-icns-if-unchanged":
        icns = ICONS / "icon.icns"
        if icns.exists() and icns_content_unchanged(icns):
            subprocess.run(
                ["git", "checkout", "--", "src-tauri/icons/icon.icns"], check=True
            )
            print("icon.icns content unchanged -- restored committed bytes")
        else:
            print("icon.icns content changed -- keeping newly generated file")
        return 0

    splash_path = next((p for p in SPLASH_CANDIDATES if p.exists()), None)
    if splash_path is None:
        candidates = "\n  ".join(str(p) for p in SPLASH_CANDIDATES)
        print(f"missing splash art, looked in:\n  {candidates}", file=sys.stderr)
        return 1
    splash = Image.open(splash_path).convert("RGBA")
    PUBLIC.mkdir(parents=True, exist_ok=True)
    if splash_path != PUBLIC / "splash.png":
        splash.save(PUBLIC / "splash.png")
    glyph = crop_glyph(splash)
    make_app_icon(glyph)
    make_tray_icons(glyph)
    print(
        "\nNow run: yarn tauri icon src-tauri/icons/icon.png"
        "\nThen restore the 1024 master: cp src-tauri/icons/icon-master.png "
        "src-tauri/icons/icon.png"
        "\n(both steps are already wired into `make icons`)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
