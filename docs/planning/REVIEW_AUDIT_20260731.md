# Magic Pointer P8 代码审查报告

审查日期：2026-07-31
审查范围：electron/（main.js 3300 行 + 渲染进程 + 安全模块）、scripts/（语音 worker + 各 bridge）、app/（fabric 引擎）、打包配置
审查方式：人工全量代码走查（无子 agent），已运行 `npm test`（112 项全绿）与 `npx eslint` 交叉验证
结论：**功能管线完整、失败关闭（fail-closed）纪律优秀，但距离"成熟产品"缺三件事：崩溃兜底、UX 打磨、工程卫生。44 项发现，其中 P0×7、P1×12、P2×12、P3×8、P4×5。**

严重度定义：P0=崩溃/数据损坏/安全敞口；P1=高频用户可见问题；P2=体验与可维护性；P3=低风险优化；P4=文档与流程。

---

## P0 — 必须修（7 项）

| # | 位置 | 问题 | 影响 |
|---|---|---|---|
| 1 | `scripts/local_voice_bridge.py:459` | `blocks.get(timeout=2.0)` 未捕获 `queue.Empty`。采样队列连续 2s 无块（系统休眠恢复、声卡重置、partial 转录卡顿）即抛异常 | 麦克风线程崩溃 → 语音会话中途无声失败，用户说话到一半气泡报错 |
| 2 | `scripts/local_voice_bridge.py:486-500` | partial 转录在**采样泵同线程**同步执行（whisper tiny 每 1.25s 一次，每次 ~1-2s CPU 密集） | 泵被阻塞 → VAD 断句时间轴漂移、静音误判、队列积压，叠加 #1 直接触发崩溃 |
| 3 | `scripts/selection_bridge.py:78-80`、`electron_bridge.py` | `read_payload()` 无大小上限读 stdin。voice worker 有 64KB 上限（`MAX_COMMAND_BYTES`），其他 bridge 全裸 | 大截图/大选区 payload 造成内存暴涨；与 voice worker 的安全基线不一致 |
| 4 | `electron/main.js:2060-2168` | 生产 main.js 内置 N17 证据采集 / dashboard 截图等 **env 门控测试钩子**，任一触发都会 `app.quit()` | 用户环境残留 `MAGIC_POINTER_*` 变量时应用启动后自动退出，无任何 UI 提示 |
| 5 | `electron/renderer/overlay.js:329` + `electron/main.js:2724` | 移除盲等 `setTimeout(1050)` 后，非 gesture 流程（runtime_issue 等）恢复完全依赖 bridge `onComplete` 后 `hideOverlay()`；bridge 超时 60s 期间 overlay 持续黑屏无恢复 | 长任务/失败场景画面冻结无反馈；用户以为死机 |
| 6 | `electron/main.js:2714` | `overlay:done` 的 `enriched.points` 无界（gesture 有 token/大小校验，此分支无） | 恶意/异常渲染进程可投递巨量坐标数据，转发 python 造成资源耗尽 |
| 7 | `electron-builder.yml:18` | `asar: false` 全树明文打包（注释承认原因） | 源码随包分发（包括 secrets 检索面）、启动变慢、无法做完整性校验（关联 #52 anti-tamper 一直做不了） |

## P1 — 高频用户可见（12 项）

