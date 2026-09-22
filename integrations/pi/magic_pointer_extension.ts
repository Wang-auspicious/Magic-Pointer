import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function magicPointerExtension(pi: ExtensionAPI) {
  pi.registerCommand('pointer', {
    description: 'Deliver a reviewed Magic Pointer prompt file: /pointer "absolute path to prompt.md"',
    handler: async (args, ctx) => {
      const input = args.trim().replace(/^"([\s\S]*)"$/, '$1');
      if (!input || !path.isAbsolute(input)) {
        ctx.ui.notify('请先在 Magic Pointer 中准备并审阅提示词，再输入 /pointer "提示词文件的绝对路径"。', 'warning');
        return;
      }
      try {
        const prompt = await fs.readFile(input, 'utf8');
        if (!prompt.trim()) throw new Error('提示词文件为空。');
        pi.sendUserMessage(prompt);
      } catch (error) {
        ctx.ui.notify(`无法读取提示词文件：${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
  });
}
