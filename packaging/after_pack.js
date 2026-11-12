'use strict';

const fs = require('node:fs');
const path = require('node:path');

const KEPT_LOCALES = new Set(['zh-CN.pak', 'en-US.pak']);

exports.default = async function afterPack(context) {
  const appOutDir = context && context.appOutDir;
  if (!appOutDir || !fs.existsSync(appOutDir)) {
    return;
  }

  const localesDir = path.join(appOutDir, 'locales');
  if (fs.existsSync(localesDir)) {
    for (const entry of fs.readdirSync(localesDir)) {
      if (entry.endsWith('.pak') && !KEPT_LOCALES.has(entry)) {
        fs.rmSync(path.join(localesDir, entry), {force: true});
      }
    }
  }

  const chromiumLicenses = path.join(appOutDir, 'LICENSES.chromium.html');
  if (fs.existsSync(chromiumLicenses)) {
    fs.rmSync(chromiumLicenses, {force: true});
  }
};
