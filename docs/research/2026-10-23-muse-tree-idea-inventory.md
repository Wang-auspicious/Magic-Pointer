# muse-tree 思想清单（机制调研，供后续批次渐进吸收）

日期：2026-10-23。材料：`D:\AI_Agents\muse-tree`（用户提供的 GitHub 克隆，"Muse" home 目录完整快照）。

**许可边界**：该仓库顶层无开源许可证，README 明确不额外授予复制/修改/分发权利。本文只记录机制与思想（机制不受版权保护），MP 侧全部自有实现，不复制其代码、文案或资产。

## 快照结构速览

SOUL.md / USER.md / IDENTITY.md / AGENTS.md / MEMORY.md / TOOLS.md / PROACTIVE_PREFERENCES.md 七个根文件各管一件事且每个文件开头写清"什么不归这里管"；HEARTBEAT.md 是可编辑的逐行心跳清单；dreams/ 夜间反思 + alignment 状态机（derived → repair threads → synthesis）；subscriptions/ 是只读查询台账（绑定 Muse VM）；memory/ 分 curated（新覆旧）/daily 全量流水/people 关系页/bank 观点库；magic-moment/ 是带评审门的大技能（story→shape→visuals→screenplay→**review gate**→render）；spaces/ 是 Muse 托管专属的 agent 建站模板；runtime-scaffold/ 是 Python 参考运行时（BM25 记忆、token 预算压缩、APScheduler 任务、self_improvement 分类法）。

## 值得渐进吸收的机制（按价值排序）

1. **任务即 Markdown（cron.d）+ HEARTBEAT 心跳清单** —— 定时任务是带 YAML frontmatter 的 .md 文件（频率目录 hourly/daily/runonce + _invalid 收容非法项），agent 可直接读写、diff 友好、自文档化。MP 落点：routine 调度器改为"每任务一个 md 文件"。工作量 S。
2. **隐藏交接（hidden handoff）+ 运行史即真相 + 自暂停** —— 后台 worker 永不直接打扰用户，写报告、由主代理决定呈现；验证看运行记录而非计划；持续受阻的任务自我暂停并留痕。MP 落点：workflow 步骤与后台任务的汇报纪律。**本批已落地第一步**（workflow 步骤指令含"向协调代理报告事实，不面向用户、不问问题、不播报进度"）；运行史即真相已由 EventSession 事件溯源与 workflow journal 天然满足。剩余：routine 的自暂停语义。工作量 S。
3. **根文件提示词分层 + 作用域否定** —— SOUL（人格）/USER（用户事实）/AGENTS（本工作区教训，"从空开始、缓慢生长、宁短勿旧"）/TOOLS（仅环境怪癖）每文件声明"不归这里管的东西"。MP 落点：buildSystemPrompt 的记忆段按此分层，给项目知识加"教训"类条目与作用域否定。工作量 S。
4. **夜间反思 + alignment 状态机** —— 会话 → 派生状态 → 修复线程 → 行为合成。MP 落点：每日 routine 跑在个人活动记忆上产出对齐状态。工作量 M。
5. **记忆分类学** —— curated 新覆旧、daily 全量、people/groups 关系页按亲疏排序、事实带 provenance 注释、内容哈希做稳定块 id。MP 落点：memory 模块加关系页与覆写语义。工作量 M。
6. **技能复审循环** —— 周期性对照近期工作审计技能：反复出现的流程提炼成技能，实测无增益的下架。MP 落点：skills/plugins 的例行审计 routine。工作量 M。

## 明确不吸收

- subscriptions/ 与 muse.db —— 绑定 Muse 守护进程/Postgres；MP 的 EventSession 事件溯源已覆盖。
- spaces/ts-runtime —— Muse 托管专属（CVM、Cloudflare workers、主题协议）；agent 建站是产品决策不是外挂件。
- magic-moment 代码与资产 —— 依赖 Muse VM 预置的 ffmpeg/Chromium/Playwright；只吸收"不可逆动作前显式评审门"的模式。
- runtime-scaffold 代码本身 —— Python 参考实现；MP 自有 TS 运行时已更强。
- Feed/Ideas/Goals 等服务端产品面 —— 非 harness 机制。

## 对本批的直接落点

/workflow 命令驱动的编排体验吸收了三条：隐藏交接（步骤汇报纪律）、运行史即真相（workflow journal + EventSession 为唯一事实源）、magic-moment 的评审门模式（Workflow.run 的权限模式继承——非只读步骤走现有权限门）。
