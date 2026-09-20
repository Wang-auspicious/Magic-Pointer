# GUI 工具卡顿、上下文计量与用量弹层修复

**后续纠正：** 本文最初的原地展开设计及离屏验收不能代表实际 GUI 的点击行为和旧会话数据显示。用户反馈后已修正为左侧独立明细，读取已有事件日志恢复旧计量，修复空闲鼠标装饰层，并以真实主进程和用户确认验收。最新结论见 [用量弹层纠正记录](2026-09-19-usage-popover-correction.md)。

开发树版本维持 **1.0.49**。遵守本任务前文的不 bump、不运行 `npm run sync` 约束，安装版未替换。保留原有未提交改动，未修改系统提示词文案，未接入 Jev 模型，也未新增模板引擎、feature flag 或迁移框架。

## 来自实际会话的证据

会话 `c1789745222499`，durable session `agent-studio-new-5c4803113f94464e9d3dee7c0d53bee7`。问题原文为“找出这个文件夹下今天写的关于jev的md，并分析他应用于我这个MP项目对我最大的改进是什么。”读取了用户的 conversations.json 与对应 EventSession JSONL；没有重新向模型发送该问题。

| 项目 | 历史记录 |
| --- | --- |
| Glob | 错误写 10000ms timeout，实际 latencyMs **200004.344** |
| 随后 Bash | `dir /s /o-d *.md`，**47139.785 ms**，扫描 release 安装包，原输出超过 64000 字符 |
| Grep | `glob` 字段被拒绝，随后使用 `glob_filter` 才成功 |
| STATUS Read | **50118 字符**进入工具结果 |
| 六次请求输入 | **6888 / 8311 / 8632 / 8970 / 15937 / 42085** tokens |
| 累计输入 / 输出 | **90823 / 1481**，合计 **92304** tokens |

旧弹层将 turn.modelUsage 的累计 inputTokens 当作最新请求输入，导致约 91k 被显示为上下文；最后一次真实请求输入是 **42085**。累计量仍是真实消耗，不应删掉或伪装成 42k。

## 实现与数据口径

- **Glob** 先用 `rg --files --hidden --no-require-git` 枚举，再匹配模式；尊重忽略规则，避免用正向 `-g` 覆盖 gitignore。修复 `**/*.md` 漏掉根目录文件。枚举子进程轮询既有取消令牌，取消后终止并回收；无 rg 时的 Python 遍历同样检查令牌，并排除安装产物目录。超时仍使用既有工具超时机制。
- **Read** 默认 200 行、约 12000 字符；长输出尽量停在完整行，报告实际行范围，仍可 offset/limit 明确分页。既有显式大范围读取能力保留。没有截短磁盘文件、原始会话或历史证据。
- **Grep** 接受实际会话出现的 `glob` 参数，原 `glob_filter` 保留。
- **工具展示** 在 tool_call_started 就传出完整 arguments，经 blob 协议传至 Electron，运行中的 Bash 可以立即展开。工具组默认折叠；模型请求耗时在服务端 usage 到达时结算，不再把后续工具执行时间全部算进模型延迟。
- **计量** inputTokens/outputTokens/totalTokens 继续表示本轮任务所有请求累计；contextTokens、lastOutputTokens、lastCacheReadTokens、lastCacheWriteTokens 表示最近一次请求。OpenAI 输入已含缓存，不重复加；Anthropic 的 input_tokens 不含缓存，补上 cache_read_input_tokens 与 cache_creation_input_tokens。缺失字段不造零。
- **实时性** 请求发出前推送实际待发送上下文的本地估算（`≈`）；模型返回 usage 时立即推送服务端实测，沿用现有 300ms GUI 进度节流。服务端未返回 usage 前无法承诺精确 tokenizer 数字。分段组成是本地估算比例，合计校准到实测输入；输出、累计消耗、账户额度不混入该条。
- **历史** completed_trajectory 不再把整个任务累计消耗覆盖到最后一条模型消息。只有累计数据的旧 GUI 记录显示未知，下一次请求刷新；不篡改历史 JSON、不从累计值猜单次上下文。

