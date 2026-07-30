#!/usr/bin/env node
'use strict';

// Collect a diagnostics bundle from the local Magic Pointer runtime.
// Usage: node scripts/collect-diagnostics.js [--out path/to/bundle.zip]
// Writes a zip if `archiver` is available; otherwise falls back to a
// timestamped directory copy so the tool always produces something usable.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function parseArgs(argv) {
  const out = { outPath: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if ((a === '--out' || a === '-o') && argv[i + 1]) {
      out.outPath = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function pickRuntimeDir() {
  const explicit = process.env.MAGIC_POINTER_USER_DATA_DIR;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const devDir = path.resolve(__dirname, '..', 'data', 'runtime');
  if (fs.existsSync(devDir)) return devDir;
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Magic Pointer')]
    : process.platform === 'darwin'
      ? [path.join(home, 'Library', 'Application Support', 'Magic Pointer')]
      : [path.join(home, '.config', 'Magic Pointer')];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function redactSecrets(text) {
  if (!text) return text;
  return text
    .replace(/([A-Za-z0-9_-]{0,3})(sk-[A-Za-z0-9-_]+)/g, '$1<redacted>')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/gi, '<redacted>')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/(api[_-]?key\s*[:=]\s*)([^\s"']+)/gi, '$1<redacted>')
    .replace(/(token\s*[:=]\s*)([^\s"']+)/gi, '$1<redacted>')
    .replace(/(password\s*[:=]\s*)([^\s"']+)/gi, '$1<redacted>');
}

function redactStructured(value, key = '') {
  if (/api[_-]?key|authorization|credential|password|secret|token/i.test(key)) {
    return '<redacted>';
  }
  if (Array.isArray(value)) return value.map((item) => redactStructured(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactStructured(childValue, childKey),
    ]));
  }
  return typeof value === 'string' ? redactSecrets(value) : value;
}

function redactDiagnosticText(text) {
  try {
    return `${JSON.stringify(redactStructured(JSON.parse(text)))}`;
  } catch (_) {
    return text.split(/(\r?\n)/).map((part) => {
      if (!part || /^\r?\n$/.test(part)) return part;
      try {
        return JSON.stringify(redactStructured(JSON.parse(part)));
      } catch (_parseError) {
        return redactSecrets(part);
      }
    }).join('');
  }
}

function copyRedacted(src, dst) {
  const text = fs.readFileSync(src, 'utf8');
  fs.writeFileSync(dst, redactDiagnosticText(text), 'utf8');
}

function isAllowedDiagnosticFile(name) {
  return name === 'electron.log'
    || /^events\.jsonl(?:\.\d+)?$/.test(name);
}

function collectDiagnosticFiles(runtimeDir) {
  if (!runtimeDir || !fs.existsSync(runtimeDir)) return [];
  return fs.readdirSync(runtimeDir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink() || !isAllowedDiagnosticFile(entry.name)) return [];
    const full = path.join(runtimeDir, entry.name);
    try {
      const stat = fs.lstatSync(full);
      return stat.isFile() && !stat.isSymbolicLink() ? [{ full, rel: entry.name }] : [];
    } catch (_) {
      return [];
    }
  });
}

function main() {
  const { outPath } = parseArgs(process.argv);
  const runtimeDir = pickRuntimeDir();
  if (!runtimeDir) {
    console.error('No runtime directory found.');
    process.exit(2);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-diag-'));

  const meta = {
    schema_version: 1,
    collected_at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    hostname_hash: crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 12),
  };
  fs.writeFileSync(path.join(stageDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  const files = collectDiagnosticFiles(runtimeDir);
  for (const f of files) {
    const outFile = path.join(stageDir, 'runtime', f.rel);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    try {
      copyRedacted(f.full, outFile);
    } catch (_) {}
  }

  const finalOut = outPath || path.join(os.tmpdir(), `magic-pointer-diagnostics-${stamp}`);
  try {
    const archiver = require('archiver');
    const zipPath = finalOut.endsWith('.zip') ? finalOut : `${finalOut}.zip`;
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(output);
    archive.directory(stageDir, false);
    archive.finalize();
    output.on('close', () => {
      fs.rmSync(stageDir, { recursive: true, force: true });
      console.log(zipPath);
    });
    return;
  } catch (_) {
    const dirOut = finalOut.endsWith('.zip') ? finalOut.replace(/\.zip$/, '') : finalOut;
    fs.mkdirSync(dirOut, { recursive: true });
    for (const f of collectFiles(stageDir)) {
      const dst = path.join(dirOut, f.rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(f.full, dst);
    }
    fs.rmSync(stageDir, { recursive: true, force: true });
    console.log(dirOut);
  }
}

if (require.main === module) main();

function collectFiles(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, base, acc);
    else if (entry.isFile() && !entry.isSymbolicLink()) acc.push({ full, rel: path.relative(base, full) });
  }
  return acc;
}

module.exports = { collectDiagnosticFiles, redactSecrets };
