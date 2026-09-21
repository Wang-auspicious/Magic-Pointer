# scraped — claude.ai 抓取产物（2026-09-17）

> 2026-09-18 补采：Claude Desktop **2.110.0.0** 的完整页面资源位于 `resources/ion-dist`，并不在 `app.asar`。已取得精确图标 hover/active/Code loop 参数、完整 310 名字→码点目录、Projects/Artifacts/Scheduled 原始矢量插画、Scheduled 悬停微界面与 Artifacts 动态缩略图源码。见 [补采来源与参数](extras/desktop-2.110.0.0/README.md)。原字体逐字节一致。下文对旧安装包“业务内容不在本地包”的结论不适用于新版；页面实时访问/付费边界仍未由这次本地提取消除。

- viewport 1037×879，dpr 2，系统缩放 100%（Windows Chrome 152）。
- 页面：https://claude.ai/new（Free 账号；`/code` 对 Free 付费墙，见下）。
- 账号：用户自有账号空会话；文本已脱敏（`«text»`/`«redacted»`），无 cookie/token/org id/对话内容。
- font 值在 tokens.json 中个别超长 family 串做了截断（首 family + serif/sans 结构保留），其余原样。

## 关键结论（先看这段）

1. **`/code` 对 Free 账号是付费墙**（跳 upgrade 页）。手册 §4/§5 中 Code 专属（tool 折叠/展开、commandCard、diffStat、permission 卡、运行态星芒计时、出错态）**本次拿不到**，需 Pro/Max 账号重抓。
2. **图标不是 SVG，是字体**：`Anthropicons-Variable`（woff2-variations，wght 400–700），`<span data-cds="Icon">` + PUA 码点。32 个码点全映射见 `icons/manifest.json`。SVG 只有 4 个（已收 4：incognito/spark/voice-activity/reflect-broadcast；29KB 点阵 pictogram 装饰跳过）。
3. **组件定位靠 `data-cds` 属性**：`ChatComposerEditor` / `ChatComposer` / `ChatComposerActions` / `MessageActions[data-reveal]` / `SegmentedControl` / `ModelSelector` / `UserMessage` / `AssistantMessage` / `TurnStatusStep`；框架 `.dframe-*`（sidebar）、`.df-*`（行）、`.epitaxy-*`（composer/transcript）。
4. **动作行是 CSS reveal，不是 JS 显隐**：`scale:none` + `--cds-message-actions-reveal-*`（in .12s/delay .1s/out 60ms），hover/focus-within 触发。见 `css/stylesheets-targeted.css`。
5. CSS 全量 1407 规则/1.57MB，其中 Tailwind `@layer utilities` 整块 1.15MB 未拉（复刻按需取）；目标组件规则原文见 `css/stylesheets-targeted.css`；937 个 selector 清单未落盘（需要可重跑 `EXTRACT('selectors')`）。
6. `computed.json` 为 `[...getComputedStyle]` 全枚举后在页面端过滤：保留视觉关键属性 + 全部 `--df/--cmp` 变量 + `__rect`（全量 400+ 属性/组件体积过大；`--cds` 全局变量见 `tokens.json`）。

## 文件

```
dom/home.html                 脱敏结构骨架（425 元素，svg/style/script 折叠）
css/tokens.json               全量 --*（含 --cds-* 约 700+）
css/fonts.css                 Anthropicons-Variable @font-face（CDN 引用，非凭证）
css/computed.json             editor/send/sidebar/row/groupLabel/modeSwitch/menuRow/switch
css/stylesheets-targeted.css  MessageActions reveal / idle-activity-bar / timeline / sidebar / pills 原文
icons/manifest.json           4 svg + 41 font 图标（码点→功能）
icons/*.svg                   原样 svg（incognito / spark / voice-activity / reflect-broadcast）
states/*.png                  home-new-chat / popover-model / popover-effort / popover-attach / popover-account / settings-dialog
```

## CSS 全量（2026-09-17 补）

- `css/stylesheets.css`（1.4MB）：4 个外部 CDN 文件原样拼接（`vendor/` 保留原文件）：
  - `c6a992d55-CnLsOVSx.css` 1.30MB / 489 rules（含 Tailwind `@layer utilities` 巨块 + @font-face）
  - `shared-styles-e78wt03W.css` 77KB / 543 rules
  - `cf1a02a1a-DdTz_5PL.css` 26KB / 251 rules
  - `shared-frame--1WLhtwS.css` 203B / 1 rule
  - CDN 为公开静态资源（assets-proxy.anthropic.com），无需登录即可直链，filenames 含内容哈希。
- `css/inline-extract.css`：inline `<style>` 去重摘录（:root 变量串/tailwind 重复部分已略，composer/cds-root/static-composer 全留）。
- `css/stylesheets-targeted.css`：目标组件速查（与 vendor 有重叠，移植时以 vendor 为准）。
- `[data-cds=Icon]` 组件定义（含 `font-feature-settings:"liga" 0`、1em flex 盒）在 `c6a992d55` 内，可 grep 定位。

## 本地 Desktop 验证（Store 版 1.49585.0.0，37MB app.asar）

- `Type / for commands` / `What's up next` / `Start a side chat` 命中 0 → Code 视图业务内容不在本地包。
- `MessageActions` 6 / `ChatComposerDock` 5 → 壳与网页共享 CDS 组件库，但 Code 视图是运行时按账号订阅拉的。
- 结论：Free 账号下 Desktop 与网页看到的是同一扇付费墙，换客户端绕不过。

## 未覆盖（需付费账号重抓）

tool.collapsed/expanded/commandCard/output/diffStat、turn.status 运行态、permission.card、bubble.user、actions.row hover 两态、popover.usage/permission/workspace、home.heatmapCell（新版 home 已无热力图，见 diff）、switch 开态。
