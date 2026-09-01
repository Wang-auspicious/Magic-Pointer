# Magic Pointer 竞品、体积与用户体验源码审计（2026-08-31）

> 范围：当前 `codex/harness-reconstruction`、本机 1.0.30 安装目录、最新
> 1.0.30 `win-unpacked`，以及本地 `external/everywhere`、Clicky 四个 clone。
> 本文只报告受支持用户路径可达的问题；不把理论攻击、冷门编码或未来抽象列为缺陷。
>
> 许可边界：Everywhere 是 BSL 1.1 竞品，只学习行为与契约；Clicky、OpenClicky、
> Clacky、clicky-windows 为 MIT，可在保留许可说明的前提下复用或改写。

## 1. 结论

Magic Pointer 不是“自己写了 1.4GB 代码”。当前安装目录实测为
**1,459,698,678 bytes**，其中：

| 部分 | 字节 | 占安装目录 | 结论 |
|---|---:|---:|---|
| `resources/python-runtime` | 1,058,547,270 | 72.52% | 体积主因 |
| Electron/Chromium 外壳 | 374,529,003 | 25.66% | 采用 Electron 43 的固定底价 |
| `resources/app`（MP 代码与资源） | 26,403,709 | 1.81% | 自有代码不是 1.4GB 主因 |

Python `site-packages` 本身是 1,017,616,506 bytes。前五项是 `torch`
476,645,818、`llvmlite` 121,390,108、`cv2` 117,859,059、PyMuPDF
55,041,039、ONNX Runtime 40,547,364 bytes。最新 NSIS 安装器为 362,280,624
bytes，解包后 `win-unpacked` 为 1,447,366,772 bytes。因此“下载包三百多 MB、装完
1.4GB”主要是二进制压缩率，不是安装器重复解了四份。

真正的工程臃肿另有一层：审计时 `release/` 有 26 个完整 sync staging，总计
**59,024,207,814 bytes**；`data/runtime` 915,849,874 bytes；`build` 1,414,938,889
bytes；`external` 2,190,983,614 bytes。这些不进最终安装包，却让开发仓库、杀毒扫描和每次
打包越来越笨重。按仓库强制交付 1.0.31 后又新增第 27 份 staging；本文没有删除它，也没有在
一次超时的全目录重扫后伪造新的总字节数。

1.0.31 sync 重启后、没有执行用户任务时的 Windows 进程树实测为 12 个进程，Working Set
求和 **781,815,808 bytes**（共享 Electron 页会在进程求和中重复计数，不能等同于独占物理内存）。
构成中 GPU process 186,875,904、无条件预热的 OCR worker 186,015,744、主进程
106,295,296、PowerShell pointer hook 91,508,736、两个 renderer 合计 119,459,840 bytes。
因此“用起来笨重”也不是单纯磁盘观感：启动即 OCR warmup 与 PowerShell 常驻 hook 是可量到的
空闲税。

产品能力上，MP 的内核已经强于 Everywhere/Clicky：它有 pointerup 先冻结的 FrameLease、
同一帧上的并发证据融合、durable session/Inbox/effect sandwich、工具按需发现、确定性权限与
Receipt。差距集中在两端：**交付物没有做依赖分层**，以及**成熟桌面产品的最后一公里细节仍断**。

## 2. 体积与交付链发现

1. **[P0] 打包语音栈自相矛盾。** `requirements.txt:9` 声明 `sherpa-onnx`，但
   `requirements.lock.txt` 没有该包，`prepare_python_runtime.ps1:171,211-225` 实际只消费
   lock；1.0.30 内置 Python 实测 `import sherpa_onnx` 失败。与此同时
   `voice_engine.py:114-148` 的 `auto` 会因 SenseVoice 不可用转向 Whisper，而
   `local_voice_bridge.py:323-328` 又要求用户另行准备 `~/.cache/whisper/<model>.pt`。
   新鲜安装既没有默认 SenseVoice runtime，也没有 Whisper 模型。

2. **[P1] 为一个仍需另装模型的 Whisper fallback 常驻打包约 650MB 依赖。** 直接入口是
   `requirements.txt:8`；lock 固定了 `openai-whisper`、`numba`、`llvmlite`、`torch`
   （`requirements.lock.txt:345,470,600,1246`），而打包/验收又硬要求 `whisper` 与 `torch`
   （`prepare_python_runtime.ps1:76-91`、`verify_windows_package.ps1:112-139`）。这是 1.4GB
   最值得先处理的单一根因。

