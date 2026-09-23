'use strict';


const fs = require('node:fs');
const path = require('node:path');

function profileWorkspaceRoot(userDataDir: string): string {
  try {
    const stateFile = path.join(String(userDataDir || ''), 'workspace.txt');
    const raw = fs.readFileSync(stateFile, 'utf-8').trim();
    if (raw && fs.existsSync(raw) && fs.statSync(raw).isDirectory()) return raw;
  } catch (_) {
    /* 未配置或读不到：没有默认工作区，调用方回落现有行为。 */
  }
  return '';
}

module.exports = { profileWorkspaceRoot };
