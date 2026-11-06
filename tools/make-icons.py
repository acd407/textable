#!/usr/bin/env python3
"""生成扩展图标（纯几何图形，不依赖字体）。

用法： python3 tools/make-icons.py
输出： icons/icon-{16,32,48,96,128}.png
"""

import os
from PIL import Image, ImageDraw

SIZES = (16, 32, 48, 96, 128)
BASE = 512
BG_TOP = (46, 158, 143)
BG_BOTTOM = (16, 92, 84)
FG = (255, 255, 255)


def rounded_mask(size: int, radius: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def background(size: int) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / (size - 1)
        grad.putpixel(
            (0, y),
            tuple(round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)),
        )
    layer = grad.resize((size, size))
    layer.putalpha(rounded_mask(size, size * 0.24))
    return layer


def table_glyph(size: int) -> Image.Image:
    """三列三行的表格：表头一行实心，其余是描边格。"""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    cols, rows = 3, 3
    margin_x = size * 0.22
    margin_y = size * 0.24
    gap = size * 0.035
    cell_w = (size - 2 * margin_x - gap * (cols - 1)) / cols
    cell_h = (size - 2 * margin_y - gap * (rows - 1)) / rows
    radius = max(1.0, size * 0.028)
    stroke = max(1.0, size * 0.03)

    for r in range(rows):
        for c in range(cols):
            x0 = margin_x + c * (cell_w + gap)
            y0 = margin_y + r * (cell_h + gap)
            box = (x0, y0, x0 + cell_w, y0 + cell_h)
            if r == 0:
                draw.rounded_rectangle(box, radius=radius, fill=FG)
            else:
                draw.rounded_rectangle(box, radius=radius, outline=FG, width=int(round(stroke)))
    return layer


def build(size: int) -> Image.Image:
    icon = background(BASE)
    icon.alpha_composite(table_glyph(BASE))
    return icon.resize((size, size), Image.LANCZOS)


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    icons = os.path.join(root, "icons")
    os.makedirs(icons, exist_ok=True)
    for size in SIZES:
        path = os.path.join(icons, "icon-%d.png" % size)
        build(size).save(path, optimize=True)
        print("  %-28s %d bytes" % (os.path.relpath(path, root), os.path.getsize(path)))


if __name__ == "__main__":
    main()
