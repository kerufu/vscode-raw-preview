'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildPythonExrDecoder, buildPythonRawpyDecoder } = require('../src/decoder');

function config(values) {
  return {
    get(key, fallback) {
      return values[key] ?? fallback;
    },
  };
}

test('uses the configured direct Python executable without a Conda environment', () => {
  const decoder = buildPythonRawpyDecoder(
    config({ pythonPath: '/usr/local/bin/python3', condaEnvironment: '' }),
    '/extension/decode_raw.py',
    '/photos/input.CR3',
    '/cache/output.jpg',
    92,
  );

  assert.equal(decoder.command, '/usr/local/bin/python3');
  assert.deepEqual(decoder.args, [
    '/extension/decode_raw.py',
    '/photos/input.CR3',
    '/cache/output.jpg',
    '92',
  ]);
});

test('runs rawpy in a named Conda environment', () => {
  const decoder = buildPythonRawpyDecoder(
    config({ condaPath: '/opt/miniconda/bin/conda', condaEnvironment: 'spectral' }),
    '/extension/decode_raw.py',
    '/photos/input.DNG',
    '/cache/output.jpg',
    88,
  );

  assert.equal(decoder.command, '/opt/miniconda/bin/conda');
  assert.deepEqual(decoder.args.slice(0, 5), [
    'run',
    '--name',
    'spectral',
    '--no-capture-output',
    'python',
  ]);
});

test('runs rawpy using an absolute Conda environment prefix', () => {
  const decoder = buildPythonRawpyDecoder(
    config({ condaEnvironment: '/opt/miniconda/envs/spectral' }),
    '/extension/decode_raw.py',
    '/photos/input.DNG',
    '/cache/output.jpg',
    90,
  );

  assert.equal(decoder.command, 'conda');
  assert.deepEqual(decoder.args.slice(0, 4), [
    'run',
    '--prefix',
    '/opt/miniconda/envs/spectral',
    '--no-capture-output',
  ]);
});

test('runs the OpenEXR decoder in the configured Conda environment', () => {
  const decoder = buildPythonExrDecoder(
    config({
      condaPath: '/opt/miniconda/bin/conda',
      condaEnvironment: '/opt/miniconda/envs/images',
    }),
    '/extension/decode_exr.py',
    '/photos/lighting.EXR',
    '/cache/output.jpg',
    95,
  );

  assert.equal(decoder.command, '/opt/miniconda/bin/conda');
  assert.match(decoder.label, /Python OpenEXR/);
  assert.deepEqual(decoder.args, [
    'run',
    '--prefix',
    '/opt/miniconda/envs/images',
    '--no-capture-output',
    'python',
    '/extension/decode_exr.py',
    '/photos/lighting.EXR',
    '/cache/output.jpg',
    '95',
  ]);
});
