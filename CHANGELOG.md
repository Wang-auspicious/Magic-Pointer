# Changelog

## Unreleased

- Migrated the Node test orchestrator and electron-builder wrapper to strict TypeScript; package/test commands now execute them through `tsx`, and the package verifier still rejects leaked development tooling.
- Migrated selection-session state and observability logging to strict TypeScript, with explicit session, prompt-packet, log-rotation, counter, and lazy crash-reporter contracts.
- Migrated deterministic wiggle reliability evidence to strict TypeScript and moved its detector dependency to a conventional eager import boundary.
- Kept Python-to-Node integration tests compatible with migrated TypeScript source by preloading the same `tsx/cjs` loader used by the Node suite.
- Migrated internal auto-execution authorization and result-surface classification to strict TypeScript without widening their fail-closed behavior.
- Migrated the Python bridge process runner to strict TypeScript, including injectable child-process, stream, cancellation, timeout, progress, and bounded-result contracts.

- **首批 Electron 策略模块迁到 strict TypeScript（2026-08-09）**：激活门、鼠标按键、指针轮询、临时面板关闭、renderer readiness、手势运行配置、地图 route、Stage 原生命中区、标题栏对比度、主动提议 once store、bridge progress、IPC surface 共 12 个 `.js` 改为带真实输入/返回类型的 `.ts`；无 `any`、无 `@ts-nocheck`，测试继续通过无扩展 CommonJS 接口加载。
- **第二批 Electron 生命周期模块迁到 strict TypeScript（2026-08-09）**：`app_lifecycle`、`python_runtime`、`submit_gating_policy`、`credential_store`、`session_timeline` 五个 Node-only 模块完成 `.ts` 迁移，补齐 marker/readiness、进程环境、提交决策、safeStorage 与诊断时间线的数据类型。
- **第三批 Electron 状态机迁到 strict TypeScript（2026-08-09）**：`proactive_rules`、`runtime_snapshot`、`dictation_correction_policy`、`voice_focus_guard` 完成 `.ts` 迁移，规则滚动状态、不可变运行快照、听写效果与 HWND 焦点证据都有显式类型。
- **TypeScript 迁移底座（2026-08-09）**：新增 strict `tsconfig`、`tsx` 隔离测试加载器和 `build-electron.ts`，Electron 开发启动与打包统一运行 `build/electron` 编译镜像，不再直接执行源码。首个迁移模块 `runtime_paths.ts` 统一源码态/编译态根目录，避免编译后 Python bridge、数据目录和 renderer 路径偏移；未迁移的 JS 在构建时逐文件校验字节一致，防止 classic renderer 被注入 CommonJS `exports`。新增 build/package/runtime-path 契约测试，真实 onboarding 冒烟通过；验收脚本同步主窗口 `studio.html`，删除隐藏窗口会停摆的双 rAF 截图等待。依赖锁同时将间接 `js-yaml` 固定到修复 DoS 公告的 4.3.1。
- **桌面运行时收敛为 Electron 单壳（2026-08-09）**：删除已停用的 Tkinter `app/main.py`（961 行）、三个 Python UI 启动批处理、旧 UI 专属系统函数和摇鼠标测试；`start_electron_overlay.bat` 修正为从仓库根目录启动，并在 Electron 依赖缺失时明确失败，不再静默拉起另一套界面。新增 `electron_only_runtime_test` 防止旧入口和回退复活。