## 参考 UI 与账户用量

读取本机 `Claude_2.110.0.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist/assets/v1`：

- `c360a9e1c-CcvsgZCp.js`：Code usage popup，360px、top/end、sideOffset 8、纵向 py-sm。
- `c2d611398-DXxqZ5AF.js`：Context window、套餐窗口、右箭头和 See detailed breakdown。
- `c6a992d55-CCAJX9iv.css`：compact CDS 字号 12px / 行高 15px；pad-lg 12px、pad-xs 4px、gap-xs 6px、gap-sm 8px。

弹层使用 **360px 内容宽度 + 两侧 1px 边框**，参考双额度窗口总高 **185px**，进度条 **4px**，内条宽 **336px**。浅色背景与边框按参考图取值。Context window 恒定在顶部，账户行按 provider 调整；头部箭头和页脚均在当前弹层展开实数明细，不跳回首页。

既有 DeepSeek/OpenRouter/Moonshot/OpenCode Go 配额适配器继续使用；本次修复了 renderer 只取一次配额后永不刷新的问题，打开时强制获取，展开期间有界刷新，切换模型/provider 后清除旧显示。OpenCode 的 rolling/weekly/monthly 数据形状已对照[官方 route 源码](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts)核验，未使用本地 token 估算账户额度。

DeepSeek 的实时余额来自 `/user/balance`；本会话费用按[官方价格](https://api-docs.deepseek.com/quick_start/pricing/)（2026-09-19 核验）、明确模型名、实际缓存计数、请求时的 UTC 峰谷时段计算。只为 api.deepseek.com 的已核验模型计价，显示 `≈USD` 和已计价请求数量；缺失计数、未知模型、其它代理价格不猜。该数是公布费率估算，不是厂家最终账单；未使用账户余额差作为会话费用。

## 验证

- 新回归先见证失败：Glob 漏根目录/进入 release、忽略取消、Read 默认倾倒大文件、累计与缓存计数错误、运行中无 arguments、Grep `unexpected field 'glob'`。新增 Python 回归最终 **8 passed**。计量传输/选择/分段的新 Node 测试也先失败后通过。
- 相关 loop/bridge/新回归定向 **173 passed / 33.34s**（其后新增 Grep 回归单独红绿验证）。
- 最终完整 `python -m pytest tests/ -q`：**2318 passed、1 failed、1 个既有 Pillow warning，308.74s**。唯一失败是用户明确指出的 `selection_bridge_test.py::test_screen_region_enrich_falls_back_to_full_capture_without_selection_bbox`，未改其测试或感知层实现。
- 最终 Node：**233 个测试文件通过**；全部 TypeScript 配置通过；Electron 构建通过。构建仍提示已有 Figma plugin ID 未配置。
- 修改的 TS/JS/CJS 定向 ESLint 无错误/告警；新 Python 模块与回归 Ruff 通过。原有 Python 模块的既有 lint 债不冒充已清理。
- `scripts/verify_context_usage.cjs` 使用真实生产 renderUsageMeter 和 CSS、Electron 离屏窗口，在 2x 页面缩放下测量并截图，验证内容宽度、12/15 字体、4px 条、右箭头与页脚展开/收回。额度与样例 66.6k 数字为明确的视觉 fixture，不是用户账户实测；不将它宣称为所有显示器/DPI 的逐像素一致证明。
- 同一真实开发工作区，生产 Glob **361.435ms**、273 行、未进入 release、包含根 README；Read STATUS **3.640ms / 12034 字符（包含分页说明）**。这是一次实测，不是统计基准；没有用修改后的文档及本地 tokenizer 冒充同一模型任务重新运行后的计费节省百分比。

证据文件：`data/runtime/context-usage-{python-final,node-final,typecheck-final,build-final,eslint}-20260919.log`、`context-usage-benchmark-20260919.json`、`context-usage-visual/{collapsed.png,metrics.json}`。当前账户余额没有使用真实凭据额外探测，计价与额度形状通过 fixture/官方来源核验。未提交、未发布、未替换安装目录。
