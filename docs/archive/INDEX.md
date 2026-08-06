# 归档索引

2026-07-06 ~ 08-05 的 72 份历史文档。**默认不要读**——结论已经并进 `docs/` 的四份现行文档。这里只为考古：想知道某个决定当时的证据和理由时，按下表定位一份。

标记：**⭐ 仍有独立价值**（原始数据/一手证据，现行文档只收了结论）｜其余均为已被取代的过程记录。

## 一手调研（⭐ 这几份的数据不在别处）

| 文件 | 是什么 |
|---|---|
| ⭐ `research/2026-08-04-what-uia-actually-exposes.md` | 四类应用的 UIA 树 dump 实测原文与复现命令。ARCHITECTURE 只收了结论表 |
| ⭐ `planning/EVERYWHERE_ANALYSIS_20260803.md` | 竞品 Everywhere 全量拆解：76 条 release notes + 源码通读 |
| ⭐ `planning/ADJACENT_PROJECTS_SCAN_20260803.md` | 23 个交集开源项目扫描。注意 :18 和 :116 关于 WritingTools 的结论**已被证伪** |
| ⭐ `planning/GOOGLE_ADDTHIS_ANDTHIS_ANALYSIS_20260731.md` | Google「add this / and this」机制 + 专利 US11221823B2 + Clicky 生态对标 |
| ⭐ `planning/CLICKY_ANALYSIS_20260731.md` | clicky 源码分析（7600 行 Swift），8 个可借鉴技术点 |
| ⭐ `research/2026-08-02-cross-app-continuous-selection-and-wechat-media.md` | 跨应用连续圈选与微信媒体获取。⚠️ 其中"wxauto 支持微信 4.1"来自商业文档，**与实测不符** |
| ⭐ `research/officecli-integration-assessment.md` | OfficeCLI 黑盒验证与集成边界 |
| ⭐ `research/2026-07-29-settings-extension-benchmark.md` | Codex / Hermes / Claude Code / Obsidian 的设置与权限 UX 基准 |
| ⭐ `research/2026-07-29-google-magic-pointer-open-source-grounding.md` | Google 官方口径考据 + 开源 UI grounding 选型 |
| ⭐ `research/2026-07-29-local-agent-project-patterns.md` | 本机 HermesAgent / OpenHuman 只读审计与许可证判断 |
| `planning/GEMINI_POINTER_STUDY.md` / `GEMINI_POINTER_FRAME_ANALYSIS.md` / `GOOGLE_DEMO_FRAME_ANALYSIS_20260726.md` | Google 演示的逐帧拆解（三份递进，最后一份最完整） |
| `planning/GOOGLE_MAGIC_POINTER_ALIGNMENT.md` | Google 公开证据与实现约束对齐 |
| `AI-Pointer-划线技术与设计.md` / `AI-桌面助手真实场景挖掘.md` | 与 Gemini 的两次对话原文（划线视觉风格 / 真实场景挖掘） |
| `planning/COMMUNITY_DEMAND_AND_BUILD_LOG_20260726.md` | 社区真实需求调研与当轮实现日志 |

## 交接与验收（时间倒序，越靠上越近）

结论已并入 `docs/STATUS.md`。

| 文件 | 是什么 |
|---|---|
| `planning/ACCEPTANCE_REPORT_20260805_CODEX.md` | **最后一份验收**：七个串联 bug 的根因、Everywhere 程序集分析、C# 框选原型、P0/P1/P2 清单 |
| `planning/HANDOFF_20260805.md` | 08-04~05 整轮交接。⚠️ §3 的模型网关（nghimmo）**已过期**，现为 DeepSeek |
| `planning/PROGRESS_20260805.md` | 08-05 逐提交执行日志与实测数据 |
| `planning/ACCEPTANCE_FAILURE_REPORT_20260804.md` | 四场景全挂的三条系统性根因。§4「明确不做」清单已作废 |
| `planning/MASTER_PLAN_20260804.md` | 上一版总体规划（Phase 0–3、P3 十二项的原始定义在 §6） |
| `planning/HANDOFF_20260803.md` | 08-03 交接 |
| `planning/PROJECT_STATE_AND_DIRECTION.md` | 8/1 那场 74MB 会话的浓缩版；含会话历史 JSONL 路径 |
| `planning/STABILIZATION_PROGRESS_20260730.md` | 07-30 稳定化记录 |
| `planning/IMPLEMENTATION_STATUS_20260726.md` | PointerStage 端到端接通那一轮 |
| `planning/PROGRESS_20260726_NIGHT2.md` | 07-26 夜间返工记录（826 字节） |
| `planning/HANDOFF_2026-07-10_MAGIC_POINTER.md` | 07-10 交接：V4 界面被用户否决那次 |
| `planning/HANDOFF_20260707_VISUAL_TO_AGI.md` | Tk → Electron overlay 切换 |
| `planning/HANDOFF.md` | 最早的交接（MVP1-alpha） |
| `planning/REVIEW_20260710_OBSERVER_FIRST.md` | observer-first 多视角评审 |
| `planning/REVIEW_AUDIT_20260731.md` | P8 全量人工代码审查：44 项发现（P0×7 已全修） |

