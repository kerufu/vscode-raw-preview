'use strict';

const SOF_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);

/**
 * Locate standalone JPEG streams inside a camera RAW container and return the
 * largest useful preview. JPEG segments are parsed instead of merely searching
 * for FF D9, because EXIF blocks can contain nested thumbnails.
 */
function extractBestJpeg(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }

  const candidates = [];
  let cursor = 0;
  while (cursor < buffer.length - 1) {
    const start = buffer.indexOf(Buffer.from([0xff, 0xd8]), cursor);
    if (start === -1) {
      break;
    }
    const parsed = parseJpeg(buffer, start);
    if (parsed?.width > 0 && parsed?.height > 0 && parsed.end - start >= 256) {
      candidates.push({
        start,
        end: parsed.end,
        width: parsed.width,
        height: parsed.height,
      });
      cursor = parsed.end;
    } else {
      cursor = start + 2;
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }

  candidates.sort((left, right) => {
    const leftPixels = (left.width || 0) * (left.height || 0);
    const rightPixels = (right.width || 0) * (right.height || 0);
    return rightPixels - leftPixels || right.end - right.start - (left.end - left.start);
  });
  const best = candidates[0];
  return {
    data: buffer.subarray(best.start, best.end),
    width: best.width,
    height: best.height,
    candidateCount: candidates.length,
  };
}

function parseJpeg(buffer, start) {
  if (buffer[start] !== 0xff || buffer[start + 1] !== 0xd8) {
    return undefined;
  }

  let position = start + 2;
  let inScan = false;
  let width;
  let height;

  while (position < buffer.length - 1) {
    const markerStart = buffer.indexOf(0xff, position);
    if (markerStart === -1 || markerStart + 1 >= buffer.length) {
      return undefined;
    }

    let markerPosition = markerStart + 1;
    while (markerPosition < buffer.length && buffer[markerPosition] === 0xff) {
      markerPosition += 1;
    }
    if (markerPosition >= buffer.length) {
      return undefined;
    }

    const marker = buffer[markerPosition];
    position = markerPosition + 1;

    if (inScan && marker === 0x00) {
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      continue;
    }
    if (marker === 0xd9) {
      return { end: position, width, height };
    }
    if (marker === 0xd8 || marker === 0x01) {
      inScan = false;
      continue;
    }

    inScan = false;
    if (position + 1 >= buffer.length) {
      return undefined;
    }
    const segmentLength = buffer.readUInt16BE(position);
    if (segmentLength < 2 || position + segmentLength > buffer.length) {
      return undefined;
    }

    if (SOF_MARKERS.has(marker) && segmentLength >= 7) {
      height = buffer.readUInt16BE(position + 3);
      width = buffer.readUInt16BE(position + 5);
    }

    position += segmentLength;
    if (marker === 0xda) {
      inScan = true;
    }
  }
  return undefined;
}

module.exports = { extractBestJpeg, parseJpeg };
