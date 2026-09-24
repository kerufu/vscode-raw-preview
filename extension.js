'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

const { extractBestJpeg } = require('./src/raw-preview');
const { listCondaEnvironments, readExifMetadata, renderRaw } = require('./src/decoder');

const VIEW_TYPE = 'spectralRawPreview.rawEditor';

class RawDocument {
  constructor(uri) {
    this.uri = uri;
  }

  dispose() {}
}

class RawPreviewProvider {
  constructor(context) {
    this.context = context;
    this.records = new Map();
    this.activePanel = undefined;
  }

  async openCustomDocument(uri) {
    return new RawDocument(uri);
  }

  async resolveCustomEditor(document, panel) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        this.context.globalStorageUri,
      ],
    };
    panel.webview.html = this.getHtml(panel.webview, document.uri);

    const record = { document, panel, generation: 0, lastMode: undefined };
    this.records.set(panel, record);
    if (panel.active) {
      this.activePanel = panel;
    }

    panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.activePanel = panel;
      }
    });
    panel.onDidDispose(() => {
      this.records.delete(panel);
      if (this.activePanel === panel) {
        this.activePanel = undefined;
      }
    });
    panel.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready') {
        await this.load(record, this.configuredMode());
      } else if (message?.type === 'refresh') {
        await this.load(record, record.lastMode || this.configuredMode(), true);
      } else if (message?.type === 'render') {
        await this.load(record, 'rendered', true);
      } else if (message?.type === 'openSettings') {
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:spectralcapture.spectral-raw-preview',
        );
      } else if (message?.type === 'reveal') {
        await vscode.commands.executeCommand('revealFileInOS', document.uri);
      }
    });
  }

  configuredMode() {
    return vscode.workspace
      .getConfiguration('spectralRawPreview')
      .get('defaultMode', 'auto');
  }

  async refreshActive(force = true) {
    const record = this.activePanel && this.records.get(this.activePanel);
    if (!record) {
      void vscode.window.showInformationMessage('Open a RAW or EXR image preview first.');
      return;
    }
    await this.load(record, record.lastMode || this.configuredMode(), force);
  }

  async renderActive() {
    const record = this.activePanel && this.records.get(this.activePanel);
    if (!record) {
      void vscode.window.showInformationMessage('Open a RAW or EXR image preview first.');
      return;
    }
    await this.load(record, 'rendered', true);
  }

  async load(record, mode, force = false) {
    const generation = ++record.generation;
    record.lastMode = mode;
    const isExr = path.extname(record.document.uri.path).toLowerCase() === '.exr';
    this.post(record, {
      type: 'loading',
      message: isExr
        ? 'Decoding OpenEXR image…'
        : mode === 'rendered'
          ? 'Developing RAW image…'
          : 'Finding embedded preview…',
    });

    try {
      const result = await this.createPreview(record.document.uri, mode, force);
      if (generation !== record.generation) {
        return;
      }
      const previewUri = record.panel.webview
        .asWebviewUri(vscode.Uri.file(result.outputPath))
        .with({ query: `v=${generation}-${Date.now()}` });
      this.post(record, {
        type: 'preview',
        src: previewUri.toString(),
        width: result.width,
        height: result.height,
        source: result.source,
        details: result.details,
      });
    } catch (error) {
      if (generation !== record.generation) {
        return;
      }
      this.post(record, {
        type: 'error',
        title: 'Unable to preview this image',
        message: error instanceof Error ? error.message : String(error),
        canRender: mode !== 'rendered',
      });
    }
  }

  post(record, message) {
    void record.panel.webview.postMessage(message);
  }

  async createPreview(uri, mode, force) {
    const config = vscode.workspace.getConfiguration('spectralRawPreview');
    const stat = await vscode.workspace.fs.stat(uri);
    const isExr = path.extname(uri.path).toLowerCase() === '.exr';
    const maxBytes = config.get('maxFileSizeMB', 512) * 1024 * 1024;
    if (stat.size > maxBytes) {
      throw new Error(
        `The file is ${formatBytes(stat.size)}, above the configured ${formatBytes(maxBytes)} limit.`,
      );
    }

    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const fingerprint = crypto
      .createHash('sha1')
      .update(`${uri.toString()}\0${stat.mtime}\0${stat.size}\0${mode}`)
      .digest('hex');
    const outputPath = vscode.Uri.joinPath(this.context.globalStorageUri, `${fingerprint}.jpg`).fsPath;

    let width;
    let height;
    let source;

    if (!force && (await isUsableFile(outputPath))) {
      const cachedPreview = extractBestJpeg(await fs.readFile(outputPath));
      width = cachedPreview?.width;
      height = cachedPreview?.height;
      source = mode === 'rendered' || isExr ? 'Rendered image (cached)' : 'Cached preview';
    } else if (mode !== 'rendered' && !isExr) {
      const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
      const preview = extractBestJpeg(bytes);
      if (preview) {
        await fs.writeFile(outputPath, preview.data);
        width = preview.width;
        height = preview.height;
        source = 'Embedded JPEG';
      } else if (mode === 'embedded') {
        throw new Error(
          'No embedded JPEG preview was found. Choose “Render full quality” to use an external RAW decoder.',
        );
      }
    }

    if (!source) {
      if (!vscode.workspace.isTrusted) {
        throw new Error(
          'Full image decoding runs an external decoder and is disabled in Restricted Mode. Trust the workspace or use an embedded RAW preview.',
        );
      }
      const inputPath = await this.localInputPath(uri, fingerprint);
      const rendered = await renderRaw({
        inputPath,
        outputPath,
        extensionPath: this.context.extensionPath,
        config,
      });
      source = `Rendered with ${rendered.decoder}`;
    }

    const inputPath = uri.scheme === 'file' ? uri.fsPath : undefined;
    const exif =
      inputPath && vscode.workspace.isTrusted ? await readExifMetadata(inputPath) : undefined;
    const details = buildDetails(uri, stat, width, height, source, exif);
    return { outputPath, width, height, source, details };
  }

  async localInputPath(uri, fingerprint) {
    if (uri.scheme === 'file') {
      return uri.fsPath;
    }
    const extension = path.extname(uri.path);
    const localUri = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      `${fingerprint}-source${extension}`,
    );
    await vscode.workspace.fs.writeFile(localUri, await vscode.workspace.fs.readFile(uri));
    return localUri.fsPath;
  }

  getHtml(webview, uri) {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'),
    );
    const nonce = crypto.randomBytes(16).toString('base64');
    const title = escapeHtml(path.basename(uri.path));
    const formatBadge = path.extname(uri.path).toLowerCase() === '.exr' ? 'EXR' : 'RAW';

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>${title}</title>
</head>
<body>
  <header class="toolbar">
    <div class="identity">
      <span class="raw-badge">${formatBadge}</span>
      <span class="filename" title="${title}">${title}</span>
      <span id="source" class="source"></span>
    </div>
    <div class="tools" aria-label="Preview controls">
      <button id="fit" type="button" title="Fit image to view">Fit</button>
      <button id="actual" type="button" title="Show image at 100%">100%</button>
      <button id="pixelZoom" type="button" title="Zoom to 1600% for pixel inspection">Pixel</button>
      <button id="zoomOut" type="button" aria-label="Zoom out">−</button>
      <output id="zoomValue">100%</output>
      <button id="zoomIn" type="button" aria-label="Zoom in">+</button>
      <span class="separator"></span>
      <button id="render" class="accent" type="button">Render full quality</button>
      <button id="refresh" type="button" title="Refresh preview">↻</button>
    </div>
  </header>
  <main class="workspace">
    <section id="viewport" class="viewport" aria-label="Image preview">
      <div id="imagePlane" class="image-plane">
        <canvas id="display" role="img" aria-label="${title}"></canvas>
        <img id="imageSource" alt="" draggable="false" crossorigin="anonymous" hidden>
      </div>
      <div id="pixelGrid" class="pixel-grid" aria-hidden="true" hidden></div>
      <div id="selectionBox" class="selection-box" hidden>
        <span id="selectionSize" class="selection-size"></span>
      </div>
      <div id="pixelMarker" class="pixel-marker" aria-hidden="true" hidden></div>
      <div id="empty" class="empty">
        <div class="spinner" aria-hidden="true"></div>
        <h1 id="emptyTitle">Opening RAW image</h1>
        <p id="emptyMessage">Finding embedded preview…</p>
        <div id="errorActions" class="error-actions" hidden>
          <button id="tryRender" class="accent" type="button">Render full quality</button>
          <button id="settings" type="button">Open settings</button>
        </div>
      </div>
    </section>
    <aside class="inspector" aria-label="Image inspector">
      <section class="adjustments-panel" aria-labelledby="adjustmentsTitle">
        <div class="panel-heading">
          <div>
            <div class="heading-line">
              <h2 id="adjustmentsTitle">Adjustments</h2>
              <span class="preview-badge">Preview only</span>
            </div>
            <p>Fine-tune the view without changing the source file.</p>
          </div>
          <button id="resetAdjustments" class="reset-all" type="button" data-adjustment-control disabled>Reset all</button>
        </div>

        <div class="control-group">
          <div class="control-heading">
            <div>
              <label for="exposure">Exposure</label>
              <p id="exposureHelp">Adjust overall brightness in stops.</p>
            </div>
            <div class="number-control">
              <input id="exposureNumber" type="number" min="-5" max="5" step="0.1" value="0" aria-label="Exposure value" data-adjustment-control disabled>
              <span>EV</span>
            </div>
          </div>
          <input id="exposure" class="parameter-slider exposure-slider" type="range" min="-5" max="5" step="0.1" value="0" aria-describedby="exposureHelp" data-adjustment-control disabled>
          <div class="scale-hints">
            <span>−5 darker</span>
            <button class="neutral-value" type="button" data-reset-adjustment="exposure" data-adjustment-control disabled>Neutral 0</button>
            <span>+5 brighter</span>
          </div>
        </div>

        <div class="control-group">
          <div class="control-heading">
            <div>
              <label for="gamma">Gamma</label>
              <p id="gammaHelp">Shape midtone brightness.</p>
            </div>
            <div class="number-control single-value">
              <input id="gammaNumber" type="number" min="0.2" max="4" step="0.05" value="2.2" aria-label="Gamma value" data-adjustment-control disabled>
            </div>
          </div>
          <input id="gamma" class="parameter-slider gamma-slider" type="range" min="0.2" max="4" step="0.05" value="2.2" aria-describedby="gammaHelp" data-adjustment-control disabled>
          <div class="scale-hints">
            <span>0.2</span>
            <button class="neutral-value" type="button" data-reset-adjustment="gamma" data-adjustment-control disabled>Neutral 2.2</button>
            <span>4.0</span>
          </div>
        </div>

        <div class="control-group">
          <div class="control-heading">
            <div>
              <label for="offset">Offset</label>
              <p id="offsetHelp">Lift or lower the black level.</p>
            </div>
            <div class="number-control single-value">
              <input id="offsetNumber" type="number" min="-0.5" max="0.5" step="0.01" value="0" aria-label="Offset value" data-adjustment-control disabled>
            </div>
          </div>
          <input id="offset" class="parameter-slider offset-slider" type="range" min="-0.5" max="0.5" step="0.01" value="0" aria-describedby="offsetHelp" data-adjustment-control disabled>
          <div class="scale-hints">
            <span>−0.5</span>
            <button class="neutral-value" type="button" data-reset-adjustment="offset" data-adjustment-control disabled>Neutral 0</button>
            <span>+0.5</span>
          </div>
        </div>

        <fieldset id="tonemap" class="tone-map" data-adjustment-control disabled>
          <legend>Tone map</legend>
          <p>Control how bright highlights roll off.</p>
          <div class="tone-options">
            <button type="button" class="tone-option" data-tonemap="none" data-adjustment-control disabled>
              <strong>None</strong><span>Original</span>
            </button>
            <button type="button" class="tone-option" data-tonemap="reinhard" data-adjustment-control disabled>
              <strong>Reinhard</strong><span>Soft</span>
            </button>
            <button type="button" class="tone-option" data-tonemap="aces" data-adjustment-control disabled>
              <strong>ACES</strong><span>Cinematic</span>
            </button>
            <button type="button" class="tone-option" data-tonemap="filmic" data-adjustment-control disabled>
              <strong>Filmic</strong><span>Smooth rolloff</span>
            </button>
          </div>
          <p id="tonemapDescription" class="tone-description" aria-live="polite"></p>
        </fieldset>
      </section>

      <section class="histogram-panel" aria-labelledby="histogramTitle">
        <div class="histogram-heading">
          <div>
            <h2 id="histogramTitle">Histogram</h2>
            <p>Display-referred RGB distribution.</p>
          </div>
          <span id="histogramScope" class="scope-badge">Whole image</span>
        </div>
        <div class="histogram-frame">
          <canvas id="histogram" width="584" height="240" role="img" aria-label="RGB histogram for the whole image"></canvas>
          <div id="histogramEmpty" class="histogram-empty">Open an image to view its histogram</div>
        </div>
        <div class="histogram-legend" aria-hidden="true">
          <span class="red-channel">Red</span>
          <span class="green-channel">Green</span>
          <span class="blue-channel">Blue</span>
          <span class="luma-channel">Luma</span>
        </div>
        <div class="histogram-actions">
          <button id="selectRegion" type="button" aria-pressed="false" disabled>Select region</button>
          <button id="clearRegion" type="button" disabled>Clear selection</button>
        </div>
        <p id="selectionHelp" class="selection-help">Select a region, then drag across the image. Alt-drag pans while selection is active.</p>
      </section>

      <section class="pixel-panel" aria-labelledby="pixelInspectorTitle">
        <div class="pixel-heading">
          <div>
            <h2 id="pixelInspectorTitle">Pixel inspector</h2>
            <p id="pixelStatus">Hover over the image to sample a pixel.</p>
          </div>
          <span class="scope-badge">Display 8-bit</span>
        </div>
        <div class="pixel-readout">
          <span id="pixelSwatch" class="pixel-swatch" aria-hidden="true"></span>
          <div class="pixel-identity">
            <output id="pixelCoordinates" aria-label="Pixel coordinates">x — &nbsp; y —</output>
            <output id="pixelHex" class="pixel-hex" aria-label="Pixel hexadecimal value">#——</output>
          </div>
          <div class="pixel-channels" aria-label="Displayed pixel channel values">
            <span class="red-channel">R <output id="pixelRed">—</output></span>
            <span class="green-channel">G <output id="pixelGreen">—</output></span>
            <span class="blue-channel">B <output id="pixelBlue">—</output></span>
            <span class="luma-channel">Y <output id="pixelLuma">—</output></span>
          </div>
        </div>
      </section>

      <section class="details" aria-label="File details">
        <div class="details-heading">
          <h2>File details</h2>
          <button id="reveal" class="text-button" type="button">Reveal</button>
        </div>
        <dl id="detailsList"></dl>
        <p class="hint">Drag to pan. Scroll to zoom up to 6400%. Double-click to toggle pixel zoom. Use Select region for histogram sampling.</p>
      </section>
    </aside>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function buildDetails(uri, stat, width, height, source, exif = {}) {
  const values = [
    ['Name', path.basename(uri.path)],
    ['Type', path.extname(uri.path).slice(1).toUpperCase() || 'RAW'],
    ['File size', formatBytes(stat.size)],
    ['Modified', new Date(stat.mtime).toLocaleString()],
    ['Preview', width && height ? `${width} × ${height}` : undefined],
    ['Source', source],
    ['Camera', joinNonempty([exif.Make, exif.Model], ' ')],
    ['Lens', exif.LensModel],
    ['Captured', exif.DateTimeOriginal],
    ['Exposure', exif.ExposureTime],
    ['Aperture', exif.FNumber],
    ['ISO', exif.ISO],
    ['Focal length', exif.FocalLength],
  ];
  return values.filter(([, value]) => value !== undefined && value !== null && value !== '');
}

