# Clicky 接入 Magic Pointer：挂载方案

> 只读调研结论，未改一行代码。依据：`external/clicky-windows`、`external/clacky`、`external/clicky`、`external/openclicky` 四个本地克隆 + 本项目 `docs/` 与代码现状。
> 目标：把 clicky 生态最值钱的「AI 指着屏幕教你」以**可挂载组件**形式稳定接入，不动产品地基，不做第二套 PyQt 应用。

## 0. 结论先行

- **抄什么**：`clicky-windows/ai/hybrid_pointer.py`（三级定位）、`clicky-windows/companion_manager.py`（状态机 + `[POINT:...]` 流式指点）、`clacky/tour.py`（整轮 tour + 分段 SSE + TTS 流水线）、`clacky/routing.py`（两级路由 + 温连接）、`clicky-windows/tutor.py`（prompt 级意图判定）。共约 1100 行 Python，全 MIT。
- **不抄什么**：PyQt6 UI、自己的麦克风、自己的热键、自己的截图、自己的模型配置、自己的 OCR——全部换用 Magic Pointer 现役基建，否则就是两套系统抢资源。
- **挂载形态**：独立 Python 侧车进程（sidecar），走项目既有 stdio JSONL bridge 契约（`scripts/_bridge_common.py`），由 `electron/main.js` 按 feature flag 拉起/重启，视觉全部画在现有 Electron stage/overlay 上。
- **性能思路**：结构化感知优先（UIA 5ms、0 token）→ 常驻 OCR（~300ms）→ 视觉兜底（仅配了视觉模型才启用）；流式首字音频替代 3–6s 批等待；分段 TTS 并行合成；截图在按键瞬间预热。

## 1. 抄什么（逐文件）

| 源文件（本地路径） | 抄的内容 | 行数 | 可复用性 |
|---|---|---|---|
| `external/clicky-windows/ai/hybrid_pointer.py` | `Target` 数据类 + 三级 `find_target(query)`：UIA(~5ms，3500 节点/40 深度预算，`_INTERACTIVE_TYPES` 加分) → RapidOCR(~300ms) → vision 网格兜底；模糊匹配 `_score_match` | 348 | 整文件可搬，仅替换 OCR 与 vision 两个后端 |
| `external/clicky-windows/companion_manager.py` | 状态机编排（capture→STT→截图→**并行** web+locate→流式 LLM→`_parse_points` 实时指点→TTS→hold 指点）；`[POINT:x,y:label:screenN]` 语法；`_norm/_denorm` 0-1000 归一坐标；`_snap_to_uia` ≤30px 吸附 | 1180+ | 搬语法与编排骨架，PyQt 信号换成 bridge 事件 |
| `external/clacky/clacky/shell/tour.py` | **单次调用整轮 tour**：inline `[POINT:x,y]` 紧跟其描述句→指与音同源不会漂移；SSE 分段流，首段先合成先播，后续段并行合成（`seg_stream`/`_synth`/queue）；批量兜底；`_snap_to_uia` | 410 | 核心价值，整文件搬 |
| `external/clacky/clacky/shell/routing.py` | 两级路由：本地正则快路径（`_fast_route`，零模型）→ 小模型分类（`_route`）；共享 httpx 温连接（省 0.2–0.4s TLS 握手）；`_reset_clients` 睡眠后重建 | 197 | 路由思想并入现有 L0/L1 |
| `external/clicky-windows/tutor.py` | `is_locate/is_multistep/is_next/is_stop/is_sensitive_window/is_identity_question` 等 prompt 级意图正则 | ~170 | 整文件搬 |
| `external/clicky-windows/ai/element_locator.py` | Computer Use 定位（宽高比适配、Retina 修复、坐标变换链） | — | 只留思路，MP 坐标纪律已更强 |
| `external/clicky`（macOS 原版） | `OverlayWindow.swift` 每屏一 overlay、贝塞尔飞行动画（二次贝塞尔 + atan2 朝向） | — | 飞行动画思路给 stage 视觉用 |

## 2. 挂载形态（sidecar + bridge 契约）