- **回答框分成两种：要送出去的 / 自己看的（2026-08-07）**：分界线只有一条——**这段产物要不要送出去**。`deliver`（回微信、回邮件、填回输入框）贴目标应用**右侧外沿**（要一边看上文一边改草稿，挂在选区旁会压住要参照的那几行）、**纯文本不解析 markdown**（对面读到的是字面量 `**` 和 `-`，渲染成粗体会让人以为发过去也是那样）、要点头的那一下长在**问题框**下面而不是回答框里（定稿的话此刻已复制回问题框，你正看着的就是即将写出去的东西）。`inspect`（生图、MCP 地图/播放器、论文翻译、解释）放开 markdown / 图片 / 工具界面，没有「拒绝 / 同意」。判定在纯函数 `electron/answer_shape_policy.js`：桥明说 > 卡的形态 > 写回类提案 > 命令动词，**拿不准一律 inspect**（判错成 inspect 只是少一个按钮，判错成 deliver 会剥掉格式并准备往别人窗口里塞字）。钉子 `tests/answer_shape_policy_test.js`。
- **扩写改成「划中一段就地展开」，不再开新的一轮（2026-08-07）**：截图里那句「目标长度是原文的四倍以上，多出来的部分只能靠编造」是两个错叠在一起——① 手势说的「6 行」是 540px 面板里**折行后的视觉行**，而 `count_lines` 数的是**换行符**，一句 47 字、零换行的中文回答分母是 1，6/1=6>4 必触发；② 那条命令走正常提交路径，`selection_bridge` 拿**屏幕上划的那块**当源，扩的根本不是回答。现在：在回答里划中一段 → 贴着选区冒出「展开讲讲」→ 新的字**就地换掉那一段**（黄一下再褪），源就是那一段字、单位是字符、倍数 2.4 由我们定，所以没有任何东西需要被警告。新增 `scripts/expand_passage_bridge.py` + `stage:expand-passage`（invoke，不动 selectionSessions / pendingQuestions，轮次不变）。撤掉答案底边的拉伸把手（一件事只留一个做法）；选区侧的把手保留但改说字数。钉子 `tests/passage_expand_target_test.py`。
- **结果卡与输入条照 Vida 重做（2026-08-07）**：面板 430→560 宽、正文 13→15px、圆角 26px，墨色从蓝白 `#183b68` 改中性近黑（蓝色正文让整段回答看起来像一个链接）；卡顶那条灰色小横杠换成「等宽状态 + 标题 + 叉」，整条头是抓手，第一轮的 `.turn-ask` 因此收起来；底栏从一排动作按钮改成参考里那条**追问条**（placeholder 绑当前这张卡在讲什么）。输入条右端补实心黑圆提交键（跑起来变方块可叫停，以前只能按回车、「按了没有」没有任何回执），处理中的蓝色斜光换成从左扫到右的彩带。**卡中卡拆掉**：`density=capsule` 时脱掉 `.mcard` 的白底/圆角/投影——面板本身已经是那张卡了。
- **舞台以前从不加载 `icons.js`（2026-08-07）**：卡片里每个 `<use href="#ic-…">` 都指向不存在的 symbol，眉毛图标、步骤的勾、警告的感叹号**全是空的**。三个界面现在共用同一份精灵。顺带把精灵的定位从行内 `style` 挪进 `.icon-sprite`（`oreo_tokens.css`）——舞台 CSP 是 `style-src 'self'`，行内样式属性被整条拦掉。
- **正文能渲染图片、工具界面有样式了（2026-08-07）**：markdown 子集补上 `![](…)`（地址过 `safeSrc`，`javascript:` / `data:text/html` 挡下并**说出来**，不静默留白）；`.mcard-slot`（MCP Apps 沙盒 iframe）此前**完全没有 CSS**；舞台 CSP 放开 `img-src` / `frame-src`，否则图和工具界面必被拦。
- **视觉契约：毛玻璃退位，白卡为准（2026-08-07）**：裁定 lab.html 判据 A（近不透明浅色）为产品基线，与 52dbd316 白卡设计系统 1:1 对齐。`stage.css` 石墨黑 #0E1116 → 近透明白卡 `rgba(252,253,255,.985)` + 深字 #152741；`oreo.css .card` 玻璃板（--glass+blur）→ 纯白卡 + hairline 边；`studio.css` hero-chip 毛玻璃 → 白底深字、删除死代码 `.hero-composer` 毛玻璃条。测试钉子 `tests/stage_static_test.js` 断言新契约并防 #0E1116 回归。ROADMAP P2 视觉基线项标记完成。
- **修复：chat-completions 模式思考吃掉全部预算返回空答案（2026-08-07）**：切 OpenCode Go 后 `deepseek-v4-flash` 的 reasoning 吃掉整个 max_tokens（实测 1199/1199），HTTP 200 但 content 空，用户看到"模型在本次预算内没有返回可见答案"。根因：messages 模式有 `thinking:{type:disabled}`，chat-completions 模式迁移后丢了。修复：chat-completions payload 补 thinking 关闭；拒收该参数的网关剥离后重试一次；空答案报错带诊断（finish_reason + reasoning_tokens）。测试 `tests/ai_client_thinking_test.py`（5 用例）。同问题真机从 26.9s 空答 → 6.4s 实答。
- **修复：`uia_text_adapter.py` 冷树重试 NameError（2026-08-07）**：上一会话写注释"不能写 `x or -1`"但 `_as_int` 从未定义。补定义（0 是合法值，不被 `or -1` 吞掉），30 个 uia 测试全绿。
- **模型网关切到 OpenCode Go（2026-08-07）**：`secrets/` 配置 `https://opencode.ai/zen/go/v1` + `deepseek-v4-flash`（chat-completions），删除 `model_api_mode.txt` 改 base_url 自动识别。视觉独立三件套：`vision_model.txt` / `vision_api_mode.txt` / `vision_base_url.txt`（+ 同名环境变量覆盖），`ask_vision_model` 读覆盖——文本/视觉/网关各自可配，代码同一套逻辑。真图验收通过（1079×809 仪表盘截图，区域追问 6.8s 精确返回基金代码）。
- **纯文本模型黑名单分类器（2026-08-07）**：`app/ai_client.py:classify_vision_capability`（移植 `external/claude-code-vision-skill`，MIT）：deepseek / glm-4.x / glm-5.x 非 v 线 / kimi-k2- / hy3 / qwen3-coder 判定纯文本，`ask_vision_model` 诚实拒绝（不发请求、提示如何配视觉模型）；未知模型不拦截。测试钉子 `tests/vision_capability_test.py`（16 项全绿）。clone 参考仓库：`external/claude-code-vision-skill`、`external/ds-vision-skill`（均 MIT）。

