'use strict';

/* exported SlashTrigger */

const SlashTrigger = (() => {
  const TRAILING_TOKEN = /(?:^|\s)\/([a-zA-Z0-9_-]*)$/;

  function detectSlashToken(textBeforeCaret: string): string | null {
    const match = TRAILING_TOKEN.exec(String(textBeforeCaret || ''));
    return match ? match[1].toLowerCase() : null;
  }

  return {detectSlashToken};
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SlashTrigger;
}
