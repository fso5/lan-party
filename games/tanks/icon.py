#!/usr/bin/env python3
"""
Generates the app icons.

Hand-drawn procedurally rather than shipped as binary assets: the icon is a
top-down tank on the same plywood ground the game renders, so it stays in sync
with the palette in index.html, and there is no binary blob in the repo whose
provenance nobody remembers.

Pure stdlib -- zlib and struct are enough to write a PNG, and the container has
no image library.
"""

import struct
import zlib
from pathlib import Path

# Same palette as the game's dark theme.
BG = (0x1F, 0x1C, 0x16)
PLY = (0x2E, 0x2A, 0x22)
TANK = (0x2E, 0x6D, 0xA4)
TANK_DARK = (0x1E, 0x4C, 0x76)
BARREL = (0x8A, 0x9C, 0xAB)
SHELL = (0xFF, 0xCE, 0x6E)
RUST = (0xC1, 0x44, 0x0E)


def rounded_rect(px, w, h, x0, y0, x1, y1, r, color):
    """Filled rounded rectangle, with the corner test done in squared space."""
    for y in range(max(0, int(y0)), min(h, int(y1) + 1)):
        for x in range(max(0, int(x0)), min(w, int(x1) + 1)):
            cx = min(max(x, x0 + r), x1 - r)
            cy = min(max(y, y0 + r), y1 - r)
            dx, dy = x - cx, y - cy
            if dx * dx + dy * dy <= r * r:
                px[y][x] = color


def disc(px, w, h, cx, cy, r, color):
    for y in range(max(0, int(cy - r)), min(h, int(cy + r) + 1)):
        for x in range(max(0, int(cx - r)), min(w, int(cx + r) + 1)):
            dx, dy = x - cx, y - cy
            if dx * dx + dy * dy <= r * r:
                px[y][x] = color


def draw(size):
    """One tank, turret pointing right, with a shell already away."""
    s = size / 512.0
    px = [[BG for _ in range(size)] for _ in range(size)]

    # Ground panel, inset, so the icon reads as a board rather than a flat fill.
    rounded_rect(px, size, size, 40 * s, 40 * s, 472 * s, 472 * s, 56 * s, PLY)

    # Treads: two dark bars either side of the hull.
    rounded_rect(px, size, size, 150 * s, 168 * s, 330 * s, 208 * s, 18 * s, TANK_DARK)
    rounded_rect(px, size, size, 150 * s, 304 * s, 330 * s, 344 * s, 18 * s, TANK_DARK)

    # Hull.
    rounded_rect(px, size, size, 158 * s, 196 * s, 322 * s, 316 * s, 26 * s, TANK)

    # Barrel, pointing right toward the shell.
    rounded_rect(px, size, size, 240 * s, 240 * s, 400 * s, 272 * s, 16 * s, BARREL)

    # Turret ring.
    disc(px, size, size, 240 * s, 256 * s, 52 * s, TANK)
    disc(px, size, size, 240 * s, 256 * s, 30 * s, TANK_DARK)

    # A shell in flight, mid-ricochet off the right wall.
    disc(px, size, size, 428 * s, 256 * s, 18 * s, SHELL)
    disc(px, size, size, 452 * s, 196 * s, 11 * s, RUST)

    return px


def write_png(path, px):
    h = len(px)
    w = len(px[0])
    raw = bytearray()
    for row in px:
        raw.append(0)  # filter type 0
        for r, g, b in row:
            raw += bytes((r, g, b))

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    Path(path).write_bytes(png)
    return len(png)


if __name__ == '__main__':
    import sys

    out = Path(sys.argv[1] if len(sys.argv) > 1 else 'dist')
    out.mkdir(parents=True, exist_ok=True)
    for size, name in ((192, 'icon-192.png'), (512, 'icon-512.png'), (180, 'apple-touch-icon.png')):
        n = write_png(out / name, draw(size))
        print(f'  {name}  {size}x{size}  {n}B')
