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

## 4. 诚实边界

- E2E 只跑了这一个 ~120 行的实验室；300 步级真实仓库任务未测。
- delegate_task 未在真机任务中用过（工具注册与 bundle 装配过测试）。
- checkpoint 只覆盖自家工具的写入；run_command 里的副作用不可回滚（CC 同限）。
- apply_patch 对 CRLF 文件插入的新行是 LF（混合换行）；Codex 的
  PreserveLineEndings 模式未移植。
- pi-subagents 插件在 `pi --print` 下不回传子代理输出（TUI 功能），本次审查
  由主会话自查完成。
