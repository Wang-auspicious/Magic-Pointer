import { stat, readFile, readlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { runPowerShellJson, runProcess } from './desktop';
import { record } from './context';
type Json = Record<string, any>;
async function directory(value: unknown): Promise<string> {
  const text = String(value ?? '')
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/^~(?=[\\/]|$)/, homedir());
  if (!text) return '';
  const path = resolve(text);
  try {
    return (await stat(path)).isDirectory() ? path : '';
  } catch {
    return '';
  }
}
async function gitRoot(cwd: string): Promise<string> {
  try {
    return await directory(
      (
        await runProcess('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 2500 })
      ).trim(),
    );
  } catch {
    return '';
  }
}
async function gitText(cwd: string, ...args: string[]): Promise<string> {
  try { return (await runProcess('git', ['-C', cwd, ...args], { timeoutMs: 2500 })).replace(/\s+$/, ''); } catch { return ''; }
}
/** What the repository looks like right now: the context a coding agent needs before touching files. */
export async function probeGitWorkspace(cwd: string): Promise<Json> {
  const resolved = (await directory(cwd)) || process.cwd(), repoRoot = await gitRoot(resolved);
  if (!repoRoot) return { cwd: resolved, repoRoot: '', branch: '', head: '', isDirty: false, changedFiles: [], diffStat: '', diffExcerpt: '' };
  const [branch, head, status, stat, staged, diff, stagedDiff] = await Promise.all([
    gitText(resolved, 'branch', '--show-current'), gitText(resolved, 'rev-parse', '--short=12', 'HEAD'),
    gitText(resolved, 'status', '--porcelain=v1', '--untracked-files=normal'),
    gitText(resolved, 'diff', '--stat', '--', '.'), gitText(resolved, 'diff', '--cached', '--stat', '--', '.'),
    gitText(resolved, 'diff', '--no-ext-diff', '--unified=3', '--', '.'), gitText(resolved, 'diff', '--cached', '--no-ext-diff', '--unified=3', '--', '.'),
  ]);
  const changedFiles = [...new Set(status.split(/\r?\n/).map(line => line.slice(3).trim()).map(path => path.includes(' -> ') ? path.split(' -> ')[1]! : path).map(path => path.replace(/^"|"$/g, '')).filter(Boolean))].slice(0, 80);
  return { cwd: resolved, repoRoot, branch: branch.slice(0, 240), head: head.slice(0, 40), isDirty: !!status, changedFiles,
    diffStat: [stat, staged].filter(Boolean).join('\n').slice(0, 6000), diffExcerpt: [diff, stagedDiff].filter(Boolean).join('\n').slice(0, 6000) };
}
export function redactLaunchCommand(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(
      /(--?(?:api[-_]?key|token|secret|password|passwd|authorization|credential))(=|\s+)("[^"]*"|'[^']*'|\S+)/gi,
      '$1$2[redacted]',
    )
    .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL))=\S+/gi, '$1=[redacted]')
    .replace(/(https?:\/\/[^\s/:]+):[^\s/@]+@/gi, '$1:[redacted]@')
    .trim()
    .slice(0, 2000);
}
async function commandDirectories(command: string): Promise<string[]> {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [],
    result = new Set<string>();
  for (let index = 0; index < Math.min(128, tokens.length); index++) {
    const token = tokens[index]!.replace(/^['"]|['"]$/g, '');
    let value = '';
    if (['-C', '--cwd', '--cd', '--directory'].includes(token))
      value = await directory(tokens[index + 1]);
    else if (/^--(?:cwd|cd|directory)=/.test(token))
      value = await directory(token.slice(token.indexOf('=') + 1));
    else if (isAbsolute(token)) {
      try {
        const info = await stat(token);
        value = info.isDirectory() ? resolve(token) : dirname(resolve(token));
      } catch {}
    }
    if (value) result.add(value);
  }
  return [...result];
}
const currentDirectoryNative = String.raw`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MpProcessDirectory {
 [StructLayout(LayoutKind.Sequential)] struct BasicInfo { public IntPtr Reserved; public IntPtr Peb; public IntPtr R1; public IntPtr R2; public IntPtr Pid; public IntPtr R3; }
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access,bool inherit,int pid);
 [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr process,IntPtr address,byte[] buffer,int size,out IntPtr read);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr handle,out bool value);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle,int kind,ref BasicInfo info,int size,out int read);
 static byte[] Read(IntPtr handle,long address,int count) { var bytes=new byte[count]; IntPtr read; return ReadProcessMemory(handle,new IntPtr(address),bytes,count,out read)&&read.ToInt64()==count?bytes:null; }
 public static string Get(int pid) { if(IntPtr.Size!=8)return ""; var handle=OpenProcess(0x0410,false,pid); if(handle==IntPtr.Zero)return ""; try { bool wow; if(IsWow64Process(handle,out wow)&&wow)return ""; var info=new BasicInfo(); int size; if(NtQueryInformationProcess(handle,0,ref info,Marshal.SizeOf(info),out size)!=0)return ""; var p=Read(handle,info.Peb.ToInt64()+0x20,8); if(p==null)return ""; var data=Read(handle,BitConverter.ToInt64(p,0)+0x38,16); if(data==null)return ""; int count=BitConverter.ToUInt16(data,0); if(count<=0||count>32768)return ""; var text=Read(handle,BitConverter.ToInt64(data,8),count); return text==null?"":Encoding.Unicode.GetString(text); } catch { return ""; } finally { CloseHandle(handle); } }
}
'@
`;
export async function probeWorkspaceProcess(pid: number): Promise<Json | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (pid === process.pid)
    return {
      pid,
      parentPid: process.ppid,
      cwd: process.cwd(),
      executablePath: process.execPath,
      commandLine: process.argv
        .map((value) => (/\s/.test(value) ? JSON.stringify(value) : value))
        .join(' '),
    };
  if (process.platform !== 'win32') {
    try {
      const base = `/proc/${pid}`,
        status = await readFile(`${base}/status`, 'utf8');
      return {
        pid,
        parentPid: Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0),
        cwd: await readlink(`${base}/cwd`),
        executablePath: await readlink(`${base}/exe`),
        commandLine: (await readFile(`${base}/cmdline`, 'utf8')).replace(/\0/g, ' '),
      };
    } catch {
      return null;
    }
  }
  try {
    const value = await runPowerShellJson(
      currentDirectoryNative +
        `$item=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"\nif($item){@{pid=[int]$item.ProcessId;parentPid=[int]$item.ParentProcessId;cwd=[MpProcessDirectory]::Get(${pid});executablePath=[string]$item.ExecutablePath;commandLine=[string]$item.CommandLine}|ConvertTo-Json -Compress}else{@{}|ConvertTo-Json -Compress}`,
      undefined,
      8000,
    );
    return value.pid ? value : null;
  } catch {
    return null;
  }
}
async function listenerProcess(port: number): Promise<number | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    const raw = await runProcess('netstat', ['-ano', '-p', 'tcp'], { timeoutMs: 3000 }),
      matches = raw
        .split(/\r?\n/)
        .map((line) =>
          new RegExp(`^\\s*TCP\\s+\\S*:${port}\\s+\\S+\\s+(\\S+)\\s+(\\d+)\\s*$`, 'i').exec(line),
        )
        .filter((item): item is RegExpExecArray => !!item),
      match =
        matches.find((item) => item[1]!.toLowerCase() === 'listening') ??
        matches.find((item) => item[1]!.toLowerCase() === 'established');
    return match ? Number(match[2]) : null;
  } catch {
    return null;
  }
}
export class RuntimeWorkspaceResolver {
  constructor(
    private processProbe = probeWorkspaceProcess,
    private listenerProbe = listenerProcess,
  ) {}
  async resolve(objects: Json[], fallbackCwd: string): Promise<Json> {
    let targetPid = 0,
      origin = '';
    const documentDirs: string[] = [];
    for (const object of objects) {
      const source = record(object.source);
      targetPid ||= Number(source.processId ?? source.process_id ?? source.pid ?? 0);
      if (source.url && !origin)
        try {
          const url = new URL(String(source.url));
          if (
            url.hostname === 'localhost' ||
            url.hostname === '[::1]' ||
            url.hostname.startsWith('127.')
          )
            origin = `${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`;
        } catch {}
      for (const key of ['documentPath', 'document_path', 'path'])
        if (source[key]) {
          const path = resolve(String(source[key]));
          try {
            if (
              (await stat(path)).isFile() &&
              !['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(extname(path).toLowerCase())
            )
              documentDirs.push(dirname(path));
          } catch {}
        }
    }
    const candidates: { pid: number; relation: string }[] = [],
      listener = origin ? await this.listenerProbe(Number(new URL(origin).port)) : null;
    if (listener) candidates.push({ pid: listener, relation: 'localhost_listener' });
    if (targetPid && targetPid !== listener)
      candidates.push({ pid: targetPid, relation: 'window_process' });
    const bound = (
      process: Json,
      relation: string,
      cwd: string,
      repoRoot: string,
      state = 'bound',
    ): Json => ({
      schemaVersion: 1,
      state,
      relation,
      targetProcessId: targetPid || null,
      workspaceProcessId: process.pid || null,
      cwd,
      repoRoot,
      executablePath: String(process.executablePath ?? '').slice(0, 2000),
      launchCommand: redactLaunchCommand(process.commandLine),
      sourceOrigin: origin,
    });
    let first: Json | undefined;
    const seen = new Set<number>();
    for (const candidate of candidates) {
      let pid = candidate.pid;
      for (let depth = 0; pid > 0 && !seen.has(pid) && depth < 6; depth++) {
        seen.add(pid);
        const process = await this.processProbe(pid);
        if (!process) break;
        const relation = depth ? `${candidate.relation}_parent` : candidate.relation,
          cwd = await directory(process.cwd),
          paths = [
            ...new Set(
              [cwd, ...(await commandDirectories(String(process.commandLine ?? '')))].filter(
                Boolean,
              ),
            ),
          ];
        for (const path of paths) {
          const repo = await gitRoot(path);
          first ??= bound(process, relation, path, '', 'bound_no_repo');
          if (repo) return bound(process, relation, path, repo);
        }
        pid = Number(process.parentPid ?? 0);
      }
    }
    for (const path of documentDirs) {
      const repo = await gitRoot(path);
      if (repo) return bound({}, 'pointed_document', path, repo);
    }
    if (first) return first;
    const cwd = (await directory(fallbackCwd)) || process.cwd();
    return bound({}, 'explicit_cwd_fallback', cwd, await gitRoot(cwd), 'fallback_unverified');
  }
}
