# Spectral RAW / EXR Preview

Open camera RAW and OpenEXR files directly in Visual Studio Code. The extension supports `.exr` plus common camera formats including DNG, CR3, CR2, NEF, ARW, RAF, ORF, RW2, PEF, SRW, and X3F.

## Automatic opening

After installation, click a supported RAW or EXR file in the VS Code Explorer and it opens directly in **RAW / EXR Image Preview**. No context-menu command or manual **Open With** step is required. The extension registers its editor with VS Code's `default` priority for lowercase and uppercase extensions.

If you previously chose a different editor for RAW files, run **Reopen Editor With… → Configure default editor**, then select **RAW Image Preview** once to replace that saved user preference.

## How it works

For camera RAW files, the default `auto` mode extracts the JPEG preview embedded by the camera. It is fast, works offline, and requires no native dependency. Use **Render full quality** in the preview toolbar when you want the RAW sensor data developed instead.

Full-quality rendering automatically tries:

1. `darktable-cli`
2. `rawtherapee-cli`
3. ImageMagick (`magick`)
4. macOS `sips`
5. Python with `rawpy` and Pillow

OpenEXR files are decoded automatically with Python OpenCV (or `imageio` as a fallback), followed by ImageMagick when available. Install the Python dependencies into the configured environment:

```sh
python3 -m pip install rawpy Pillow numpy opencv-python imageio
```

### Conda environments

Run **RAW Preview: Select Conda Environment** from the Command Palette. The extension calls `conda env list --json`, shows the available environments, and stores the selected environment prefix in settings. Full-quality Python rendering then runs inside that environment with `conda run`.

Alternatively, set these values manually:

```json
{
  "spectralRawPreview.decoder": "pythonRawpy",
  "spectralRawPreview.condaPath": "/path/to/conda",
  "spectralRawPreview.condaEnvironment": "spectral-capture"
}
```

`condaEnvironment` accepts either an environment name or its absolute prefix. Install both RAW and EXR decoder packages with `conda install -n spectral-capture -c conda-forge rawpy pillow numpy opencv imageio`, adjusting the environment name as needed.

## Features

- Double-click RAW or EXR files to open a dedicated preview editor
- Fit, 100%, and pixel-level zoom up to 6400%, with mouse-drag panning
- One-click 1600% Pixel view, crisp nearest-neighbor magnification, and a high-zoom pixel grid
- Hover pixel inspector with zero-based coordinates, displayed RGB, hex, and luma values
- Real-time exposure, gamma, offset, and tone-map controls powered by WebGL
- None, Reinhard, ACES, and Filmic tone-map modes with one-click reset
- Live RGB and luma histogram for the adjusted image
- Cursor-drawn image regions for scoped histogram inspection; clear the selection to return to the whole image
- Instant, dependency-free embedded-preview extraction
- Optional full-quality RAW development
- Camera metadata when `exiftool` is installed
- Works with local and remote files for embedded previews
- Respects VS Code Restricted Mode before starting external tools

## Image adjustments

Adjustments are applied instantly to the displayed preview and never modify the RAW file:

- **Exposure**: scales linear light from -5 to +5 EV
- **Gamma**: controls display gamma from 0.2 to 4.0; 2.2 is neutral for the sRGB preview
- **Offset**: adds or subtracts a linear-light value from -0.5 to +0.5
- **Tone map**: choose None, Reinhard, ACES, or Filmic

The controls run in a WebGL shader, so zooming and full-resolution adjustments remain responsive. Their values persist while the editor is open; **Reset** restores the neutral view. The histogram measures the adjusted, display-referred preview. Choose **Select region**, drag across the image, and use **Clear selection** to return to the whole-image histogram. While the selection tool is active, Alt-drag or middle-drag pans.

Use **Pixel** to jump to 1600%, or keep pressing **+** to zoom as far as 6400%. Double-clicking the image toggles between 100% and pixel zoom. From 1600% onward, a grid identifies individual pixels. Hover over any image pixel to see its zero-based `x`/`y` coordinates and adjusted 8-bit RGB, hex, and luma values in the Pixel inspector.

## Settings

- `spectralRawPreview.defaultMode`: `auto`, `embedded`, or `rendered`
- `spectralRawPreview.decoder`: choose a full-quality decoder or use `auto`
- `spectralRawPreview.decoderPath`: custom executable path for the selected decoder
- `spectralRawPreview.pythonPath`: Python executable for the rawpy and OpenEXR decoders
- `spectralRawPreview.condaPath`: Conda executable name or absolute path
- `spectralRawPreview.condaEnvironment`: Conda environment name or absolute prefix
- `spectralRawPreview.jpegQuality`: rendered-preview JPEG quality
- `spectralRawPreview.maxFileSizeMB`: safety limit for files read by the extension

## Development

Open this folder in VS Code and press **F5** to launch an Extension Development Host. Then open a supported RAW file.

```sh
npm install
npm test
npm run check
npm run package
```

The package command creates a `.vsix` that can be installed with:

```sh
code --install-extension spectral-raw-preview-0.5.0.vsix
```

## Format notes

RAW is a family of vendor-specific formats, not one codec. Embedded-preview availability and native decoder support vary by camera model. CR3 and newer camera formats may require a current decoder. If a file has no embedded JPEG and every configured decoder rejects it, the editor shows the individual decoder errors and leaves the original file untouched.

OpenEXR is converted to an sRGB JPEG preview before display. Values outside the 0–1 linear range are clipped during that conversion, so the current viewer is intended for inspection rather than lossless HDR grading. The original EXR is never changed.
