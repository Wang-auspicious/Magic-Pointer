'use strict';

const path = require('path');

function bundledPythonPath(resourcesPath) {
  if (typeof resourcesPath !== 'string' || !resourcesPath.trim()) {
    throw new TypeError('resourcesPath must be a non-empty string');
  }
  return path.join(resourcesPath, 'python-runtime', 'python.exe');
}

function resolvePythonRuntime({
  isPackaged = false,
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  env = process.env,
} = {}) {
  if (isPackaged === true && platform === 'win32') {
    return {
      executable: bundledPythonPath(resourcesPath),
      source: 'bundled',
      required: true,
    };
  }
  const configured = String(env?.MAGIC_POINTER_PYTHON || env?.PYTHON_EXECUTABLE || '').trim();
  return {
    executable: configured || 'python',
    source: configured ? 'environment' : 'path',
    required: false,
  };
}

function pythonSpawnEnvironment({ env = process.env, isolated = false } = {}) {
  if (!isolated) return { ...env };
  const next = {};
  const blocked = new Set([
    'VIRTUAL_ENV',
    'CONDA_PREFIX',
    'CONDA_DEFAULT_ENV',
    '__PYVENV_LAUNCHER__',
  ]);
  for (const [key, value] of Object.entries(env || {})) {
    const normalized = String(key).toUpperCase();
    if (normalized.startsWith('PYTHON') || blocked.has(normalized)) continue;
    next[key] = value;
  }
  next.PYTHONNOUSERSITE = '1';
  next.PYTHONDONTWRITEBYTECODE = '1';
  next.PYTHONUTF8 = '1';
  return next;
}

function pythonInvocationArgs(args = [], { isolated = false } = {}) {
  const normalized = Array.isArray(args) ? [...args] : [];
  return isolated ? ['-I', '-X', 'utf8', ...normalized] : normalized;
}

function resolvePythonExecutable(options) {
  return resolvePythonRuntime(options).executable;
}

module.exports = {
  bundledPythonPath,
  pythonInvocationArgs,
  pythonSpawnEnvironment,
  resolvePythonRuntime,
  resolvePythonExecutable,
};
