# Perception Broker and InputArtifact Foundation Implementation Plan

> **执行说明：**本计划是 [主权 Agent 后端重构蓝图](../../research/2026-08-17-magic-pointer-sovereign-agent-backend-blueprint.md) 的第一批代码。它只改一条纵向链：冻结帧之上的结构感知并发收集，编译为自有 Runtime 实际消费的 InputArtifact。它不启动 Electron，不实现 GUI，不重写 session，不引入第二套 Agent。

**目标：**让生产 selection → Agent loop 路径不再使用“第一个非空 adapter 即胜出”的串行感知，并让模型收到的独立 data 消息来自一个有版本、可投影、可返回给上层的 InputArtifact，而不是临时拼接的 evidence 字符串。

**架构：**保留现有 AdapterReadContext、FrameLease 和 selection bridge 外部协议。新增一个深的 `PerceptionBroker`，并发调用所有匹配的结构 provider，把结果归一为 typed observation，稳定排序后融合；现有 `resolve_structured_perception()` 变成兼容 seam。新增 `InputArtifact` 领域对象；`selection_bridge._loop_router()` 从已绑定的 snapshot、app context 与 command 编译 artifact，其 model projection 继续通过既有 `origin=data` 消息进入 loop，避免同时重写 Loop API。

**技术栈：**Python 3 dataclasses、`concurrent.futures.ThreadPoolExecutor`、现有 Evidence contract、pytest；不新增依赖。

---

## Task 1：先固定并发感知契约（RED）

**文件：**

- 新建：`tests/perception_broker_test.py`
- 读取：`app/adapters/base.py`
- 读取：`app/grounding/perception_cascade.py`
- 读取：`app/evidence/contract.py`

### Step 1：写并发与完整收集失败测试

建立两个 synthetic adapter：各睡 120ms，都返回不同的可用结构。断言：

- 两个 adapter 均被调用一次；
- 总耗时明显小于串行和（阈值留 Windows 调度余量）；
- selected context 按既有 priority 决定，不按完成先后；
- trace 同时含两个 observation/attempt。

### Step 2：写失败状态诚实性测试

覆盖：

- adapter exception → `error`；
- `error="uia probe timed out"` → `timeout`；
- `error="worker busy"` → `busy`；
- 一个 timeout + 一个 success 时仍选择 success，但不丢 timeout；
- 全 timeout/busy 时 selected context 为 `None`，不能标成 confirmed empty。

### Step 3：写稳定排序与冲突测试

让低优先级 adapter 先返回、高优先级 adapter 后返回，多次运行：

- trace observation 顺序始终按 candidate priority/name；
- 两个互不包含的正文产生 `content_disagreement`；
- 容器名与正文同时出现时正文胜出，容器 observation 保留且降级。

### Step 4：运行测试并确认预期失败

运行：

```powershell
python -m pytest tests/perception_broker_test.py -q
```

预期：因为 `app.perception` 尚不存在，测试在 collection/import 阶段失败。确认是缺失实现，不是测试语法问题。

---

## Task 2：实现 typed observation 与并发 Broker（GREEN）

**文件：**

- 新建：`app/perception/__init__.py`
- 新建：`app/perception/broker.py`
- 修改：`app/grounding/perception_cascade.py`
- 测试：`tests/perception_broker_test.py`

### Step 1：定义最小 observation

`StructuredObservation` 只拥有当前批次需要的字段：

- candidate index；
- layer / adapter / method；
- `EvidenceStatus`、confidence、latency；
- container hint 与 reason；
- 原 `AdapterReadContext`（只在进程内使用）；
- 不含 raw context 的 `to_trace_dict()`。

复用 `app.evidence.contract.EvidenceStatus/EvidenceSource/Evidence`，不再创造第二套状态枚举。

### Step 2：实现 adapter → observation 归一

规则：

- exception 为 error；
- error 文本按 timeout/busy/unsupported/denied 映射；
- 有可用结构但附带 error 为 degraded；
- 无 error、无结构为 empty_confirmed；
- 单行内容等于窗口 title/process/class 时应用 container heuristic；
- priority 只用于稳定 selection，不允许提前结束采集。

