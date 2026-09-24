'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

async function renderRaw({ inputPath, outputPath, extensionPath, config }) {
  const selected = config.get('decoder', 'auto');
  const decoderPath = config.get('decoderPath', '');
  const quality = clamp(config.get('jpegQuality', 92), 50, 100);
  const isExr = path.extname(inputPath).toLowerCase() === '.exr';
  const rawScriptPath = path.join(extensionPath, 'scripts', 'decode_raw.py');
  const exrScriptPath = path.join(extensionPath, 'scripts', 'decode_exr.py');
  const partialPath = `${outputPath}.${randomUUID()}.partial.jpg`;
  const pythonRawpy = buildPythonRawpyDecoder(
    config,
    rawScriptPath,
    inputPath,
    partialPath,
    quality,
  );
  const pythonExr = buildPythonExrDecoder(
    config,
    exrScriptPath,
    inputPath,
    partialPath,
    quality,
  );

  const definitions = {
    darktable: {
      label: 'Darktable',
      command: 'darktable-cli',
      args: [
        inputPath,
        partialPath,
        '--core',
        '--conf',
        `plugins/imageio/format/jpeg/quality=${quality}`,
      ],
    },
    rawtherapee: {
      label: 'RawTherapee',
      command: 'rawtherapee-cli',
      args: ['-Y', `-j${quality}`, '-o', partialPath, '-c', inputPath],
    },
    imagemagick: {
      label: 'ImageMagick',
      command: 'magick',
      args: [inputPath, '-auto-orient', '-quality', String(quality), partialPath],
    },
    sips: {
      label: 'macOS sips',
      command: 'sips',
      args: ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), inputPath, '--out', partialPath],
      platforms: ['darwin'],
    },
    pythonRawpy: {
      ...pythonRawpy,
    },
    pythonExr: {
      ...pythonExr,
    },
  };

  let names;
  if (selected === 'auto') {
    names = isExr
      ? ['pythonExr', 'imagemagick']
      : ['darktable', 'rawtherapee', 'imagemagick', 'sips', 'pythonRawpy'];
  } else if (selected === 'pythonRawpy' && isExr) {
    names = ['pythonExr'];
  } else if (selected === 'pythonExr' && !isExr) {
    throw new Error('The Python OpenEXR decoder can only open .exr files.');
  } else if (definitions[selected]) {
    names = [selected];
  } else {
    throw new Error(`Unknown RAW decoder: ${selected}`);
  }

  const errors = [];
  for (const name of names) {
    const definition = definitions[name];
    if (definition.platforms && !definition.platforms.includes(process.platform)) {
      continue;
    }
    const command =
      selected === name && decoderPath && !name.startsWith('python')
        ? decoderPath
        : definition.command;
    await fs.rm(partialPath, { force: true }).catch(() => {});
    try {
      await run(command, definition.args, 180_000);
      const outputStat = await fs.stat(partialPath);
      if (outputStat.size < 256) {
        throw new Error('decoder produced an empty image');
      }
      await fs.rm(outputPath, { force: true }).catch(() => {});
      await fs.rename(partialPath, outputPath);
      return { decoder: definition.label };
    } catch (error) {
      errors.push(`${definition.label}: ${shortError(error)}`);
    }
  }

  await fs.rm(partialPath, { force: true }).catch(() => {});
  throw new Error(
    `${isExr ? 'No OpenEXR decoder' : 'No RAW decoder'} could render the file. ${isExr ? 'Install OpenCV and Pillow in the configured Python environment, or install ImageMagick.' : 'Install Darktable, RawTherapee, ImageMagick, or Python rawpy.'}\n\n${errors.join('\n')}`,
  );
}

function buildPythonRawpyDecoder(config, scriptPath, inputPath, outputPath, quality) {
  return buildPythonScriptDecoder(
    config,
    'Python rawpy',
    scriptPath,
    inputPath,
    outputPath,
    quality,
  );
}

function buildPythonExrDecoder(config, scriptPath, inputPath, outputPath, quality) {
  return buildPythonScriptDecoder(
    config,
    'Python OpenEXR',
    scriptPath,
    inputPath,
    outputPath,
    quality,
  );
}

function buildPythonScriptDecoder(
  config,
  label,
  scriptPath,
  inputPath,
  outputPath,
  quality,
) {
  const condaEnvironment = String(config.get('condaEnvironment', '') || '').trim();
  if (!condaEnvironment) {
    return {
      label,
      command: String(config.get('pythonPath', 'python3') || 'python3'),
      args: [scriptPath, inputPath, outputPath, String(quality)],
    };
  }

  const condaPath = String(config.get('condaPath', 'conda') || 'conda');
  const usePrefix = isCondaPrefix(condaEnvironment);
  return {
    label: `${label} (Conda: ${path.basename(condaEnvironment) || condaEnvironment})`,
    command: condaPath,
    args: [
      'run',
      usePrefix ? '--prefix' : '--name',
      condaEnvironment,
      '--no-capture-output',
      'python',
      scriptPath,
      inputPath,
      outputPath,
      String(quality),
    ],
  };
}

async function listCondaEnvironments(condaPath = 'conda') {
  const result = await run(condaPath || 'conda', ['env', 'list', '--json'], 30_000);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('Conda returned invalid JSON while listing environments.');
  }
  if (!Array.isArray(parsed.envs)) {
    throw new Error('Conda did not return an environment list.');
  }
  return parsed.envs.map((prefix) => ({
    prefix,
    name: prefix === parsed.root_prefix ? 'base' : path.basename(prefix),
    isActive: prefix === parsed.default_prefix,
  }));
}

function isCondaPrefix(environment) {
  return (
    path.isAbsolute(environment) ||
    environment.includes('/') ||
    environment.includes('\\') ||
    /^[A-Za-z]:/.test(environment)
  );
}

async function readExifMetadata(inputPath) {
  try {
    const result = await run(
      'exiftool',
      [
        '-json',
        '-Make',
        '-Model',
        '-LensModel',
        '-DateTimeOriginal',
        '-ExposureTime',
        '-FNumber',
        '-ISO',
        '-FocalLength',
        inputPath,
      ],
      8_000,
    );
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed[0] || {} : {};
  } catch {
    return undefined;
  }
}

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const maxOutput = 128 * 1024;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxOutput) {
        stdout += chunk.toString();
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxOutput) {
        stderr += chunk.toString();
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `exited with code ${code}`));
      }
    });
  });
}

function shortError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s+/g, ' ').trim().slice(0, 240);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || minimum));
}

module.exports = {
  buildPythonExrDecoder,
  buildPythonRawpyDecoder,
  listCondaEnvironments,
  readExifMetadata,
  renderRaw,
  run,
};
