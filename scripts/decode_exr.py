#!/usr/bin/env python3
"""Convert OpenEXR to an sRGB preview and optionally preserve float32 RGB."""

from __future__ import annotations

import os
import struct
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


def to_color(image, channel_order: str):
    import numpy as np

    pixels = np.asarray(image, dtype=np.float32)

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

    rgb = np.ascontiguousarray(rgb, dtype=np.float32)
    if alpha is not None:
        alpha = np.ascontiguousarray(alpha, dtype=np.float32)
    return rgb, alpha


def linear_to_srgb(image):
    import numpy as np

    finite = np.nan_to_num(image, nan=0.0, posinf=1.0, neginf=0.0)
    clipped = np.clip(finite, 0.0, 1.0)
    srgb = np.where(
        clipped <= 0.0031308,
        clipped * 12.92,
        1.055 * np.power(clipped, 1.0 / 2.4) - 0.055,
    )
    return np.clip(np.rint(srgb * 255.0), 0, 255).astype(np.uint8)


def write_float_pixels(output_path: str, rgb, alpha) -> None:
    import numpy as np

    pixels = np.concatenate((rgb, alpha), axis=2) if alpha is not None else rgb
    height, width, channels = pixels.shape
    if channels not in (3, 4):
        raise ValueError(f"expected RGB or RGBA data, received {channels} channels")
    little_endian = pixels.astype("<f4", copy=False)
    with open(output_path, "wb") as output:
        output.write(struct.pack("<4sIII", b"SRF2", width, height, channels))
        output.write(little_endian.tobytes(order="C"))


def main() -> int:
    if len(sys.argv) not in (4, 5):
        print(
            "usage: decode_exr.py INPUT OUTPUT JPEG_QUALITY [FLOAT_RGB_OUTPUT]",
            file=sys.stderr,
        )
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

    input_path, output_path, quality_text = sys.argv[1:4]
    float_output_path = sys.argv[4] if len(sys.argv) == 5 else None
    quality = max(50, min(100, int(quality_text)))
    try:
        image, channel_order = load_exr(input_path)
        float_rgb, float_alpha = to_color(image, channel_order)
        if float_output_path:
            write_float_pixels(float_output_path, float_rgb, float_alpha)
        preview_linear = float_rgb
        if float_alpha is not None:
            import numpy as np

            preview_alpha = np.nan_to_num(float_alpha, nan=0.0, posinf=1.0, neginf=0.0)
            preview_linear = float_rgb * np.clip(preview_alpha, 0.0, 1.0)
        preview_rgb = linear_to_srgb(preview_linear)
        Image.fromarray(preview_rgb, "RGB").save(output_path, "JPEG", quality=quality)
    except Exception as error:
        print(f"OpenEXR decoding failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
