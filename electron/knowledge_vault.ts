'use strict';

import fs from 'node:fs';
import path from 'node:path';

export interface VaultTodoItem {
  filePath: string;
  noteTitle: string;
  lineIndex: number;
  text: string;
  done: boolean;
}

export interface VaultNoteSummary {
  filePath: string;
  relativePath: string;
  title: string;
  folder: string;
  source: string;
  tags: string[];
  links: string[];
  backlinks: string[];
  excerpt: string;
  updatedAt: number;
}

export interface VaultTagCount {
  tag: string;
  count: number;
}

export interface VaultOverview {
  vaultDir: string;
  notes: VaultNoteSummary[];
  tags: VaultTagCount[];
  todos: VaultTodoItem[];
}

const IGNORED_DIRS = new Set([
  '.obsidian',
  '.git',
  '.trash',
  'node_modules',
  '.gemini',
]);

function safeFilename(title: string): string {
  const cleaned = String(title || 'Untitled')
    .replace(/[<>:"/\\|?*\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
  return cleaned || 'Untitled';
}

function parseFrontmatter(content: string): {
  meta: Record<string, string | string[]>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) {
    return {meta: {}, body: content};
  }
  const meta: Record<string, string | string[]> = {};
  const lines = match[1].split(/\r?\n/);
  let currentArrayKey = '';
  for (const line of lines) {
    const arrItem = /^\s*-\s+(.+)$/.exec(line);
    if (arrItem && currentArrayKey) {
      const existing = Array.isArray(meta[currentArrayKey])
        ? (meta[currentArrayKey] as string[])
        : [];
      existing.push(arrItem[1].trim().replace(/^["']|["']$/g, ''));
      meta[currentArrayKey] = existing;
      continue;
    }
    currentArrayKey = '';
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) {
      continue;
    }
    const key = kv[1].trim();
    const rawVal = kv[2].trim();
    if (!rawVal) {
      meta[key] = [];
      currentArrayKey = key;
    } else if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      meta[key] = rawVal
        .slice(1, -1)
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      meta[key] = rawVal.replace(/^["']|["']$/g, '');
    }
  }
  return {meta, body: match[2]};
}

function extractWikilinks(text: string): string[] {
  const found = new Set<string>();
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].split('|')[0].split('#')[0].trim();
    if (raw) {
      found.add(raw);
    }
  }
  return Array.from(found);
}

function extractInlineTags(text: string): string[] {
  const found = new Set<string>();
  const re = /(?:^|\s)#([A-Za-z0-9_\-\u4e00-\u9fff/]{1,48})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) {
      found.add(m[1]);
    }
  }
  return Array.from(found);
}

function collectMarkdownFiles(
  rootDir: string,
  dir: string,
  out: string[],
  limit = 500,
): void {
  if (out.length >= limit || !fs.existsSync(dir)) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, {withFileTypes: true});
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) {
      return;
    }
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      collectMarkdownFiles(rootDir, path.join(dir, entry.name), out, limit);
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
}

