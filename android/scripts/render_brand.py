"""Renders every Android brand image from the owner's Meldling art (2026-10-29, "use these image assets on mobile app and
webapp"): the originals are in brand/meldling/ (as in meldiq-web brand/meldling/), and brand/meldling/rendered/ holds what
meldiq-web's scripts/render-brand-assets.mjs makes from them (the app icon square, the launch icon, the cropped poses and
posters), so Android and the web show the same pictures. Nothing is redrawn: this script scales, places and, for the
single-colour icons, keeps only the white cub as opacity (as the web's badge and favicons). Until 2026-10-29 the source
was brand/meldling.png (the earlier teal Meldling), kept as a reference.

Run after replacing the art (needs Pillow and NumPy):
    python3 -I android/scripts/render_brand.py

Writes, under android/app/src/main/res:
- mipmap-*/ic_launcher_foreground.webp  adaptive icon foreground: the art's square at 80 dp, so the 72 dp mask shows it
                                         edge to edge on the navy ground (ic_launcher_background)
- mipmap-*/ic_launcher_monochrome.webp  themed-icon layer: the cub's white shape inside the 66 dp safe zone
- drawable-*/ic_stat_meldiq.png          notification icon: the cub's white shape, 22 dp wide in 24 dp
- drawable-*/splash_mark.webp            launch screen icon: the rounded app icon inside the system's 192 dp circle
- drawable-nodpi/meldiq_mark.webp        in-app tile: the rounded app icon
- drawable-nodpi/meldling_glyph.png      the cub's shape alone, white on transparent, tightly cropped (tinted in Compose)
- drawable-nodpi/meldling_<pose>.webp    the poses and posters (intro pages, empty states, sign-in, Mojo and Spark heroes)
- values/brand_colors.xml                the art's ground, #070a24 (as the web's GROUND)
"""
import os
import shutil

import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
ART = os.path.join(ROOT, "brand", "meldling", "rendered")
DENSITIES = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}
GROUND = (0x07, 0x0A, 0x24)
# The cub is near white in every channel; the glow around it is saturated blue or violet (one channel low). The darkest
# channel, from LOW (transparent) to HIGH (opaque), is the cub's opacity; its eyes and nose stay holes.
LOW, HIGH = 110, 185
POSES = ["hello", "gaming", "all-set", "loading", "waving", "confused", "love", "banner", "plus", "spark"]

square = Image.open(os.path.join(ART, "meldling-maskable-512.png")).convert("RGBA")  # the art, edge to edge
rounded = Image.open(os.path.join(ART, "meldling-512.png")).convert("RGBA")  # the app icon, corners see-through


def silhouette():
    """White where the cub is, transparent elsewhere, cropped to the cub."""
    px = np.asarray(square.convert("RGB")).astype(np.float32)
    a = np.clip((px.min(axis=2) - LOW) / (HIGH - LOW), 0, 1)
    ys, xs = np.nonzero(a > 0.5)
    out = np.zeros(px.shape[:2] + (4,), dtype=np.uint8)
    out[..., :3] = 255
    out[..., 3] = (a * 255).astype(np.uint8)
    return Image.fromarray(out, "RGBA").crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))


CUB = silhouette()


def centred(img, canvas_px, span_px, fill=None):
    """[img] scaled so its larger side is [span_px], centred on a square canvas (transparent, or [fill])."""
    scale = span_px / max(img.width, img.height)
    scaled = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (canvas_px, canvas_px), fill + (255,) if fill else (0, 0, 0, 0))
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    layer.paste(scaled, ((canvas_px - scaled.width) // 2, (canvas_px - scaled.height) // 2))
    canvas.alpha_composite(layer)
    return canvas


def save(img, folder, name, fmt):
    d = os.path.join(RES, folder)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, name)
    if fmt == "webp":
        img.save(path, "WEBP", quality=90, method=6)
    else:
        img.save(path, "PNG", optimize=True)
    print(os.path.relpath(path, ROOT))


for dens, k in DENSITIES.items():
    # Adaptive icon: 108 dp canvas, visible area a 72 dp mask: the art's square at 80 dp fills it with room for parallax.
    save(centred(square, round(108 * k), 80 * k), f"mipmap-{dens}", "ic_launcher_foreground.webp", "webp")
    # Themed icon: the cub inside the 66 dp safe zone (its larger side 48 dp).
    save(centred(CUB, round(108 * k), 48 * k), f"mipmap-{dens}", "ic_launcher_monochrome.webp", "webp")
    # Notification icon: 24 dp, the cub 22 dp (status bars draw it as a white silhouette).
    save(centred(CUB, round(24 * k), 22 * k), f"drawable-{dens}", "ic_stat_meldiq.png", "png")
    # Launch screen: 288 dp icon on the ground, cropped by the system to a 192 dp circle; the rounded icon's diagonal fits it.
    save(centred(rounded, round(288 * k), 136 * k, fill=GROUND), f"drawable-{dens}", "splash_mark.webp", "webp")

# In-app tile (the shape is clipped in Compose) and the tintable glyph.
save(rounded.resize((384, 384), Image.LANCZOS), "drawable-nodpi", "meldiq_mark.webp", "webp")
save(centred(CUB, 96, 96), "drawable-nodpi", "meldling_glyph.png", "png")

# The poses and posters, as the web renders them.
for pose in POSES:
    dest = os.path.join(RES, "drawable-nodpi", "meldling_" + pose.replace("-", "_") + ".webp")
    shutil.copyfile(os.path.join(ART, pose + ".webp"), dest)
    print(os.path.relpath(dest, ROOT))

with open(os.path.join(RES, "values", "brand_colors.xml"), "w", encoding="utf-8") as f:
    f.write(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        "    <!-- The Meldling art's ground (brand/meldling, as meldiq-web's GROUND), by android/scripts/render_brand.py. -->\n"
        '    <color name="brand_ground">#FF%02X%02X%02X</color>\n</resources>\n' % GROUND
    )
print("cub", CUB.size)
