# Magic Pointer 端到端工作全描述（真实数据版）

> 2026-08-13，以一次真实交互为样本：用户在 Notepad 打开 `2026-08-09-054408-local-command-caveatcaveat-the-messages-below.txt`（34,660 字），晃动唤醒 → 划线 → 输入"这个文件里读到了啥。概况总结。"（14 字）。
> 所有数字来自 `data/runtime/electron.log`、UIA 探针实测（hwnd 67130）、`history/conversations.json` 与冻结帧 OCR；无任何编造。标注"修复后"的是当日修复落地后的行为。

---

## 0. 常驻态（唤醒之前，什么在跑）

| 进程 | 状态 | 干什么 |
|---|---|---|
| Electron 主进程 | 常驻 | 20ms 轮询 `pointerState` 子进程（前台窗口/按键/滚轮）；wiggle 检测器 |
| `frame_capture_worker.py` | 常驻子进程，**空闲零抓取** | 等 arm 指令 |
| `ocr_resident_worker.py` | 常驻预热 | 等 OCR 请求 |
| 语音 runtime | 常驻暖池 | 等触发词/按键 |
| `fabric_bridge.py` | 按需 | settings/agent/session 等操作 |

设计红线：空闲**不扫描 UI 树、不截图、不调模型**；`frame_capture_worker` 的 `capture_once_for_test` 在 idle 时直接返回 False（有测试钉死）。

## 1. 晃动唤醒（wiggle → activation）

1. 每 20ms 一次 tick：读光标物理坐标，喂 `wiggle_detector`。真实日志样本：
   `wiggle accepted metrics={"ready":true,"durationMs":424,"xRange":323,"yRange":200,"reversals":2,"totalTravel":732.48,...}`
2. 判定通过 → `activation decision=activate`（500ms 内 2 次方向反转 + 位移阈值）。
3. 同时立刻做三件事（并行）：
   - `armSelectionGesture`：记录 **foreground 身份**（此刻 `pointerInputState` 里缓存的 `foregroundApp/foregroundHwnd/foregroundProcessId`——这是租约锚点的第一步）；
   - `getCaptureCommitCoordinator().arm({epochId: token, displayId, scaleFactor, surfaceBoundsPx: 物理像素整屏, targetWindow: {...}, overlayExcluded: true})` → 发给常驻 worker：**环形缓冲开始抓帧**（33ms 间隔 × 8 帧，抓取在锁外、按完成时间戳入环）；
   - overlay 窗口显示（`setContentProtection(true)` 已挂 WDA_EXCLUDEFROMCAPTURE，生效性待真机验证），渲染层开始画线。

## 2. 划线与 pointerup

1. 渲染层收集笔画点（局部坐标）→ `overlay:gesture-input` 逐点回主进程。
2. pointerup → `completeSelectionGesture`：
   - `summarizeGesture(points, strokes)`：合法性（圈闭合/线段）→ 单笔或多笔；
   - **坐标换算**：每个点按所在屏的 scaleFactor 转物理像素（多屏不同 DPI 逐点换算）；
   - 组装 `gesture` 对象（schemaVersion 2, coordinateSpace=physical_screen_pixels, points/strokes/bbox/kind/anchorPoint/displayBounds/source）。
3. `coordinator.complete(gesture)`（**先冻结，后释放 overlay，再开会话**——顺序有状态机 + 竞态测试钉死）：
   - worker `commit`：取环中 **抓取完成时间 ≤ commit 时间** 的最后一帧（在飞的抓取不算）；保存 PNG、算 sha256，产出不可变 `FrameLease` JSON（含 `capturedAtMonotonicMs` 毫秒、`captureLatencyMs`、`overlayExcluded`、surface bounds、gesture）；
   - 提交失败 → fail-closed：快照桥收到 `invalid_frame_lease` 时**禁止重新截屏**（设计 §17.1），返回"画面未冻结"。
4. 真实日志：`pixels_frozen ms=23`（本机 8·12 会话实测）。

## 3. 会话与感知（selection_snapshot_bridge.py）

真实 phase 日志：`payload_read ms=0 → settings_loaded ms=1 → pixels_frozen ms=23 → windows_enumerated ms=27 → structured_read ms=1611 → visual_saved ms=1617 → total ms=1619`。

1. `windows_enumerated`：列全部可见窗口（hwnd/title/pid/class），据此找目标窗口。
2. `structured_read`（1611ms，大头在这里）：
   - 按目标窗口匹配 adapter（Office/DevTools/UIA）；
   - UIA 探针（`uia_selection_probe.exe`，单进程每次运行）走点路径：FocusedElement → 根元素 → 文档选区扫描 → 点元素 → **（修复后）整篇文档回退**；
   - 本案实测（修复后）：探针返回 `{"ok":true,"result_kind":"document_text","text":"<34,660 字全文>","truncated":false,"rectangles":[...文档矩形...]}`——修复前是 `"error":"No non-empty UI Automation text selection was exposed."` + 空文本；
   - adapter 组装 `AdapterReadContext`：`method=uia:document-text`、content=全文、artifacts（selection_rectangles 物理坐标、hash、probe_elapsed_ms）。
