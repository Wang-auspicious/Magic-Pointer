# 交接文档：对标 Hermes/Pi/Codex 的基座差距补齐（2026-08-21）

> **进度更新（同日晚些）：§5 的 ①②③ 已全部完成并交付（1.0.13），数据与
> 结论见 `docs/research/2026-08-21-coding-tools-e2e-and-hermes-baseline.md`。
> 下一步从 §5.4 继续：把差距清单 §2B 逐项做成带验收的批次（subagent 真机
> 使用、plan mode GUI 往返、checkpoint UI 入口、skills 自进化、web 工具集、
> cron）。本文其余部分保留作背景。**

> 写给 /clear 后的新会话。读完这一份 + `docs/STATUS.md` 即可无缝继续。
> 当前分支 `codex/harness-reconstruction`，最新提交见 `git log`。
> 验证命令（必须用独立 basetemp）：
> `python -m pytest tests/ -q --basetemp=data/runtime/pytest-tmp-xxx`
> `npx tsx scripts/run-node-tests.ts && npm run typecheck`

---

## 0. 一句话现状

Magic Pointer 的 loop 内核（会话/压缩/守卫/权限/收据）经过真机锤炼已较扎实，
但**工具面严重偏科**：22 个工具全是桌面动作与感知，**没有任何代码工具**
（读文件/grep/shell），所以它现在修不了任何仓库的 bug——这是与 Hermes/
Codex/CC 的第一差距。编码工具集 `app/agent_runtime/coding_tools.py` 刚写完
（6 工具，13 个测试全过），**尚未接线进插件 bundle、尚未做真实仓库修复的
端到端验证、尚未跑 Hermes 对照**。这是接手后的第一件事。

## 1. 对标项目与本地源码位置

| 项目 | 本地路径 | 许可证 | 学什么 |
|---|---|---|---|
| HermesAgent | `D:\AI_Agents\HermesAgent` | MIT | terminal/file 工具集、subagent、skills 自进化闭环、cron、turn 端验证门、tool guardrails（已移植部分见 THIRD_PARTY_NOTICES.md） |
| Codex (openai) | `D:\AI_Agents\codex`（HEAD 2151d3a） | Apache-2.0 | codex-rs/core 的 turn 循环/compact/tools/parallel/input_queue/rollout 持久化/ext/goal；apply_patch 契约 |
| Pi | `D:\AI_Agents\pi` | MIT | packages/agent/src/agent-loop.ts 纯 turn 状态机、steer/followup 双队列 |
| Claude Code | `C:\Users\zjz65\PycharmProjects\claude-code-main` | 内部参考 | Read/Edit/Bash/Grep/Glob 工具契约、queryLoop、systemPromptSections |
| DSH (deepseek-harness) | 本地 clone commit 47f9438（查 `docs/2026-08-14-plugin-architecture-review.md`） | MIT | 插件内核金标准（已移植为 app/harness）、session 事件溯源 |

模型配置：opencode Go 网关，`secrets/model.txt = mimo-v2.5`（用户指定）。
Hermes 跑法：`cd D:/AI_Agents/HermesAgent && OPENCODE_GO_API_KEY=<secrets/openai_key.txt内容> python cli.py --query "..." --model mimo-v2.5 --provider opencode-go -t terminal`（依赖 wcwidth/fire/concurrent-log-handler 已装）。

## 2. 与成熟 agent 的差距清单（按对"修 bug/长任务"能力的影响排序）

### A. 致命缺口（正在补）

1. **零代码工具面** ← 当前工作。Hermes 有 terminal+file 工具集，Codex 有
   shell+apply_patch，CC 有 Read/Edit/Bash/Grep/Glob；MP 一个都没有。
   **已写好待接线**：`app/agent_runtime/coding_tools.py`
   （read_file/write_file/edit_file/glob/grep/run_command，workspace 沙箱限定，
   effect 分级 read/reversible_write/local_irreversible，测试
   `tests/coding_tools_test.py` 13/13 过）。剩余：
   a) builtin_bundle 加 `coding-tools` 行（config 带 workspace_root，桥传 cwd）；
   b) selection/conversation 桥的 runtime 配置里传 `workspace_root=Path.cwd()`；
   c) electron-builder files 白名单无需改（纯 Python）。
2. **shell 无沙箱**：run_command 只靠权限门（bypass 才放行）。Codex 有
   windows_sandbox_rs/linux_sandbox。中期：至少加危险命令黑名单 + 工作区外
   命令拒绝。
3. **无真实仓库修复的端到端验证**：造一个含失败测试的小仓库，让 MP 用
   coding tools + bypass 权限走完「跑测试→定位→编辑→再跑→绿」全链；
   同任务同模型跑 Hermes 对照，产出差距数据。

### B. 结构性差距（A 完成后按序）

4. **无子代理/并行子任务**：Hermes subagent、Codex multi-agent collab 都有；
   MP 单循环。蓝图 Gate 6 要求先有真实账本证明瓶颈再做。
5. **无 plan mode**：CC/Codex 可先只读规划再执行；MP 权限模式有 plan 档但
   没有「先出计划文档再动手」的产品语义。
6. **无 checkpoint/回滚**：CC 有 /rewind 文件快照；MP 会话可溯源但文件系统
   改动不可回滚（coding tools 落地后需要 .mp/backups 机制）。
7. **skills 自进化闭环弱**：Hermes 自动从经验创建 skill 并自我改进；MP 只有
   learning review 候选 + 只读 skill 注入。
8. **无 web 搜索/浏览工具集**（Hermes web toolset）；MCP client 已有可部分替代。
9. **无定时任务/cron**（Hermes scheduled automations）。
10. **上下文压缩不如 Codex 成熟**：已有 rolling compaction + 真实 usage 触发 +
    CJK 计数 + 五段交接摘要；缺 Codex 的压缩中撞窗删最老重试、remote compaction。

