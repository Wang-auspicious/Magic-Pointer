'use strict';

/* 首帧前解析系统/已保存主题(原 studio.html 内联脚本外置:
   页面 CSP 为 script-src 'self',内联块会被拦,行为必须与原先逐字一致)。 */
(() => {
  try {
    const saved = localStorage.getItem('mp:theme');
    const theme = saved === 'light' || saved === 'dark'
      ? saved
      : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
  } catch (_) {
    document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
})();
