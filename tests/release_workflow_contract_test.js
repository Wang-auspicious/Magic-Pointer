'use strict';

const assert = require('assert');
const fs = require('fs');

const workflowPath = '.github/workflows/release.yml';
assert(fs.existsSync(workflowPath), 'unified release workflow must exist');
const workflow = fs.readFileSync(workflowPath, 'utf8');

assert.match(workflow, /tags:\s*\n\s*-\s*['"]v\*['"]/,
  'version tags must trigger a release build');
assert.match(workflow, /permissions:\s*\n\s*contents:\s*write/,
  'release publishing must have scoped contents write permission');
assert.doesNotMatch(workflow, /setup-python|prepare_python_runtime|python -m pytest/,
  'release builds must use the TypeScript Runtime without obsolete Python preparation');
assert.match(workflow, /actions\/setup-node@v4[\s\S]*?node-version:\s*['"](?:24|20)['"]/,
  'release builds must pin the supported Node version');
assert.match(workflow, /npm ci --ignore-scripts/);
assert.match(workflow, /npm test/);
assert.match(workflow, /run:\s*npm run dist:win/,
  'Windows artifacts must be built exactly once before verification');
assert.match(workflow, /npm run dist:win[\s\S]*?npm run verify:package[\s\S]*?npm run verify:installer/,
  'Windows build must verify the exact installer before uploading');
assert.doesNotMatch(workflow, /--publish always/,
  'electron-builder must not publish an unverified installer during its build');
assert.match(workflow, /gh release create[\s\S]*?\.exe[\s\S]*?\.dmg[\s\S]*?\.blockmap/,
  'verified installers for all platforms must be published in one release');
assert.match(workflow, /GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/,
  'GitHub CLI must publish with the workflow-scoped token');

console.log('release workflow contract test ok');
