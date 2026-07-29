'use strict';

const assert = require('assert');
const fs = require('fs');

const workflowPath = '.github/workflows/release-windows.yml';
assert(fs.existsSync(workflowPath), 'Windows release workflow must exist');
const workflow = fs.readFileSync(workflowPath, 'utf8');

assert.match(workflow, /tags:\s*\n\s*-\s*['"]v\*['"]/,
  'version tags must trigger a Windows release build');
assert.match(workflow, /permissions:\s*\n\s*contents:\s*write/,
  'release publishing must have scoped contents write permission');
assert.match(workflow, /actions\/setup-python@v5[\s\S]*?python-version:\s*['"]3\.12['"]/,
  'bundled runtime builds must pin the supported Python version');
assert.match(workflow, /actions\/setup-node@v4[\s\S]*?node-version:\s*['"]24['"]/,
  'release builds must pin the supported Node version');
assert.match(workflow, /npm ci --ignore-scripts/);
assert.match(workflow, /npm test/);
assert.match(workflow, /python -m pytest -q/);
assert.match(workflow, /npm run dist:win -- --publish always/,
  'tag builds must publish electron-updater metadata and installer');
assert.match(workflow, /release\/\*\.exe[\s\S]*?release\/latest\.yml[\s\S]*?release\/\*\.blockmap/,
  'workflow artifacts must contain installer and updater metadata');
assert.match(workflow, /GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/,
  'electron-builder must publish with the workflow-scoped token');

console.log('release workflow contract test ok');