3. **[P1] OCR 选择的是功能完整、不是交付体积最小的依赖组合。** `rapidocr` 带入
   OpenCV 117.9MB，另带 ONNX Runtime 40.5MB、RapidOCR 32.6MB；入口是
   `requirements.txt:6-7`。OCR 是核心能力，不能直接删除，但应以真实 OCR 回放确认哪些 OpenCV
   能力被用到，再决定是否换更窄 runtime；不能只靠包名猜着裁。

4. **[P1] Electron 本身已使“完整安装后 100MB”在当前架构下不现实。**
   `package.json:44-52` 使用 Electron 43，`electron-builder.yml:14-18` 又因 Python 桥选择
   `asar:false`。即使把整个 Python runtime 拿掉，当前安装仍约 375MB；要到一百多 MB，需要
   native/Tauri 类壳或按需下载策略，而不是压几张图片。

5. **[P1] 每次 `npm run sync` 永久留下一套完整 staging。**
   `sync_install.ps1:6-7,27-29` 为每次运行创建 `release/sync-<version>-<time>-<pid>`，后文只复制
   installer metadata 和安装树，没有回收。实测 26 份共 59.0GB。这是开发仓库最主要的“越改越胖”。

6. **[P1] 本机安装使用 `/E` 只增不减，删除过的生产文件会永久残留。**
   `sync_install.ps1:65-69` 用 `robocopy /E`。当前安装目录比 1.0.30 `win-unpacked` 多
   12,331,906 bytes、282 个文件，包括旧 `__pycache__`、旧 renderer bundle 与
   `data/runtime/uia_resident_host.exe`。这不只是磁盘问题：删除/改名模块仍可能被 import，开发机
   还能被旧二进制“垫绿”，而新用户没有它。

7. **[P1] sync 没有验证安装版本等于开发版本。** `sync_install.ps1:73-78` 只打印
   `$installedVersion`，缺文件也只打印提示，之后仍输出 `sync done`。一次部分复制可被当成交付成功。

8. **[P1] fresh install 与开发机 UIA 冷启动路径不同。** `main.ts:3100-3123` 只在
   `resources/app/data/runtime/uia_resident_host.exe` 存在时启动常驻宿主；当前 1.0.30
   `win-unpacked` 不含它，开发机安装目录却因 #6 的历史残留含它。新用户首笔 UIA 会走
   `uia_text_adapter.py:232-281` 的现场 C# 编译/回退路径，现有本机验收没有覆盖同一条件。

9. **[P2] production bundle 带了 100 个 source map（1,161,376 bytes）。**
   `electron-builder.yml:22` 全收 `build/electron/**`，而 `tsconfig.electron.json:7`、
   `tsconfig.renderer.json:9` 开启 source map。体积不大，但安装版没有消费方。

10. **[P2] 开发证据/测试临时目录没有保留策略。** `data/runtime` 当前 350 个一级目录、
    43,140 个目录节点，主要是 `pytest-*`、截图和旧 acceptance 证据；它不进包，却显著拖慢文件搜索、
    杀毒和备份。应按“保留最后一次交付证据 + 明确 golden fixtures”裁，不建新的归档框架。

## 3. Runtime 与执行正确性发现

11. **[P0][1.0.31 已修] 异常退出不释放真实输入锁。** 正常终态原在 `loop.py:731-739` 调
    `registry.notify_session_end()`；`run_agent_loop` 的异常路径只 repair session 后重抛
    （`loop.py:538-564`）。若一次 Click/Type 已经让 `desktop_actions/session.py:354-359`
    取得进程输入锁，随后 provider/session 异常，下个任务会持续 `COMPUTER_USE_BUSY`。1.0.31 已将
    `notify_session_end()` 移到 public `run_agent_loop` 的 `finally`，正常与异常路径均且仅通知一次。

12. **[P0] 工具 timeout 不是硬截止，且会把已完成写入报告成 timeout。**
    `loop.py:2109-2152` 的 Timer 只取消 scope，主线程仍同步等待 `execute_tool` 返回；不消费 scope
    的工具可在 deadline 后完成真实写入，随后 `2153-2161` 丢弃结果并返回 TIMEOUT。用户既可能
    已被改动，又被告知“超时”。

13. **[P1] 并行工具收到取消后仍会等全部 worker。** `tool_scheduler.py:181-216` 在取消后
    没有停止 in-flight Future，退出 `ThreadPoolExecutor` 时仍 drain；Stop 在两条慢工具期间看似无效。

14. **[P1] provider 重用 `tool_call_id` 会覆盖大结果文件。** session 已处理 provider 重复 id，
    但 `_persist_tool_result` 只用 call id 命名并 `write_text` 覆盖
    （`loop.py:2317-2361`）。较早轮次告诉模型的绝对路径随后可能指向另一轮结果。

