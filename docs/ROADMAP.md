# 下一步

> 这是**依赖顺序**，不是排期。没有发布日期——哪天用户自己天天在用了，哪天就是发布了。
> 目标是完成度：功能全、无大 bug、快、美、生态闭环、用两周就离不开。**不要再引入"MVP / 先砍后补"叙事。**

## 三条执行纪律（覆盖一切默认行为）

1. **不死磕。** 任何单点（尤其是性能）做到"可用"就停：记一条 TODO（写清当前数字、剩余空间、下一步思路），立刻切下一项。延迟做到百毫秒量级就走人，别为最后 50ms 耗三天。
2. **持续提交，没有"大版本"。** 每个功能真机验过就提交，主分支永远可跑。
3. **兜底智能，永不说"不支持"。** 规则覆盖的走快路径，规则外的落到通用模型路径。"列出来的功能能做、稍有偏差就死"是最不可接受的状态。

## P0 — 这一条主线，不要旁开

**把首笔手势、C# 元素框、像素候选图合并成一条链。**

现在是两条：`element_probe_bridge.py` 只在 Stage 打开后再次点击时才用；第一次划线拿不到候选框。应该让常驻 native host 在**第一次手势提交时**就返回 `candidates / selected / score / margin / provider`，接进 `selection_snapshot_bridge.py`。融合算法见 [ARCHITECTURE.md](ARCHITECTURE.md#手划线与精准框应该怎么融合设计方向尚未实现)。

配套四件：

1. **微信/Qt/Flutter 的生产像素候选服务。** C# WGC 常驻帧环；先问 MSAA/IA2，再在笔画邻域跑 OCR 行框 + 轻量 detector。缓存键至少含 `hwnd + frameHash + dpi + clientRect`。
2. **C# 原型变成受生命周期管理的常驻服务。** 现在 `scripts/native_element_picker_demo.cs` 只是给人体验用的独立原型。要 named pipe、provider hang 隔离、多屏/DPI 测试、窗口移动销毁事件、tray 与安装包集成。
3. **模型能力必须持久化。** `visionInput=no` 要写进 model profile。**未知能力不能默认为 yes**——当前后端读不了图，但"请求成功"曾被写成"视觉可用"。配了独立视觉模型才启用视觉路由。
4. **浏览器生产链不能依赖 `--remote-debugging-port`。** 做扩展 + Native Messaging，返回当前 tab/frame 的受限 DOM 和相关网络证据；无扩展时诚实回退 UIA/像素（证据显示 UIA 树完全够用）。

**验收：不再用简单 OCR、日历或购物清单用例代替真人复杂场景。**

## P1

- **模型调用改流式。** 现在非流式、约 3–6 秒。应流式显示首 token，整个交互给 8–12 秒 wall-clock，超时立即显示本地证据。
- **OCR worker 忙时不能返回空。** 排队一个有界请求，或明确返回 `worker_busy` 并在 UI 显示"正在读取"。**忙碌不等于屏幕上没有文字。**
- **诊断页。** 直接展示每次会话的 HWND、候选层、OCR 框数/截断、路由 tier、模型首 token/总耗时、降级原因。打点数据已经在记（`bridge_progress.py`），画出来就是页。不能继续靠人翻 `electron.log`。
- **P3 剩两项**：选中动作条、clicky 指针陪伴。两件都要一个**常驻文本选中监听**——`selection-hook`（MIT，104★）已实测在我们自己的 Electron 43 里 `require` + `new` + `start()` 全通，`prebuilds/` 带 6 平台预编译 `.node`，不用 rebuild。约束不能跳过：它会装**第三个** `WH_MOUSE_LL`（我们已有两个），必须用互斥状态机（划线时 `stop()`，结束后延迟约 400ms 再 `start()`），不要让两者同时活；隐私是硬约束不是文档——不启用 `enableClipboard`、拒绝 `method=99`、选中文本不落盘不进日志不进遥测、默认 false。
- **真人语音验收**：真实麦克风、中文口音、噪声环境。自动化通过不能替代。
- **原位改写扩到 Word 之外。** 现在非 Word 应用会诚实地说"改写结果生成了，无法写回这个应用"。要真写回：复用 `_paste_text_to_foreground`（不要新造），按 [三级写回](ARCHITECTURE.md#关键架构决策) 落地，开关 `INPLACE_WRITEBACK_LEVEL = 0|1|2|3` 默认先 2，真机验过级别 3 再放开。影响面已量化：Python 侧 44 处消费 `succeeded`、前端 8 处——**先加枚举但不产出该状态**（行为零变化、测试应全绿），逐一审完再让级别 3 真的产出它。

## P2

- **交互形态 v3：流式回合。** 现状是所有笔画攒着最后一次性提交。改成一条时间戳流：指针武装期贯穿整句话；每一笔落笔 **250ms 内**出反馈（目标高亮 + 一个 chip 插进输入流，打字打到"把"时划一笔，输入框当场变成 `把 [①1 lb Spaghetti]`，语音的 ASR partial 流进同一个框）；词与笔画按时间戳绑定，代词绑定到它前面最近的一笔；静默 1.2s 或回车结束回合。
  `InteractionEpisode` 的多对象绑定、`slots.here`、`pendingIntent` 全都在，**缺的只是记账，不是 AI**。`stage_turn_stream.js` 的记账已完成并测过，但气泡仍然是画完才开，所以 chip 是"打开时一次给全"而不是"每笔冒一个"。改的是手势生命周期。
- **设置中心重设计**（以 ChatGPT 桌面端为模板）：左侧三个区块「个人 / 能力 / 系统」，每页卡片分节，顶部有搜索。每项 = 名称 + 一句人话 + 当前值 + 默认值角标 + reset。配置真身是 JSON（可导出、可 diff、可让 AI 改）。**诊断页优先做。**
- **~~视觉基线：结束 `stage.css` 的石墨黑 / 浅蓝白分叉~~（2026-08-07 已裁定：浅色白卡）**：规范（`docs/archive/superpowers/specs/2026-07-26-*`）写的是石墨黑 #0E1116，实际发布的气泡是浅色。**裁定结果：浅色白卡为准**（lab.html 判据：石墨黑在黑底终端/照片上糊成一片，近不透明白卡三背景全稳）。已落地：`stage.css` token 石墨→近透明白（`rgba(252,253,255,.985)`）+ 深字；`oreo.css .card` 玻璃→白卡；`studio.css` hero-chip 毛玻璃→白卡、删除死代码 `.hero-composer` 毛玻璃条。测试钉子 `tests/stage_static_test.js` 断言新契约且 `#0E1116` 不得回归。剩余：设置中心深色 mica、外观页 accent 可改、图标换 lucide 未做。
- **token 热力图**：审计事件里零个 token 字段，得先让 `ask_text_model` 把 usage 写进审计日志。
- **点选改 hover 触发**：`element_probe_bridge.py` 每次点选 spawn 一个 Python（约 1.2s，其中约 300ms 是解释器启动）。点击够用，hover 不够。参照 `ocr_resident_worker.py` 做常驻即可解锁。
- **感知级联并行化**：手势兜底采样已加 3.5s 预算（12.9s → 约 4s）。剩下的空间在并行跑适配器而不是串行。当前量级可用，先不磕。
- **摩擦触发层**：`WH_MOUSE_LL` + `SetWinEventHook` 已经能看到这些信号，成本几乎为零——连续两次截图 →「要直接把里面的文字取出来吗？」；在两个窗口间来回切 3 次以上 →「要把这两边的内容合成一条给 agent 吗？」；**在输入框手打的内容与屏幕上已存在的文本高度重合** →「这段屏幕上已经有了，要直接取吗？」（最强的一击）。铁律：**同一提示一生只出现一次，可永久关闭，绝不打断输入焦点。** 越过这条线就是 Clippy。
- **零模型快路径**：一条与 router/plan 完全并行的确定性通道，圈选 → 结构化读取/OCR → 剪贴板。目标 <200ms、0 次模型调用、离线可用。只有它先于模型返回，我们才在"比 Ctrl+C 快"上站得住。
- **打包与分发遗留**：macOS 发布流水线（workflow 已有未实机跑）、Windows 代码签名（需 Azure Trusted Signing）、macOS notarize（需 Apple Developer 账号）、asar 打包（需改 Python bridge 资源路径）、beta channel 的 Dashboard UI（后端已有）。

## 已经做完的（别当成待办）

老文档里这些还写成"缺口"，实际已落地：

- **Recipe 数据化 + 插件加载器**：`catalog.py` 已经是加载器，39 条 recipe 在 `data/recipes/builtin.recipes.json`，第三方目录可加载。
- **三层智能路由**、**记忆层**、**剪贴板历史**、**MCP client**、**悬浮翻译**、**图转提示词**、**选区拉伸把手**、**点选追问**、**`[POINT]` 指点**、**零元件窗口视觉框选**。
- **语音降级为加速器**：`default_input_mode` 已默认 `text`。