function joinNonempty(values, separator) {
  return [...new Set(values.filter(Boolean))].join(separator) || undefined;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

async function isUsableFile(filePath) {
  try {
    return (await fs.stat(filePath)).size > 0;
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function selectCondaEnvironment() {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage(
      'Conda discovery starts an external executable and is disabled in Restricted Mode.',
    );
    return;
  }

  const config = vscode.workspace.getConfiguration('spectralRawPreview');
  const condaPath = config.get('condaPath', 'conda');
  let environments;
  try {
    environments = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'RAW Preview: Finding Conda environments…',
      },
      () => listCondaEnvironments(condaPath),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const choice = await vscode.window.showErrorMessage(
      `Could not list Conda environments: ${message}`,
      'Open Settings',
    );
    if (choice === 'Open Settings') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:spectralcapture.spectral-raw-preview conda',
      );
    }
    return;
  }

  const selected = await vscode.window.showQuickPick(
    [
      {
        label: '$(terminal) Direct Python executable',
        description: config.get('pythonPath', 'python3'),
        detail: 'Clear the Conda environment setting',
        prefix: '',
      },
      ...environments.map((environment) => ({
        label: `$(symbol-misc) ${environment.name}${environment.isActive ? ' (active)' : ''}`,
        description: environment.prefix,
        prefix: environment.prefix,
      })),
    ],
    {
      placeHolder: 'Select the Python environment that contains RAW / EXR decoder packages',
      matchOnDescription: true,
    },
  );
  if (!selected) {
    return;
  }

  await config.update(
    'condaEnvironment',
    selected.prefix,
    vscode.ConfigurationTarget.Global,
  );
  const label = selected.prefix || config.get('pythonPath', 'python3');
  void vscode.window.showInformationMessage(`RAW Preview Python environment: ${label}`);
}

function activate(context) {
  const provider = new RawPreviewProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('spectralRawPreview.open', async (uri) => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        void vscode.window.showInformationMessage('Select a RAW or EXR image in the Explorer first.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('spectralRawPreview.refresh', () => provider.refreshActive(true)),
    vscode.commands.registerCommand('spectralRawPreview.render', () => provider.renderActive()),
    vscode.commands.registerCommand(
      'spectralRawPreview.selectCondaEnvironment',
      selectCondaEnvironment,
    ),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