15. **[P1] 同一 call id 也会覆盖 Studio 历史轨迹的 Receipt 对齐。**
    `conversation_bridge.py:373-388` 把 receipts 做成 `toolCallId -> receipt` 字典；重复 id 时，所有
    同 id 历史步骤显示最后一次参数、结果、backend 和时延。

16. **[P1] UI 只拿到 InteractionLedger 最后一行。** selection 与 conversation bridge 都
    `query()[-1]`（`selection_bridge.py:2498-2503`、`conversation_bridge.py:977-982`）。多工具任务
    和中断任务中，用户看不到前面已发生的动作、失败与外发事实。

17. **[P1] DraftArtifact 已落 session，却没有进入 GUI 可编辑契约。** loop 在完成时记录 draft，
    但两个 bridge 的正常 payload 只返回 answer/activities/receipts/ledger
    （`conversation_bridge.py:389-405,983-1005`、`selection_bridge.py:2468-2515`）。用户无法基于
    `artifactId + revision` 做局部 patch、接受或撤销，产品规格里的“版本化可编辑草稿”仍是后端孤岛。

18. **[P1] Receipt 的 `memoryEligible` 恒为 false。** `receipts/projection.py:53-81` 无条件写
    `memory_eligible=False`；“验证过才能沉淀”的准入链永远不会放行任何成功经验。

19. **[P1] Receipt 只报告最后一个非空 backend。** `loop.py:2286-2299` 倒序取第一个
    `used_backend`。一次同时用 model、UIA、vision、MCP 的任务只显示其中一个，违反项目自己的
    honest usedBackend 约定。

20. **[P1] `SetValue` / `Act` 把调用返回 ok 当作结果已验证。**
    `desktop_actions/session.py:265-304` 直接 `_acted(... matched=True)`，loop 又把任意 JSON
    `verification.matched=true` 当完成证据（`loop.py:2261-2277`）。UIA 调用成功并不证明值、弹窗或
    外部状态真的变成目标状态。

21. **[P1] 坐标型写操作只校验窗口几何，不校验坐标下元素新鲜度。**
    `_require_snapshot` 只有 index 才重读 role/name/rect（`desktop_actions/session.py:362-443`）；
    Click/Type/Select/Drag 的 x/y 路径不做该检查（`177-214,306-345`）。动态列表原地刷新后，旧坐标
    可点到另一个控件。

22. **[P1] `Type(submit=true)` 只验证写入框文本，不验证提交结果。**
    `desktop_actions/session.py:215-233` 文本匹配后直接 Enter 并返回原 matched；聊天消息、表单或命令
    是否真的提交没有再 Observe，Receipt 可误报 verified。

23. **[P1] 感知 deadline 后线程留存，卡死 provider 可累积。**
    `perception/broker.py:156-167,197-235` 明确 deadline 只限交互，`shutdown(wait=False)` 让线程自行
    结束；如果 provider 永不返回，连续手势会持续创建新线程并拖垮后续感知。

24. **[P1] 未完成任务状态只看最新 `turn/end`。** `session.py:1007-1024` 从最后一个终态推导
    pending。一次长任务 interrupted 后，用户完成一条无关短追问，旧任务就从 pending UX 消失，尽管
    transcript 里仍有未完成步骤。

25. **[P1] 所有非空最终文本都会成为 Artifact，当前 Receipt 又挂全会话所有 Artifact。**
    `loop.py:1185-1187` 不区分交付稿和“好的/解释一句”；`2286-2297` 对整个 session
    `project_artifacts`。结果是无意义产物堆积，后一次 Receipt 还错误归因前面任务的 draft。

26. **[P2] loop crash 的用户错误面丢失已发生事实。** conversation bridge 只返回异常类型
    （`conversation_bridge.py:952-959`），selection bridge 更只返回 `loopError` 与 InputArtifact
    （`selection_bridge.py:2461-2466`）；settled operations、backend 和已产生 effects 不上屏。

27. **[P2] Click 后回读失败被静默吞掉，原 `matched=true` 保留。**
    `desktop_actions/session.py:470-486` 把 UIA 变化重读当“可选增益”。这恰好会把最需要验证的按钮
    点击退化为“dispatch 成功即完成”。

28. **[P2] 因澄清/审批被跳过的同批工具不是结构化错误。** `loop.py:1253-1305` 产生未执行文本，
    但 `is_error=False` 且没有 operation prepared/settled；模型、Receipt 与恢复层对“未执行”理解不一致。

