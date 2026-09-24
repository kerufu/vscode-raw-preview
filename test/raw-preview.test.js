'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { extractBestJpeg, parseJpeg } = require('../src/raw-preview');

function segment(marker, data) {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, data]);
}

function fakeJpeg(width, height, payloadSize = 256, appData = Buffer.alloc(0)) {
  const frame = Buffer.alloc(15);
  frame[0] = 8;
  frame.writeUInt16BE(height, 1);
  frame.writeUInt16BE(width, 3);
  frame[5] = 3;
  const scanHeader = Buffer.from([3, 1, 0, 2, 0, 3]);
  const entropy = Buffer.alloc(payloadSize, 0x55);
  entropy[8] = 0xff;
  entropy[9] = 0x00;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe1, appData),
    segment(0xc0, frame),
    segment(0xda, scanHeader),
    entropy,
    Buffer.from([0xff, 0xd9]),
  ]);
}

test('extracts the largest embedded JPEG preview', () => {
  const thumbnail = fakeJpeg(160, 120);
  const preview = fakeJpeg(2048, 1365, 512);
  const raw = Buffer.concat([Buffer.alloc(80), thumbnail, Buffer.alloc(53), preview]);

  const result = extractBestJpeg(raw);

  assert.equal(result.width, 2048);
  assert.equal(result.height, 1365);
  assert.equal(result.candidateCount, 2);
  assert.deepEqual(result.data, preview);
});

test('ignores a nested EXIF thumbnail when finding the outer JPEG end', () => {
  const nested = fakeJpeg(32, 24);
  const outer = fakeJpeg(1200, 800, 300, nested);

  const parsed = parseJpeg(outer, 0);

  assert.equal(parsed.end, outer.length);
  assert.equal(parsed.width, 1200);
  assert.equal(parsed.height, 800);
});

test('returns undefined when a RAW container has no complete JPEG', () => {
  const raw = Buffer.concat([Buffer.alloc(40), Buffer.from([0xff, 0xd8]), Buffer.alloc(80)]);
  assert.equal(extractBestJpeg(raw), undefined);
});