| # | 位置 | 问题 | 影响 |
|---|---|---|---|
| 8 | `electron/wiggle_detector.js:8,34` | `Number(sensitivity) || 0.55` falsy 合并——`sensitivity=0` 静默变 0.55 | 设置文件写入 0 无法到达"最不敏感"，API 语义错误 |
| 9 | `electron/renderer/stage.js anchorNearPointer` | 气泡锚点无 workArea 边界 clamp（AGENT.md 已记录未修） | 指针贴屏边时气泡溢出屏幕外，命令不可见 |
| 10 | `electron/main.js:2718` | `capturePad: 54` 硬编码物理像素，不随 scaleFactor 缩放 | 150%/200% 屏上截屏扩展不足，圈选边缘内容被裁 |
| 11 | `electron/renderer/overlay.js buildPointerFrames/buildAuraFrames` | OffscreenCanvas 按 1× CSS 像素预渲染，`ctx.setTransform(dpr,…)` 后 drawImage 放大 | 2x/3x 高分屏上游标/光环模糊，恰是产品核心视觉 |
| 12 | `electron/gesture_capture.js:60` | 线/自由形 `semanticPoint` = 首尾点中点，非路径质心 | 画弧线/斜线选区时圈心语义点落空，Python 距离打分错选 |
| 13 | `electron/wiggle_detector.js:11` | `windowMs` 默认 700、上限 900，蓝图规定窗口 250-600ms | 晃动窗口过长 → 误把普通移动纳入判定，误触率风险 |
| 14 | `electron/update_manager.js:78-97` | 启动 20s 自动检查发现新版本直接弹**模态对话框** | 用户正工作时被阻断；应改为托盘气泡/非模态 |
| 15 | `electron/renderer/dashboard.js:2254-2271` | 校准按钮：无失败路径（bridge 报错按钮永久 disabled + 显示"校准完成"）；倒计时固定 10s 不随实际采集提前结束 | 校准失败无反馈，用户被假完成误导 |
| 16 | `electron/main.js:1549,2766,2811` | 34ms/90ms 盲等 setTimeout 链路（合成器 gap、episode 重 arm） | 全部依赖经验值，机器慢时丢帧；应事件驱动 |
| 17 | `electron/main.js:2713-2718` | 非 gesture 分支 scaleFactor 取光标所在屏，选区可跨屏（多屏异构 DPI 时截屏错位） | 与 #1 修复同源问题在另一分支未修 |
| 18 | `scripts/local_voice_worker.py:590` | `_event_sink` 由 `serve()` 外部注入（属性直写），构造/测试路径不一致 | 代码异味：worker 生命周期中事件通道从无到有，易漏注 |
| 19 | `scripts/local_voice_worker.py:360-385` | `_start_microphone` 持 `_microphone_lock` 执行秒级模型加载 | serve 循环被阻塞，期间 stdin 命令（stop）排队，用户无法及时停止 |

## P2 — 体验与可维护性（12 项）

| # | 位置 | 问题 |
|---|---|---|
| 20 | `electron/main.js` ~3300 行 | 单文件 monolith（#16），模块边界靠注释 |
| 21 | `electron/renderer/dashboard.js` 2417 行 | 同上（#17） |
| 22 | `npm run lint` | **从未干净**：HEAD 上 overlay.js 就有 18 errors（`no-implicit-globals` 全量触发），本次后 21 errors；CI 没拦 = lint 形同虚设 |
| 23 | `electron/renderer/overlay.js:322,331`、`electron/main.js:123,1318,1336,1422` | 死代码：`restoreAfterCapture`/`requestSeq`（本次改动残留）、`fadeTrail`、`SELECTION_GESTURE_ARM_DELAY_MS`、`showOverlay`、`showRuntimeIssueOverlay`、`residentStage` |
| 24 | pytest Windows | temp ACL 报错（WinError 1314）整片 ERROR，测试长期红着没人修（Inventory 12.7 自述） |
| 25 | — | 无 E2E 黄金路径（#94）：112 项 JS 测试多为静态/单测，真实链路零覆盖 |
| 26 | — | 无 wiggle P50/P95 性能基线（#96） |
| 27 | `electron/update_manager.js` | 更新错误不累积、无红点、无诊断页（Inventory 已列 P1 未修） |
| 28 | `scripts/local_voice_worker.py:524` | `_status()` 无锁读 `self._model`，与 unload 并发时读到中间态 |
| 29 | `scripts/local_voice_worker.py:268` | push 模式落地后 `_microphone_events` 64 条队列已冗余，徒增内存与复杂度 |
| 30 | `electron/update_manager.js:68-119` | "下载更新"与"立即重启"两个模态对话框串行弹出，共 4 次用户打断 |
| 31 | `electron-builder.yml` `files: electron/**` | 已退役 `panel.html/panel.js` 仍打进安装包 |
| 32 | `electron-builder.yml:49` | `smoke_fabric.py` 等开发脚本混入发布包，体积与攻击面双增 |

