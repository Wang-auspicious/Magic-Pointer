import { stat } from 'node:fs/promises';
import { ActionFailure, type ToolRegistry } from './tools';
import { copyToClipboard } from './fabric';

type Data = Record<string, any>;

export function registerSelectionQuickTools(registry: ToolRegistry, snapshot: Data, copyText = copyToClipboard): void {
  const content = String(snapshot.context?.content ?? snapshot.content ?? '');
  const capturePath = String(snapshot.capture_path || snapshot.frame_lease?.localArtifact?.path || '').trim();
  const window = snapshot.source_window || snapshot.context?.window || {};
  const title = String(window.title || '当前窗口');
  const processName = String(window.process_name || window.processName || '');
  const schema = { type: 'object', properties: {}, required: [] };
  registry.register({ name: 'copy_selected_text', description: '把当前冻结选区的文本复制到剪贴板并读回核对。', input_schema: schema,
    effect: 'reversible_write', deferred: true, is_concurrency_safe: true, resource_keys: ['clipboard'], used_backend: 'windows_forms_clipboard',
    execute: async (_args, context) => {
      if (!content.trim()) throw new ActionFailure('content_changed', '没有可复制的文本内容。');
      await copyText(content, context.signal);
      return { message: `已复制 ${[...content].length} 个字符到剪贴板。`, verification: { matched: true } };
    } });
  registry.register({ name: 'save_screenshot', description: '返回本次冻结选区已保存截图的路径；先核对文件仍存在。', input_schema: schema,
    effect: 'reversible_write', deferred: true, is_concurrency_safe: true, used_backend: 'frozen_capture',
    execute: async () => {
      if (!capturePath || !(await stat(capturePath).then(info => info.isFile() && info.size > 0, () => false)))
        throw new ActionFailure('content_changed', '当前选区没有可保存的截图，或冻结截图文件已丢失。');
      return { message: `选区截图已保存：${capturePath}`, path: capturePath, verification: { matched: true } };
    } });
  registry.register({ name: 'show_source', description: '说明当前冻结选区的来源窗口。', input_schema: schema,
    effect: 'read', deferred: true, is_concurrency_safe: true, used_backend: 'frozen_selection',
    execute: () => `来源：${title}${processName ? `（${processName}）` : ''}` });
}