export function scanKnowledgeVault(vaultDir: string): VaultOverview {
  const normalizedRoot = path.resolve(String(vaultDir || ''));
  if (!normalizedRoot || !fs.existsSync(normalizedRoot)) {
    return {vaultDir: normalizedRoot, notes: [], tags: [], todos: []};
  }
  const files: string[] = [];
  collectMarkdownFiles(normalizedRoot, normalizedRoot, files, 500);

  const notes: VaultNoteSummary[] = [];
  const todos: VaultTodoItem[] = [];
  const tagCounts = new Map<string, number>();

  for (const filePath of files) {
    let raw = '';
    let mtimeMs = 0;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    const {meta, body} = parseFrontmatter(raw);
    const relativePath = path
      .relative(normalizedRoot, filePath)
      .replace(/\\/g, '/');
    const folder = path.dirname(relativePath) === '.' ? '' : path.dirname(relativePath);
    const baseTitle = path.basename(filePath, path.extname(filePath));
    const title =
      typeof meta.title === 'string' && meta.title.trim()
        ? meta.title.trim()
        : baseTitle;
    const source = typeof meta.source === 'string' ? meta.source.trim() : '';

    const fmTags = Array.isArray(meta.tags)
      ? meta.tags
      : typeof meta.tags === 'string' && meta.tags
        ? [meta.tags]
        : [];
    const tags = Array.from(new Set([...fmTags, ...extractInlineTags(body)]));
    for (const tag of tags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }

    const links = extractWikilinks(body);
    const allLines = raw.split(/\r?\n/);
    for (let i = 0; i < allLines.length; i++) {
      const todoMatch = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(allLines[i]);
      if (todoMatch) {
        todos.push({
          filePath,
          noteTitle: title,
          lineIndex: i,
          text: todoMatch[2].trim(),
          done: todoMatch[1].toLowerCase() === 'x',
        });
      }
    }

    const excerpt = body
      .replace(/```[\s\S]*?```/g, '')
      .replace(/[#>*`[\]]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);

    notes.push({
      filePath,
      relativePath,
      title,
      folder,
      source,
      tags,
      links,
      backlinks: [],
      excerpt,
      updatedAt: mtimeMs,
    });
  }

  // Compute bidirectional Obsidian [[wikilink]] backlinks
  const noteByKey = new Map<string, VaultNoteSummary>();
  for (const note of notes) {
    noteByKey.set(note.title.toLowerCase(), note);
    const base = path.basename(note.relativePath, '.md').toLowerCase();
    noteByKey.set(base, note);
  }
  for (const note of notes) {
    for (const linkTarget of note.links) {
      const target = noteByKey.get(linkTarget.toLowerCase());
      if (target && target !== note && !target.backlinks.includes(note.title)) {
        target.backlinks.push(note.title);
      }
    }
  }

  notes.sort((a, b) => b.updatedAt - a.updatedAt);
  const tags: VaultTagCount[] = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({tag, count}))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  return {vaultDir: normalizedRoot, notes, tags, todos};
}

export function saveVaultNote(
  vaultDir: string,
  input: {
    title: string;
    folder?: string;
    tags?: readonly string[];
    source?: string;
    body: string;
  },
): {ok: boolean; filePath: string; relativePath: string} {
  const normalizedRoot = path.resolve(String(vaultDir || ''));
  const subFolder = String(input.folder || '')
    .replace(/\.\./g, '')
    .replace(/^[/\\]+|[/\\]+$/g, '');
  const targetDir = subFolder
    ? path.join(normalizedRoot, subFolder)
    : normalizedRoot;
  fs.mkdirSync(targetDir, {recursive: true});

  const fileName = `${safeFilename(input.title)}.md`;
  const filePath = path.join(targetDir, fileName);
  const cleanTags = (input.tags || [])
    .map(t => String(t).replace(/^#/, '').trim())
    .filter(Boolean);
  const frontmatterLines = [
    '---',
    `title: "${String(input.title || 'Untitled').replace(/"/g, '\\"')}"`,
    ...(input.source
      ? [`source: "${String(input.source).replace(/"/g, '\\"')}"`]
      : []),
    ...(cleanTags.length ? [`tags: [${cleanTags.join(', ')}]`] : []),
    `created: ${new Date().toISOString()}`,
    '---',
    '',
  ];
  const fullContent = `${frontmatterLines.join('\n')}${String(input.body || '').trim()}\n`;
  fs.writeFileSync(filePath, fullContent, 'utf8');
  return {
    ok: true,
    filePath,
    relativePath: path.relative(normalizedRoot, filePath).replace(/\\/g, '/'),
  };
}

export function toggleVaultTodo(
  vaultDir: string,
  filePath: string,
  lineIndex: number,
  done: boolean,
): {ok: boolean; error?: string} {
  const normalizedRoot = path.resolve(String(vaultDir || ''));
  const resolvedFile = path.resolve(String(filePath || ''));
  if (!resolvedFile.startsWith(normalizedRoot) || !fs.existsSync(resolvedFile)) {
    return {ok: false, error: 'vault_file_not_found'};
  }
  const raw = fs.readFileSync(resolvedFile, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  if (lineIndex < 0 || lineIndex >= lines.length) {
    return {ok: false, error: 'invalid_todo_line'};
  }
  const updated = lines[lineIndex].replace(
    /^(\s*[-*]\s+\[)[ xX](\]\s+)/,
    `$1${done ? 'x' : ' '}$2`,
  );
  if (updated === lines[lineIndex]) {
    return {ok: false, error: 'line_is_not_todo'};
  }
  lines[lineIndex] = updated;
  fs.writeFileSync(resolvedFile, lines.join(eol), 'utf8');
  return {ok: true};
}