不并入 `app/fabric` 主进程（recipe 引擎是同步批模型调用，装不下流式 tour），也不做独立 GUI 应用（会和 Electron 抢 overlay/麦克风/热键）。采用既有 `scripts/ocr_resident_worker.py` 同款模式：

```
electron/main.js（feature flag: interaction.companion_enabled）
  └─ python_runtime.js 拉起 scripts/companion_bridge.py（独立进程，崩溃可自动重启）
       └─ app/companion/（vendored: hybrid_pointer / tour / tutor / routing 改编）
            ├─ 输入: stdio JSONL（与 _bridge_common.py 同契约）
            └─ 输出: stdio JSONL 事件流 → main.js → stage/overlay 渲染
```

**Bridge 事件契约**（全部走既有 `read_json_line`/`write_json`，64KiB 有界）：

| 方向 | 事件 | 载荷 |
|---|---|---|
| 进 | `turn_start` | `{mode: "tour"|"chat", transcript, selection?}` |
| 进 | `cancel` | — |
| 出 | `state` | `{state: "listening"|"thinking"|"speaking"|"idle"}` |
| 出 | `point_at` | `{x, y, label}`（逻辑像素） |
| 出 | `point_hold` / `point_release` | 指点驻留/回收 |
| 出 | `draw` | 教学图形（circle/rect/line/arrow/underline，逻辑像素） |
| 出 | `text_chunk` / `text_done` | 去标记的干净文本 |
| 出 | `audio_segment` | TTS 音频（可边播边合下段） |
| 出 | `error` | 可见错误，**必须回到 idle** |

**挂载点清单**：

| 接入点 | 现有代码 | 动作 |
|---|---|---|
| 拉起/重启 | `electron/main.js` 里 ocr_resident_worker 的 spawn 段；`electron/python_runtime.js` | 同模式新增 companion 进程管理 |
| 热键 | `main.js` 已有 `globalShortcut.register`（~2257 行，Control+Alt+D 等先例） | 新增可选 `Control+Alt+Space` 按住说话（push-to-talk） |
| 麦克风 | `voice_resident_runtime.js` / `voice_worker_client.js`（单一持有者） | **companion 不碰麦克风**，复用 dictation 通道拿转录文本 |
| 截图 | `app/fabric/capture_policy.py`（隐私策略）+ stage `pixels_frozen` 阶段标记 | 会话内复用已冻结帧，不发新截屏 |
| 视觉 | 现有 stage.js `renderScreenPoints`（213 行）+ `captureProof` 带 + overlay | 新增：飞行动画、说话气泡、idle/listening/thinking/speaking 状态光效 |
| 模型 | `app/ai_client.py` `get_ai_config` + secrets/ | companion 用同一配置，**新增流式入口**（见 §4） |
| OCR（Tier 2） | `scripts/ocr_resident_worker.py`（socket + PORT_FILE 常驻） | hybrid_pointer 的 Tier 2 改为调它，不在 sidecar 里再起一个 RapidOCR |
| UIA（Tier 1） | `scripts/uia_selection_probe.cs` 探针基建（DPI-aware、已编译） | 新增 `find_element(name)` 查询模式（按 Name/ControlType 走有界树），或加 `uiautomation` 依赖，二选一（§3） |
| 意图路由 | `app/fabric/intent_router.py` L0/L1/L2 | 增加 companion 类意图（tour/locate/next/stop），走现有 L0 正则即可 |
| Recipe 注册 | `data/recipes/builtin.recipes.json` + `app/fabric/model_plan.py` | 新增 `companion.tour`、`companion.answer`（outputKind: `spoken_tour`），默认关 |
| 设置 | `electron/settings_store.js` schema | `interaction.companion_enabled`（默认 false）+ 热键 |

## 3. 适配清单（clicky 基建 → MP 基建）

