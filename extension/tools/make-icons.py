"""Draw the toolbar icons: a black speaker plate with a pale cone and the orange lamp.

Run: python3 tools/make-icons.py   (needs Pillow). Writes icons/icon-{16,32,48,128}.png.
Each size is drawn at 8x and scaled down so the edges are smooth.
"""

from pathlib import Path

from PIL import Image, ImageDraw

INK = (15, 14, 18, 255)       # te-black #0f0e12
FACE = (245, 245, 245, 255)   # te-white #f5f5f5
ACCENT = (240, 90, 36, 255)   # te-orange #f05a24

OUT = Path(__file__).resolve().parent.parent / "icons"
OUT.mkdir(exist_ok=True)


def draw(size: int) -> Image.Image:
    s = size * 8
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    # Tall cabinet, slightly narrower than the square, like a bookshelf speaker.
    small = size <= 16
    w = s * (0.74 if small else 0.68)
    h = s * (0.96 if small else 0.92)
    x0 = (s - w) / 2
    y0 = (s - h) / 2
    d.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=s * 0.07, fill=INK)

    cx = s / 2
    # Cone: a pale ring with a dark centre.
    r = w * (0.34 if small else 0.32)
    cy = y0 + h * 0.64
    ring = max(s * 0.07, 8) if small else s * 0.05
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=FACE)
    d.ellipse([cx - r + ring, cy - r + ring, cx + r - ring, cy + r - ring], fill=INK)
    if not small:
        dc = r * 0.28
        d.ellipse([cx - dc, cy - dc, cx + dc, cy + dc], fill=FACE)

    # Lamp: the one accent, where the tweeter would be.
    lr = w * (0.12 if small else 0.095)
    ly = y0 + h * (0.22 if small else 0.22)
    d.ellipse([cx - lr, ly - lr, cx + lr, ly + lr], fill=ACCENT)

    return im.resize((size, size), Image.LANCZOS)


for size in (16, 32, 48, 128):
    draw(size).save(OUT / f"icon-{size}.png")
    print("wrote", OUT / f"icon-{size}.png")

# A contact sheet for checking them by eye (not used by the extension).
sheet = Image.new("RGBA", (16 + 32 + 48 + 128 + 100, 148), (240, 240, 238, 255))
x = 20
for size in (16, 32, 48, 128):
    sheet.alpha_composite(draw(size), (x, 10 + (128 - size) // 2))
    x += size + 20
sheet.save(Path(__file__).resolve().parent.parent / "tests" / "screenshots" / "icons-sheet.png")
