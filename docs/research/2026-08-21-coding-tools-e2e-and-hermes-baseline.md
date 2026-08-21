# 编码工具接线 + 真实仓库修复 E2E + Hermes 对照（2026-08-21）

> 接续 `docs/HANDOFF_20260821_CODING_BASE_GAP.md` 的第 1–3 步。全部数据来自
> 本机真跑，不是推演。

## 0. 一句话

Magic Pointer 第一次能修真实仓库的 bug 了：生产链路（conversation_bridge →
boot_loop_context → run_agent_turn）+ 网关模型 mimo-v2.5，78 秒把一个含 3 个
种子 bug、2 个失败测试的 Python 包修到 4/4 全绿；同任务同模型 Hermes 用
71 秒——首战同档。

## 1. 本批落地（全部已验证）

| 能力 | 出处 | 文件 |
|---|---|---|
| coding-tools 行接线（无 workspace_root 时诚实缺席） | 交接 §5.1 | `app/harness/builtin_bundle.py` |
| `/cwd` 工作区命令 + 持久化 | CC/Codex「agent 在哪个仓库工作」语义 | `app/agent_runtime/workspace_state.py`、`slash_directory.py`、`conversation_bridge.py` |
| apply_patch 工具（Add/Delete/Update/Move-to/@@/EOF 标记、四级模糊匹配） | Codex `codex-rs/apply-patch`（Apache-2.0，HEAD 536f86e）逐契约移植 | `app/agent_runtime/apply_patch.py` |
| checkpoint 回滚（write/edit/apply_patch 全部先拍 before-image，restore_files 撤销 N 步） | CC /rewind 契约（差距清单 §2B-6） | `coding_tools.py::FileCheckpointStore` |
| delegate_task 子代理（全新上下文、仅编码工具、继承权限档、父只收摘要） | Hermes `tools/delegate_tool.py`（MIT） | `app/agent_runtime/subagent.py` |
| plan mode 产品语义（只读研究→出计划→等确认）+ coding 工作流提示段 | CC plan mode | `system_prompt.py` |
| 模型档案自适应压缩预算（gemini 1M/kimi 256k/deepseek 128k…显式 env 永远赢） | Codex model_family 表 | `app/agent_runtime/model_profiles.py` |
| 压缩撞窗删最老重试一次 | Codex compact retry | `memory.py::compact_messages` |
| 危险命令小黑名单（rm -rf /、format、diskpart、shutdown 等） | 交接 §A2 最小集 | `coding_tools.py::_CATASTROPHIC_COMMANDS` |

### 顺手抓到的真机 bug

pywin32 在 sys.path 上留了两个无 `__init__.py` 的 `scripts` 目录
（`Python312\scripts`、`site-packages\win32\scripts`）。桥脚本直跑时，
首次 `from scripts._bridge_common import ...` 失败后 Python 把 **namespace
package 缓存在 sys.modules 里**，之后 `ensure_root_on_path()` 补了 path 也
没用——`from scripts.bridge_progress import PhaseClock` 必炸
（ModuleNotFoundError）。修复：`_bridge_common.ensure_root_on_path()` 现在
会把无 `__file__` 的 namespace 包从 sys.modules 驱逐。本机
`python scripts/conversation_bridge.py` 直跑此前必现，现已通过。

## 2. E2E 真实修复（MP 生产链路）

实验室：`data/runtime/e2e-fix-lab/`（inventory 包，~120 行，3 个种子 bug：
subtotal 忽略数量、折扣当加价、most_expensive 按数量比；4 测试 2 红 2 绿；
自带 pyproject.toml 隔离 MP 根配置的 testpaths 泄漏）。

驱动方式 = 真实产品路径：`write_workspace(ROOT, lab)` 后子进程跑
`scripts/conversation_bridge.py`，payload 带 `permissionPreset=danger-full-access`
（BYPASS 档）、独立 windowTitle 保证新会话。

结果（mimo-v2.5，2026-08-21）：