### C. MP 独有、对标项目没有的（保持并强化）

桌面感知（FrameLease 冻结帧/UIA 树/并发证据融合/八态诚实）、effect sandwich
操作账本、ActionLease/snapshot 绑定、Receipt 收尾发票。这些是创新基座，别丢。

## 3. 本会话已完成（全部已提交，见 git log ea1905f..HEAD）

1. 保护性提交上一批工作；完成悬空的 9 个 TDD 契约（冻结/实时语义隔离 P1、
   get_app_state 轮询不误杀 S5、元素级快照失效 P4、压缩去重 C3）。
2. Codex 逐行学习 → `docs/research/2026-08-19-codex-harness-study-and-audit.md`。
3. 压缩摘要升级 Codex 五段结构化交接 + 摘要源 12k→48k（双桥单源
   compaction_prompt.py）。
4. session append O(n²)→增量采用（_known_size 前缀 + _adopt_incremental）。
5. 跨进程优雅取消 O3（cancel/request 持久事件 + bridge action=cancel +
   interrupt_check 接线 + GUI 5s 宽限）；运行中插话 steer O1/O2（stage 处理中
   提交写 durable inbox）；真实步数上卡 O5；has_pending_work D2；look 配额 P5；
   steer/压缩事件可见 O7；账单过契约层 O6；取消文案诚实化 O4。
6. **真机测试暴露并修复的缺陷链**（证据 data/runtime/scenario-evidence/notepad-edit）：
   - CJK token 低估近半（86k 真实 vs 48k 估算）→ token_estimate 按 CJK 1字/token 计
   - 压缩判定接入上一轮 provider 真实 prompt_tokens（ground truth）
   - BACKEND_RECOVERY：productive turn 遇瞬时后端错误 15s/25s 退避重试
   - STALLED/BUDGET_EXHAUSTED/PROVIDER_UNAVAILABLE 且有成功回执 → 部分交付
     （已完成步骤清单 + 诚实缺口），不再 answer 为空
   - 熔断器瞬态类连续 2 次失败才开（单次 SSL 抖动曾杀死整个 turn）
   - look 空裁剪诚实 unsupported（原 AttributeError）、VisionUnavailable 错引修正
   - press_key 键名别名（Return/Del/PgUp/箭头等）、app 匹配回退 class/title
     （Win11 记事本 process_name 为空）
7. 真机测试台增强：notepad-edit/notepad-batch 场景 + 独立 UIA 验证、ALT 技巧
   过前台锁、每 run 独立 session。
8. 编码工具集 coding_tools.py（本交接时 13/13 测试过，未提交、未接线）。

## 4. 真机测试的教训（新会话必读）

- **真机测试会占用用户桌面焦点数分钟**：跑之前明确告知用户不要动键鼠；
  曾出现人正在用机导致窗口被关、IME 拼音残留污染结果（harness 本身行为正确）。
- 场景会话必须每 run 独立（旧 session 陈史会污染模型上下文）。
- Windows 前台锁会拒绝后台调用方的 SetForegroundWindow：用 ALT 键技巧
  （real_scenario_test.py::_set_foreground）。
- pytest 必须带 `--basetemp=data/runtime/...`（系统 temp 权限问题）。
- 网关 mimo-v2.5 较慢（每轮 8-45s），22 轮任务约 5 分钟，注意 SELECTION_BUDGETS
  （当前 5 分钟，rolling 续期只在 productive 轮生效）。

## 5. 接手后怎么做（按序）

1. **接线 coding tools**：builtin_bundle 加 `_apply_coding_tools` 行
   （读 config["workspace_root"]，缺省不注册）；selection/conversation 桥的
   runtime dict 加 `"workspace_root": str(Path.cwd())`；跑全量测试提交。
2. **真实 bug 修复端到端**：造一个 ~200 行的小 Python 包（含一个故意写错的
   函数 + 失败的 pytest），用 conversation_bridge 或直接 run_agent_turn +
   coding tools + permission_mode=bypass 让模型修到测试绿。验收：测试由红变绿、
   会话日志有 edit_file/run_command 回执、轮数/token 记录在案。
3. **Hermes 对照**：同一仓库同一 prompt 跑 Hermes CLI（命令见 §1），对比
   完成度/轮数/是否自己跑测试验证。写入 docs/research/ 新文档。
4. **把差距清单 §2B 逐项做成带验收的批次**，先 6（checkpoint 回滚）和 5
   （plan mode），这两个对"修 bug"场景价值最大。
5. 每批完成后：fresh 全量验证 → git 提交 → 更新 STATUS.md → 升版本 npm run sync
   （安装版交付是硬性要求）。

## 6. 关键文件地图

- loop 内核：`app/agent_runtime/loop.py`（BACKEND_RECOVERY/rolling budget/守卫）
- 会话：`app/agent_runtime/session.py`（增量 append/cancel/pending work）
- 压缩：`app/agent_runtime/memory.py::compact_messages` + `compaction_prompt.py`
- 熔断：`app/model_health.py`（transient_streak）
- 桌面动作：`app/desktop_actions/session.py`（元素级快照校验）
- 编码工具：`app/agent_runtime/coding_tools.py`（新，未接线）
- 插件树：`app/harness/builtin_bundle.py`（加行在这里）
- 真机测试台：`scripts/real_scenario_test.py`（notepad-edit/batch 场景）
- 部分交付：`app/fabric/loop_answer.py`（_PARTIAL_DELIVERY_REASONS）
- 桥：`scripts/selection_bridge.py`（_loop_router/progress_sink）、
  `scripts/conversation_bridge.py`、`scripts/agent_session_bridge.py`
  （put/pending/status/cancel）
