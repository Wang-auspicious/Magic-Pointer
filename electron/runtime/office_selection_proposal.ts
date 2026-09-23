import { createHash, randomUUID } from 'node:crypto';
import { win32 } from 'node:path';

type Data = Record<string, any>;

export interface WordSelection {
  context: Data;
  artifacts: Data;
  original: string;
  document: string;
  documentName: string;
  hwnd: number;
  start: number;
  end: number;
  beforeHash: string;
  sourceWindowTitle: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const excerpt = (value: string) => value.length <= 700 ? value : `${value.slice(0, 700)}...`;

function wantsWordRewrite(command: string): boolean {
  const text = command.trim().toLowerCase();
  if (!text || text.startsWith('/')) return false;
  const externalWrite = /(?:写入|写进|写到|发送到|发到|复制到|粘贴到)[^，。,.；;]{0,20}(?:邮件|邮箱|微信|聊天|消息|剪贴板|另(?:一|个|份)|其他|别的|新文件|新文档)/.test(text)
    || /\b(?:write|paste|copy|send)\b.{0,20}\b(?:email|message|another file|another document|clipboard)\b/i.test(text);
  if (externalWrite) return false;
  const writeBack = /替换|写回(?:到)?(?:原文|原处|选区|当前|本|该|word|文档)|写回(?=$|[，。,.；;！!？?\s])|(?:写入|写进)(?:当前|本|该|原文|原处|选区)|回填|覆盖(?:原文|选区|选中文字)|改成|改为|变成|变为|\breplace\b|write\s*back|\boverwrite\b|\bchange\s+(?:it\s+)?to\b/i.test(text);
  if (!writeBack && (/^(?:请|帮我)?(?:解释|说明|分析|总结|概括|摘要|回答|告诉我|怎么|如何|为什么|为何)/.test(text) || /^(?:explain|summarize|describe|what|why|how)\b/.test(text) || /建议|思路|方案|\bsuggestions?\b|\badvice\b/.test(text))) return false;
  const rewrite = /润色|改写|重写|修订|修改|优化|精简|压缩|扩写|缩短|修正|纠错|更正式|更口语|\bpolish\b|\brewrite\b|\brephrase\b|\bshorten\b|\bexpand\b|fix grammar|make it (?:more )?(?:formal|friendly|concise|clear)/i.test(text);
  return rewrite || writeBack;
}

export function wordSelectionForRewrite(snapshot: Data, command: string): WordSelection | null {
  if (!wantsWordRewrite(command)) return null;
  const context = snapshot.context || {}, artifacts = context.artifacts || {}, trace = snapshot.perception_trace || {};
  if (snapshot.status !== 'ok' || snapshot.structured_covers_mark !== true || trace.selectedAdapter !== 'office' || trace.liveIdentityMatched !== true || snapshot.conflicts?.length || trace.conflicts?.length) return null;
  if (context.adapter !== 'office' || context.app !== 'word' || context.error) return null;
  const original = String(context.content || ''), document = String(artifacts.document || ''), documentName = String(artifacts.document_name || '');
  const hwnd = Number(artifacts.hwnd), start = Number(artifacts.selection_start), end = Number(artifacts.selection_end);
  const suppliedHash = String(artifacts.selection_text_sha256 || ''), beforeHash = sha256(original);
  if (!original.trim() || !document || !documentName || !Number.isSafeInteger(hwnd) || hwnd <= 0 || artifacts.selection_start == null || artifacts.selection_end == null || String(artifacts.selection_start).trim() === '' || String(artifacts.selection_end).trim() === '' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null;
  if (Number(context.window?.hwnd) !== hwnd || Number(snapshot.source_window?.hwnd) !== hwnd || suppliedHash && suppliedHash !== beforeHash) return null;
  if (!['Word.Application', 'KWPS.Application', 'wps.Application'].includes(String(artifacts.com_prog_id || ''))) return null;
  return { context, artifacts, original, document, documentName, hwnd, start, end, beforeHash, sourceWindowTitle: String(snapshot.source_window.title || '') };
}

export function cleanWordReplacement(answer: string): string {
  let text = answer.trim();
  const fence = /```(?:\w+)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1].trim();
  for (const prefix of ['Replacement:', 'Rewritten:', '改写如下：', '改写如下:', '替换文本：', '替换文本:']) {
    if (text.startsWith(prefix)) { text = text.slice(prefix.length).trim(); break; }
  }
  const [head, rest] = text.split('\n', 2);
  if (rest?.trim() && head.length <= 40 && /[：:]$/.test(head.trim()) && /好的|以下是|如下|这是|改写后|压缩后|扩写后|翻译后|结果|here is|here's|sure|rewritten/i.test(head)) text = text.slice(head.length + 1).trim();
  return text;
}

export function makeWordReplaceSelectionProposal(selection: WordSelection, command: string, replacement: string, selectionSessionId?: string | null, selectionSnapshotId?: string | null): Data | null {
  if (!replacement.trim() || replacement === selection.original) return null;
  const afterHash = sha256(replacement), beforeExcerpt = excerpt(selection.original), afterExcerpt = excerpt(replacement);
  const common = { app: 'word', document: selection.document, document_name: selection.documentName, hwnd: selection.hwnd,
    selection_start: selection.start, selection_end: selection.end, expected_text_sha256: selection.beforeHash,
    office_host: selection.artifacts.host, com_prog_id: selection.artifacts.com_prog_id,
    selection_session_id: selectionSessionId || null, selection_snapshot_id: selectionSnapshotId || null,
    source_window_title: selection.sourceWindowTitle };
  return {
    id: `word-replace-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    action_type: 'office_replace_selection',
    target: { object_id: null, selection_id: selectionSnapshotId || null, point: null, bbox: null,
      description: `Word selection in ${win32.basename(selection.document)}`, metadata: common },
    parameters: { ...common, selection_type: selection.artifacts.selection_type, expected_text_excerpt: beforeExcerpt,
      replacement_text: replacement, replacement_text_sha256: afterHash, replacement_text_excerpt: afterExcerpt, command },
    safety_level: 'high', confirmation_required: true,
    rationale: 'Replace the current Word selection only if the document and selection still match the preview.',
    metadata: { ...common, adapter: selection.context.adapter, method: selection.context.method,
      replacement_text_sha256: afterHash },
  };
}
