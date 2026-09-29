#!/usr/bin/env python3
"""Small rawpy bridge used by the VS Code extension's optional decoder."""

from __future__ import annotations

import sys

from colour_demosaicing import  demosaicing_CFA_Bayer_Malvar2004, demosaicing_CFA_Bayer_Menon2007, demosaicing_CFA_Bayer_bilinear
import cv2

def readRaw(f):
    return (custom_demosaic(str(f)).clip(1E-5, None))

def custom_demosaic(fname, dm_algo="bilinear"):
    with rawpy.imread(fname) as raw:
        # get raw image data
        h, w = raw.raw_image.shape[:2]
        image = np.array(raw.raw_image, dtype=np.double)
        # subtract black levels and normalize to interval [0..1]
        black_patch = np.array([
              [[raw.black_level_per_channel[0]],[raw.black_level_per_channel[1]]],
              [[raw.black_level_per_channel[3]],[raw.black_level_per_channel[2]]]
        ]).squeeze()

        black = np.tile(black_patch, (h // 2, w // 2))

        # wb_patch = np.array([
            #   [[raw.camera_whitebalance[0]],[raw.camera_whitebalance[1]]],
            #   [[raw.camera_whitebalance[3]],[raw.camera_whitebalance[2]]]
        # ]).squeeze()
        # wb_patch = wb_patch / wb_patch[0,1]
        # wb = np.tile(wb_patch, (h // 2, w // 2))

        # TODO(chris): we may not want to do this normalization
        image = (image - black) / (raw.white_level - black)
        # image = image * wb

        if dm_algo == "malvar2004":
            image_dm = demosaicing_CFA_Bayer_Malvar2004
        elif dm_algo == "menon2007":
            image_dm = demosaicing_CFA_Bayer_Menon2007
        elif dm_algo == "cv2":
            image = cv2.cvtColor(
                (image * 65535).astype(np.uint16), cv2.COLOR_BAYER_RG2BGR
            )
            return image.astype(np.double) / 65535.0
        else:
            image_dm = demosaicing_CFA_Bayer_bilinear

        image = image_dm(image, pattern="RGGB")

        # if wb is applied then you should norm the camera to xyz matrix as well, otherwise the colors will be wrong. the raw.rgb_xyz_matrix is actually XYZ to camera matrix and naming is confusing.
        xyz_to_cam = raw.rgb_xyz_matrix[:3,:3]
        # norm = np.sum(xyz_to_cam, axis=1, keepdims=True)
        # xyz_to_cam = xyz_to_cam / norm
        cam_to_xyz = np.linalg.inv(xyz_to_cam)
        image = image @ cam_to_xyz.T

        image_cropped = image[raw.sizes.crop_top_margin: raw.sizes.crop_top_margin + raw.sizes.crop_height, raw.sizes.crop_left_margin: raw.sizes.crop_left_margin + raw.sizes.crop_width, :]
    # print(image.max(), image.min())
    return image_cropped


def customimread(path, gamma_correct=True):
    if ".CR3" in path:
        raw_rgb = readRaw(path)
        if gamma_correct:
            raw_rgb = np.power(raw_rgb, 1/2.2)
        raw_rgb = np.clip(raw_rgb, 0, 1)
        raw_rgb = (raw_rgb*255).astype(np.uint8)
        return cv2.cvtColor(raw_rgb,cv2.COLOR_RGB2BGR)
    else:
        return cv2.imread(path)

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
        # with rawpy.imread(input_path) as raw:
        #     rgb = raw.postprocess(
        #         use_camera_wb=True,
        #         output_bps=8,
        #         output_color=rawpy.ColorSpace.sRGB,
        #     )
        rgb = readRaw(input_path)
        Image.fromarray(rgb).save(output_path, "JPEG", quality=quality)
    except Exception as error:  # rawpy exposes decoder-specific exception types.
        print(f"rawpy failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