3. `perception_trace`：逐 attempt 记录（layer/adapter/method/status/reason），本案修复后 `selectedLayer=uia, selectedMethod=uia:document-text, pixelFallbackUsed=false`。
4. 结构化证据没有/不足时 → 像素兜底：冻结帧裁剪 → 常驻 OCR（本案修复前走到了这里：`enrich_screen_region ms=910`）。
5. 输出 snapshot JSON：`captureSummary`（app/label/detail=字数+标题/excerpt/hasContent/covers_mark）、`context`（全文 34,660 字）、`frame_lease`、`selection_gesture`、`perception_trace`。

## 4. 气泡输入命令 → selection_bridge.py

真实日志：`bridge phase .../selection_bridge.py phase=context_from_snapshot ms=0 → enrich_screen_region ms=910 → enrich_local_file ms=910`。

1. `_fabric_objects(payload, target_window, app_ctx, snapshot)`：把快照证据整理成 fabric objects（id/content/source/kind）。
2. 意图路由（**修复后**）：
   - L0 确定性快路径（零模型）：本地动作（复制/截图/来源）、显式 handoff（"让 codex"）、L0 短语（"OCR 一下"等）——直接执行；
   - 其余（问答、长尾、模型建议）→ **`_loop_router`**（模型即路由器；`MAGIC_POINTER_LEGACY_ROUTER=1` 可回滚旧链）。
3. `_loop_router` 组装本次 loop 的完整输入（下节全列）。

## 5. 交给模型的全部信息（_loop_router，逐字列出）

### 5.1 系统提示词（`AiClientMessagesBackend(system_prompt=...)` → chat-completions `role:system`）

```
你是 Magic Pointer 的桌面助手。用户在屏幕上圈选了对象，下方是本次圈选的结构化证据。
规则：
1. 基于证据回答；证据不足以回答时，用 read_around / find_in_window /
   list_windows / look 等感知工具补充；仍然不足就直接说明缺什么。绝不编造屏幕内容。
2. 需要把结果写回应用、导出文件、发送内容或执行任何改变外部状态的操作时，
   调用对应能力工具生成方案；这些工具只生成方案，用户确认后才真正执行。
3. 复制文本、保存截图、查看来源可以直接调用对应工具。
4. 回答要简短（用户在看气泡），除非用户要求详细。
```

### 5.2 首条 user 消息（命令 + 证据块）

```
这个文件里读到了啥。概况总结。

[本次圈选对象证据]
窗口：2026-08-09-054408-local-command-caveatcaveat-the-messages-below.txt - Notepad
对象：THIS · …（label）
圈选内容：
╭─── Claude Code v2.1.220 ───…（34,660 字全文，超 60,000 截断并标注）
```

### 5.3 工具列表（`tools` 参数，每项 name + description + parameters）

1. **感知（READ）**：`read_around(anchor, radius 1..10)`、`find_in_window(pattern)`、`list_windows()`、`get_focused()`、`dump_subtree(anchor, depth 1..8)`；
2. **视觉逃生舱（READ）**：`look(anchor='bbox:l,t,r,b'|'element:id', box?, prompt?)`——真实后端：冻结帧按 box 裁剪 → `ask_vision_model`；
3. **本地动作**：`copy_selected_text`（REVERSIBLE_WRITE，pyperclip）、`save_screenshot`、`show_source`；
4. **能力工具（READ，只生成方案）**：26 个，如
   `text__translate_in_place{language:string}`、
   `text__summarize_route{destination:string}`、
   `table__to_spreadsheet{format}`、`agent__handoff{agent}`……描述统一为"XX：XX。调用它只会生成一个执行方案并等待用户确认，不会立即执行。"
5. 循环级约束：`allowed_effects=(READ, REVERSIBLE_WRITE)`，效果不符的工具调用直接被 loop 拒绝并回喂 `permission_denied` 工具消息。

### 5.4 实际 HTTP 请求（chat-completions）

```json
POST https://opencode.ai/zen/go/v1/chat/completions
{ "model": "deepseek-v4-flash",
  "max_tokens": 800,
  "messages": [
    {"role":"system","content":"<5.1 全文>"},
    {"role":"user","content":"<5.2 全文>"}
  ],
  "tools": [ <5.3 全部工具 schema> ],
  "tool_choice": "auto" }
```

## 6. 循环怎么跑（run_agent_loop）

