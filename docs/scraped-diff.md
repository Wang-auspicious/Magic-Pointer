# scraped-diff：MP 现状 vs 2026-09-17 抓取结果

> 数据源：`参考claude设计/scraped/`（claude.ai/new，Free 账号，1037×879@dpr2）。
> 类别：**数值差**（两个数）/ **结构差** / **缺失**。移植不在本次 PR（禁动 `electron/`）。

## 0. 前提偏离（必读）

- `/code` 对 Free 付费墙 → tool.* / permission.card / turn.status 运行态 / bubble / usage popover **缺失**，需付费账号重抓。以下只对免费版可见组件。
- 真图标是字体 `Anthropicons-Variable`（码点见 manifest），不是 SVG。MP 现状 `icons.ts` 全是自绘 24px 描边符号。

## 1. 图标（结构差为主）

| MP 现状 | 抓取 | 类别 |
|---|---|---|
| `ic-spark`：24px 描边四角星（几何近似） | `spark.svg`：viewBox 100×100 **实心** path，`fill=var(--cds-clay,#d97757)` | 结构差：MP 是重画，不合格，按手册需原样替换 |
| `ic-claude-star`：248 视窗重画星芒 | 同上（同一 Spark 形） | 结构差：同上 |
| send/attach/dictate/mic 等：自绘 stroke 1.5 | 字体码点：send U+E013 / attach U+E001 / dictate U+E0AB / mic U+E027，20px/wght 433.3 | 结构差：MP 缺字体通道，需 vendor woff2（`css/fonts.css` 有 CDN 引用，需 license 复核后本地化，禁止热链） |
| 勾选：自绘 | U+E03B（menu radio/checkbox 通用勾） | 缺失 |
| 开关 knob：CSS 画 | 同（CSS 实现，无字形） | 一致 |
| voice 波形：MP 有 6 线记忆 | `voice-activity.svg`：6 条 line，`stroke-width=1.2/round`，y 高度 [8.5-11.5 / 6.5-13.5 / **3.5-16.5** / 6.5-13.5 / 4.5-15.5 / 8.5-11.5] | 数值差：MP 需按此六组 y 值对表 |
| incognito 鬼脸：MP 无 | `incognito.svg` 原样 | 缺失 |

## 2. composer（数值差）

| 项 | MP 现状（claude_chat.css） | 抓取 | 类别 |
|---|---|---|---|
| editor 字号/行高 | 需抽查（MP 多用 13–14px） | **16px / 22px**，wght 360（`font-variation-settings:"wght" 360`） | 数值差：16 vs MP 约 13/14；22 vs 约 20 |
| editor 内边距 | 8px 10px 系 | **5px 0 5px 8px**（右 0，工具行另算） | 数值差 |
| editor 高 | MP 固定/自适应各异 | min **54px** / max 384px，`--cmp-row-h` 公式行高 | 数值差 + 结构差（MP 无 cmp 行高公式） |
| 容器圆角 token | `var(--mp-r7)` 系 | `--cds-radius-composer: calc(.875rem*1)` = **14px** | 数值差：以 14 为准 |
| send 键 | MP 尺寸各异 | **32×32，radius 8px**，空态 opacity **.4**，图标 20px | 数值差：32 / 8 / .4 |
| caret/文字色 | MP 自有 | `#f0efec` / caret 同色，`color-scheme: dark` | 数值差 |
| 工具行图标字重 | — | 小图标 16px/**533.3**，大 20px/**433.3**，微标 12px/**577.8**（=`--cds-badge-x-wght`） | 缺失：MP 无 wght 轴概念 |
| Chat/Cowork 切换 | MP 无 Cowork | SegmentedControl 119×28，padding 1px，radius 7px，track 白 5% | 缺失 |

## 3. 动作行 reveal（结构差，MP 最缺）

- 真机制：`[data-cds="MessageActions"][data-reveal]` + `scale:none` + `@starting-style`，hover 与 focus-within 双触发（原文见 `stylesheets-targeted.css`）。
- 时间：in **.12s** / delay **.1s** / out **60ms**，ease `cubic-bezier(.32,.72,0,1)`，origin top。
- MP 现状：`dsh-reveal`（`--mp-dur-structure`）为一次性入场动画，无 hover reveal 语义 → **结构差**。

## 4. 运行态时间线（数值差，静态抓不到活态但动画原文已拿）

- `timeline-status-enter` .25s / exit .15s / spark-depart .42s / quiet-dots 3px 点 `.26em` 上浮、clay 色 `#d97757`、stagger .15s（原文见 targeted.css）。
- MP 现状 `ic-claude-spinner` 为自绘圆弧 → 星芒 depart + 三点点 dots **缺失**。

## 5. 侧栏（数值差）

| 项 | MP | 抓取 |
|---|---|---|
| 宽 | 需抽查 | **288px**（`--df-sidebar-width` = `--static-sidebar-width`），右侧 **.5px** 白 10% 边 |
| 行 | MP 行高各异 | 高 **32px**，padding 0 2px，gap **8px**，radius **8px**，字 14/400/21，色 secondary `#c3c2b7` |
| 分组标题 | — | 字 12px（13-1）/500，色 secondary，上 margin 14px（首组 0），下 2px |
| 选中/悬停 | MP 自有 | `--df-selected` 白 15% / `--df-hover` 白 7.5%（dark 系；web 系用 neutral-50/60） |
| 收起态 | — | collapsed 变横向 pill（28px，comfortable 32px），body 280px 浮层 | 
| 图标 | 16px | leading-slot **28px**，图标 20px/433.3 |

## 6. 菜单 popover（数值差）

- 行：**padding 6/10/7/10**，gap 8，radius 8，字 14/400/**20px**；菜单宽 408（model）。
- Effort 五档：Low / **Medium(当前)** / High Default / Extra / **Max 1.5×+**（与 MP 五档对应，MP 文案需对表）。
- Attach：Add files **Ctrl+U** / Screenshot / project / Skills / connector / Design system / plugins / Web search✓ / Memory✓。
- 账号卡：Settings（**Ctrl+Shift+,**）/ Language / Get help / Upgrade / Apps / Learn more / Log out。

## 7. 开关（数值差）

- **36×20**，padding 2，pill，关态底白 10%，knob 白 16px；MP 开关尺寸需按 36×20 对表（开态色未抓：开关处于关）。

## 8. 设置（结构差）

- 设置为 `#settings/general` dialog 路由：Preferences/Account/Privacy/Billing/Capabilities/**Memory/Reflect**/Time and focus/**Claude Code**/Skills/Connectors/Plugins；Theme System/Light/Dark；Chat font；Motion；Voice（Language/Style/Speed）；Notifications switch。MP 设置页结构需对照补项。

## 9. 字体（缺失）

- 正文 `anthropic-sans` 300–800 可变；等宽 `anthropic-mono`；标题/语音 `anthropic-serif` + 四 fallback（Georgia/Times/DejaVu/Noto，含 size-adjust/ascent-override 精确值，见抓取 @font-face）；图标 `Anthropicons-Variable` 400–700。MP 无等宽/衬线对照体系。

## 10. 拿不到的（下次）

tool 折叠/展开/commandCard/output/±N、permission 卡、turn.status 活态（星芒+计时+阶段名）、bubble.user、usage popover、switch 开态、出错态。需 Pro/Max 账号 + 真跑一次 Code 任务重抓 §5 的 2–5/11–12。