## P3 — 低风险优化（8 项）

| # | 位置 | 问题 |
|---|---|---|
| 33 | `scripts/selection_bridge.py:661` | 错误文案英文（"The source set did not contain..."），其余全中文，产品文案不统一 |
| 34 | `electron/settings_store.js:34,84` | schema 命名不一致：顶层 `schema_version` vs models `schemaVersion` |
| 35 | `scripts/selection_bridge.py:889` | `cwd` 直接取 `payload.workspaceRoot`，未验证路径来源（Agent payload 注入面） |
| 36 | `electron/main.js:2107` | 测试证据 `process.stdout.write` 与业务输出同管道，打包后可能泄漏 |
| 37 | `electron/renderer/overlay.js` | 脉冲循环每帧全画布 `clearRect` + 重绘，可做 diff-region/脏矩形 |
| 38 | `electron/main.js` | `gesture.displayBounds` 存 DIP 值却混在物理坐标 schema 里，语义混淆 |
| 39 | `electron/main.js:1593` | `mousePollTimer` 固定间隔轮询，指针静止时也空转；应退避或事件触发 |
| 40 | `electron/preflight_checks.js:159` | `timer` 未在完成路径统一清理（多处 `catch (_) {}`） |

## P4 — 文档与流程（5 项）

| # | 位置 | 问题 |
|---|---|---|
| 41 | `CHANGELOG.md` | 今日 5 文件变更（DPI 坐标、RWLock、IPC push、OffscreenCanvas、VAD）**未记录**，违反 AGENT.md 自我更新规范 |
| 42 | `AGENT.md` | 文件表行数过期：main.js 3255→3300+、voice_worker_client 269→~230、overlay.js 492→~640 |
| 43 | `AGENT.md` | "已知问题"段：气泡定位未修仍开、voice 精度仍开——正确；但"第二次激活画线失败已修复"与新行数未同步 |
| 44 | `FEATURE_INVENTORY_20260730.md` | 8.20/3.5 pass_through 灰掉"待开发"，但代码已实现 pass_through_gesture.js（110 行）——文档漂移 |
| 45 | `scripts/verify_*.py` | n19/n20/stage/onboarding 四个验证脚本各有 300+ 行重复的"启动 edge/electron/等待/回收"模板，应抽公共 harness |

---

## 修复优先级建议

1. **立即（P0 #1 #2 合并）**：把 partial 转录挪到独立线程 + 泵侧 `queue.Empty` 捕获 → 语音是核心卖点，崩在 VAD 是 3.25。
2. **本周（P0 #5 + P1 #10 #11）**：overlay 恢复事件化（主进程 `overlay:capture-done` IPC）、capturePad×scaleFactor、OffscreenCanvas 按 dpr 渲染。
3. **两周（P1 #8 #12 #13 #14 #15）**：falsy 合并修复、semanticPoint 质心化、晃动窗口对齐蓝图、更新提示非模态、校准失败路径。
4. **持续**：lint 清零（#22）、死代码清理（#23）、verify 脚本抽公共层（#45）。

## 已确认的良好实践（无需改动）

- 失败关闭（fail-closed）：选区快照过期校验、provider unavailable 显式报缺、`del provider.startswith("unavailable:")` 不伪造成功
- 安全：IPC sender 校验、CSP、will-navigate 拦截、credential 脱敏 `withoutRawCredential`、HMAC 幂等键
- 语音 worker 的 64KB 命令上限、超长行丢弃、事件协议白名单——本次 push 改造保留了全部约束