## v0.0.1 - MVP0

- Added Windows desktop prototype using Tkinter.
- Added `Ctrl + Alt + M` global hotkey polling.
- Added region selection overlay and screenshot capture.
- Added OpenAI multimodal model integration with no-key fallback.
- Added local object logging in JSONL.
- Added README, AGI distance tracking, smoke test, MIT license.

## Unreleased

- **快速单点指向（2026-08-01）**：唤醒后按下至松开不超过 260ms、累计位移不超过 10 DIP 时，判定为 `kind: 'point'` / `point_target`；overlay 与 pass-through 捕获均保留松开采样，普通拖拽及多笔链逻辑不变。

- **重做实时划线蓝带（2026-08-01）**：默认 `demo6_band` 改为本地 WebGL2 屏幕空间路径 SDF，从结构上移除急弯外扩网格与三角毛刺。光带只使用一个蓝色色值，中央为平坦主体，仅上下边缘窄幅 alpha 羽化；亮度按真实累计弧长从旧尾到光标连续增强，旧尾略软且按住期间保持可见，抬手后才在 128ms 内整体退场。保留 Canvas2D 降级路径、原始手势坐标、多笔语义与 overlay 输入协议；新增像素级夹具和无残影验证。

- **调研：clicky 生态 44 个 issue 全记录 + 底层设计**：新增 `docs/planning/BOTTOM_LAYER_DESIGN_20260801.md`——① farzaa/clicky 38 issue + Bitshank-2338/clicky-windows 6 issue 反馈分类（成本/API key、Windows 空白、全链路慢、语言记忆缺失、bug 实录）；② 8 类日常功能清单→输入需求推导，收敛出底层 6 能力（元素定位/内容提取/指代解析/语音流/上下文/执行验证）；③ Referent 会话引擎架构：一次唤醒=一个会话，笔画与语音时间戳对齐（this/and this/排除绑定），增量 grounding；④ 定位差异：本地优先+语义层+用户圈定聚焦 vs clicky 全屏截图发散找。