## 产品方向的历次版本（每份都被下一份取代）

现行版本是 `docs/PRODUCT.md`。这条线记录了方向是怎么一步步收窄到「Ctrl+C 复制不了的东西」的。

`planning/PRODUCT_STRATEGY_20260803.md`（**最接近现行版**，一手调研最全）→ `planning/MAGIC_POINTER_REAL_WORKFLOWS_20260802.md` → `planning/MAGIC_POINTER_MATURE_ARCHITECTURE_20260801.md` → `planning/PRODUCT_ECOSYSTEM_DETAILED_PLAN_20260727.md` → `PRODUCT_BLUEPRINT_20260726.md` → `planning/PRODUCT_RESEARCH_REASSESSMENT_20260722.md` → `planning/PRODUCT_DIRECTION_PIVOT_USER_RESEARCH_20260712.md` → `planning/PRODUCT_WISHES_AND_DEMO_IMPLEMENTATION_20260712.md` → `planning/PRODUCT_PROGRESS_ALIGNMENT_20260712.md`

另有：`planning/BOTTOM_LAYER_DESIGN_20260801.md`（clicky 生态 44 个 issue 全记录 + Referent 会话引擎设计）｜`planning/AGI_DISTANCE.md`（每版距离"桌面 AGI"还差什么）｜`USER_WORKFLOWS.md`（20 个工作流，多数为设想）｜`FEATURE_INVENTORY_20260730.md`（07-30 的功能清单 + 竞品差距）

## 清单类（已完成或已并入 ROADMAP）

`planning/GAP_ANALYSIS_100_20260730.md`（100 条漏洞）｜`planning/TODO_REMAINING_20260730.md`（其中未落地的打包/签名项已并入 ROADMAP P2）｜`planning/EXTERNAL_COMPONENTS.md`（外部依赖与许可证矩阵，现行版在 ARCHITECTURE）｜`planning/RESEARCH_AGENT_OCR_ADDENDUM_20260726.md`（OCR 后端选型：RapidOCR 为默认）｜`planning/TERRA_IMPLEMENTATION_HANDOFF_PROMPT_20260727.md`（给另一个模型的执行 prompt，一次性）

## 实施计划与设计规格（superpowers/，均已执行完或已废弃）

`plans/` 是逐任务实施计划，`specs/` 是对应的设计定稿。同日期的两份配对阅读。

| 计划（`plans/`） | 规格（`specs/`） | 状态 |
|---|---|---|
| `2026-08-01-google-sweep-renderer.md` | `2026-08-01-single-color-sweep-visual-design.md` | 已实现（WebGL2 SDF 单色光带） |
| `2026-07-29-grounding-runtime-truth.md` | `2026-07-29-grounded-desktop-product-design.md` | 已实现 |
| `2026-07-26-pointer-action-fabric.md` | — | 已实现（fabric 引擎 + recipe 体系） |
| `2026-07-26-demo-grade-interaction-layer.md` | `2026-07-26-demo-grade-interaction-layer-design.md` | 已实现（PointerStage 单舞台）。⚠️ 规格里的「石墨黑 #0E1116」**与实际发布的浅色气泡分叉**，见 ROADMAP P2 |
| `2026-07-26-community-demand-object-bridge.md` | `2026-07-26-community-demand-object-bridge-design.md` | 已实现 |
| `2026-07-23-runtime-issue-handoff.md` | `2026-07-23-runtime-issue-handoff-design.md` | 已实现 |
| `2026-07-22-context-prompt-compiler-alpha.md` | `2026-07-22-context-prompt-compiler-alpha-design.md` | 已实现 |
| `2026-07-12-grounded-review-handoff-v1.md` | — | 已实现 |
| `2026-07-12-contextual-result-surface-implementation.md` | `2026-07-12-contextual-result-surface-design.md` | **已废弃**——Rail/Reader 三窗口形态被 PointerStage 单舞台取代 |
| `2026-07-12-native-shopping-list-action-implementation.md` | `2026-07-12-native-dashboard-shopping-list-design.md` | 已实现，但**已降为自动化回归项**，不再是产品验收主线 |
| `2026-07-12-native-calendar-action-implementation.md` | `2026-07-12-native-dashboard-calendar-design.md` | 同上 |
| — | `2026-07-12-native-dashboard-route-design.md` | 同上（地图路线） |
| — | `2026-07-12-native-dashboard-table-merge-design.md` | 同上（表格合并） |
