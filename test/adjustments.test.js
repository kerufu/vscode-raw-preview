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
const webviewStyles = fs.readFileSync(
  path.join(__dirname, '..', 'media', 'main.css'),
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

test('pixel zoom and inspection expose floating source or display values', () => {
  for (const id of [
    'pixelZoom',
    'pixelGrid',
    'pixelLabels',
    'pixelMarker',
    'pixelOverlayLegend',
    'pixelCoordinates',
    'pixelRed',
    'pixelGreen',
    'pixelBlue',
    'pixelAlphaChannel',
    'pixelAlpha',
    'pixelLuma',
  ]) {
    assert.match(extensionSource, new RegExp(`id=["']${id}["']`));
    assert.match(webviewSource, new RegExp(`getElementById\\(["']${id}["']\\)`));
  }
  assert.match(webviewSource, /const MAX_SCALE = 64/);
  assert.match(webviewSource, /const PIXEL_ZOOM_SCALE = 16/);
  assert.match(webviewSource, /Math\.floor\(x\)/);
  assert.match(webviewSource, /gl\.readPixels\(0, 0, 1, 1/);
  assert.match(webviewSource, /Original linear EXR/);
  assert.match(webviewSource, /\$\{hasAlpha \? 'RGBA' : 'RGB'\} · \$\{valueSource\}/);
  assert.match(webviewSource, /source float/);
  assert.match(webviewSource, /displayRed \/ 255/);
  assert.match(webviewSource, /const channelColors = \['#ff5f63', '#54d17a', '#55a7ff', '#f1f1f1'\]/);
  assert.match(webviewSource, /const labels = values\.map/);
  assert.match(webviewSource, /sourcePixelData\?\.channels === 4/);
  assert.match(webviewSource, /toPrecision\(9\)/);
  assert.doesNotMatch(webviewSource, /`R\$\{red\}`/);
  assert.match(webviewStyles, /image-rendering: pixelated/);
  assert.match(webviewStyles, /\.pixel-grid/);
  assert.match(webviewStyles, /\.pixel-labels/);
});

test('every scripted UI element exists in the webview markup', () => {
  const ids = [
    ...webviewSource.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g),
  ].map((match) => match[1]);

  for (const id of ids) {
    assert.match(extensionSource, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
});