## 4. Electron、交互与常驻资源发现

29. **[P1] 单个静默阶段仍能被 60/120 秒闸杀。** runner 的 deadline 是 idle deadline，任意
    stdout/stderr 会续期（`python_bridge_runner.ts:143-178`），所以不是“任务总长两分钟”。但 Stage
    与 Studio 分别传 60s/120s（`main.ts:4712-4730,1796-1799`）；不发心跳的模型/provider/工具在
    其间仍会被 kill，和 Runtime 的长任务边界冲突。

30. **[P1] Studio 当前轮只在 bridge 成功完成后入库。** `main.ts:1796-1844` 直到 onComplete
    才 `appendTurn`；进程崩溃、更新、超时或强杀时，用户问题、进度与刚广播的 agent session id
    没进入可恢复的对话记录。

31. **[P1] 应用重启不会重新附着正在运行/待输入任务。** active map 是内存字段
    （`main.ts:241,1800-1808`），启动路径 `4026-4155` 没有扫描 conversations 中的
    `agentSessionId/hasPendingWork` 并查询状态。

32. **[P1] Stop 五秒后直接 kill，不等待并持久化最终 Receipt。**
    `main.ts:1852-1866` 发 graceful cancel 后固定五秒强杀；当前轮本来又没预先入库（#30），因此用户
    可能只得到“停了”，看不到已完成/未知/可恢复的精确边界。

33. **[P1] 选择会话完成后固定两分钟过期。** `selection_session.ts:67-81,199-205` 会保护运行中
    request，但完成后重新只给两分钟。用户切去核对资料、仔细审阅审批卡，再回来批准/继续时，THIS 与
    proposal 已被回收。

34. **[P1] Stage 后台任务 watcher 仅在内存。** `main.ts:1003-1022,1084-1124` 仅在当前 Stage
    attach；`task_watcher.ts:213-220` 不持久化 watcher。关 Stage 或重启后，任务仍可能在跑，用户却
    丢失进度入口。

35. **[P2] 启动 2.5 秒后无条件预热 OCR。** `main.ts:4066-4067,4917-4939` 无视是否发生手势、
    是否需要 OCR，直接启动重型 Python worker。这与 canonical “OCR 只在明确 wake/gesture/task 后
    激活”的边界相反，是后台笨重感的直接来源。

36. **[P2] 收藏箱默认每 700ms 轮询剪贴板。** 默认 `stash.clipboard=true`
    （`settings_store.ts:203-209`），app ready 后启动（`main.ts:4068-4077`），实际 interval 在
    `stash_runtime.ts:70-74,272-310`。图片进入剪贴板还会派生 Python 视觉简介。功能可以保留，但应由
    用户显式开启，而不是完整 Agent 空闲态的默认税。

37. **[P2] 模型健康每分钟 spawn 一次 Python bridge。** `main.ts:4877-4900` 在 app ready 后
    常驻 timer，即使 Studio 不打开、用户没有任务也会做 IPC/进程加载。隐藏后台应用会周期性唤醒。

38. **[P2] 隐藏 Studio 仍运行 demo ticker。** `renderer/studio.ts:3019-3028` 只要
    `#demo-run` 存在就每 2.6 秒改 DOM；窗口关闭到托盘并不销毁 renderer。

39. **[P2] 用户每次打开 Studio 都会被重置窗口位置/大小。** `main.ts:2476-2501` 无条件
    `setBounds`；用户自己摆放的窗口布局不能保持。

40. **[P2] hotkey 注册冲突只记日志，入口直接失效。** `main.ts:3631-3649` 不处理
    `globalShortcut.register()` false。Everywhere 在
    `ShortcutListener.cs:91-124,160-190` 只为注册失败的快捷键启用低级 hook，并用 dummy key-up
    避免 Win 菜单残留；MP 不需要重写快捷键系统，只缺这个失败分支。

## 5. Everywhere / Clicky 有而 MP 没有的成熟功能

41. **受控的文字选区复制回退。** Everywhere 先读 UIA，再在允许的应用走 Ctrl+Insert/Ctrl+C
    （`VisualElementContext.TextSelection.cs:398-410,569-664`），并备份/恢复文本、DIB、HDROP
    （`529-560,667-682`）。MP 的 `uia_text_adapter.py:127-143` 明确当前不会发送 Ctrl+C；在
    Chromium/Electron 真实可复制文本上会更慢地退 OCR。只能学思想，不能抄 BSL 代码。

