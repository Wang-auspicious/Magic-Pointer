# 感知 provider 协议与 fusion 接缝（蓝图 §7 / §13.1 / Gate 1 收尾）

> 前置：`docs/research/2026-08-17-magic-pointer-sovereign-agent-backend-blueprint.md` §7、§13.1、§15.2、§17。
> 上一批（1.0.9–1.0.11）已经把结构适配器改成并发 broker 并加了裁决 deadline。本批补的是它缺的那一半。

## 为什么现在做，而且必须和第二类 provider 同批做

蓝图 §13.1 把 `app/perception/providers.py` 与 `app/perception/fusion.py` 标为第一批实现，实际二者都不存在。但"补两个文件"不是本批的目的——**只有一个实现的抽象不合格**（§17 硬律 4）。真正要修的是三处生产事实：

1. **Explorer 是无条件短路的前置步骤。** `capture_snapshot` 先跑 `read_explorer_file_context()`，返回非 None 就直接接管 `app_ctx` / `perception_trace` / `gesture_grounding`，通用链一次都不跑。在资源管理器里，UIA 永远没有机会印证或反驳它。
2. **SurfaceAdapter 命中会丢掉整份 observations。** `perception_trace = _surface_adapter_trace(surface_ctx)` 直接覆盖 broker 的 trace——broker 刚刚并发采集到的全部 observation（含 timeout/busy/container_hint）在这一行消失。这不是"优先级"，是证据丢失。
3. **OCR 在另一个进程里当串行兜底。** 冻结帧在 `capture_snapshot` 里 pointerup 就已校验可用，但 OCR 直到 `selection_bridge._enrich_screen_region_context()` 才跑，条件是 `structured_covers_mark == False`。后果：UIA 返回容器名（`...\powershell.exe`）时，容器观测的内容被**丢弃**并整体替换成 OCR 上下文——不是"正文压过容器名"，而是"没人知道曾有两个来源"。

三处的共同形状是：**裁决写在命令式 if/else 里，赢家覆盖输入而不是加入证据集。** provider 协议要替代的就是这个，不是给 `read_context()` 起个新名字。

## 范围与非范围

做：
- provider 协议 + descriptor + typed observation（蓝图 §7.2 的 `EvidenceObservation` 形状，v1 用 frozen dataclass + JSON-safe payload，不做泛型框架）。
- fusion：typed observations → 选中项 / 冲突 / 印证 / trace 投影。裁决规则含 mark 覆盖与 container hint，把今天散在两个 bridge 里的命令式补丁收进一处。
- 四个 provider 实现，两个 tier：adapter bridge（结构）、Explorer（结构）、SurfaceAdapter（结构）、冻结帧 OCR（像素）。
- 生产接线：snapshot bridge 一次 fan-out；selection_bridge 用同一 fusion 补像素 tier。

不做：
- 不把 OCR 塞进 pointerup 的阻塞路径。冻结帧 OCR 在暖 worker 上 1–3s，塞进 snapshot 会把"释放后 194ms 出现输入框"变成秒级——那是拿真实交互延迟换架构整洁。像素 tier 仍在回答阶段跑，但它跑的是**同一个 plan 的第二 tier、同一个冻结帧、同一个 fusion**，而不是另一套 if/else。
- 不动 GUI 视觉、不重写 session store、不引入 Vision provider（视觉模型按 §7.3 只在结构冲突/全不可用/任务本身要视觉语义时启动，属于下一批）。
- 不留 feature flag 双跑：旧路径在新路径承担全部生产 caller 后当批删除。

## tier 不是"第一个非空即胜出"的换皮

两者的区别必须写清楚，否则这批就是白做：

| | 今天 | 本批 |
|---|---|---|
| 谁决定用像素 | `structured_covers_mark == False` 一个布尔 | fusion 对全部 typed observation 排序（覆盖 mark > 非容器 > 非降级 > tier > priority > confidence） |
| 结构证据的下场 | 被 OCR 上下文整体替换，内容丢弃 | 留在 observations 里，带 container_hint 与 coverage_reason |
| 两个来源都读到东西 | 后者覆盖前者，无人知道 | 一致 → 印证并叠加来源徽标；不一致 → 显式 conflict |
| 同 tier 内 | Explorer/Surface 互相短路 | 同一次并发，谁都不短路谁 |

tier 只决定**愿意为一个来源等多久 / 值不值得启动它**（蓝图 §7.3 明确允许："OCR 使用冻结帧…可根据区域大小与表面先验启动"），不决定谁的证据可信。

## 测试先行（必须先看到失败）

1. Explorer provider 与通用结构 provider 在同一次 fan-out 里都被调用；Explorer 命中不阻止另一个来源产生 observation。
2. SurfaceAdapter 命中后，broker 已采集的 observation 仍在 trace 里（今天为 0 条）。
3. UIA 只给容器名、OCR 覆盖 mark：选中项是 OCR，容器观测仍在且 `container_hint=True`，trace 有 `structured_container_superseded`，**不**伪造 content_disagreement。
4. UIA 给正文且覆盖 mark、OCR 给近似同一段文本：判为印证，来源徽标含两个，无 conflict。
5. 同上但两段文本实质不同：显式 content_disagreement。
6. 结构 tier 干净命中时，像素 provider 一次都不被调用（不烧无谓 OCR CPU）。
7. 结构 tier 全 busy/timeout 时不得伪装 `empty_confirmed`，且像素 tier 会被启动。
8. 跨进程：从 snapshot trace 复原 tier-1 observation + 新增像素 observation → 同一 fusion 得出与单进程一致的裁决。
9. 冻结帧缺失时，`requires_frozen_pixels` 的 provider 不进 plan（诚实记为 unsupported，不实时抓屏）。

## 顺序

1. `app/perception/providers.py` + `app/perception/fusion.py` + `broker.py` 重写（结构 tier 行为不变，现有 `perception_broker_test.py` 保持绿）。
2. `app/perception/pixel_ocr.py`：冻结帧 OCR provider，从 `selection_bridge` 迁出 worker 客户端与 mark 过滤。
3. snapshot bridge 接线：Explorer/SurfaceAdapter/gesture 结构策略三个 provider 一次 fan-out，fusion 出裁决与 trace。
4. selection_bridge 接线：复原 tier-1 observation + 跑像素 tier + 同一 fusion；删 `_enrich_screen_region_context` 的兜底判定。
5. 全量验证 → 版本补丁号 → `npm run sync` → STATUS 与蓝图进度账本。