### Step 3：实现并发 collect

- 0 个 candidate 返回 unavailable trace；
- 1 个 candidate 可直接调用，避免无意义线程池；
- 多个 candidate 同批提交到最多 4 个 worker；
- 按 candidate index 收集结果，完成次序不改变输出；
- 本批不增加一个与 provider 内部 timeout 竞争的全局 timeout。

### Step 4：实现最小 fusion

- 首选 usable、非 container、低 priority observation；
- 其次 usable container；
- 其余无 selected context；
- 所有 observation 都进入 trace；
- 多个正文既不相同、也互不包含时记录结构化 conflict；
- trace 保持现有字段以兼容 selection bridge，并增加 `observations/conflicts/elapsedMs`。

### Step 5：把旧 resolver 改为兼容入口

`resolve_structured_perception()` 只负责匹配/排序 candidate，然后调用 Broker；`append_perception_attempt()` 保持 API。删除旧 serial first-usable 循环，不保留 feature flag。

### Step 6：运行新测试和既有 selection 测试

```powershell
python -m pytest tests/perception_broker_test.py -q
python -m pytest tests/selection_snapshot_bridge_test.py tests/frame_lease_selection_bridge_test.py -q
```

预期：新契约通过；若既有测试假定“第二 provider 永不调用”，应根据产品真相改为“均调用但高质量结果稳定选中”，不能为了旧实现恢复提前返回。

---

## Task 3：固定 InputArtifact 契约（RED）

**文件：**

- 新建：`tests/input_artifact_test.py`
- 读取：`scripts/selection_bridge.py`
- 读取：`app/fabric/context_packet.py`

### Step 1：写构建与验证失败测试

断言：

- gesture-bound snapshot 缺 `frameLeaseId` 时拒绝构建；
- 纯文字任务允许没有 gesture/frame lease；
- artifact id、revision、utterance、target、facts、conflicts、display 均稳定序列化；
- selection content 和关键结构事实保留；
- raw UIA tree、raw evidence、无关节点不会进入 model projection。

### Step 2：写 display projection 测试

断言后端投影能直接告诉 GUI：

- 标题、摘要、source badges；
- confidence；
- 是否需确认；
- preview artifact；
- conflict 数量。

### Step 3：写生产接入测试

对 `_loop_router()` 的既有 fake harness 路径增加断言：

- `evidence_input` 是 InputArtifact model projection；
- 返回结果含 public `inputArtifact`；
- 屏幕内容仍通过独立 `origin=data` 消息，不拼入 command。

### Step 4：运行并观察失败

```powershell
python -m pytest tests/input_artifact_test.py -q
```

预期：缺少 `app.input_artifact` 导致 import/contract 失败。

---

## Task 4：实现并接入 InputArtifact（GREEN）

**文件：**

- 新建：`app/input_artifact/__init__.py`
- 新建：`app/input_artifact/schema.py`
- 修改：`scripts/selection_bridge.py`
- 测试：`tests/input_artifact_test.py`
- 测试：相关 `tests/selection_bridge_*`

### Step 1：实现纯领域对象

使用 frozen dataclass：

- `InputTarget`
- `InputFact`
- `InputConflict`
- `InputDisplay`
- `InputArtifact`

提供：

- `to_public_dict()`：可给 GUI/CLI；
- `to_model_dict()` / `to_model_text()`：最小充分 data 投影；
- `compile_input_artifact(command, target_window, app_ctx, snapshot)`：唯一 bridge builder。

不在类内读取文件、不查 UIA、不调用模型。

### Step 2：复用现有 snapshot 真相

- id 从 selection snapshot id 派生；无 snapshot 时用 run-local UUID；
- gesture 和 frame lease 只引用现有值，不晚截图；
- target bounds 优先 selection bbox，其次 context rectangles；
- facts 从精确 selection content 与有限结构字段生成；
- conflicts/source badges 来自新 perception trace；
- display 不泄露 raw evidence。

