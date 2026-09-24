'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
);

test('registers the RAW preview as the automatic default editor', () => {
  const editor = manifest.contributes.customEditors.find(
    (candidate) => candidate.viewType === 'spectralRawPreview.rawEditor',
  );

  assert.ok(editor, 'RAW custom editor is missing');
  assert.equal(editor.priority, 'default');
});

test('automatically matches common lowercase and uppercase RAW and EXR files', () => {
  const editor = manifest.contributes.customEditors.find(
    (candidate) => candidate.viewType === 'spectralRawPreview.rawEditor',
  );
  const patterns = new Set(editor.selector.map((entry) => entry.filenamePattern));

  for (const extension of ['dng', 'cr3', 'cr2', 'nef', 'arw', 'raf', 'orf', 'rw2', 'exr']) {
    assert.ok(patterns.has(`*.${extension}`), `missing *.${extension}`);
    assert.ok(patterns.has(`*.${extension.toUpperCase()}`), `missing *.${extension.toUpperCase()}`);
  }
});

test('contributes Conda settings and the environment picker command', () => {
  const properties = manifest.contributes.configuration.properties;
  const commands = new Set(manifest.contributes.commands.map((entry) => entry.command));

  assert.ok(properties['spectralRawPreview.condaPath']);
  assert.ok(properties['spectralRawPreview.condaEnvironment']);
  assert.ok(commands.has('spectralRawPreview.selectCondaEnvironment'));
});