42. **HTTP/SSE MCP transport 与过期会话重连。** Everywhere 的 ManagedMcpClient 同时选择
    stdio/HTTP transport，并在 session expired 后重连重试一次
    （`ManagedMcpClient.cs:223-241,386-427`）。MP `fabric/mcp_client.py:8-11,89-126` 只有 stdio，
    公司/云端 MCP URL 无法接入。

43. **基于当前对象的可见快捷动作。** Everywhere StrategyContext/Provider 能只展示当前文本、
    文件或元素适用动作（`StrategyContext.cs:9-52`、`TextSelectionStrategyProvider.cs:13-136`）。
    MP 有模型 ToolSearch，却没有让普通用户一眼看到“这里可翻译/解释/改写”的低风险入口。最小吸收是
    4–6 个固定 suggestion chips，不移植策略 DSL。

44. **专门的 coordinate-location 请求。** Clicky 用 Computer Use 专门 schema、截图宽高比匹配和
    坐标空间，而非让普通 vision 回答自然语言坐标
    （`ElementLocationDetector.swift:14-21,68-118,161-186`）。MP 有 Look/POINT，但没有独立的
    “只求一个坐标”provider profile。

45. **指点与语音同源的流式 tour。** Clacky 把 `[POINT]` 放在对应句前，并在那句音频开始时才移动
    指针（`tour.py:28-54,104-144,174-198`）。MP 有 POINT overlay 与语音输入，却没有结果 TTS，
    因此不能做免手的“边讲边指”。

46. **睡眠恢复语音设备。** clicky-windows 在系统 resume 后恢复 mic/loop
    （`companion_manager.py:340,375-395`）。MP 的 `voice_resident_runtime.ts:195-239` 能重启 child，
    但 Electron 侧没有 power resume 接线。

47. **一条 PTT 同时说话和圈选。** OpenClicky 用独立 event tap 吞本轮 down/drag/up，并在同一
    hold 收 partial transcript（`CircleSelectSession.swift:126-163,219-277,448-476`）。MP 当前 voice
    和 overlay gesture 是两个会话；这是高价值交互，但不应改掉已验证 FrameLease 常规路径。

48. **“笔迹覆盖 + 口述词”吸附语义对象。** OpenClicky 给 AX/window 候选同时算几何重叠和 speech
    token 加分（`CircleSelectSnapResolver.swift:33-60,80-156,159-203`）。MP 当前只用几何与已得
    evidence；如果将来立项 #47，可用已有 partial transcript 给候选加一次词面分，不建通用意图规则。

## 6. MP 已经做对、不能因竞品对照而倒退的地方

- FrameLease 在 pointerup 后先提交，失败 fail-closed；冻结历史与 live 动作语义分离。
- PerceptionBroker 对同帧证据并发收集、保留八态与冲突；不照抄 clicky-windows 的串行首命中。
- EventSession、durable Inbox、operation prepared/settled、Receipt 已形成完整 Harness 地基；
  Clicky 的记忆 JSON 不能替代它。
- 工具与 MCP 按需发现；远端 MCP 即使自报 `readOnlyHint` 也不会自动获得低权限。
- SurfaceAdapter/Capability seam 已存在；不把新 app 功能堆进 6,172 行的 `electron/main.ts`。

## 7. 建议顺序（不代表本轮全部施工）

1. **先修确定性 P0：**异常退出归还输入锁已随 1.0.31 完成；下一项是工具 late completion
   不能伪报未执行。
2. **再裁体积产品决策：**把本地语音做成明确的可选包（优先 SenseVoice runtime），不要在 baseline
   为缺模型的 Whisper fallback 常驻 650MB。这个裁决会改变离线语音交付形态，需单独确认后实施。
3. **修交付一致性：**sync 安装树镜像化、版本严格相等、staging 回收。已有 59GB 目录的删除属于
   不可逆操作，按用户新约束必须等确认口令；本文不删除任何文件。
4. **闭合自有 Harness 的 UI 投影：**pending turn 持久化/重启重附着、DraftArtifact/完整 ledger/
   Receipt 可视化。
5. **按真实需求补成熟桌面细节：**选区复制回退、hotkey fallback、HTTP MCP；语音 tour/PTT 圈选
   只有在明确作为产品模式时才做。

## 8. 测量命令与边界

目录字节/文件数使用 Windows `robocopy /L /E /BYTES` 只读统计；依赖大小对安装版
`site-packages` 一次遍历按首级包聚合；当前 package 与安装树差异用 `robocopy /L /MIR` 只读列举。
没有删除、移动或重打包任何文件。磁盘数字是 2026-08-31 本机事实；源码结论以当前 HEAD
`8dce76d` 为基准。
