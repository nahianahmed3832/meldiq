"""Renders every Android brand image from the one official brand asset, brand/meldling.png (Meldling, the mascot: the
white bear cub on its deep teal, as Meldiq Web uses everywhere since 2026-10-27). Until 2026-10-28 the source was the
ribbon logo, brand/meldiq-logo.webp, kept as a reference. Nothing is redrawn: the script crops, scales and, for the
single-colour icons, keeps only the bright mark. The web app derives its icons from the same file (meldiq-web
scripts/render-brand-assets.mjs).

Run after replacing the asset (needs Pillow and NumPy):
    python3 -I android/scripts/render_brand.py

Writes, under android/app/src/main/res:
- mipmap-*/ic_launcher_foreground.webp  adaptive icon foreground (the asset, mark inside the 66 dp safe zone)
- mipmap-*/ic_launcher_monochrome.webp  themed-icon layer (white mark, transparent elsewhere)
- drawable-*/ic_stat_meldiq.png          notification icon (white mark, 24 dp)
- drawable-*/splash_mark.webp            launch screen icon (288 dp, mark inside the 192 dp circle)
- drawable-nodpi/meldiq_mark.webp        in-app tile (mark on its ground, 14% padding)
- drawable-nodpi/meldling_glyph.png      the mark alone, white on transparent and tightly cropped (tinted in Compose:
                                         the Messages tab, the typing indicator)
- values/brand_colors.xml                the ground colour, sampled from the asset
"""
import os

import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
DENSITIES = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}
SOURCE = os.path.join("brand", "meldling.png")
# The mark is bright (any channel well above 120); the ground stays below.
BRIGHT = 120
# Soft edge for the single-colour layers: fully transparent at or below LOW, opaque at or above HIGH.
LOW, HIGH = 115, 175

logo = Image.open(os.path.join(ROOT, SOURCE)).convert("RGB")
px = np.asarray(logo).astype(np.float32)
n = logo.width
bright = px.max(axis=2)
ys, xs = np.nonzero(bright > BRIGHT)
x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
mark_w, mark_h = x1 - x0, y1 - y0
mark_diag = (mark_w ** 2 + mark_h ** 2) ** 0.5
cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
ground = tuple(int(v) for v in np.median(np.concatenate([px[:40, :40].reshape(-1, 3), px[-40:, -40:].reshape(-1, 3)]), axis=0))


def feathered_logo():
    """The logo with its outer edge faded into the ground, so it can sit on a larger canvas of that colour."""
    yy, xx = np.mgrid[0:n, 0:n]
    r = np.hypot(xx - n / 2, yy - n / 2) / (n / 2)
    alpha = np.clip((1.0 - r) / 0.25, 0, 1) * 255
    rgba = logo.copy().convert("RGBA")
    rgba.putalpha(Image.fromarray(alpha.astype(np.uint8)))
    return rgba


FEATHERED = feathered_logo()


def ribbon_only():
    """White where the ribbon is, transparent elsewhere (themed icons and the notification icon)."""
    a = np.clip((bright - LOW) / (HIGH - LOW), 0, 1) * 255
    out = np.zeros((n, n, 4), dtype=np.uint8)
    out[..., :3] = 255
    out[..., 3] = a.astype(np.uint8)
    return Image.fromarray(out, "RGBA")


RIBBON = ribbon_only()


def place(source, canvas_px, mark_span_px, by="diag", fill=None):
    """Scales [source] so the mark spans [mark_span_px] (its diagonal or width) and centres the mark on the canvas."""
    span = mark_diag if by == "diag" else max(mark_w, mark_h)
    scale = mark_span_px / span
    size = max(1, round(n * scale))
    scaled = source.resize((size, size), Image.LANCZOS)
    canvas = Image.new("RGBA", (canvas_px, canvas_px), fill + (255,) if fill else (0, 0, 0, 0))
    ox = round(canvas_px / 2 - cx * scale)
    oy = round(canvas_px / 2 - cy * scale)
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    layer.paste(scaled, (ox, oy))  # a plain copy (clipped at the edges), then composited once
    canvas.alpha_composite(layer)
    return canvas


def save(img, folder, name, fmt):
    d = os.path.join(RES, folder)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, name)
    if fmt == "webp":
        img.save(path, "WEBP", lossless=True, quality=100, method=6)
    else:
        img.save(path, "PNG", optimize=True)
    print(os.path.relpath(path, ROOT))


for dens, k in DENSITIES.items():
    # Adaptive icon: 108 dp canvas, visible area a 72 dp mask, safe zone a 66 dp circle. The mark's diagonal is 66 dp.
    save(place(FEATHERED, round(108 * k), 66 * k, fill=ground), f"mipmap-{dens}", "ic_launcher_foreground.webp", "webp")
    save(place(RIBBON, round(108 * k), 66 * k), f"mipmap-{dens}", "ic_launcher_monochrome.webp", "webp")
    # Notification icon: 24 dp, the mark's width 22 dp (status bars draw it as a white silhouette).
    save(place(RIBBON, round(24 * k), 22 * k, by="width"), f"drawable-{dens}", "ic_stat_meldiq.png", "png")
    # Launch screen: 288 dp icon on the ground colour, cropped by the system to a 192 dp circle; the mark's diagonal 176 dp.
    save(place(FEATHERED, round(288 * k), 176 * k, fill=ground), f"drawable-{dens}", "splash_mark.webp", "webp")

# In-app tile: the mark with 14% padding on each side, on its ground (the shape is clipped in Compose).
tile_px = 384
save(place(FEATHERED, tile_px, tile_px / 1.28, by="width", fill=ground), "drawable-nodpi", "meldiq_mark.webp", "webp")

# The mark alone for tinting: its width fills a 96 px square.
save(place(RIBBON, 96, 96, by="width"), "drawable-nodpi", "meldling_glyph.png", "png")

hex_ground = "#FF%02X%02X%02X" % ground
with open(os.path.join(RES, "values", "brand_colors.xml"), "w", encoding="utf-8") as f:
    f.write(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        f"    <!-- Sampled from {SOURCE} by android/scripts/render_brand.py: the brand asset's ground. -->\n"
        f'    <color name="brand_ground">{hex_ground}</color>\n</resources>\n'
    )
print("mark bbox", (int(x0), int(y0), int(x1), int(y1)), "ground", hex_ground)
