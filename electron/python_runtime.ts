'use strict';

const path = require('path');

type RuntimeEnvironment = Record<string, string | undefined>;
type RuntimeResolution = {
  executable: string;
  source: 'bundled' | 'environment' | 'path';
  required: boolean;
};

type RuntimeOptions = {
  isPackaged?: boolean;
  platform?: NodeJS.Platform;
  resourcesPath?: string;
  env?: RuntimeEnvironment;
};

function bundledPythonPath(resourcesPath: string, platform: NodeJS.Platform = 'win32'): string {
  if (typeof resourcesPath !== 'string' || !resourcesPath.trim()) {
    throw new TypeError('resourcesPath must be a non-empty string');
  }
  const executable = platform === 'darwin' ? path.join('bin', 'python3') : 'python.exe';
  return path.join(resourcesPath, 'python-runtime', executable);
}

function resolvePythonRuntime({
  isPackaged = false,
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  env = process.env,
}: RuntimeOptions = {}): RuntimeResolution {
  if (isPackaged === true && (platform === 'win32' || platform === 'darwin')) {
    return {
      executable: bundledPythonPath(resourcesPath, platform),
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

function pythonSpawnEnvironment({
  env = process.env,
  isolated = false,
}: {
  env?: RuntimeEnvironment;
  isolated?: boolean;
} = {}): RuntimeEnvironment {
  if (!isolated) return { ...env };
  const next: RuntimeEnvironment = {};
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

function pythonInvocationArgs(
  args: string[] = [],
  { isolated = false }: { isolated?: boolean } = {},
): string[] {
  const normalized = Array.isArray(args) ? [...args] : [];
  return isolated ? ['-I', '-X', 'utf8', ...normalized] : normalized;
}

function resolvePythonExecutable(options?: RuntimeOptions): string {
  return resolvePythonRuntime(options).executable;
}

module.exports = {
  bundledPythonPath,
  pythonInvocationArgs,
  pythonSpawnEnvironment,
  resolvePythonRuntime,
  resolvePythonExecutable,
};