- **统一多笔划线圈选（2026-07-31 phase2，不切形态/不分启动方式）**：一次激活后连续圈选任意笔；每笔 pointerup 通过 `window.magicPointer.gestureStroke(token, count)` → 新 IPC `overlay:gesture-stroke` → `markSelectionDrawing()` 续命防超时；滚动窗口 `CHAIN_GAP_MS=1000` 后自动收尾、Enter 立即完成、Esc/右键仍可关闭。`summarizeGesture` 支持 `kind:'multi'` + `strokes[]` 保留每笔几何 + `anchorPoint`=第一笔 release（气泡锚定不跳）+ `releasePoint`=最后一笔 release + 聚合 bbox；overlay 画已提交笔迹+序号，hint 显示「已圈选 N 处 · 继续圈选其他内容，或按 Enter 完成」，stage 气泡新增「N 处」计数徽章（`#capsule-count`）。覆盖测试 `tests/multi_stroke_chain_contract_test.js`、`gesture_capture_test.js` 多笔断言。
- **修复本地语音崩溃（sherpa 空 VAD abort，exit 4294967295）**：`scripts/sense_voice_bridge.py` 的 `_create_vad()` 曾用空配置构造 `sherpa_onnx.VoiceActivityDetector`，sherpa 在无 VAD 模型文件时直接 `std::abort()`（实测 Windows 退出码 4294967295）。现改为返回 `None`（实际 VAD 是回调内的能量检测），文件内不再出现 `VoiceActivityDetector(`；新增回归测试 `tests/voice_engine_contract_test.py`。
- **修复本地语音 CLI 麦克风回调崩溃（TypeError）**：`_emit(kind, **payload)` 与 `run_microphone_with_model` 的 `event_sink(kind, payload_dict)` 协议不匹配，真实麦克风回调触发 `TypeError: _emit() takes 1 positional argument but 2 were given`（cffi callback 内异常）。`_emit` 改为同时兼容两种调用风格；新增 `test_sense_emit_accepts_both_call_styles` 与 `test_sense_microphone_loop_emits_partial_without_typeerror`（假 sounddevice 复现回调路径）；顺带修正 CLI loading/ready 事件里 `sense-voice-sense-voice-small` 前缀重复。
- **调研：Google「add this / and this」底层 + Clicky 生态对标**：新增 `docs/planning/GOOGLE_ADDTHIS_ANDTHIS_ANALYSIS_20260731.md`——结论：Google 的毫秒级感知来自语义对象层（Chrome DOM / Android 可访问性树），不是截屏 OCR；"add this → and this" 是专利 US11221823B2 的"动词建一次、指示词+指针逐目标累积、统一执行"会话范式；clacky/clicky-windows 已在 Windows 落地 UIA(5ms)→OCR(300ms)→Vision(1-3s) 三层定位、本地快路径+Haiku 路由、[POINT] 流式指点+UIA 吸附。clone 新参考仓库：`external/openclicky`、`external/clacky`、`external/clicky-windows`。

- Fixed multi-DPI physical coordinate mapping in `completeSelectionGesture` (`electron/main.js`): per-point display lookup with `X_phys = Screen_Physical_Origin + (Local_Logical × sf)` instead of a single global scale factor; bbox recomputed from physical point set.
- Fixed model unload segfault race (`scripts/local_voice_worker.py`): added `_ModelRWLock` reader-writer lock so `unload()` waits for in-flight transcription to finish before dropping the model reference.
- Replaced 80ms microphone polling with event-driven push (`scripts/local_voice_worker.py` + `electron/voice_worker_client.js`): worker pushes `partial`/`final`/`error` events straight to stdout via an async event sink; deleted `poll_microphone` command, `_pollActiveMicrophone`, and `pollIntervalMs` timer.
- Optimized overlay rendering (`electron/renderer/overlay.js`): pointer and observer aura pre-rendered into OffscreenCanvas frame caches (6 frames each), main loop only calls `drawImage()`; removed blind `setTimeout(1050)` restore — recovery is driven by the main-process capture completion path.
- Made VAD noise-floor tracking noise-immune (`scripts/local_voice_bridge.py`): asymmetric envelope follower (fast release 0.99 / slow attack 0.001) replaces the symmetric 0.92/0.08 EMA so transient noise (keystrokes, door slams) can no longer poison the threshold.
- Fixed the P0 microphone capture failure path (`scripts/local_voice_bridge.py`): temporary audio-queue starvation no longer leaks `queue.Empty`, and partial Whisper inference now runs as a single background job so it cannot block the sampling pump or overlap final inference on the same model.
- Completed the event-driven microphone lifecycle contract (`scripts/local_voice_worker.py`): `microphone_stopped` is now pushed to Electron after the session returns to idle, preventing the client from retaining a stale active request.
- Added a 64 KiB UTF-8 input ceiling to the reviewed selection and Electron bridges, with bounded prefix reads and explicit `payload_too_large` fail-closed responses instead of unbounded stdin buffering.

