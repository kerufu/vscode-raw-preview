'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extensionSource = fs.readFileSync(
  path.join(__dirname, '..', 'extension.js'),
  'utf8',
);
const webviewSource = fs.readFileSync(
  path.join(__dirname, '..', 'media', 'main.js'),
  'utf8',
);

test('webview exposes every requested image adjustment', () => {
  for (const id of ['exposure', 'gamma', 'offset', 'tonemap', 'resetAdjustments']) {
    assert.match(extensionSource, new RegExp(`id=["']${id}["']`));
    assert.match(webviewSource, new RegExp(`getElementById\\(["']${id}["']\\)`));
  }

  for (const id of ['exposureNumber', 'gammaNumber', 'offsetNumber']) {
    assert.match(extensionSource, new RegExp(`id=["']${id}["']`));
    assert.match(webviewSource, new RegExp(`getElementById\\(["']${id}["']\\)`));
  }
  assert.match(extensionSource, /Preview only/);
  assert.match(extensionSource, /Neutral 2\.2/);
});

test('shader implements all tone-map modes', () => {
  for (const mode of ['none', 'reinhard', 'aces', 'filmic']) {
    assert.match(webviewSource, new RegExp(`${mode}: \\d`));
  }
  assert.match(webviewSource, /uniform float u_exposure/);
  assert.match(webviewSource, /uniform float u_gamma/);
  assert.match(webviewSource, /uniform float u_offset/);
});

test('histogram supports whole-image and cursor-selected scopes', () => {
  for (const id of [
    'histogram',
    'histogramScope',
    'selectRegion',
    'clearRegion',
    'selectionBox',
  ]) {
    assert.match(extensionSource, new RegExp(`id=["']${id}["']`));
    assert.match(webviewSource, new RegExp(`getElementById\\(["']${id}["']\\)`));
  }
  assert.match(webviewSource, /gl\.readPixels/);
  assert.match(webviewSource, /selectedRegion \|\|/);
  assert.match(webviewSource, /Whole image/);
  assert.match(webviewSource, /uniform vec2 u_uvMin/);
  assert.match(webviewSource, /uniform vec2 u_uvMax/);
});

test('every scripted UI element exists in the webview markup', () => {
  const ids = [
    ...webviewSource.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g),
  ].map((match) => match[1]);

  for (const id of ids) {
    assert.match(extensionSource, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
});
