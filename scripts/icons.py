"""Deterministic local vector-style icon rasterization; no generated/external imagery."""
from PIL import Image, ImageDraw
from pathlib import Path
dest = Path('public/icons')
dest.mkdir(parents=True, exist_ok=True)
for size in (16, 32, 48, 128):
    scale = 4
    im = Image.new('RGBA', (128 * scale, 128 * scale))
    draw = ImageDraw.Draw(im)
    def box(coords): return tuple(int(n * scale) for n in coords)
    draw.rounded_rectangle(box((2, 2, 126, 126)), radius=29 * scale, fill='#247c57')
    # Two rounded strokes form an S and a memory dot.
    draw.arc(box((32, 25, 91, 76)), 90, 300, fill='#ffffff', width=12 * scale)
    draw.arc(box((36, 52, 95, 103)), 270, 480, fill='#ffffff', width=12 * scale)
    draw.ellipse(box((91, 26, 104, 39)), fill='#c6ebd4')
    im.resize((size, size), Image.Resampling.LANCZOS).save(dest / f'{size}.png')
