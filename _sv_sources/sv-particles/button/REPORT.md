# REPORT — button(sv-particles)

- **来源 URL**
  - 页面: https://sv-particles.vercel.app/particles/button
  - 仓库: https://github.com/SikandarJODD/sv-particles (branch `master`)
  - 原文路径: `src/lib/components/particles/button/*.svelte`(raw.githubusercontent.com 逐字抓取)
  - 提取日期核对: 部署站与 master 同步(页面展示变体名与 data.ts 全部一致);master 最后推送 2026-07-12
- **框架**: SvelteKit + Svelte 5(runes)+ Tailwind CSS v4 + TypeScript;shadcn-svelte 组件体系
- **依赖清单**(组件实际 import)
  - `$lib/components/ui/button`、`$lib/components/ui/badge`、`$lib/components/ui/card`、`$lib/components/ui/spinner`、`$lib/hooks/use-clipboard.svelte` —— shadcn-svelte CLI 生成的本地 UI 层(底座 bits-ui ^2.17.3,工具链 clsx/tailwind-merge/tailwind-variants)
  - `@lucide/svelte ^0.577.0`(图标)、`svelte ^5.55.2`
- **文件清单**(33 个,逐字原文)
  - 变体 ×32:default-button · outline-button · secondary-button · destructive-button · ghost-button · link · extra-small · small · large · disabled-button · icon · small-icon · large-icon · button-with-icon · link-button · show-more-less-toggle · back-link-chevron · card-style-button · direction-pad-controls · outline-like-with-count · qr-code-signin · with-avatar · pill · get-started · print-button · message-notification · cancel-save · animated-status-dot · copy-button · copy-with-feedback · rotating-toggle · hamburger-menu
  - index.ts(统一导出 Button 包装)
- **许可证**: ❌ 无。仓库无 LICENSE 文件、package.json 无 license 字段、README/页脚无授权声明 → 默认 All Rights Reserved(作者 Bhide Svelte / SikandarJODD)。仅可作参考;复制进产品需先获得作者授权。
- **视觉/交互一句话**: 32 个 shadcn 风格按钮变体,覆盖尺寸/状态/图标组合与微交互——呼吸状态点、旋转图标开关、复制反馈、汉堡↔箭头切换、点赞计数等,适合直接提升桌面外壳的按钮质感。