- **78s，10 轮模型请求，17 个工具调用，0 错误**
- 自主链路：glob → run_command(pytest) → read_file×5 → todo_write →
  edit_file×5（pricing.py 四处 + discount.py 阈值 > → >=）→ run_command(pytest 全绿)
  → read_file 读回验证 → 收工
- 实验室终态：**4 passed**；测试文件未被改动（遵守了指令）
- 会话回执含全部 edit_file/run_command 记录（`e2e_result.json`）

## 3. Hermes 对照（同仓库同 prompt 同模型）

Hermes CLI：`python cli.py --query <同文> --model mimo-v2.5 --provider opencode-go -t terminal`，
在 `data/runtime/e2e-fix-lab-hermes/`（同一份坏代码重置）上运行。

| 维度 | Magic Pointer | Hermes |
|---|---|---|
| 结果 | 4/4 通过 | 4/4 通过 |
| 耗时 | 78s | 71s |
| 工具调用 | 17 | 18 |
| 修法 | edit_file×5（含阈值边界修复） | 同样四处逻辑 + >= 边界，复用 line_total |
| 自跑测试验证 | 是（改前红/改后绿各一次） | 是 |

结论：**编码修复能力首战即与 Hermes 同档**。差距清单 §A1（零代码工具面）
关闭。剩余差距按 §2B 继续：subagent 已有雏形（单层、顺序执行），plan mode
有提示语义但 GUI 无确认往返，checkpoint 有工具无 UI 入口。

## 4. 真机暴露的两个新缺陷（已修）

1. **tool_limit 截断静默藏工具**：loop 把发给模型的 schema 按注册顺序截到
   ``tool_limit``（双桥传 30）。编码批后注册表涨到 ~52 个，delegate_task 和
   capability 工具全部跌出窗口——模型说「没有 delegate_task 工具」是真的：
   schema 根本没发给它。真机 delegate 验证抓出。修复：双桥 30 → 64
   （52 个 schema ≈ 4k token，可接受）。
2. **apply_patch 的 delete 文件不进 checkpoint**：restore_files 回滚不了被删
   文件。已修并加 roundtrip 验证。

## 5. delegate_task 真机验证（生产链路）

任务：委派子代理统计仓库每个 .py 行数写入 report.txt，父代理只验收。
结果：139s，delegate_task 真实调用，子代理完成统计，父代理读回 report.txt
并用 wc -l 交叉核对（还抓出并修正一处 27→26 的行数差异）。事件流里父子
两代工具调用都在会话回执中。

## 5.5 plan mode 闭环真机验证

第二轮补齐后真机跑通完整闭环：turn1（plan 预设）33s 出计划挂起
（present_plan → .mp/plan.md → Stage 选项按钮 pendingInput）；点"批准该计划，
开始执行"后 turn2 171s 自动转写入权限执行——edit_file×4 实现 apply_coupon +
自写 3 个测试 + pytest 验证，实验室 7/7 全绿，plan.md 批准即消费。
配套：权限预设表新增 "plan" 档（Python + 渲染层镜像），桥透传
awaitingUserInput/pendingInput 字段（此前 _completed_result 把它丢了）。

## 6. 同批新增能力（Hermes/Codex 对齐继续）

| 能力 | 出处 | 文件 |
|---|---|---|
| web_search / web_fetch（DDG HTML + httpx 抽正文，零 key） | Hermes web_tools 契约 | `app/agent_runtime/web_tools.py` |
| save_skill（agent 自写 skill，下回合 SkillLoader 自动注入——自进化闭环合拢） | Hermes skills 自进化 | `app/agent_runtime/skill_writer.py` |
| 压缩尾部陈旧工具输出修剪（>24k 时仅保留最近 6 条全文） | Codex | `memory.py::_prune_stale_tool_outputs` |

诚实边界：web_fetch 不执行 JS、不支持 PDF；save_skill 无人工审批门
（SkillLoader 本就只注入 user_data 目录）；尾部修剪阈值是拍定的经验值。

