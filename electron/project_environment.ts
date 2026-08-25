'use strict';

import path from 'node:path';

interface ProjectEnvironmentInput {
  root: string;
  branchOutput?: string;
  numstatOutput?: string;
  remoteUrl?: string;
}

interface ProjectEnvironment {
  root: string;
  name: string;
  isGit: boolean;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  changedFiles: number;
  fileChanges: Array<{ path: string; status: string; staged: boolean }>;
  addedLines: number;
  deletedLines: number;
  remoteUrl: string;
  pullRequestUrl: string;
}

function normalizeGitRemoteUrl(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const scp = raw.match(/^git@([^:]+):(.+)$/i);
  if (scp) return `https://${scp[1]}/${scp[2].replace(/\.git$/i, '')}`;
  const ssh = raw.match(/^ssh:\/\/(?:git@)?([^/]+)\/(.+)$/i);
  if (ssh) return `https://${ssh[1]}/${ssh[2].replace(/\.git$/i, '')}`;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\.git\/?$/i, '').replace(/\/$/, '');
    return parsed.toString().replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

function githubPullRequestUrl(remoteValue: string, branchValue: string): string {
  const remote = normalizeGitRemoteUrl(remoteValue);
  const branch = String(branchValue || '').trim();
  if (!remote || !branch) return '';
  try {
    const parsed = new URL(remote);
    if (parsed.hostname.toLowerCase() !== 'github.com') return '';
    const repository = parsed.pathname.replace(/^\//, '').replace(/\/$/, '');
    if (repository.split('/').length !== 2) return '';
    return `https://github.com/${repository}/compare/${encodeURIComponent(branch)}?expand=1`;
  } catch (_) {
    return '';
  }
}

function parseGitEnvironment(input: ProjectEnvironmentInput): ProjectEnvironment {
  const root = path.resolve(String(input.root || ''));
  const lines = String(input.branchOutput || '').split(/\r?\n/).filter(Boolean);
  const header = lines[0]?.replace(/^##\s*/, '') || '';
  const branchPart = header.split('...')[0]?.replace(/^No commits yet on\s+/, '').trim() || '';
  const upstreamMatch = header.match(/\.\.\.([^\s[]+)/);
  const aheadMatch = header.match(/ahead\s+(\d+)/);
  const behindMatch = header.match(/behind\s+(\d+)/);
  let addedLines = 0;
  let deletedLines = 0;
  for (const line of String(input.numstatOutput || '').split(/\r?\n/)) {
    const [added, deleted] = line.split('\t');
    if (/^\d+$/.test(added || '')) addedLines += Number(added);
    if (/^\d+$/.test(deleted || '')) deletedLines += Number(deleted);
  }
  const remoteUrl = normalizeGitRemoteUrl(String(input.remoteUrl || ''));
  const fileChanges = lines.slice(header ? 1 : 0).map((line) => {
    const x = line[0] || ' ';
    const y = line[1] || ' ';
    const rawPath = line.slice(3).trim();
    const changedPath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() || rawPath : rawPath;
    const status = x === '?' && y === '?' ? '?' : `${x}${y}`.trim();
    return { path: changedPath.replace(/^"|"$/g, ''), status, staged: x !== ' ' && x !== '?' };
  }).filter((entry) => entry.path).slice(0, 200);
  return {
    root,
    name: path.basename(root),
    isGit: Boolean(header || remoteUrl),
    branch: branchPart,
    upstream: upstreamMatch?.[1] || '',
    ahead: Number(aheadMatch?.[1] || 0),
    behind: Number(behindMatch?.[1] || 0),
    changedFiles: fileChanges.length,
    fileChanges,
    addedLines,
    deletedLines,
    remoteUrl,
    pullRequestUrl: githubPullRequestUrl(remoteUrl, branchPart),
  };
}

function sourceLinksFromConversation(value: unknown, maxLinks = 12): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const queue: unknown[] = [value];
  let visited = 0;
  while (queue.length && found.length < maxLinks && visited < 2000) {
    const current = queue.shift();
    visited += 1;
    if (typeof current === 'string') {
      for (const match of current.matchAll(/https?:\/\/[^\s<>"'\])}]+/gi)) {
        const candidate = String(match[0] || '').replace(/[.,;:!?]+$/, '');
        try {
          const parsed = new URL(candidate);
          if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !seen.has(parsed.href)) {
            seen.add(parsed.href);
            found.push(parsed.href.replace(/\/$/, ''));
          }
        } catch (_) {}
        if (found.length >= maxLinks) break;
      }
    } else if (Array.isArray(current)) {
      queue.push(...current);
    } else if (current && typeof current === 'object') {
      queue.push(...Object.values(current as Record<string, unknown>));
    }
  }
  return found;
}

export {
  githubPullRequestUrl,
  normalizeGitRemoteUrl,
  parseGitEnvironment,
  sourceLinksFromConversation,
};
export type { ProjectEnvironment, ProjectEnvironmentInput };
