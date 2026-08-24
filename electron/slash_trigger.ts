'use strict';

/* exported SlashTrigger */
// DSH input-trigger 的 detect 层：光标前文本是否构成一个未提交的斜杠
// token。渲染层在 textarea 的 input/keydown 里调用，决定开合菜单与过滤。

const SlashTrigger = (() => {
  const TRAILING_TOKEN = /(?:^|\s)\/([a-zA-Z0-9-]*)$/;

  /** 返回 token（小写）；不触发时返回 null；裸 "/" 返回空串（全量目录）。 */
  function detectSlashToken(textBeforeCaret: string): string | null {
    const match = TRAILING_TOKEN.exec(String(textBeforeCaret || ''));
    return match ? match[1].toLowerCase() : null;
  }

  return { detectSlashToken };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SlashTrigger;
}