- - Fixed P0#5 overlay recovery (`electron/main.js`): the non-gesture `overlay:done` branch now hides the overlay immediately at capture handoff (event-driven), instead of waiting for the bridge `onComplete` — the overlay can no longer sit black and input-blocking for the whole bridge run (up to 120s on timeout).
- - Fixed P0#6 unbounded capture coordinates (`electron/main.js`): non-gesture `overlay:done` points are truncated to `MAX_OVERLAY_CAPTURE_POINTS = 4096` before forwarding, so a compromised renderer cannot push an unbounded coordinate array to the bridge.
- - Fixed P0#4 production test-hook isolation (`electron/main.js`): the N17 focus-evidence, N18 wiggle-evidence, and dashboard-capture env hooks (and `captureMode`) are now gated behind `!app.isPackaged`, so leftover `MAGIC_POINTER_*` variables can no longer make a packaged app auto-quit at startup; packaged runs log that the hooks are ignored.
- - Closed the voice push-mode test contract (`tests/local_voice_worker_test.py`): the removed `MAX_MICROPHONE_EVENTS` constant is no longer imported; the push-mode regression test emits 65 partials (past the old 64-event poll buffer cap) and asserts no forced stop and no dropped events. Added a deterministic regression test proving `start_microphone` cannot overlap an in-flight WAV transcription on the same model.
- - Made the PDF fixture-dependent test robust (`tests/pdf_selection_recovery_test.py`): `test_live_recovery_rejects_an_occluded_background_pdf` now skips when the local `2307.00583v1.pdf` fixture is absent, matching its sibling tests, so the suite is green without the fixture.
- - Added `tests/test_hooks_isolation_static_test.js` and P0#5/#6 regression assertions in `tests/runtime_issue_hotkeys_test.js` locking in the event-driven overlay recovery and the capture-points cap.
- 
- - Completed the voice-engine roadmap item (Phase 2):
-   - Added `scripts/voice_engine.py`: engine contract (whisper / sense_voice / auto) with drop-in bridge bundles; `local_voice_worker.py` accepts `--engine`, reports the active engine on every event, and fails over to Whisper after two consecutive SenseVoice load failures (`engineFallback` reason on ready/status).
-   - Wired the engine choice end to end: `settings_store.js` `interaction.voice_engine` (auto/whisper/sense_voice, validated), `voice_worker_client.js` passes `--engine`, `voice_resident_runtime.js` forwards it, and the Dashboard voice panel offers Auto/Whisper/SenseVoice.
-   - Verified the real SenseVoice pipeline (sherpa-onnx 1.13.4, model.int8.onnx): model loads, WAV transcription returns, clean shutdown; benchmark shows SenseVoice loads in 2.6s and transcribes in 0.14s/utterance vs whisper tiny 6.2s / 0.50s.
-   - Added `scripts/benchmark_voice_engines.py` (same recordings through both engines, CER via char-level Levenshtein, optional intent accuracy through the production RecipeRouter) plus contract/benchmark tests.
- - Fixed the selection-capsule landing on scaled displays (`electron/main.js` + `electron/coordinate_space.js`): the stroke release point is emitted in physical pixels but was treated as DIPs, so on 150%/200% displays the capsule overflowed the viewport and clamped into the bottom-right corner. The point is now converted once via `screen.screenToDipPoint` before display lookup and stage anchoring; `physicalGestureTrace` no longer double-scales gestures that are already physical.
- - Anchored the stage capsule exactly once per session and made it draggable (`electron/renderer/stage.js`): `capsulePlaced` prevents re-anchoring when grounding resolves later (no more bubble jumping), and pressing the capsule body (outside the text input) drags it to a new position with viewport clamping (`capsuleDragged` locks it).
- - Stopped silently dropping manual voice presses (`electron/main.js`): `dictation:start` now waits up to 3s for grounding to finish (polling the session), then starts dictation or reports a friendly error instead of doing nothing.- Started the intent-execution separation roadmap (advisor plan, Phase 1):
-   - Added `app/fabric/model_plan.py`: strict ModelPlan contract (intent / targetObjectIds / requestedResult / toolCalls / riskLevel / needsConfirmation / expectedVerification) with an 18-tool registry mapped to local recipes; validation fails closed on unknown or unimplemented tools, missing required arguments, risk downgrades, unconfirmed destructive plans, object-count violations, and payloads over 64KiB.
-   - Added `FabricEngine.plan_from_model()`: model-plan-first routing while keyword recipe routing remains the offline fallback; a model can escalate confirmation but never bypass the local permission policy.
-   - Extended `electron/gesture_capture.js` geometry: circles become closed polygon rings (32 samples + closing vertex), lines/freeforms become bandwidth corridors (closed normal-offset polygon), freeform semanticPoint is now the stroke centroid, and a unit direction vector is exposed; `completeSelectionGesture` passes geometry/direction through to grounding.
-   - Verified the Stage bubble boundary clamp (`electron/stage_anchor.js`) already covers screen-edge and oversized-surface cases with tests; verified no gesture-kind-to-destructive-action binding exists.- Added `docs/planning/REVIEW_AUDIT_20260731.md`: P8 code review, 44 findings (P0×7 / P1×12 / P2×12 / P3×8 / P4×5) with prioritized fix order.
- Cloned `external/opensre` (Tracer-Cloud, Apache 2.0, depth 1) and documented the borrowable patterns (synthetic scored RCA suites, reversible masking, context budgeting) in AGENT.md.
- Added `electron/observability.js`: structured JSONL event log
  (`events.jsonl` under the runtime directory, rotated at 5 MB × 5 files),
  in-process counters via `bump()`/`snapshotCounters()`, and lazy
  `crashReporter.start()` with `uploadToServer: false`. Wired into
  `electron/main.js` so every run records `session.start` and fatal
  hardening events.
