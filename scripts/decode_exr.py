#!/usr/bin/env python3
"""Convert a linear OpenEXR image into an sRGB JPEG preview."""

from __future__ import annotations

import os
import sys


def load_exr(input_path: str):
    os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
    errors: list[str] = []

    try:
        import cv2

        image = cv2.imread(input_path, cv2.IMREAD_UNCHANGED)
        if image is not None:
            if image.ndim == 2:
                return image[..., None], "gray"
            return image, "bgr"
        errors.append("OpenCV returned no image")
    except Exception as error:  # OpenCV EXR availability is build-dependent.
        errors.append(f"OpenCV: {error}")

    try:
        import imageio.v3 as iio

        image = iio.imread(input_path)
        if image is not None:
            if image.ndim == 2:
                return image[..., None], "gray"
            return image, "rgb"
        errors.append("imageio returned no image")
    except Exception as error:
        errors.append(f"imageio: {error}")

    raise RuntimeError("; ".join(errors))


def to_rgb(image, channel_order: str):
    import numpy as np

    pixels = np.asarray(image, dtype=np.float32)
    pixels = np.nan_to_num(pixels, nan=0.0, posinf=1.0, neginf=0.0)

    if pixels.shape[2] == 1:
        rgb = np.repeat(pixels, 3, axis=2)
        alpha = None
    elif pixels.shape[2] == 2:
        rgb = np.repeat(pixels[..., :1], 3, axis=2)
        alpha = pixels[..., 1:2]
    else:
        rgb = pixels[..., :3]
        if channel_order == "bgr":
            rgb = rgb[..., ::-1]
        alpha = pixels[..., 3:4] if pixels.shape[2] >= 4 else None

    rgb = np.maximum(rgb, 0.0)
    if alpha is not None:
        alpha = np.clip(alpha, 0.0, 1.0)
        rgb = rgb * alpha
    return rgb


def linear_to_srgb(image):
    import numpy as np

    clipped = np.clip(image, 0.0, 1.0)
    srgb = np.where(
        clipped <= 0.0031308,
        clipped * 12.92,
        1.055 * np.power(clipped, 1.0 / 2.4) - 0.055,
    )
    return np.clip(np.rint(srgb * 255.0), 0, 255).astype(np.uint8)


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: decode_exr.py INPUT OUTPUT JPEG_QUALITY", file=sys.stderr)
        return 2

    try:
        import numpy  # noqa: F401 - checked here for a clearer setup error.
        from PIL import Image
    except ImportError:
        print(
            "Python OpenEXR decoding needs numpy, Pillow, and either OpenCV or "
            "imageio. Install with: conda install -c conda-forge numpy pillow "
            "opencv imageio",
            file=sys.stderr,
        )
        return 3

    input_path, output_path, quality_text = sys.argv[1:]
    quality = max(50, min(100, int(quality_text)))
    try:
        image, channel_order = load_exr(input_path)
        rgb = linear_to_srgb(to_rgb(image, channel_order))
        Image.fromarray(rgb, "RGB").save(output_path, "JPEG", quality=quality)
    except Exception as error:
        print(f"OpenEXR decoding failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
