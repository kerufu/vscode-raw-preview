(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const imageSource = document.getElementById('imageSource');
  const display = document.getElementById('display');
  const imagePlane = document.getElementById('imagePlane');
  const viewport = document.getElementById('viewport');
  const empty = document.getElementById('empty');
  const emptyTitle = document.getElementById('emptyTitle');
  const emptyMessage = document.getElementById('emptyMessage');
  const errorActions = document.getElementById('errorActions');
  const tryRender = document.getElementById('tryRender');
  const source = document.getElementById('source');
  const zoomValue = document.getElementById('zoomValue');
  const pixelZoom = document.getElementById('pixelZoom');
  const detailsList = document.getElementById('detailsList');
  const exposureInput = document.getElementById('exposure');
  const exposureNumber = document.getElementById('exposureNumber');
  const gammaInput = document.getElementById('gamma');
  const gammaNumber = document.getElementById('gammaNumber');
  const offsetInput = document.getElementById('offset');
  const offsetNumber = document.getElementById('offsetNumber');
  const tonemapInput = document.getElementById('tonemap');
  const tonemapDescription = document.getElementById('tonemapDescription');
  const toneMapButtons = [...document.querySelectorAll('[data-tonemap]')];
  const resetAdjustments = document.getElementById('resetAdjustments');
  const adjustmentControls = [...document.querySelectorAll('[data-adjustment-control]')];
  const selectionBox = document.getElementById('selectionBox');
  const selectionSize = document.getElementById('selectionSize');
  const selectRegion = document.getElementById('selectRegion');
  const clearRegion = document.getElementById('clearRegion');
  const selectionHelp = document.getElementById('selectionHelp');
  const histogramCanvas = document.getElementById('histogram');
  const histogramEmpty = document.getElementById('histogramEmpty');
  const histogramScope = document.getElementById('histogramScope');
  const histogramContext = histogramCanvas.getContext('2d');
  const pixelGrid = document.getElementById('pixelGrid');
  const pixelLabels = document.getElementById('pixelLabels');
  const pixelLabelsContext = pixelLabels.getContext('2d');
  const pixelMarker = document.getElementById('pixelMarker');
  const pixelOverlayLegend = document.getElementById('pixelOverlayLegend');
  const pixelStatus = document.getElementById('pixelStatus');
  const pixelSwatch = document.getElementById('pixelSwatch');
  const pixelCoordinates = document.getElementById('pixelCoordinates');
  const pixelHex = document.getElementById('pixelHex');
  const pixelRed = document.getElementById('pixelRed');
  const pixelGreen = document.getElementById('pixelGreen');
  const pixelBlue = document.getElementById('pixelBlue');
  const pixelLuma = document.getElementById('pixelLuma');

  const HISTOGRAM_SAMPLE_SIZE = 256;
  const MAX_SCALE = 64;
  const PIXELATED_SCALE = 4;
  const PIXEL_GRID_SCALE = 16;
  const PIXEL_ZOOM_SCALE = 16;
  const zoomStops = Object.freeze([
    0.01, 0.02, 0.033, 0.05, 0.067, 0.1, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667,
    0.75, 1, 2, 4, 8, 16, 32, 64,
  ]);
  const defaultAdjustments = Object.freeze({
    exposure: 0,
    gamma: 2.2,
    offset: 0,
    tonemap: 'none',
  });
  const toneMapIndex = Object.freeze({
    none: 0,
    reinhard: 1,
    aces: 2,
    filmic: 3,
  });
  const toneMapDescriptions = Object.freeze({
    none: 'Preserves the source contrast. Values brighter than white are clipped.',
    reinhard: 'Compresses highlights gently for a soft, natural-looking result.',
    aces: 'Adds cinematic contrast and a stronger highlight rolloff.',
    filmic: 'Balances shadows and highlights with a smooth film-like response.',
  });
  const previousState = vscode.getState() || {};
  const adjustments = sanitizeAdjustments(previousState.adjustments);

  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let fitMode = true;
  let dragging = false;
  let selecting = false;
  let selectionMode = false;
  let dragStart;
  let selectionStart;
  let selectedRegion;
  let imageWidth = 0;
  let imageHeight = 0;
  let gl;
  let shaderProgram;
  let imageTexture;
  let histogramTexture;
  let histogramFramebuffer;
  let histogramFrameRequest;
  let sampleBufferWidth = HISTOGRAM_SAMPLE_SIZE;
  let sampleBufferHeight = HISTOGRAM_SAMPLE_SIZE;
  let inspectedPixel;
  let pixelFrameRequest;
  let pixelLabelsFrameRequest;
  let uniforms;

  const vertexShaderSource = `
    attribute vec2 a_position;
    uniform vec2 u_uvMin;
    uniform vec2 u_uvMax;
    varying vec2 v_texCoord;

    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      vec2 baseUv = vec2(
        (a_position.x + 1.0) * 0.5,
        (1.0 - a_position.y) * 0.5
      );
      v_texCoord = mix(u_uvMin, u_uvMax, baseUv);
    }
  `;

  const fragmentShaderSource = `
    precision highp float;

    uniform sampler2D u_image;
    uniform float u_exposure;
    uniform float u_gamma;
    uniform float u_offset;
    uniform int u_tonemap;
    varying vec2 v_texCoord;

    vec3 acesFilm(vec3 value) {
      return clamp(
        (value * (2.51 * value + vec3(0.03))) /
          (value * (2.43 * value + vec3(0.59)) + vec3(0.14)),
        0.0,
        1.0
      );
    }

    vec3 hableCurve(vec3 value) {
      float A = 0.15;
      float B = 0.50;
      float C = 0.10;
      float D = 0.20;
      float E = 0.02;
      float F = 0.30;
      return ((value * (A * value + vec3(C * B)) + vec3(D * E)) /
        (value * (A * value + vec3(B)) + vec3(D * F))) - vec3(E / F);
    }

    void main() {
      vec4 sampled = texture2D(u_image, v_texCoord);
      vec3 color = pow(max(sampled.rgb, vec3(0.0)), vec3(2.2));
      color = max(color * exp2(u_exposure) + vec3(u_offset), vec3(0.0));

      if (u_tonemap == 1) {
        color = color / (vec3(1.0) + color);
      } else if (u_tonemap == 2) {
        color = acesFilm(color);
      } else if (u_tonemap == 3) {
        color = hableCurve(color * 2.0) / hableCurve(vec3(11.2));
      }

      color = pow(clamp(color, 0.0, 1.0), vec3(1.0 / u_gamma));
      gl_FragColor = vec4(color, sampled.a);
    }
  `;

  function post(type) {
    vscode.postMessage({ type });
  }

  function sanitizeAdjustments(value = {}) {
    if (!value || typeof value !== 'object') {
      value = {};
    }
    const validTonemaps = new Set(['none', 'reinhard', 'aces', 'filmic']);
    return {
      exposure: clampNumber(value.exposure, -5, 5, defaultAdjustments.exposure),
      gamma: clampNumber(value.gamma, 0.2, 4, defaultAdjustments.gamma),
      offset: clampNumber(value.offset, -0.5, 0.5, defaultAdjustments.offset),
      tonemap: validTonemaps.has(value.tonemap) ? value.tonemap : defaultAdjustments.tonemap,
    };
  }

  function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
  }

  function showLoading(message) {
    empty.hidden = false;
    empty.classList.remove('error');
    emptyTitle.textContent = 'Opening image';
    emptyMessage.textContent = message;
    errorActions.hidden = true;
  }

  function showError(message, canRender) {
    display.style.display = 'none';
    imageWidth = 0;
    imageHeight = 0;
    clearSelection();
    setSelectionMode(false);
    resetPixelInspector();
    enableAdjustments(false);
    selectRegion.disabled = true;
    showHistogramEmpty('Open an image to view its histogram');
    empty.hidden = false;
    empty.classList.add('error');
    emptyTitle.textContent = 'Unable to preview this image';
    emptyMessage.textContent = message;
    tryRender.hidden = !canRender;
    errorActions.hidden = false;
    source.textContent = '';
  }

  function renderDetails(details) {
    detailsList.replaceChildren();
    for (const [label, value] of details || []) {
      const row = document.createElement('div');
      row.className = 'detail-row';
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      term.textContent = label;
      description.textContent = String(value);
      row.append(term, description);
      detailsList.append(row);
    }
  }

  function applyTransform() {
    const pixelated = scale >= PIXELATED_SCALE;
    if (pixelated) {
      offsetX = Math.round(offsetX);
      offsetY = Math.round(offsetY);
    }
    imagePlane.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    display.classList.toggle('pixelated', pixelated);
    zoomValue.textContent = `${Math.round(scale * 100)}%`;
    updateSelectionOverlay();
    updatePixelOverlays();
    schedulePixelLabels();
  }

  function fitImage() {
    if (!imageWidth || !imageHeight) {
      return;
    }
    const padding = 36;
    scale = Math.min(
      1,
      Math.max(
        0.01,
        Math.min(
          (viewport.clientWidth - padding * 2) / imageWidth,
          (viewport.clientHeight - padding * 2) / imageHeight,
        ),
      ),
    );
    offsetX = (viewport.clientWidth - imageWidth * scale) / 2;
    offsetY = (viewport.clientHeight - imageHeight * scale) / 2;
    fitMode = true;
    applyTransform();
  }

  function actualSize() {
    if (!imageWidth || !imageHeight) {
      return;
    }
    scale = 1;
    offsetX = (viewport.clientWidth - imageWidth) / 2;
    offsetY = (viewport.clientHeight - imageHeight) / 2;
    fitMode = false;
    applyTransform();
  }

  function zoomTo(nextScale, clientX, clientY) {
    if (!imageWidth) {
      return;
    }
    const clamped = Math.min(MAX_SCALE, Math.max(0.01, nextScale));
    const bounds = viewport.getBoundingClientRect();
    const pointX = clientX === undefined ? bounds.left + bounds.width / 2 : clientX;
    const pointY = clientY === undefined ? bounds.top + bounds.height / 2 : clientY;
    const localX = pointX - bounds.left;
    const localY = pointY - bounds.top;
    const imageX = (localX - offsetX) / scale;
    const imageY = (localY - offsetY) / scale;
    scale = clamped;
    offsetX = localX - imageX * scale;
    offsetY = localY - imageY * scale;
    fitMode = false;
    applyTransform();
  }

  function zoomByStep(direction, clientX, clientY) {
    const tolerance = 0.0001;
    let nextScale;
    if (direction > 0) {
      nextScale = zoomStops.find((candidate) => candidate > scale + tolerance) || MAX_SCALE;
    } else {
      nextScale = [...zoomStops]
        .reverse()
        .find((candidate) => candidate < scale - tolerance) || zoomStops[0];
    }
    zoomTo(nextScale, clientX, clientY);
  }

  function zoomToPixels(clientX, clientY) {
    zoomTo(PIXEL_ZOOM_SCALE, clientX, clientY);
  }

  function compileShader(type, sourceCode) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, sourceCode);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || 'Unknown shader error';
      gl.deleteShader(shader);
      throw new Error(`Image adjustment shader failed: ${message}`);
    }
    return shader;
  }

  function initializeWebGl() {
    if (gl) {
      return;
    }
    gl = display.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      throw new Error('WebGL is unavailable. Enable hardware acceleration in VS Code.');
    }

    const vertexShader = compileShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
    shaderProgram = gl.createProgram();
    gl.attachShader(shaderProgram, vertexShader);
    gl.attachShader(shaderProgram, fragmentShader);
    gl.linkProgram(shaderProgram);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
      throw new Error(`Image adjustment shader failed: ${gl.getProgramInfoLog(shaderProgram)}`);
    }

    gl.useProgram(shaderProgram);
    const positionLocation = gl.getAttribLocation(shaderProgram, 'a_position');
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    imageTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    histogramTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, histogramTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      HISTOGRAM_SAMPLE_SIZE,
      HISTOGRAM_SAMPLE_SIZE,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    histogramFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, histogramFramebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      histogramTexture,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('The GPU could not create the histogram sample buffer.');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    uniforms = {
      exposure: gl.getUniformLocation(shaderProgram, 'u_exposure'),
      gamma: gl.getUniformLocation(shaderProgram, 'u_gamma'),
      offset: gl.getUniformLocation(shaderProgram, 'u_offset'),
      tonemap: gl.getUniformLocation(shaderProgram, 'u_tonemap'),
      uvMin: gl.getUniformLocation(shaderProgram, 'u_uvMin'),
      uvMax: gl.getUniformLocation(shaderProgram, 'u_uvMax'),
    };
    gl.uniform1i(gl.getUniformLocation(shaderProgram, 'u_image'), 0);
  }

  function uploadImage() {
    initializeWebGl();
    const maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (
      imageSource.naturalWidth > maximumTextureSize ||
      imageSource.naturalHeight > maximumTextureSize
    ) {
      throw new Error(
        `The ${imageSource.naturalWidth} × ${imageSource.naturalHeight} preview exceeds this GPU's ${maximumTextureSize}px texture limit.`,
      );
    }

    display.width = imageSource.naturalWidth;
    display.height = imageSource.naturalHeight;
    imageWidth = imageSource.naturalWidth;
    imageHeight = imageSource.naturalHeight;
    clearSelection();
    setSelectionMode(false);
    resetPixelInspector();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      imageSource,
    );
    renderFrame();
  }

  function configureShader(uvMin = [0, 0], uvMax = [1, 1]) {
    gl.useProgram(shaderProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);
    gl.uniform1f(uniforms.exposure, adjustments.exposure);
    gl.uniform1f(uniforms.gamma, adjustments.gamma);
    gl.uniform1f(uniforms.offset, adjustments.offset);
    gl.uniform1i(uniforms.tonemap, toneMapIndex[adjustments.tonemap]);
    gl.uniform2f(uniforms.uvMin, uvMin[0], uvMin[1]);
    gl.uniform2f(uniforms.uvMax, uvMax[0], uvMax[1]);
  }

  function renderFrame() {
    if (!gl || !imageWidth) {
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, display.width, display.height);
    configureShader();
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    scheduleHistogram();
    schedulePixelLabels();
    if (inspectedPixel) {
      schedulePixelSample(inspectedPixel, true);
    }
  }

  function scheduleHistogram() {
    if (histogramFrameRequest) {
      cancelAnimationFrame(histogramFrameRequest);
    }
    histogramFrameRequest = requestAnimationFrame(() => {
      histogramFrameRequest = undefined;
      updateHistogram();
    });
  }

  function updateHistogram() {
    if (!gl || !imageWidth || !histogramContext) {
      showHistogramEmpty('Open an image to view its histogram');
      return;
    }

    const region = selectedRegion || { x: 0, y: 0, width: imageWidth, height: imageHeight };
    const uvMin = [region.x / imageWidth, region.y / imageHeight];
    const uvMax = [
      (region.x + region.width) / imageWidth,
      (region.y + region.height) / imageHeight,
    ];
    const pixels = new Uint8Array(HISTOGRAM_SAMPLE_SIZE * HISTOGRAM_SAMPLE_SIZE * 4);

    gl.bindFramebuffer(gl.FRAMEBUFFER, histogramFramebuffer);
    gl.viewport(0, 0, HISTOGRAM_SAMPLE_SIZE, HISTOGRAM_SAMPLE_SIZE);
    configureShader(uvMin, uvMax);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.readPixels(
      0,
      0,
      HISTOGRAM_SAMPLE_SIZE,
      HISTOGRAM_SAMPLE_SIZE,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, display.width, display.height);

    const red = new Uint32Array(256);
    const green = new Uint32Array(256);
    const blue = new Uint32Array(256);
    const luma = new Uint32Array(256);
    for (let index = 0; index < pixels.length; index += 4) {
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      red[r] += 1;
      green[g] += 1;
      blue[b] += 1;
      luma[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)] += 1;
    }

    drawHistogram({ red, green, blue, luma });
    histogramEmpty.hidden = true;
    if (selectedRegion) {
      const width = Math.max(1, Math.round(selectedRegion.width));
      const height = Math.max(1, Math.round(selectedRegion.height));
      histogramScope.textContent = `${width} × ${height} px`;
      histogramCanvas.setAttribute(
        'aria-label',
        `RGB histogram for the selected ${width} by ${height} pixel region`,
      );
    } else {
      histogramScope.textContent = 'Whole image';
      histogramCanvas.setAttribute('aria-label', 'RGB histogram for the whole image');
    }
  }

  function drawHistogram(channels) {
    const width = histogramCanvas.width;
    const height = histogramCanvas.height;
    const inset = 10;
    histogramContext.clearRect(0, 0, width, height);
    histogramContext.strokeStyle = 'rgba(160, 160, 160, 0.15)';
    histogramContext.lineWidth = 1;
    for (let line = 1; line < 4; line += 1) {
      const y = Math.round((height * line) / 4) + 0.5;
      histogramContext.beginPath();
      histogramContext.moveTo(0, y);
      histogramContext.lineTo(width, y);
      histogramContext.stroke();
    }

    let maximum = 1;
    for (const values of Object.values(channels)) {
      for (const count of values) {
        maximum = Math.max(maximum, Math.log1p(count));
      }
    }
    drawHistogramSeries(channels.red, '#ff5f63', 'rgba(255, 95, 99, 0.16)', maximum, inset);
    drawHistogramSeries(channels.green, '#54d17a', 'rgba(84, 209, 122, 0.16)', maximum, inset);
    drawHistogramSeries(channels.blue, '#55a7ff', 'rgba(85, 167, 255, 0.17)', maximum, inset);
    drawHistogramSeries(channels.luma, '#f1f1f1', null, maximum, inset);
  }

  function drawHistogramSeries(values, stroke, fill, maximum, inset) {
    const width = histogramCanvas.width;
    const height = histogramCanvas.height;
    const baseline = height - inset;
    const graphHeight = height - inset * 2;
    histogramContext.beginPath();
    histogramContext.moveTo(0, baseline);
    for (let index = 0; index < values.length; index += 1) {
      const x = (index / 255) * width;
      const y = baseline - (Math.log1p(values[index]) / maximum) * graphHeight;
      histogramContext.lineTo(x, y);
    }
    if (fill) {
      histogramContext.lineTo(width, baseline);
      histogramContext.closePath();
      histogramContext.fillStyle = fill;
      histogramContext.fill();
    }
    histogramContext.strokeStyle = stroke;
    histogramContext.lineWidth = stroke === '#f1f1f1' ? 1.25 : 1;
    histogramContext.stroke();
  }

  function showHistogramEmpty(message) {
    if (histogramContext) {
      histogramContext.clearRect(0, 0, histogramCanvas.width, histogramCanvas.height);
    }
    histogramEmpty.textContent = message;
    histogramEmpty.hidden = false;
    histogramScope.textContent = 'Whole image';
  }

  function schedulePixelLabels() {
    if (!gl || !imageWidth || scale < PIXEL_GRID_SCALE || !pixelLabelsContext) {
      if (pixelLabelsFrameRequest) {
        cancelAnimationFrame(pixelLabelsFrameRequest);
        pixelLabelsFrameRequest = undefined;
      }
      clearPixelLabels();
      return;
    }
    if (pixelLabelsFrameRequest) {
      cancelAnimationFrame(pixelLabelsFrameRequest);
    }
    pixelLabelsFrameRequest = requestAnimationFrame(() => {
      pixelLabelsFrameRequest = undefined;
      updatePixelLabels();
    });
  }

  function updatePixelLabels() {
    if (!gl || !imageWidth || scale < PIXEL_GRID_SCALE || !pixelLabelsContext) {
      clearPixelLabels();
      return;
    }
    const viewportWidth = viewport.clientWidth;
    const viewportHeight = viewport.clientHeight;
    const startX = Math.max(0, Math.min(imageWidth, Math.floor(-offsetX / scale)));
    const startY = Math.max(0, Math.min(imageHeight, Math.floor(-offsetY / scale)));
    const endX = Math.max(
      0,
      Math.min(imageWidth, Math.ceil((viewportWidth - offsetX) / scale)),
    );
    const endY = Math.max(
      0,
      Math.min(imageHeight, Math.ceil((viewportHeight - offsetY) / scale)),
    );
    const sampleWidth = endX - startX;
    const sampleHeight = endY - startY;
    if (sampleWidth <= 0 || sampleHeight <= 0) {
      clearPixelLabels();
      return;
    }

    ensureSampleBuffer(sampleWidth, sampleHeight);
    const samples = new Uint8Array(sampleWidth * sampleHeight * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, histogramFramebuffer);
    gl.viewport(0, 0, sampleWidth, sampleHeight);
    configureShader(
      [startX / imageWidth, startY / imageHeight],
      [endX / imageWidth, endY / imageHeight],
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.readPixels(
      0,
      0,
      sampleWidth,
      sampleHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      samples,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, display.width, display.height);

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const canvasWidth = Math.max(1, Math.round(viewportWidth * pixelRatio));
    const canvasHeight = Math.max(1, Math.round(viewportHeight * pixelRatio));
    if (pixelLabels.width !== canvasWidth || pixelLabels.height !== canvasHeight) {
      pixelLabels.width = canvasWidth;
      pixelLabels.height = canvasHeight;
    }
    pixelLabels.hidden = false;
    pixelOverlayLegend.hidden = false;
    pixelOverlayLegend.textContent =
      scale >= 32 ? 'R / G / B · adjusted 0–255' : 'Y luma · adjusted 0–255';
    pixelLabelsContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    pixelLabelsContext.clearRect(0, 0, viewportWidth, viewportHeight);

    for (let row = 0; row < sampleHeight; row += 1) {
      const sourceRow = sampleHeight - row - 1;
      for (let column = 0; column < sampleWidth; column += 1) {
        const index = (sourceRow * sampleWidth + column) * 4;
        const red = samples[index];
        const green = samples[index + 1];
        const blue = samples[index + 2];
        const luma = Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue);
        const centerX = offsetX + (startX + column + 0.5) * scale;
        const centerY = offsetY + (startY + row + 0.5) * scale;
        drawPixelValue(centerX, centerY, red, green, blue, luma);
      }
    }
  }

  function ensureSampleBuffer(requiredWidth, requiredHeight) {
    if (requiredWidth <= sampleBufferWidth && requiredHeight <= sampleBufferHeight) {
      return;
    }
    const nextWidth = Math.max(sampleBufferWidth, requiredWidth);
    const nextHeight = Math.max(sampleBufferHeight, requiredHeight);
    const maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (nextWidth > maximumTextureSize || nextHeight > maximumTextureSize) {
      throw new Error('The visible pixel grid exceeds this GPU\'s sample-buffer limit.');
    }
    gl.bindTexture(gl.TEXTURE_2D, histogramTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      nextWidth,
      nextHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    sampleBufferWidth = nextWidth;
    sampleBufferHeight = nextHeight;
  }

  function drawPixelValue(centerX, centerY, red, green, blue, luma) {
    const darkText = luma >= 150;
    pixelLabelsContext.textAlign = 'center';
    pixelLabelsContext.textBaseline = 'middle';
    pixelLabelsContext.fillStyle = darkText ? '#101010' : '#ffffff';
    pixelLabelsContext.strokeStyle = darkText
      ? 'rgba(255, 255, 255, 0.72)'
      : 'rgba(0, 0, 0, 0.82)';

    if (scale >= 32) {
      const fontSize = Math.max(8, Math.min(12, Math.floor(scale / 5)));
      const lineHeight = fontSize + 1;
      pixelLabelsContext.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      pixelLabelsContext.lineWidth = Math.max(1.5, fontSize * 0.22);
      const values = [`R${red}`, `G${green}`, `B${blue}`];
      const firstLineY = centerY - lineHeight;
      for (let line = 0; line < values.length; line += 1) {
        const y = firstLineY + line * lineHeight;
        pixelLabelsContext.strokeText(values[line], centerX, y);
        pixelLabelsContext.fillText(values[line], centerX, y);
      }
      return;
    }

    const fontSize = Math.max(7, Math.min(10, Math.floor(scale * 0.42)));
    pixelLabelsContext.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    pixelLabelsContext.lineWidth = Math.max(1.5, fontSize * 0.22);
    const value = String(luma);
    pixelLabelsContext.strokeText(value, centerX, centerY);
    pixelLabelsContext.fillText(value, centerX, centerY);
  }

  function clearPixelLabels() {
    pixelLabels.hidden = true;
    pixelOverlayLegend.hidden = true;
    if (pixelLabelsContext) {
      pixelLabelsContext.clearRect(0, 0, pixelLabels.width, pixelLabels.height);
    }
  }

  function resetPixelInspector() {
    inspectedPixel = undefined;
    if (pixelFrameRequest) {
      cancelAnimationFrame(pixelFrameRequest);
      pixelFrameRequest = undefined;
    }
    if (pixelLabelsFrameRequest) {
      cancelAnimationFrame(pixelLabelsFrameRequest);
      pixelLabelsFrameRequest = undefined;
    }
    pixelStatus.textContent = 'Hover to sample. Pixel zoom overlays values on every visible cell.';
    pixelCoordinates.textContent = 'x —   y —';
    pixelHex.textContent = '#——';
    pixelRed.textContent = '—';
    pixelGreen.textContent = '—';
    pixelBlue.textContent = '—';
    pixelLuma.textContent = '—';
    pixelSwatch.style.removeProperty('background');
    pixelMarker.hidden = true;
    pixelGrid.hidden = true;
    clearPixelLabels();
  }

  function imagePixelFromPointer(event) {
    const bounds = viewport.getBoundingClientRect();
    const x = (event.clientX - bounds.left - offsetX) / scale;
    const y = (event.clientY - bounds.top - offsetY) / scale;
    if (x < 0 || y < 0 || x >= imageWidth || y >= imageHeight) {
      return undefined;
    }
    return { x: Math.floor(x), y: Math.floor(y) };
  }

  function schedulePixelSample(pixel, force = false) {
    if (!pixel || !gl || !imageWidth) {
      return;
    }
    const unchanged =
      inspectedPixel && inspectedPixel.x === pixel.x && inspectedPixel.y === pixel.y;
    inspectedPixel = pixel;
    updatePixelOverlays();
    pixelStatus.textContent = 'Adjusted preview value · zero-based coordinates.';
    if (unchanged && !force && !pixelFrameRequest) {
      return;
    }
    if (pixelFrameRequest) {
      cancelAnimationFrame(pixelFrameRequest);
    }
    pixelFrameRequest = requestAnimationFrame(() => {
      pixelFrameRequest = undefined;
      sampleDisplayedPixel();
    });
  }

  function sampleDisplayedPixel() {
    if (!inspectedPixel || !gl || !imageWidth) {
      return;
    }
    const pixel = { ...inspectedPixel };
    const sample = new Uint8Array(4);
    const uvMin = [pixel.x / imageWidth, pixel.y / imageHeight];
    const uvMax = [(pixel.x + 1) / imageWidth, (pixel.y + 1) / imageHeight];

    gl.bindFramebuffer(gl.FRAMEBUFFER, histogramFramebuffer);
    gl.viewport(0, 0, 1, 1);
    configureShader(uvMin, uvMax);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, sample);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, display.width, display.height);

    if (!inspectedPixel || inspectedPixel.x !== pixel.x || inspectedPixel.y !== pixel.y) {
      schedulePixelSample(inspectedPixel, true);
      return;
    }
    updatePixelReadout(pixel, sample);
  }

  function updatePixelReadout(pixel, sample) {
    const [red, green, blue] = sample;
    const luma = Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue);
    const hexadecimal = [red, green, blue]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    pixelCoordinates.textContent = `x ${pixel.x}   y ${pixel.y}`;
    pixelHex.textContent = `#${hexadecimal}`;
    pixelRed.textContent = String(red);
    pixelGreen.textContent = String(green);
    pixelBlue.textContent = String(blue);
    pixelLuma.textContent = String(luma);
    pixelSwatch.style.background = `rgb(${red} ${green} ${blue})`;
  }

  function updatePixelOverlays() {
    const showGrid = Boolean(imageWidth && scale >= PIXEL_GRID_SCALE);
    pixelGrid.hidden = !showGrid;
    if (showGrid) {
      pixelGrid.style.setProperty('--pixel-size', `${scale}px`);
      pixelGrid.style.left = `${offsetX}px`;
      pixelGrid.style.top = `${offsetY}px`;
      pixelGrid.style.width = `${imageWidth * scale}px`;
      pixelGrid.style.height = `${imageHeight * scale}px`;
    }

    const showMarker = Boolean(
      imageWidth && inspectedPixel && scale >= PIXELATED_SCALE,
    );
    pixelMarker.hidden = !showMarker;
    if (showMarker) {
      pixelMarker.style.left = `${offsetX + inspectedPixel.x * scale}px`;
      pixelMarker.style.top = `${offsetY + inspectedPixel.y * scale}px`;
      pixelMarker.style.width = `${scale}px`;
      pixelMarker.style.height = `${scale}px`;
    }
  }

  function imagePointFromPointer(event) {
    const bounds = viewport.getBoundingClientRect();
    return {
      x: Math.min(imageWidth, Math.max(0, (event.clientX - bounds.left - offsetX) / scale)),
      y: Math.min(imageHeight, Math.max(0, (event.clientY - bounds.top - offsetY) / scale)),
    };
  }

  function regionBetween(start, end) {
    return {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
  }

  function updateSelectionOverlay() {
    if (!selectedRegion || !imageWidth) {
      selectionBox.hidden = true;
      clearRegion.disabled = true;
      return;
    }
    selectionBox.hidden = false;
    selectionBox.style.left = `${offsetX + selectedRegion.x * scale}px`;
    selectionBox.style.top = `${offsetY + selectedRegion.y * scale}px`;
    selectionBox.style.width = `${selectedRegion.width * scale}px`;
    selectionBox.style.height = `${selectedRegion.height * scale}px`;
    selectionSize.textContent = `${Math.max(1, Math.round(selectedRegion.width))} × ${Math.max(1, Math.round(selectedRegion.height))}`;
    clearRegion.disabled = false;
  }

  function clearSelection() {
    selectedRegion = undefined;
    selectionStart = undefined;
    selecting = false;
    updateSelectionOverlay();
    if (imageWidth) {
      scheduleHistogram();
    }
  }

  function setSelectionMode(enabled) {
    selectionMode = Boolean(enabled && imageWidth);
    selectRegion.classList.toggle('active', selectionMode);
    selectRegion.setAttribute('aria-pressed', String(selectionMode));
    viewport.classList.toggle('selecting', selectionMode);
    selectionHelp.textContent = selectionMode
      ? 'Drag across the image to sample a region. Alt-drag pans.'
      : 'Select a region to inspect it; without one, the whole image is sampled.';
  }

  function enableAdjustments(enabled) {
    for (const control of adjustmentControls) {
      control.disabled = !enabled;
    }
  }

  function updateAdjustmentControls() {
    exposureInput.value = String(adjustments.exposure);
    exposureNumber.value = adjustments.exposure.toFixed(1);
    gammaInput.value = String(adjustments.gamma);
    gammaNumber.value = adjustments.gamma.toFixed(2);
    offsetInput.value = String(adjustments.offset);
    offsetNumber.value = adjustments.offset.toFixed(2);
    for (const button of toneMapButtons) {
      const active = button.dataset.tonemap === adjustments.tonemap;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    tonemapDescription.textContent = toneMapDescriptions[adjustments.tonemap];
  }

  function persistAdjustments() {
    vscode.setState({ ...previousState, adjustments: { ...adjustments } });
  }

  function setAdjustment(name, value) {
    Object.assign(adjustments, sanitizeAdjustments({ ...adjustments, [name]: value }));
    updateAdjustmentControls();
    renderFrame();
    persistAdjustments();
  }

  function commitNumberInput(name, input) {
    if (input.value === '') {
      updateAdjustmentControls();
      return;
    }
    setAdjustment(name, input.value);
  }

  function resetImageAdjustments() {
    Object.assign(adjustments, defaultAdjustments);
    updateAdjustmentControls();
    renderFrame();
    persistAdjustments();
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'loading') {
      showLoading(message.message);
    } else if (message.type === 'error') {
      showError(message.message, message.canRender);
    } else if (message.type === 'preview') {
      source.textContent = message.source;
      renderDetails(message.details);
      imageSource.onload = () => {
        try {
          uploadImage();
          display.style.display = 'block';
          empty.hidden = true;
          enableAdjustments(true);
          selectRegion.disabled = false;
          fitImage();
        } catch (error) {
          showError(error instanceof Error ? error.message : String(error), false);
        }
      };
      imageSource.onerror = () => {
        showError('The decoder returned an image that VS Code could not display.', true);
      };
      imageSource.src = message.src;
    }
  });

  document.getElementById('fit').addEventListener('click', fitImage);
  document.getElementById('actual').addEventListener('click', actualSize);
  pixelZoom.addEventListener('click', () => zoomToPixels());
  document.getElementById('zoomIn').addEventListener('click', () => zoomByStep(1));
  document.getElementById('zoomOut').addEventListener('click', () => zoomByStep(-1));
  document.getElementById('refresh').addEventListener('click', () => post('refresh'));
  document.getElementById('render').addEventListener('click', () => post('render'));
  tryRender.addEventListener('click', () => post('render'));
  document.getElementById('settings').addEventListener('click', () => post('openSettings'));
  document.getElementById('reveal').addEventListener('click', () => post('reveal'));
  exposureInput.addEventListener('input', () => setAdjustment('exposure', exposureInput.value));
  exposureNumber.addEventListener('change', () =>
    commitNumberInput('exposure', exposureNumber),
  );
  gammaInput.addEventListener('input', () => setAdjustment('gamma', gammaInput.value));
  gammaNumber.addEventListener('change', () => commitNumberInput('gamma', gammaNumber));
  offsetInput.addEventListener('input', () => setAdjustment('offset', offsetInput.value));
  offsetNumber.addEventListener('change', () => commitNumberInput('offset', offsetNumber));
  for (const button of toneMapButtons) {
    button.addEventListener('click', () => setAdjustment('tonemap', button.dataset.tonemap));
  }
  for (const button of document.querySelectorAll('[data-reset-adjustment]')) {
    button.addEventListener('click', () => {
      const name = button.dataset.resetAdjustment;
      setAdjustment(name, defaultAdjustments[name]);
    });
  }
  resetAdjustments.addEventListener('click', resetImageAdjustments);
  selectRegion.addEventListener('click', () => setSelectionMode(!selectionMode));
  clearRegion.addEventListener('click', clearSelection);

  viewport.addEventListener(
    'wheel',
    (event) => {
      if (!imageWidth) {
        return;
      }
      event.preventDefault();
      zoomTo(scale * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
    },
    { passive: false },
  );
  viewport.addEventListener('pointerdown', (event) => {
    if (!imageWidth || (event.button !== 0 && event.button !== 1)) {
      return;
    }
    const shouldSelect = selectionMode && event.button === 0 && !event.altKey;
    if (shouldSelect) {
      selecting = true;
      selectionStart = imagePointFromPointer(event);
      selectedRegion = regionBetween(selectionStart, selectionStart);
      updateSelectionOverlay();
    } else {
      dragging = true;
      fitMode = false;
      dragStart = { x: event.clientX - offsetX, y: event.clientY - offsetY };
      viewport.classList.add('dragging');
    }
    event.preventDefault();
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener('pointermove', (event) => {
    if (selecting) {
      selectedRegion = regionBetween(selectionStart, imagePointFromPointer(event));
      updateSelectionOverlay();
      scheduleHistogram();
    } else if (dragging) {
      offsetX = event.clientX - dragStart.x;
      offsetY = event.clientY - dragStart.y;
      applyTransform();
    }
    const pixel = imagePixelFromPointer(event);
    if (pixel) {
      schedulePixelSample(pixel);
    } else if (inspectedPixel) {
      pixelStatus.textContent = 'Last sampled adjusted preview value.';
    }
  });
  function stopPointerAction(event) {
    if (selecting) {
      selecting = false;
      if (!selectedRegion || selectedRegion.width < 2 || selectedRegion.height < 2) {
        clearSelection();
      } else {
        updateSelectionOverlay();
        scheduleHistogram();
      }
    }
    dragging = false;
    viewport.classList.remove('dragging');
    if (viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
  }
  viewport.addEventListener('pointerup', stopPointerAction);
  viewport.addEventListener('pointercancel', stopPointerAction);
  viewport.addEventListener('pointerleave', () => {
    if (inspectedPixel) {
      pixelStatus.textContent = 'Last sampled adjusted preview value.';
    }
  });
  viewport.addEventListener('dblclick', (event) => {
    if (!imageWidth || selectionMode) {
      return;
    }
    zoomTo(scale >= 8 ? 1 : PIXEL_ZOOM_SCALE, event.clientX, event.clientY);
  });
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    if (selectedRegion) {
      clearSelection();
    } else if (selectionMode) {
      setSelectionMode(false);
    }
  });
  window.addEventListener('resize', () => {
    if (fitMode) {
      fitImage();
    } else {
      updateSelectionOverlay();
      updatePixelOverlays();
      schedulePixelLabels();
    }
  });

  showHistogramEmpty('Open an image to view its histogram');
  resetPixelInspector();
  updateAdjustmentControls();
  post('ready');
})();
