# Changelog

## 0.4.0

- Added automatic lowercase and uppercase OpenEXR file associations
- Added OpenEXR decoding through the configured Python or Conda environment, with ImageMagick fallback
- Added a live RGB and luma histogram that follows the preview adjustments
- Added cursor-drawn image-region selection for scoped histograms
- Added clear-selection behavior that restores the whole-image histogram

## 0.3.1

- Redesigned adjustments as a spacious inspector instead of a crowded toolbar
- Added exact numeric entry and clearly labeled neutral values for each slider
- Added descriptive tone-map cards and contextual guidance
- Improved narrow-editor responsiveness and adjustment accessibility

## 0.3.0

- Added real-time exposure adjustment from -5 to +5 EV
- Added gamma and additive offset controls
- Added None, Reinhard, ACES, and Filmic tone mapping
- Added one-click reset and per-editor adjustment persistence

## 0.2.0

- Added Conda environment discovery from the Command Palette
- Added settings for the Conda executable and environment name or prefix
- Python rawpy rendering can now run through `conda run`

## 0.1.0

- Initial RAW custom editor
- Default-priority associations automatically open lowercase and uppercase RAW files from the Explorer
- Embedded JPEG extraction for dependency-free previews
- Full-quality Darktable, RawTherapee, ImageMagick, sips, and rawpy rendering
- Zoom, fit, pan, file details, and optional ExifTool metadata