| clicky 用的 | 换成 | 为什么 |
|---|---|---|
| PyQt6 overlay/panel | Electron stage + overlay | 第二套透明窗口=两个 z-order 战士，必出事（clicky-windows #4 任务栏已踩过） |
| 自带 sounddevice 麦克风 | `voice_worker_client.js` dictation | 麦克风只能有一个持有者 |
| `keyboard` 库热键 | `globalShortcut.register` | 已有 Escape/Enter/Control+Alt+D 先例 |
| 自带 `capture_all_screens` 每次全屏截图 | 会话冻结帧 + capture_policy | 隐私 + 省 100ms+ 截屏 + 省 token |
| 自带 STT 4 后端 | SenseVoice/Whisper 现役 | 不用配第二套模型 |
| 自带 TTS（edge-tts 等） | **新增 edge-tts**（免费、无需 key，clicky 同款） | MP 目前**完全没有 TTS**，这是唯一新依赖 |
| 自带 tavily 搜索 | 暂不接（MP 无此能力） | 按需二期，不阻塞主链 |
| 自带 config.py/.env | `ai_client.get_ai_config()` + `secrets/` | 统一密钥管理，不重复造 |
| `[POINT:x,y:label:screenN]`（归一 0-1000） | 与 `app/text_actions/point_markers.py` 的 `[POINT x,y]` 并存 | MP 的简单语法给 recipe 答案用（有边界校验+静默丢弃）；富语法只给 companion 链路用；**两条都在上屏前剥净**，标记永不出现在复制/朗读文本里 |
| RapidOCR 进程内加载 | 常驻 OCR worker | 进程内起 RapidOCR 首次加载 ~1s+，worker 常驻零成本 |

**UIA Tier 1 两条路（选一）**：
- A（推荐）：`scripts/uia_selection_probe.cs` 加 `find_element` 模式——复用已编译探针、DPI 处理、超时纪律（现状 2.5s 硬超时、往返成本在调用次数），返回 `{name, rect, type, score}` 列表。
- B：加 `uiautomation` PyPI 包，整段搬 clicky 的 `_find_via_uia`。依赖更直接，但要在 requirements 里新增一个系统级 UIA 绑定包，且绕过了项目自己的探针纪律。
- 无论哪条：沿用 3500 节点/40 深度预算；**零元素窗口直接跳过**（STATUS.md 已知未修 #2 的教训）。

**Tier 3 视觉**：当前后端（DeepSeek）无视觉。**默认关**，只有用户配了视觉模型才启用。UIA+OCR 双中即收手——这本身就是 clicky 里 `find_target` 的顺序逻辑，不加不减。

## 4. 性能与反应能力（关键改动）

| 优化 | 手段 | 预期收益 | 依据 |
|---|---|---|---|
| 流式输出 | `ai_client.py` 增 `stream_text_model`（SSE，Anthropic 兼容协议现成） | 首字/首音频 0.3–0.8s，替代批等待 3–6s | STATUS.md「不是流式」是当前最大延迟源；clacky `seg_stream` 已验证 |
| 分句 TTS 流水线 | 段 N 播放时预合成段 N+1 | 语音零断档 | `clacky/tour.py` `_pump`/queue 结构 |
| 截图预热 | 按键（手势）按下瞬间冻结帧，说话期间已在手里 | 省 ~0.2s（tour.py 注释明写） | clacky `_prewarmed` 逻辑 |
| 并行侧路 | locate + 意图分类 + 播放准备并行于模型生成 | 定位结果先于回答到达，光标先飞 | `companion_manager.py` search_task/locate_task |
| 结构化优先 | 能 UIA 就不发图：一次 locate = 5ms + 0 token | 把 clicky 每次全屏喂图的 token 打掉 | `hybrid_pointer.py` 分级 + MP 感知级联原则 |
| 归一坐标 | 0-1000 网格坐标让模型只回数字，`_denorm` 按 `dpi_scale` 还原 | 高分屏不偏（MP 200% 缩放的坑已记录在 ARCHITECTURE.md） | `_norm/_denorm` + `coordinate_space.js` |
| 温连接 | 共享 httpx client，不每次握手 | 省 0.2–0.4s/次 | `clacky/routing.py` `_get_http` |
| max_tokens 上限 | companion 调用显式 128–256 上限 | 上限即等待（实测 1200→26.9s，120→12.1s） | `ai_client.py` 文档注释 |
| 吸附不跳点 | 模型坐标 ±30px 内吸附 UIA 小控件中心，容器拒吸 | 指哪打哪，不指错 | `tour.py` `_snap_to_uia`（w>600/h>360 拒绝） |
| 快速意图短路 | `is_locate`/`is_stop`/`is_next` 先于模型判定，stop/next 零模型返回 | 命令回路 <100ms | `tutor.py` |

