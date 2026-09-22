import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';

const ROOT = path.resolve(__dirname, '..');

interface ElectronBuilderPackage {
  bin: string | Record<string, string>;
}

type SpawnResult = Pick<SpawnSyncReturns<Buffer>, 'error' | 'status'>;
type SpawnRunner = (command: string, args: string[], options: SpawnSyncOptions) => SpawnResult;

interface RunnerOptions {
  root?: string;
  spawnSync?: SpawnRunner;
}

interface BuildOptions extends RunnerOptions {
  platform?: NodeJS.Platform;
  electronDist?: string;
  electronBuilderCli?: string;
  nodeExecutable?: string;
}

function electronDistDir(): string {
  return path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
}

function electronBuilderCli(): string {
  const packagePath = require.resolve('electron-builder/package.json');
  const packageData = require(packagePath) as ElectronBuilderPackage;
  const relativeBin =
    typeof packageData.bin === 'string' ? packageData.bin : packageData.bin['electron-builder'];
  if (!relativeBin) throw new Error('electron-builder CLI is not declared by its package');
  return path.join(path.dirname(packagePath), relativeBin);
}

function runBuild(
  args: string[],
  {
    root = ROOT,
    electronDist = electronDistDir(),
    electronBuilderCli: builderCli = electronBuilderCli(),
    nodeExecutable = process.execPath,
    spawnSync: run = spawnSync as SpawnRunner,
  }: BuildOptions = {},
): number {
  const electronExe = path.join(electronDist, 'electron.exe');
  if (!fs.existsSync(electronExe) && root === ROOT) {
    throw new Error(`Local Electron distribution is unavailable: ${electronExe}`);
  }
  const result = run(nodeExecutable, [builderCli, `-c.electronDist=${electronDist}`, ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status == null ? 1 : result.status;
}

if (require.main === module) process.exitCode = runBuild(process.argv.slice(2));

export { runBuild };
