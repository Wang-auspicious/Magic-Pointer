import { requestText, type ModelConfig, type TextRequest } from './model';

const length = (text: string) => Array.from(text).length;

export function cleanReplacementText(answer: string): string {
  let text = answer.trim();
  const fence = /```(?:\w+)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1].trim();
  for (const prefix of ['Replacement:', 'Rewritten:', '改写如下：', '改写如下:', '替换文本：', '替换文本:']) {
    if (text.startsWith(prefix)) text = text.slice(prefix.length).trim();
  }
  const split = text.indexOf('\n');
  if (split >= 0) {
    const head = text.slice(0, split).trim();
    const rest = text.slice(split + 1).trim();
    if (/[:：]$/.test(head) && length(head) <= 40 && rest && /好的|以下是|如下|这是|改写后|压缩后|扩写后|翻译后|结果|here is|here's|sure|rewritten/i.test(head)) text = rest;
  }
  return text;
}

export async function expandPassage(passage: string, context: string, config: ModelConfig, options: Pick<TextRequest, 'fetch' | 'signal' | 'healthFile'> = {}) {
  const started = performance.now();
  const fail = (error: string) => ({ ok: false, prompt: '展开讲讲', error, usedBackend: config.model, latencyMs: performance.now() - started, sourceChars: undefined, resultChars: undefined });
  const source = passage.trim();
  const sourceChars = length(source);
  if (!sourceChars) return fail('没有选中任何文字。');
  if (sourceChars < 8) return fail('选中的太短了，展开它只会变成重写。多选一点再点。');
  if (sourceChars > 4000) return fail(`选中了 ${sourceChars} 字，一次最多展开 4000 字。分几段来。`);
  let wanted = Math.min(1600, Math.max(1, Math.round(sourceChars * 2.4)));
  if (wanted <= sourceChars) wanted = sourceChars + Math.max(60, Math.floor(sourceChars / 5));
  const surrounding = Array.from(context.trim()).slice(0, 3000).join('');
  try {
    const result = await requestText(config, { ...options, timeoutMs: 45_000, attempts: 1,
      prompt: `把下面这段文字扩写到大约 ${wanted} 个字。补充的内容必须来自原文已有的意思——展开论证、补足省略的步骤、把概括写具体，不要引入原文没有的事实、数字、人名或来源。\n额外要求：这段话是一整段回答里的一小截，展开后要能原样嵌回原处：不要加开场白、不要加总结句、不要重复前后文已经说过的结论。\n只输出替换后的文字本身。不要前言，不要“好的”“以下是”，不要标题、引号、markdown 或任何解释。保持原文的语言和段落结构。`,
      context: `${surrounding ? `这段话所在的整段回答（只作参考，不要改写它）：\n${surrounding}\n\n` : ''}原文：\n${source}`,
      system: '你把一段话展开讲得更细。只输出展开后的那段话本身，不要任何解释。补充的内容必须来自原文已有的意思，不要引入原文没有的事实、数字或来源。' });
    const text = cleanReplacementText(result.text);
    const resultChars = length(text);
    if (!text || text.startsWith('AI 调用失败')) return fail(text || '模型没有返回内容，那一段没有被改动。');
    if (resultChars <= sourceChars) return fail('这次没能展开得更细（回来的比原文还短），那一段保持原样。');
    return { ok: true, prompt: '展开讲讲', text, sourceChars, resultChars, usedBackend: result.usedBackend, latencyMs: result.latencyMs };
  } catch (error) { return fail(`AI 调用失败：${error instanceof Error ? error.message : String(error)}`); }
}
