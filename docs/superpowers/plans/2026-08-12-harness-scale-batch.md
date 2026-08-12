# 规模化批：变更流/感知权限/账本与Bench/能力与失败对话（评审批次 3）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。每 Task 独立 swarm，严格文件隔离。
>
> **依赖**：批次 1（loop）✅ + 批次 2（安全）✅。
> **评审依据**：`docs/harness-gap-review-20260812.md` L9（变更流）+ L10（感知权限）+ L13（账本/PointerBench/doctor）+ L14（能力矩阵/降级）+ L15（失败修复对话）+ L16（能力发现）。
> **已有地基**：`app/governance/`、`app/evidence/`、`app/action_guard/`（egress 审计）、`app/agent_runtime/`（loop/tools）。

## Goal

六件规模化件：事件驱动感知订阅（L9）、感知权限与隐私（L10）、交互账本与 PointerBench 基座（L13）、能力矩阵与优雅降级（L14）、失败修复对话数据（L15）、目标条件化能力提示（L16）。全部以**数据/基础设施层**交付（UI 排除，但为 UI 提供后端数据契约）。

## Architecture 决策（冻结）

1. **变更流（L9）**：不做真实 UIA 事件接入（常驻宿主未建），建**事件订阅抽象层**：`SurfaceChangeEvent` 四类（structure/text/focus/property）+ 按窗口/元素订阅 + 节流 + 白名单 + 风暴保护（评审：别全局订阅）。事件源注入式。
2. **感知权限（L10）**：应用级黑名单在**感知前**拦截（连感知都不发生）；敏感内容（IsPassword/卡号/身份证）就地脱敏不进 context；本机不出网模式；权限粒度"应用×动作类"（capability_matrix 承载）。
3. **账本（L13）**：`InteractionLedger` 单条记录（turns/token 文本+视觉/各阶段延迟/证据层/置信度/是否走 look/成败/egress 事件引用）；PointerBench 任务清单 schema + 记录器 + 报告生成器（三方对比的采集基座，对比本身留真机）。
4. **失败对话（L15）**：`RepairPrompt` 数据生成器：失败归因（结构化 failure_type/evidence 状态）→ 人类可读文案 + 建议动作枚举（look/重指/选候选/重试）。UI 消费数据，不产生 UI。
5. **能力发现（L16）**：`capability_hints(target_type)` 返回 3-8 个 Hint（动作名+描述+触发轨迹 id）；数据来自轨迹缓存+工具目录。
6. 全部新文件模块化，不改批次 1/2 已有行为（除 registry 里注册 hint 工具可选）。

## Non-goals

真实 UIA 事件宿主接线、真实三方 PointerBench 跑分、UI 层、macOS、WGC。

## File structure

```
app/events/                  # L9
  __init__.py
  change_events.py           # SurfaceChangeEvent 判别联合 + 订阅契约
  subscription.py            # WindowSubscription：按窗口/元素、节流、白名单、风暴熔断
app/permissions/             # L10 + L14 共用
  __init__.py
  app_blacklist.py           # 默认感知黑名单（密码/银行/凭据/隐私）+ 规则匹配
  sensitive_detect.py        # 密码框/卡号/身份证模式脱敏
  offline_mode.py            # 本机不出网声明 + 生效开关
  capability_matrix.py       # 应用×能力×状态（可用/需解锁/不支持）+ 持久化
app/telemetry/               # L13
  __init__.py
  interaction_ledger.py      # 每次交互账单
  pointerbench.py            # 任务 schema + 记录器 + 报告生成器
  doctor_report.py           # /doctor 能力矩阵诊断报告
app/failure_flow/            # L15 + L16
  __init__.py
  repair_prompt.py           # 失败归因 → 修复对话数据
  capability_hints.py        # 目标条件化能力提示
tests/events_*_test.py
tests/permissions_*_test.py
tests/telemetry_*_test.py
tests/failure_flow_*_test.py
```

## Batch 3A：变更流（L9）与感知权限（L10）——并行

