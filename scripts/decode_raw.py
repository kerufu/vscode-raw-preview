#!/usr/bin/env python3
"""Small rawpy bridge used by the VS Code extension's optional decoder."""

from __future__ import annotations

import sys


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: decode_raw.py INPUT OUTPUT JPEG_QUALITY", file=sys.stderr)
        return 2

    try:
        import rawpy
        from PIL import Image
    except ImportError:
        print(
            "Python decoder needs rawpy and Pillow. Install them with: "
            "python -m pip install rawpy Pillow",
            file=sys.stderr,
        )
        return 3

    input_path, output_path, quality_text = sys.argv[1:]
    quality = max(50, min(100, int(quality_text)))
    try:
        with rawpy.imread(input_path) as raw:
            rgb = raw.postprocess(
                use_camera_wb=True,
                output_bps=8,
                output_color=rawpy.ColorSpace.sRGB,
            )
        Image.fromarray(rgb).save(output_path, "JPEG", quality=quality)
    except Exception as error:  # rawpy exposes decoder-specific exception types.
        print(f"rawpy failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
