"""Generate PWA icons: rounded navy tile, cyan vessel chevron over wave arcs."""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "app" / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

BG = (10, 21, 34, 255)
BG_TOP = (16, 34, 54, 255)
CYAN = (63, 200, 255, 255)
CYAN_DIM = (63, 200, 255, 110)
TEAL = (89, 224, 184, 200)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def draw_icon(size, rounded=True, pad_scale=1.0):
    img = Image.new("RGBA", (size, size))
    d = ImageDraw.Draw(img)

    # vertical gradient background
    for y in range(size):
        t = y / size
        r = int(BG_TOP[0] * (1 - t) + BG[0] * t)
        g = int(BG_TOP[1] * (1 - t) + BG[1] * t)
        b = int(BG_TOP[2] * (1 - t) + BG[2] * t)
        d.line([(0, y), (size, y)], fill=(r, g, b, 255))

    s = size / 100.0 * pad_scale
    cx = size / 2

    # depth contour arcs (bottom)
    for i, (ry, alpha) in enumerate([(66, 230), (76, 150), (86, 80)]):
        w = max(2, int(2.6 * s))
        color = (CYAN[0], CYAN[1], CYAN[2], alpha) if i == 0 else (CYAN[0], CYAN[1], CYAN[2], alpha)
        d.arc(
            [cx - 34 * s, ry * s - 14 * s, cx + 34 * s, ry * s + 14 * s],
            start=200,
            end=340,
            fill=color,
            width=w,
        )

    # vessel chevron
    top = 16 * s
    d.polygon(
        [
            (cx, top),
            (cx + 17 * s, top + 44 * s),
            (cx, top + 33 * s),
            (cx - 17 * s, top + 44 * s),
        ],
        fill=CYAN,
        outline=(8, 18, 30, 255),
        width=max(1, int(1.5 * s)),
    )

    if rounded:
        img.putalpha(rounded_mask(size, int(size * 0.22)))
    return img


draw_icon(192).save(OUT / "icon-192.png")
draw_icon(512).save(OUT / "icon-512.png")
# maskable: full-bleed square, content scaled into the 80% safe zone
draw_icon(512, rounded=False, pad_scale=0.8).save(OUT / "maskable-512.png")
print("icons written to", OUT)
