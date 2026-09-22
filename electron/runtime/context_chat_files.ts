import { readdir, readFile, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { array, record, type Json } from './context';
const storeNames: Record<string, string[]> = {
  wechat: ['xwechat_files', 'WeChat Files'],
  dingtalk: ['DingTalk', 'DingTalk Files'],
  feishu: ['Feishu', 'Lark', '.feishu'],
};
const storeKey = (name: string) =>
  /^(weixin|wechat)(\.exe)?$/i.test(name)
    ? 'wechat'
    : /dingtalk/i.test(name)
      ? 'dingtalk'
      : /feishu|lark/i.test(name)
        ? 'feishu'
        : '';
export const looksLikeFilename = (value: string): boolean =>
  /^[^\\/:*?"<>|\r\n]{1,120}\.[A-Za-z][A-Za-z0-9]{0,11}$/.test(value.trim());
async function directories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((item) => item.isDirectory())
      .map((item) => join(root, item.name));
  } catch {
    return [];
  }
}
async function existing(values: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const path of values)
    try {
      if ((await stat(path)).isDirectory() && !result.includes(resolve(path)))
        result.push(resolve(path));
    } catch {}
  return result;
}
async function defaultRoots(): Promise<Record<string, string[]>> {
  const home = process.env.USERPROFILE ?? homedir(),
    roots = {
      wechat: [join(home, 'Documents', 'xwechat_files'), join(home, 'Documents', 'WeChat Files')],
      dingtalk: [join(home, 'Documents', 'DingTalk'), join(home, 'DingTalk')],
      feishu: [
        join(home, '.feishu'),
        join(home, 'Documents', 'Feishu'),
        join(process.env.LOCALAPPDATA ?? home, 'Feishu'),
      ],
    };
  if (process.env.APPDATA) {
    const config = join(process.env.APPDATA, 'Tencent', 'xwechat', 'config');
    let entries: string[] = [];
    try {
      entries = await readdir(config);
    } catch {}
    for (const entry of entries.filter((item) => item.endsWith('.ini'))) {
      const drive = (await readFile(join(config, entry), 'utf8').catch(() => ''))
        .trim()
        .replace(/[\\/]+$/, '');
      if (/^[A-Za-z]:$/.test(drive)) roots.wechat.push(join(`${drive}/`, 'xwechat_files'));
    }
  }
  return roots;
}
export async function discoverChatStores(
  userDataDir: string,
  extraRoots: string[] = [],
  writeCache = true,
): Promise<Record<string, string[]>> {
  const defaults = await defaultRoots(),
    result: Record<string, string[]> = {};
  for (const [key, roots] of Object.entries(defaults)) result[key] = await existing(roots);
  const drives = await existing(
    'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `${letter}:/`),
  );
  for (const root of [...drives, ...extraRoots])
    for (const first of await directories(root)) {
      const levels = Object.values(storeNames).flat().includes(basename(first))
        ? [first]
        : await directories(first);
      for (const path of levels)
        for (const [key, names] of Object.entries(storeNames))
          if (names.includes(basename(path)) && !result[key]!.includes(resolve(path)))
            result[key]!.push(resolve(path));
    }
  if (writeCache) {
    const path = join(userDataDir, 'chat-stores.json'),
      temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, stores: result }));
    await rename(temporary, path);
  }
  return result;
}
export async function chatDataRoots(processName: string, userDataDir: string): Promise<string[]> {
  const key = storeKey(processName);
  if (!key) return [];
  let cached: Json = {};
  try {
    cached = record(JSON.parse(await readFile(join(userDataDir, 'chat-stores.json'), 'utf8')));
  } catch {}
  const roots = await existing(array<string>(record(cached.stores)[key]));
  return roots.length ? roots : ((await discoverChatStores(userDataDir))[key] ?? []);
}
export async function locateChatFile(
  processName: string,
  filename: string,
  userDataDir: string,
  explicitRoots?: string[],
): Promise<string[]> {
  if (!looksLikeFilename(filename)) return [];
  const roots = explicitRoots ?? (await chatDataRoots(processName, userDataDir)),
    found = new Set<string>();
  for (const root of roots) {
    const accounts = (await directories(root)).sort().reverse();
    for (const account of accounts)
      for (const relative of ['msg/file', 'FileStorage/File', '']) {
        const base = relative ? join(account, relative) : account,
          buckets = (await directories(base)).sort().reverse().slice(0, 18);
        for (const bucket of buckets) {
          const path = join(bucket, filename);
          try {
            if ((await stat(path)).isFile()) found.add(resolve(path));
          } catch {}
        }
      }
  }
  return [...found];
}