- 预算：FULL_ANSWER=4000ms 墙钟门（每轮开头检查，`budget_ms` 余量传给 HTTP timeout）；每轮消息列表先过 `validate_messages`（origin/role 合法性，恢复消息 injected 白名单）。
- 模型回合：`AiClientMessagesBackend` 一次性请求 → 事件（MessageDelta/ToolCallArrived/TurnDone）；截断后缀守卫（`last_truncated` → 丢弃工具调用 + "输出被截断，重新生成"回喂）；withhold 恢复（backend_error → is_error user 消息回喂，上限 3 次）。
- 工具执行：并发安全分区（ThreadPoolExecutor 4 线程）→ validate_input → allowed_effects → 前置断言（本批暂无真实 probe 工厂则跳过）→ 执行 → 结果以 TOOL 消息回喂（含 `is_error`、failure_type、used_backend、latency）。
- 终止：模型不再调工具 → COMPLETED；或 MAX_TURNS(≤6)/BUDGET_EXHAUSTED/STOP_HOOK/USER_INTERRUPT。

## 7. 模型输出如何变成答案

1. 本案（修复后）预期：模型可能先 `read_around`（拿到 34,660 字——其实已在首条消息里）→ 直接总结成 200 字文本；如果它想"写回笔记"，调 `text__summarize_route{destination}` → propose 回调跑 `FabricEngine.plan(...)` → 返回**已签名 plan**（含 requiresConfirmation）。
2. `terminal_to_answer(terminal, command)`：文本 → `answer`；`local_action` 终端 → L0 动作；`loopTerminated` 诚实标注。
3. 能力工具结果里带 `plan` 的 → `make_fabric_action_proposal(plan)` → `actionProposals` 列表进答案 JSON：
```json
{ "ok": true, "prompt": "这个文件里读到了啥。概况总结。",
  "answer": "<总结文本>",
  "answerShape": "answer",
  "route": {"tier":"L2","action":"model_loop","turns":2},
  "selectionContext": {...},
  "actionProposals": [ {"action_type":"fabric_recipe_execute",
      "target":{"metadata":{"recipe_id":"text.summarize_route","plan_id":"..."}},
      "confirmation_required": true, ...} ] }
```
4. 桥尾统一处理：`parse_points` 摘掉 `[POINT x,y]` 标记（防止下游复制/填入带坐标）；`_record_auto_memory` 记「对象+问题」；打印 JSON。

## 8. 确认与执行（写回类动作）

1. Electron 收到 actionProposals → 确认卡（"摘要并路由…请核对动作后确认"）；
2. 用户点确认 → `fabric_bridge` `plan/execute`（带 `clipboard_writer/reader`、`target_probe=实时窗口`）→ `FabricEngine.execute`：
   - 签名校验（HMAC，plan 被改则拒）；`requires_confirmation` 必须已确认；
   - TargetLease 实时校验（`requiresLiveValidation` → 重新枚举窗口比对）；capture policy；
   - 执行器执行（本案修复后 `model.text` 走本地 `_local_model_transform`，不再回落 agent.task）；
   - **验证回执**：读回校验（如剪贴板 hash 比对）；artifact 注册、provenance、skill_candidates、审计 JSONL。
3. 答案气泡显示回执 + 可撤销（UndoLog 补偿）。

## 9. 全程可审计与记忆

- `electron.log`（每阶段 ms）、`bridge_progress`、`fabric-audit.jsonl`（plan/execute/deny 事件 + token 使用）、`conversations.json`（Q/A/outcome）、`events.jsonl`（session 生命周期）、`interaction_ledger`（token 分文本/视觉、各阶段延迟、evidence 层、look 占比、成功/失败）。
- 冻结帧/截图进 stash，TTL 清理；`prune_capture_dir` 定期清 selection-captures。

## 10. 与 Claude Code 的对照（对应 fable5 评审表）

| CC | Magic Pointer（现状） |
|---|---|
| 文件系统 = 稳定寻址 | FrameLease（不可变像素）+ Anchor 五重身份 + `resolve()` 五路判别 |
| `Read/Grep` 按需拉取 | 感知即工具：read_around/find_in_window/look（接真实后端） |
| `Edit` 唯一匹配断言 | ActionGuard 前置四断言（exact/focused/content_hash/no_modal）fail-closed |
| git 可逆 | UndoLog 补偿栈 + 两阶段确认 + 签名 plan |
| Agent Loop | `run_agent_loop`（withhold 恢复/截断守卫/预算/代际取消）+ 生产已接 `_loop_router` |
| 工具描述即 API | 26 个能力工具（真实 schema）+ 5 感知 + 3 本地动作，模型按描述选择 |
| 无关键词表 | 生产路由已去掉关键词决策（仅 L0 快路径保留） |
| 权限 checkPermissions | allowed_effects + ActionApproval 黑名单 + EgressGate + 确认不可由模型触发 |
| ToolSearch 延迟加载 | **未做**（T4 计划：工具超阈值 defer + 搜索工具） |
