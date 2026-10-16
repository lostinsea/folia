#!/usr/bin/env python3
"""Build app icons from the supplied feather artwork (requires Pillow)."""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
SOURCE = ASSETS / "feather-source.jpg"
SIZES = (16, 24, 32, 48, 64, 128, 256)


def make_master():
    image = Image.open(SOURCE).convert("RGB")
    if image.size != (2000, 2000):
        raise ValueError(f"Unexpected feather source size: {image.size}")

    # Flood only the exterior white area; white highlights inside the mark
    # must remain opaque. JPEG antialiasing at the boundary is white-matted.
    minimum = ImageChops.darker(ImageChops.darker(*image.split()[:2]), image.getchannel("B"))
    exterior = minimum.point(lambda value: 255 if value > 205 else 0)
    ImageDraw.floodfill(exterior, (0, 0), 128, thresh=0)

    rgba = image.convert("RGBA")
    pixels = rgba.load()
    exterior_pixels = exterior.load()
    for y in range(image.height):
        for x in range(image.width):
            if exterior_pixels[x, y] != 128:
                continue
            r, g, b, _ = pixels[x, y]
            alpha = min(255, max(0, round((247 - min(r, g, b)) * 255 / 27)))
            if alpha == 0:
                pixels[x, y] = (0, 0, 0, 0)
            elif alpha < 255:
                pixels[x, y] = (
                    max(0, min(255, round(255 + (r - 255) * 255 / alpha))),
                    max(0, min(255, round(255 + (g - 255) * 255 / alpha))),
                    max(0, min(255, round(255 + (b - 255) * 255 / alpha))),
                    alpha,
                )
    return rgba


def main():
    master = make_master()
    for name, size in (
        ("logo.png", 1024),
        ("logo_dark.png", 512),
        ("app-icon.png", 1024),
        ("file-icon.png", 512),
    ):
        master.resize((size, size), Image.Resampling.LANCZOS).save(ASSETS / name)

    icon = master.resize((256, 256), Image.Resampling.LANCZOS)
    for name in ("logo.ico", "file-icon.ico"):
        icon.save(ASSETS / name, format="ICO", sizes=[(size, size) for size in SIZES])


if __name__ == "__main__":
    main()