- Added `scripts/collect-diagnostics.js` and the `npm run diag:collect`
  script: bundles the runtime directory into a zip (falls back to a
  timestamped directory if `archiver` is not installed) with secret
  redaction (`sk-*`, `api_key=`, `token=`, `password=`) applied to text
  logs and JSONL events, plus a `meta.json` header. Hostname is hashed.
- Added `tests/observability_test.js` covering event write / counter
  accumulation / secret redaction — surfaced by
  `scripts/run-node-tests.js`.
- Added `electron/security_hardening.js` and wired it into `electron/main.js`:
  enables Electron sandbox, rejects `window.open` and `will-navigate` targets
  outside `http/https/mailto/tel`, blocks webview attachment, denies
  non-media permission prompts, and installs `uncaughtException` /
  `unhandledRejection` handlers that log, notify the user via
  `dialog.showErrorBox`, and `app.relaunch()`.
- Hardened all `BrowserWindow` `webPreferences` with `sandbox: true` and
  `webSecurity: true` for overlay, stage, dashboard and onboarding surfaces.
- Added strict `Content-Security-Policy` meta tags to `dashboard.html` and
  `onboarding.html`, matching the existing policy in `index.html` /
  `panel.html` / `stage.html`.
- Added GitHub Actions workflows for macOS release (`release-macos.yml`),
  CodeQL security scanning (JS + Python), dependency audits (`npm audit`,
  `pip-audit`) and CycloneDX SBOM generation attached to tagged releases.
- Added `.github/dependabot.yml` covering npm, pip and GitHub Actions with
  weekly grouped updates.
- Enabled Windows differential updates (`nsis.differentialPackage: true`)
  and cross-arch builds (`x64` + `arm64`) for both Windows and macOS in
  `electron-builder.yml`.
- Added macOS packaging metadata: hardened runtime entitlements
  (`build/entitlements.mac.plist`), usage descriptions for microphone,
  Apple Events, accessibility and screen capture, DMG + ZIP targets.
- Extended `installer.nsh` with a `customUnInit` prompt that asks whether to
  purge `%LOCALAPPDATA%\Magic Pointer` on uninstall (defaults to keep).
- Added project meta and quality gates: `.editorconfig`, `.nvmrc`, `.python-version`,
  `.prettierrc.json`, `.prettierignore`, `eslint.config.mjs`, `pyproject.toml`
  (ruff + pytest + coverage), and `.pre-commit-config.yaml`.
