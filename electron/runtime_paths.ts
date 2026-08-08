const path = require('node:path');

function projectRoot(runtimeDirectory: string = __dirname): string {
  const isCompiledRuntime =
    path.basename(runtimeDirectory) === 'electron' &&
    path.basename(path.dirname(runtimeDirectory)) === 'build';
  return isCompiledRuntime
    ? path.resolve(runtimeDirectory, '..', '..')
    : path.resolve(runtimeDirectory, '..');
}

module.exports = { projectRoot };