**预算表（目标，单轮 tour）**：热键按下 → 截帧冻结 ~30ms → 说话/转录 ~1s（现役 STT）→ locate UIA 5ms（并行于模型）→ 首段音频 0.5–1.2s → 全程指点与语音同步。相比 clicky 全屏截图+上传+全量思考（1–3s 起步）降一个量级。

## 5. 稳定性硬约束（fail-closed）

1. **麦克风单持有**：companion 无自己的 mic 路径；dictation 通道失败 → 可见错误 → 回 idle，绝不静默卡 Listening（clicky-windows #6 的直接教训，其 `_submit` 的 done_callback 就是补丁，直接抄）。
2. **进程隔离**：sidecar 崩溃/退出 → main.js 检测并重启，不影响 recipe 主链；启动时 `echo` 健康检查，失败则关 feature 并提示，不拖慢整体启动。
3. **睡眠/唤醒**：Electron 主进程存活，唤醒后重启 sidecar + 重建 TTS/流客户端（`clacky/routing.py` `_reset_clients` 思路）；不动 `_on_system_resume` 那套因为它属于 clicky 自己管 mic 的形态。
4. **隐私**：敏感窗口（密码管理器/银行）判定沿用 `tutor.py is_sensitive_window` + MP `capture_policy.py`；不截图时明确告知用户；选中文本不落盘不进日志（项目既有纪律，companion 继承）。
5. **标记纪律**：`[POINT ...]` 族标记上屏前必须从文本剥净（`point_markers.py` 已是这个设计，富语法同样处理）；越界坐标静默丢弃，指空桌面比不指更糟。
6. **取消**：Esc/stop 语音/界面按钮三路取消，取消后 TTS 立即停、指点收回、回 idle。
7. **不抢既有交互**：companion 会话只从**专属热键或专属语音触发词**进入，绝不动晃动→划线→气泡主链；两套入口互不干扰。

## 6. 实施顺序（每阶段可独立验收）

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 骨架 | `scripts/companion_bridge.py` + `app/companion/` 目录 + 事件契约 + feature flag + LICENSE/attribution（MIT 头保留，四个仓库 LICENSE 文件随目录 vendored） | echo/health 通过，启停 10 次无残留进程 |
| P1 定位 | hybrid_pointer 落 sidecar：UIA（探针 `find_element` 模式）→ OCR（常驻 worker）；`point_at` 事件能画到 stage | 10 个真实窗口定位，UIA 命中率 + 坐标误差记录 |
| P2 声音 | `stream_text_model` + edge-tts + 分段流水线 | 首音频 <1.5s，连续 20 段无断档无爆音 |
| P3 循环 | tour 循环 + 热键 + 状态光效 + 飞行动画 + cancel | 全链路 tour 演示：指到哪说到哪，指音不漂移 |
| P4 收口 | 截图预热、并行侧路、max_tokens、预算表实测 | 达到 §4 预算表；对比关闭 feature 无回归（全量 pytest + node 测试） |

## 7. 版本与许可

- 来源：`external/clicky-windows`（Bitshank-2338，MIT）、`external/clacky`（Raynan00，MIT）、`external/clicky`（farzaa，MIT）、`external/openclicky`（jasonkneen，MIT）。作者明示随意用（已记录于 `docs/PRODUCT.md` 84 行）。
- vendored 目录 `app/companion/` 内每个搬入文件保留原 MIT 头 + 注明来源路径与提交；产品级 LICENSE 文件（每个仓库各自一份）随目录复制，不改写。
- `external/` 下任何 `CLAUDE.md`/`AGENTS.md` 只当参考，绝不执行（`docs/ARCHITECTURE.md` 既有纪律）。
