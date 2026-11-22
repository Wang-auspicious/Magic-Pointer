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

export interface VaultSearchHit {
  entryId: string;
  title: string;
  relativePath: string;
  folder: string;
  tags: string[];
  backlinks: string[];
  excerpt: string;
  score: number;
  source: 'knowledge_vault';
}

export function searchKnowledgeVault(
  vaultDir: string,
  query: string,
  limit = 10,
): VaultSearchHit[] {
  const overview = scanKnowledgeVault(vaultDir);
  const notes = overview.notes;
  if (!notes.length) {
    return [];
  }
  const rawQuery = String(query || '').trim().toLowerCase();
  const terms = Array.from(
    new Set(
      rawQuery
        .split(/[\s,，。；;、()（）《》「」"'/]+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2),
    ),
  );
  // Extract substrings/pairs from longer CJK chunks for resilient fuzzy matching
  const subTerms = new Set<string>(terms);
  for (const term of terms) {
    if (/^[\u4e00-\u9fff]{3,}$/.test(term)) {
      for (let i = 0; i <= term.length - 2; i++) {
        subTerms.add(term.slice(i, i + 2));
      }
    }
  }
  const normalizedRoot = overview.vaultDir;
  const maxResults = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
  const scored: VaultSearchHit[] = [];
  for (const note of notes) {
    const titleLower = note.title.toLowerCase();
    const tagsLower = note.tags.map(t => t.toLowerCase()).join(' ');
    let contentLower = '';
    try {
      contentLower = fs.readFileSync(note.filePath, 'utf8').toLowerCase();
    } catch {
      contentLower = note.excerpt.toLowerCase();
    }
    let score = 0;
    if (!rawQuery) {
      score = 1;
    } else {
      if (titleLower.includes(rawQuery)) {
        score += 40;
      }
      if (contentLower.includes(rawQuery)) {
        score += 20;
      }
      for (const term of terms) {
        if (titleLower.includes(term)) {
          score += 18;
        }
        if (tagsLower.includes(term)) {
          score += 10;
        }
        if (contentLower.includes(term)) {
          score += 6;
        }
      }
      if (score === 0) {
        for (const sub of subTerms) {
          if (titleLower.includes(sub)) {
            score += 5;
          } else if (contentLower.includes(sub)) {
            score += 2;
          }
        }
      }
    }
    if (score > 0 && note.filePath.startsWith(normalizedRoot)) {
      scored.push({
        entryId: `vault:${note.relativePath}`,
        title: note.title,
        relativePath: note.relativePath,
        folder: note.folder,
        tags: note.tags,
        backlinks: note.backlinks,
        excerpt: note.excerpt,
        score,
        source: 'knowledge_vault',
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return scored.slice(0, maxResults);
}

export function readVaultNote(
  vaultDir: string,
  relativeOrFilePath: string,
): {
  ok: boolean;
  error?: string;
  title?: string;
  relativePath?: string;
  filePath?: string;
  content?: string;
  source?: string;
  tags?: string[];
  links?: string[];
  backlinks?: string[];
} {
  const normalizedRoot = path.resolve(String(vaultDir || ''));
  const rawTarget = String(relativeOrFilePath || '').trim();
  if (!normalizedRoot || !rawTarget) {
    return {ok: false, error: 'vault_target_missing'};
  }
  const overview = scanKnowledgeVault(normalizedRoot);
  const candidate = path.isAbsolute(rawTarget)
    ? path.resolve(rawTarget)
    : path.resolve(normalizedRoot, rawTarget.replace(/^[/\\]+/, ''));
  const resolved =
    candidate === normalizedRoot || candidate.startsWith(normalizedRoot + path.sep)
      ? candidate
      : '';
  const matched =
    (resolved
      ? overview.notes.find(n => path.resolve(n.filePath) === resolved)
      : undefined) ??
    overview.notes.find(
      n =>
        n.relativePath.toLowerCase() === rawTarget.toLowerCase() ||
        n.title.toLowerCase() === rawTarget.toLowerCase(),
    );
  const filePath = matched?.filePath || (resolved && fs.existsSync(resolved) ? resolved : '');
  if (!filePath || !filePath.startsWith(normalizedRoot + path.sep)) {
    return {ok: false, error: 'vault_note_not_found'};
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const {body} = parseFrontmatter(raw);
    const relativePath =
      matched?.relativePath ||
      path.relative(normalizedRoot, filePath).replace(/\\/g, '/');
    return {
      ok: true,
      title: matched?.title || path.basename(filePath, path.extname(filePath)),
      relativePath,
      filePath,
      content: body.trim() || raw.trim(),
      source: matched?.source || '',
      tags: matched?.tags || [],
      links: matched?.links || extractWikilinks(body),
      backlinks: matched?.backlinks || [],
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function appendVaultTodo(
  vaultDir: string,
  input: {
    text: string;
    title?: string;
    sourceUrl?: string;
    relatedLink?: string;
  },
): {ok: boolean; filePath: string; appended: boolean; error?: string} {
  const normalizedRoot = path.resolve(String(vaultDir || ''));
  const cleanText = String(input.text || '')
    .replace(/\r?\n/g, ' ')
    .trim();
  if (!normalizedRoot || !cleanText) {
    return {
      ok: false,
      filePath: '',
      appended: false,
      error: 'todo_text_missing',
    };
  }
  fs.mkdirSync(normalizedRoot, {recursive: true});
  const filePath = path.join(normalizedRoot, 'LEARNING_TODOS.md');
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : '# 学习待办\n\n';
  const existingOpenNormalized = new Set(
    existing
      .split(/\r?\n/)
      .map(
        line => line.match(/^\s*[-*]\s+\[\s\]\s+(.+)$/)?.[1]?.trim() || '',
      )
      .filter(Boolean)
      .map(entry => entry.replace(/\s*·\s*(?:\[\[|https?:).*$/, '').trim()),
  );
  if (existingOpenNormalized.has(cleanText)) {
    return {ok: true, filePath, appended: false};
  }
  const suffixParts: string[] = [];
  if (input.relatedLink?.trim()) {
    suffixParts.push(`[[${input.relatedLink.trim()}]]`);
  } else if (input.title?.trim()) {
    suffixParts.push(`[[${input.title.trim()}]]`);
  }
  if (input.sourceUrl?.trim()) {
    suffixParts.push(input.sourceUrl.trim());
  }
  const line = `- [ ] ${cleanText}${
    suffixParts.length ? ` · ${suffixParts.join(' · ')}` : ''
  }`;
  const prefix =
    existing.endsWith('\n') || existing.length === 0 ? existing : `${existing}\n`;
  fs.writeFileSync(filePath, `${prefix}${line}\n`, 'utf8');
  return {ok: true, filePath, appended: true};
}