### Task A1：变更事件与订阅
**Files:** `app/events/change_events.py` + `app/events/subscription.py` + `tests/events_subscription_test.py`
- [ ] **Step 1** 失败测试：`SurfaceChangeEvent` 四类（structure_changed/text_changed/focus_changed/property_changed，各带 window_ref/element_ref/t_utc/args）；订阅器 `WindowSubscription`：subscribe(window_ref, kinds)` 只收该窗口指定类型；节流（同窗口同类型 100ms 内合并/丢弃）；白名单（未订阅窗口事件丢弃）；风暴熔断（1s 内 >N 事件 → 熔断 5s 不再下发，事件计数可查）
- [ ] **Step 2-4** 观察失败→实现→转绿 + commit `feat: add throttled window change subscriptions`

### Task A2：感知黑名单与敏感脱敏
**Files:** `app/permissions/app_blacklist.py` + `app/permissions/sensitive_detect.py` + `app/permissions/offline_mode.py` + `tests/permissions_privacy_test.py`
- [ ] **Step 1** 失败测试：黑名单规则（进程名/窗口标题模式/窗口类；内置默认：密码管理器、银行、凭据窗口、隐私模式浏览器）；`is_blacklisted(window_identity) -> BlacklistDecision(allowed, reason, rule)`；**感知前拦截语义**（测试断言调用方流程：blacklist 拒绝 → 不发感知请求）；敏感检测：`IsPassword` 标志、信用卡（16 位 Luhn）、身份证（18 位模式）→ `redact()` 返回脱敏文本（保留前后 4 位）；offline_mode：`is_offline()` / `set_offline(True)` → 断言影响面声明（模型端点/视觉端点禁用列表可查）
- [ ] **Step 2-4** 观察失败→实现→转绿 + commit `feat: gate perception by app blacklist and redact sensitive content`

## Batch 3B：账本与 Bench（L13）——并行

### Task B1：交互账本
**Files:** `app/telemetry/interaction_ledger.py` + `tests/telemetry_ledger_test.py`
- [ ] **Step 1** 失败测试：`LedgerEntry`（interaction_id/start_end_utc/turns/token_text/token_vision/各阶段延迟 dict/证据层/置信度/used_look/成功/egress_event_ids/失败类型）；`InteractionLedger.record/query(filter)/summarize()`（按日/按应用汇总：token 合计、p50/p95、逃生舱占比、成功率）；重复 interaction_id 拒绝
- [ ] **Step 2-4** 实现 + commit `feat: record per-interaction cost and latency ledger`

### Task B2：PointerBench 基座
**Files:** `app/telemetry/pointerbench.py` + `tests/telemetry_pointerbench_test.py`
- [ ] **Step 1** 失败测试：`BenchTask`（id/应用/目标/指代对象/期望结果/难度）；`BenchRun`（task_id/backend_tag[magic_pointer|screen_cua|human]/成功/端到端延迟/token 成本/指代准确率）；`PointerBench.record_run/load/save`（JSON 往返）；`generate_report()`：三方对比表 + 指标（成功率/延迟 p50/token/指代准确率）+ 缺失组诚实标注"未采集"
- [ ] **Step 2-4** 实现 + commit `feat: add pointer bench task and report base`

## Batch 3C：能力矩阵与 doctor（L14）——与 3B 并行

### Task C1：能力矩阵 + doctor 报告
**Files:** `app/permissions/capability_matrix.py` + `app/telemetry/doctor_report.py` + `tests/capability_matrix_doctor_test.py`
- [ ] **Step 1** 失败测试：`CapabilityEntry(app, capability[read_text|read_structure|write_back|precise_location], status[available|needs_unlock|unsupported], notes)`；`CapabilityMatrix.set/get/filter` + 持久化 JSON 往返；`doctor_report(matrix, checks) -> DoctorReport`：能力矩阵表 + 健康检查汇总（UIA 宿主/OCR 预热/模型端点）——checks 注入式（成功/失败/未知三态），未知 ≠ 失败
- [ ] **Step 2-4** 实现 + commit `feat: expose per-app capability matrix and doctor report`

## Batch 3D：失败对话与能力发现（L15/L16）——与 3B/3C 并行

### Task D1：失败修复对话数据
**Files:** `app/failure_flow/repair_prompt.py` + `tests/failure_flow_repair_test.py`
- [ ] **Step 1** 失败测试：`RepairPrompt.build(failure: ActionFailure | None, evidence_status: EvidenceStatus | None, target_type: str | None) -> RepairSuggestion`（title 归因文案/actions 建议枚举：use_look/repick/rechoose_candidate/retry/explain_what_failed/ask_user）；映射表：timeout→use_look+retry；empty_confirmed→repick；ambiguous→rechoose_candidate；stale_anchor→repick；unsupported→explain_what_failed；文案不得空、必须含归因（评审：不能转圈然后消失）；`RepairSuggestion.to_dict` 供 UI
- [ ] **Step 2-4** 实现 + commit `feat: generate attributed repair suggestions on failure`

### Task D2：目标条件化能力提示
**Files:** `app/failure_flow/capability_hints.py` + `tests/failure_flow_hints_test.py`
- [ ] **Step 1** 失败测试：`hints_for(target_type: str, trajectories, registry) -> list[Hint]`（3-8 个）；target_type 映射：text_selection→[翻译/解释/改写/扩写/压缩]；table_region→[转表格/求和/排序]；file_line→[打开/重命名/发给]；image→[图转提示词/描述/OCR]；未知类型→默认清单（解释/翻译/总结）；每个 Hint(动作/描述/触发轨迹 id 或 None)；数量钳制 3-8；数据来源：trajectories（recipe_cache）+ registry 工具描述
- [ ] **Step 2-4** 实现 + commit `feat: derive target-conditioned capability hints`

## Batch 3E：集成与验证

- [ ] **T E1** 集成测试 `tests/batch3_integration_test.py`：黑名单拦截→账本记录→修复建议生成全链；bench 报告生成含"未采集"诚实标注
- [ ] **T E2** 全量回归：`npm test` + typecheck + lint + 全量 pytest
- [ ] **T E3** 更新 STATUS.md + 设计账本（批次 3 完成）
- [ ] **T E4** commit `feat: ship scale batch (events, permissions, ledger, bench, hints)`

## Plan self-review checklist

- [ ] 每行为有前置失败测试；不改批次 1/2 行为。
- [ ] 黑名单在感知前拦截；脱敏后不保留原文。
- [ ] 账本含文本/视觉 token 分开；bench 缺组诚实标注。
- [ ] doctor 未知 ≠ 失败；修复文案必须含归因。
- [ ] 不启动 Electron UI；每 Batch 及时提交。