### Step 3：接入自有 loop

在 `_loop_router()` 创建 artifact：

- `first_input` 仍是纯 command；
- `evidence_input` 改为 artifact model text；
- loop mapping 增加 public artifact；
- normal/local/failure 返回尽可能透传同一 artifact，不另建第二份。

### Step 4：运行定向测试

```powershell
python -m pytest tests/input_artifact_test.py tests/perception_broker_test.py -q
python -m pytest tests/selection_bridge_runtime_test.py tests/selection_snapshot_bridge_test.py tests/frame_lease_selection_bridge_test.py -q
```

若实际测试文件名不同，先用 `rg --files tests | rg 'selection.*bridge|loop_router'` 找现有最小集合；不运行与失败无关的大范围检查来碰运气。

---

## Task 5：删除第一批旧形状并检查调用图

**文件：**

- 修改：`app/grounding/perception_cascade.py`
- 修改：`scripts/selection_bridge.py`
- 可能修改：相关测试 fixture

### Step 1：确认 serial loop 已消失

```powershell
rg -n "for adapter in candidates|return StructuredPerceptionResult" app/grounding/perception_cascade.py app/perception
```

预期：旧文件不再包含 first-usable serial loop；返回只发生在 Broker/fusion 的明确边界。

### Step 2：确认 InputArtifact 有生产 caller

```powershell
rg -n "compile_input_artifact|to_model_text|inputArtifact" app scripts tests
```

预期：`scripts/selection_bridge.py` 是真实 caller，不是只有 tests。

### Step 3：检查 Evidence contract 不再完全孤立

```powershell
rg -n "EvidenceStatus|apply_container_heuristic|Evidence\(" app/perception app/grounding
```

预期：新 Broker 复用现有 evidence 语义。

---

## Task 6：全量验证、设计账本与本机交付

**文件：**

- 修改：`docs/design/MAGIC_POINTER_HARNESS_20260811.md`
- 修改：`docs/STATUS.md`
- 修改：`package.json`（若本批改变可感知行为则 patch +1）

### Step 1：运行新旧相关测试

先运行定向集合，失败时只修本批引入或暴露的真实回归。

### Step 2：运行仓库规定的 fresh full verification

从 `package.json` 和现有 STATUS 读取当前标准命令，执行 Python、Node、typecheck/build 的完整集合。记录每条命令、通过数、耗时和未覆盖的真实机器验证。

### Step 3：更新 canonical progress ledger

只写已完成事实：

- structured adapters 是否已并发；
- Evidence contract 是否进入生产；
- InputArtifact 是否被 loop 实际消费；
- OCR/视觉是否仍未进入同一 Broker；
- resident surface host 是否仍待下一批。

不能把“结构 provider 并发”夸成“全部 UIA/DOM/COM/OCR/vision 已统一并发”。

### Step 4：同步安装版

若 `selection_bridge` 返回或 Agent 输入行为有可感知变化：

1. `package.json` patch version +1；
2. `npm run sync`；
3. 读取 `%LOCALAPPDATA%\Programs\Magic Pointer\resources\app\package.json` 核对版本；
4. 在 STATUS 写明交付版本。

不启动 Electron 做探索性查看；`npm run sync` 按仓库交付规则负责安装与重启。

---

## 本批完成定义

只有同时满足以下事实才算完成：

1. 同一窗口的所有匹配 structured adapters 在生产 resolver 中并发读取；
2. timeout/busy/error/empty 不再压成同一种“没读到”；
3. trace 保留所有来源和冲突，selection 稳定且不受完成先后影响；
4. 自有 loop 实际消费 InputArtifact 的 data projection；
5. GUI/CLI 可从返回对象读取同一 artifact 的 display projection；
6. command 与 evidence 仍保持 instruction/data 隔离；
7. FrameLease 的 fail-closed 行为和既有选择桥测试无回归；
8. fresh full verification 通过，并完成本机同步交付。