- Added community docs: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`.
- Added `engines` (Node 20-24, npm 10+), `bugs`, `homepage`, and dependency
  `overrides` to `package.json`; added `lint`/`lint:fix`/`format`/`format:check`
  scripts.
- Added V2 native selected-text support for Chromium/Firefox-style applications
  and PDF readers through Windows UI Automation:
  - reads `TextPattern.GetSelection()` without sending keys or touching the
    clipboard;
  - validates the selected element against the frozen foreground HWND and PID;
  - records source element identity, text hash, range count, and selection
    rectangles;
  - labels browser, PDF, and other application selections separately and keeps
    the capability read-only.
- Added a small C# UI Automation probe that is compiled locally into ignored
  runtime data using the Windows compiler already present on the machine.
- Bound snapshot capture to the exact Windows foreground handle instead of the
  first Z-order window, and fail closed when that handle is Magic Pointer or
  cannot be matched.
- Narrowed self-window filtering to the exact `Magic Pointer Overlay` and
  `Magic Pointer Panel` titles so legitimate documents containing the product
  name are not ignored.
- New pointer sessions now clear old command text before binding a new `THIS`.
- Verified real Edge HTML and Edge PDF selections with unchanged clipboard
  sequence numbers. Warm PDF hotkey capture completed in about 805 ms and the
  panel appeared in about 827 ms; a cold Electron run took about 1.1 seconds.
- Added observer selection sessions aligned with the public Google Magic Pointer
  interaction principles:
  - the hotkey freezes the foremost native selection before the panel takes
    focus;
  - the compact panel identifies `THIS`, its source, excerpt, and contextual
    actions without opening as a chat transcript;
  - commands, model requests, and action proposals carry short-lived session
    provenance, and stale results are ignored;
  - Word write proposals retain document, window, range, and content-hash
    verification.
- Added a fast read-only Word/WPS selection probe using `cscript`, with the
  existing PowerShell COM path retained as fallback. Real Word snapshot time is
  now 356-428 ms and full hotkey-to-panel time is about 560-770 ms on the
  reference machine.
- Fixed the panel run button so a mouse click submits the command text instead
  of serializing the browser click event.
- Added selection-session, frozen-snapshot, fast-probe/fallback, stale-request,
  and panel interaction regression coverage.
- Added `GOOGLE_MAGIC_POINTER_ALIGNMENT.md` to keep public evidence, local demo
  observations, deliberate product differences, and V2 acceptance criteria in
  one tracked decision record.
- Reworked the in-progress observer-first flow after real desktop review:
  - kept the native mouse fully usable and replaced the duplicate custom cursor with a transient observer aura;
  - reduced the selection command panel to a compact, content-sized local tool;
  - fixed corrupted Chinese panel/bridge/model strings and restored safe Markdown rendering;
  - stopped the selection bridge from scanning past an unsupported foreground app into a background Office window;
  - added WPS Writer selection support through `KWPS.Application`, including collapsed-selection rejection;
  - added post-write verification and context-anchored delayed restore for Word-compatible documents;
  - made ambiguous restore attempts fail closed instead of replacing the first full-document text match;
  - redacted full before/after restore text after a successful undo;
  - hardened the HTTP client against malformed proxy environment variables;
  - added focused pytest coverage and a real-size Electron panel preview helper.
- Added v0.2.0-alpha pointer-first local grounding/action scaffold:
  - platform-neutral grounding and action schemas;
  - Explorer file grounding adapter with optional COM/UIA backends and safe fallback;
  - `MagicPointerOperator` observation/proposal pipeline;
  - typed clipboard-copy action bridge with confirmation and main-process proposal provenance tokens;
  - safe Markdown result rendering and action chips in the Electron overlay.
- Added regression tests for grounding schemas, Explorer dependency fallback, and action bridge rejection paths.
- Improved Explorer copy-path flow: added PowerShell COM/UIA fallback when Python UIA packages are missing, and suppresses misleading manual-shortcut answers when safe path grounding fails.
- Added local file content understanding scaffold: Explorer-grounded PDF/HTML/TXT/MD/DOCX/ZIP files can be read locally and injected into model context for summarize/explain/key-point prompts.
- Added UFO-inspired Windows app adapter harness with Office Word/Excel native selection context via COM/PowerShell and a hard local permission policy for future write-back actions.

- Added local `secrets/*.txt` config fallback for API key/base URL/model.
- Switched AI call path to direct OpenAI-compatible HTTP chat completions for 78code compatibility.
- Verified 78code `gpt-5.4-mini` text and vision calls.

- Added background mode, no-console VBS launcher, and mouse-shake trigger.
- Improved prompt/result dialog: visible primary send button, non-selectable hint label, Ctrl+Enter send, larger resizable window.
- Redesigned prompt window into a cleaner card layout; removed explanatory gray hint text; simplified actions.
- Relaxed mouse-shake trigger thresholds so small left-right wiggles summon selection more reliably.
- Changed prompt dialog to left screenshot / right prompt+reply layout; Enter sends and Shift+Enter inserts newline.
- Added Windows visible-window metadata to reduce VLM-only mistakes when counting partially hidden windows.
- Added best-effort Windows Mica/Acrylic backdrop for a more modern glass-like window.

- Added general Screen Context foundation: z-ordered window metadata, overlap/visibility ratios, annotated object map image, and object-log persistence.
- Right-click now cancels region selection.
- Mouse-shake trigger is more responsive with lower thresholds and shorter cooldown.
- Reworked mouse-shake trigger into a fixed three-reversal left-right gesture to reduce accidental triggers while keeping low latency.
- Added gesture smoke test.

- Started MVP1 object registry: recent objects, this/that/group reference context, history image attachment for comparison/merge prompts, and continue-select flow.
- Added object store test.

- Optimized outbound vision images as bounded JPEG data URLs to reduce gateway failures.
- Added retry and primary-image fallback for transient SSL/connection errors from OpenAI-compatible gateways.
- Limited extra reference images per request to keep multimodal payload stable.

- Fixed this/that reversal risk by labeling every multimodal image: IMAGE A=THIS current object, IMAGE B=THAT previous object.
- Comparison prompts now attach only the immediate previous object by default to avoid historical image confusion.
- Added coreference guard instructing the model never to swap ??/?? with ???/??.

- Added MVP1-beta explicit object panel: recent object thumbnails, THIS/THAT/GROUP badges, pin/unpin, clear group, and pin-current-after-send.
- Added persistent explicit group state in `data/objects/object_state.json`.
- Changed group/merge prompts to use the explicit pinned group instead of implicit recent history; compare-with-previous still uses THAT.
- Expanded object store tests for explicit group management.

- Revised MVP1-beta direction: removed default historical thumbnail panel and persistent manual pin group from active model context.
- Added hidden current-task context with `TaskContextStore`, 30-minute idle rollover, explicit new task, and previous-task restore.
- Changed `THIS/THAT/GROUP` semantics to be session-scoped: global object history is now diagnostic/log-only by default.
- Added `tests/task_context_test.py`.

- Enlarged and made the home/control window resizable to avoid clipped UI on Windows scaling.
- Added `MagicPointerPanel.vbs` for no-terminal visible panel startup; it stops an existing Magic Pointer process first, then launches the panel with `pythonw`.
- Added a `?????` button so users can keep hotkey/mouse listening without using the terminal.

- Fixed VBS launcher again: `pythonw` was not on PATH when launched by Windows Script Host, so the launcher now uses the user's Scoop Python path first.
- Added `data/runtime/launcher.log` for VBS launch attempts.
- Added `data/runtime/app_error.log` for silent `pythonw` startup failures.

- Fixed the home/control panel source text by using Unicode escape literals, preventing PowerShell/VBS editing from corrupting Chinese UI strings into `????`.
- Increased the home/control panel to `760x460` with minimum `700x420` to avoid clipped buttons and text.

- Added MVP1-gamma task-scoped `DESTINATION`: users can set/clear the current selection as the destination inside the current task.
- Added destination state to `TaskContextStore` and model context; commands like "there", "target", "????", "????" now resolve to the explicit current-task destination.
- Destination reference images are attached only when destination-like prompts are detected.
- Expanded task context tests for destination and task object registration.

- Added MVP1-delta interaction redesign: region selection now opens a compact pointer command bar instead of a large chat-style prompt window.
- Added quick actions: explain, compare, set destination, clear destination, execute, details, continue selection.
- Results now appear as a short action-card style result; the old large view is replaced by an on-demand details window.
- The command bar is positioned near the selected region and keeps task context hidden by default.

- Added MVP1-epsilon low-friction command capture: a `??` button focuses the command field and opens Windows dictation with Win+H, without adding microphone dependencies.
- Added context-aware suggested default prompts in the command bar: explain first object, compare when THAT exists, or prepare content for DESTINATION when available.
- Added a `???` quick action that uses current-task DESTINATION semantics.
