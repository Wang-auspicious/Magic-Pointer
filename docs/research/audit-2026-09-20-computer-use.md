# 2026-09-20 Computer Use 分区只读审计

本报告针对当日**未提交工作树**，不是上一版安装包；没有修生产代码、启动 GUI、触碰真实桌面、调用真实模型或读取外部参考项目源码。FrameLease Phase A 的历史时序问题和已修 60/120 秒天花板不重复计入。以下 27 项按独立故障原因列出；没有为了达到数量把单个截断问题拆开。

证据级别：**A** = 当前代码路径的纯替身最小复现；**B** = 当前生产装配/调用链直接证明，尚未执行真实应用验收。复现脚本为 `docs/research/audit-2026-09-20-cu-repro.py`，输出为同名 `.json`。执行命令 `python -B docs/research/audit-2026-09-20-cu-repro.py`，退出 0。它只调用注入的窗口/元素/输入替身，Win32InputDriver 以 `__new__` 构造后拦截 `_send`，PowerShell 执行也被拦截。补充见证只创建临时假文件/图像、以假DOM运行项目自身JS，再经过真实reader；没有实际浏览器或截图。这个成功退出表示缺陷见证取得，**不是修复测试通过**。

## 已确认的问题

### CU01 · P1 · Focus 返回成功，但真实输入驱动没有 activate

- 位置：`app/desktop_actions/session.py:385–394`；`app/computer_operator/windows.py:139–397`。
- 触发：Agent 按工具推荐先 `Focus(window_id)`，再 Type/Key 操作非前台窗口。
- 实际：`getattr(driver, "activate", None)` 得到 None，跳过全部动作后仍返回 `ok: true`。生产 `Win32InputDriver` 全类没有 `activate`。其后前台检查失败，不能完成聚焦恢复。
- 预期/影响：窗口真正进入前台后才能报告成功；目前工具误导 Agent 重复观察/输入。既有单测 `_Driver` 有 activate，所以未覆盖生产接口断路。
- 最小修法：实现 Win32 激活并读回前台；缺少实现时明确失败。证据 **A**：`focus.production_driver_has_activate=false`，`driver_calls=[]`，result.ok=true。

### CU02 · P1 · 横向滚动请求变成零滚动

- 位置：`app/desktop_actions/session.py:527–543`、`:307`；schema 在 `:1085–1104`。
- 触发：Excel 宽表、横向时间线调用 `Scroll(dx=3,dy=0)` 或 `act_ui(scroll_x=3)`。
- 实际：首句 `del dx`；只给驱动 `delta=dy`，却返回成功动作回执。
- 最小修法：驱动支持横向 wheel，或当前能力契约明确拒绝非零 dx；不能静默丢参。证据 **A**：`horizontal_scroll` 为 `delta:0`。

### CU03 · P1 · Type 多行草稿会发送真实 Enter，submit=false 也可能发出消息

- 位置：`app/computer_operator/windows.py:368–390`；`app/desktop_actions/session.py:470–505`。
- 触发：把多段回复写入微信/钉钉等 Enter 发送的输入框，或写含 Tab 的表格文本。
- 实际：`\n`/`\r` 编成 VK_RETURN；`\t` 编成 VK_TAB。换行能够提交前半段，Tab 能切换焦点，余下文字继续落到新位置；外层 submit=false 仅阻止最后额外的 Enter，阻止不了文本中的控制键。
- 最小修法：纯文本输入用 ValuePattern 或保留剪贴板的受控粘贴；换行键作为应用能力单独执行。不要把内容字符解释成提交/导航动作。证据 **A**：`type_control_keys` 显示文本中发出 VK13 和 VK9。

### CU04 · P1 · 快捷键中后续键失败会把 Ctrl/Alt 留在按下状态

- 位置：`app/desktop_actions/session.py:864–869`；可对照同项目 `windows.py:575–597` 已有的正确释放逻辑。
- 触发：`Key(keys="ctrl+unsupported")`，或第二个 SendInput 调用失败。
- 实际：全部 key_down 完成后才开始 key_up，没有 finally；异常会跳过已按下键的释放，影响用户后续真实输入。
- 最小修法：记录实际按下的键，finally 逆序释放，再传播原异常。证据 **A**：只有 down ctrl/down unsupported，无 up ctrl。

### CU05 · P1 · 多任务输入所有权没有真正隔离

- 位置：`app/harness/builtin_bundle.py:341–343`；`app/desktop_actions/session.py:40–70`、`:1209–1223`。
- 触发：用户同时推进 Stage 与 Studio 任务，或同进程重建多个 Runtime。
- 实际：生产 `default_session()` 未传真实任务 ID，全部用默认 `session_id="loop"`；锁把第二任务当作同持有者重入。不同 Python bridge 进程又各有一把 `threading.Lock`，同一真实桌面没有跨进程仲裁。
- 最小修法：传真实任务/运行身份，并让所有桌面输入经既有持久宿主的一处所有权入口；不要额外造第二套任务账本。证据 **A+B**：两个独立 session 同时 `_require_input` 均通过，holder=loop；生产装配直接证明默认值可达。

### CU06 · P1 · RuntimeId 变了，index 点击仍通过 stale 检查

- 位置：`app/desktop_actions/session.py:725–779`、`:1417–1432`；UIA 已在 `app/desktop_actions/uia.py:127–129` 保留 runtime_id。
- 触发：列表虚拟化、切换会话/文档后同位置出现同名控件，例如同一位置的“发送”“删除”。
- 实际：重探只比较 role/name/rect，忽略已有 runtime_id；新对象同名同位置就通过。原生 UIA act 之后还会按 runtime_id 找目标，但物理 Click 不会。
- 最小修法：有原生 RuntimeId 时首先比较；缺失才使用现有语义降级。证据 **A**：runtime_id=[1]→[2] 后 fake driver 仍接到 click。

### CU07 · P1 · 裸坐标动作完全不检查窗口内部状态变化

- 位置：`app/desktop_actions/session.py:698–723`、`:781–813`。
- 触发：截图/Observe 后等待模型期间用户滚动、切标签、弹层变化，但 HWND/PID/窗口大小未变；模型按旧 x/y 点击。
- 实际：不带 index 时不重探元素；租约只比较 hwnd/pid/bounds。原坐标可命中新对象，且遮挡检查只证明仍是同一个窗口。
- 最小修法：坐标绑定本次观察的局部目标证据/状态代际；变化时重新观察再定位。无需给整个桌面新增哈希。证据 **B**：唯一 live 内容检查只在 `targets` 非空时运行。

### CU08 · P1 · “完整缓存树搜索”实际上只能搜前 100 节点与每段前 80 字

- 位置：`app/desktop_actions/session.py:204–239`、`:339–351`、`:1454–1490`。
- 触发：Office ribbon/复杂网页超过100控件，或搜索某长文本/值的后半段。
- 实际：raw_elements 保存了全量，但 search_ui 使用压缩后的 snap.elements；被裁掉的第101个节点不可搜、不可取得 @e ref，read_text 也无法通过 `_element_for_ref` 找到它。80字符以后的关键词搜不到。schema 明称“完整缓存树”。
- 最小修法：查询与引用解析使用 raw_elements，只有结果投影有界；保持可继续搜索/展开，不抬高默认首屏 dump。证据 **A**：raw=101，visible=100，Target命中0；原文含 Needle，查询仍0。

### CU09 · P1 · read_text 对 TextPattern 文档只有控件名字，没有文档正文

- 位置：`app/desktop_actions/uia.py:418–439`；`app/desktop_actions/session.py:255–260`。
- 触发：UIA 支持 TextPattern、不支持 ValuePattern 的文档编辑器/阅读器，模型调用 read_text。
- 实际：dump 只从 ValuePattern 读取 value；虽公开 `patterns:["Text"]`，read_text 只返回 value 或 name，不调用 TextPattern 的文本范围。读到“文档/编辑器”名称可能被误当正文。
- 最小修法：缓存/深读 TextPattern DocumentRange（有界并可继续），无法取正文则诚实 unavailable。证据 **B**：代码中 TextPattern 仅用于 select_text，未进入正文读取路径。

### CU10 · P1 · act_ui 部分动作已成功后，后一步失败会丢掉成功回执

- 位置：`app/desktop_actions/session.py:288–330`。
- 触发：第一步 typeText 已写入，第二步 keypress 不支持/失焦，或点击展开后下一步 target stale。
- 实际：`executed` 只在全部循环成功后返回；异常直出工具边界，仅留下整批错误，没有已执行前缀、每一步backend/验证结果。重试整批可能重复写入。
- 最小修法：逐步收集并返回实际回执；失败携带已执行/未执行索引，不声称原子事务。证据 **A**：driver已记录 `type already written`，registry 只返回异常，value=None。

### CU11 · P2 · act_ui 接受 path，但拖拽只走首尾两点

- 位置：`app/desktop_actions/session.py:309–313`。
- 触发：模型给出折线路径以绕过中间目标，或做画布上的路径操作。
- 实际：所有中间点静默丢弃，变成首尾直线；调用方无法知道实际轨迹不同。
- 最小修法：保留路径执行，或契约只允许两个点并拒绝多点；不要接收无法兑现的路径。证据 **A**：三点path的中间(300,400)未进入driver。

### CU12 · P1 · 点击/快捷键/submit 始终声明可逆写，无法落实真实发送/删除语义

- 位置：`app/desktop_actions/session.py:944–954`、`:1010–1079`、`:1120–1132`。
- 触发：Type(submit=true)、Key(Enter/Delete)、Click/Act 操作发送/删除按钮。
- 实际：这些工具和 act_ui 全是静态 `Effect.REVERSIBLE_WRITE`，没有按任务授权/明确动作范围细化 effect。权限门、恢复重放门、完成回执因此不能区分普通输入与外部发送/破坏操作。
- 最小修法：把用户明确授权和已定位目标的真实动作效果带到调用契约，经过现有 effect/access_for/恢复门；不以全局禁用或机械二次确认代替。证据 **B**。与 Runtime 分区同根因时只计一次。

### CU13 · P1 · UIA 异常变空树，等待“控件消失”会假成功

- 位置：`app/desktop_actions/uia.py:140–148`；`app/desktop_actions/session.py:276–286`。
- 触发：等待保存进度/删除确认消失时目标 UIA 短暂报错或提供者不可用。
- 实际：walk_window 吞异常返回[]，get_app_state无失败状态；wait_for(until=absent)对空树取反，found=true。
- 最小修法：区分读失败与真实空树，失败不得满足 absence 条件。证据 **A+B**：fake空探测立即found=true；生产异常→[]由明确代码证明。

### CU14 · P2 · 每次观察快照永久留在当前会话内存

- 位置：`app/desktop_actions/session.py:113`、`:426–434`、`:645–647`。
- 触发：长任务多轮 Observe，或 wait_for 每150ms观察一次。
- 实际：每次uuid快照都含窗口副本、压缩树和完整raw_elements，字典只增加不清除；turn_ended也只放锁。长run不需要旧快照的模型照样累积全部原文。
- 最小修法：保留有限最近状态/仍被使用的状态，旧引用明确stale；详细历史只保留现有任务日志中必要证据。证据 **A**：200次observe后仍保留200份。

### CU15 · P2 · 合法追加输入永远拿整字段与追加片段比较

- 位置：`app/desktop_actions/session.py:489–503`。
- 触发：已有prefix的输入框，Type(text="suffix",clear=false,index=...)。
- 实际：读回prefixsuffix后与suffix精确比较，判unavailable；submit=true因此跳过提交，模型可能重试追加。
- 最小修法：依据操作前内容和选区生成预期后置值；无法确定选区时诚实提供实测值和未验证状态，不把写对的追加当失败。证据 **A**：读回prefixsuffix仍matched=false。

### CU16 · P1 · Excel 区域读取脚本四个坐标占位符从不替换

- 位置：`app/adapters/office_adapter.py:119`、`:188–203`。
- 触发：圈选Excel单元格区域并经COM region-from-point读取。
- 实际：模板用 `{region_x}/{region_y}/{region_w}/{region_h}`，替换循环却处理 `{x}/{y}/{width}/{height}`。传给PowerShell仍含四个占位符，坐标表达式不能按预期执行，整条准确区域读取失效。
- 最小修法：统一模板名与参数名，并对最终真实脚本文本做行为契约；无需另建兼容层。证据 **A**：拦截真正 `_run_powershell_json` 实参，四个token全部残留。

### CU17 · P1 · Live Observe 用旧 source_id 读取同窗口的新文档/会话

- 位置：`app/harness/builtin_bundle.py:374–387`。
- 触发：用户给任务绑定微信群A、网页标签A或Office文档A，随后在同HWND切到B，模型 `Observe(source_id=A)`。
- 实际：read_live_state只核对HWND；source中的conversation/document/browser身份完全未检查。当前B的像素和树被标成sourceA，污染引用与后续判断。
- 最小修法：经该来源的现有adapter重绑并核对相应会话/文档身份；不一致返回需重绑。证据 **B**，与Context分区同根因时只计一次。

### CU18 · P1 · 目标窗口被遮挡时，Live Observe 读取遮挡者像素并归给目标

- 位置：`app/harness/builtin_bundle.py:389–404`；`app/capture/__init__.py:70–75`。
- 触发：已绑定窗口后弹出Stage/其他应用遮住它，模型要求live观察。
- 实际：按目标窗口bbox调用默认GDI桌面ImageGrab，没有可见性/遮挡归属说明；UIA来自目标窗口，像素却来自上层窗口，仍同一sourceId输出。
- 最小修法：按窗口捕获；当前只能桌面抓取时明确遮挡/覆盖不足，不能把遮挡内容归属给目标。证据 **B**。这是实时Observe的问题，不是重报已修FrameLease冻结时序。

### CU19 · P1 · 一张窗口视口截图被标成完整 document coverage

- 位置：`app/agent_runtime/live_observer.py:130–137`；`app/harness/builtin_bundle.py:389–404`。
- 触发：对长文档/聊天/网页执行不带locator的Live Observe，视觉返回非空文字。
- 实际：extent=document、totalUnits=1、complete=true；实际只有当前窗口截图和有界UIA树，屏幕外正文未读取。
- 最小修法：extent应是viewport/neighborhood等实际范围，未取得全文不承诺document complete；既有结构reader补全文。证据 **B**，直接违反PRD覆盖度语义。

### CU20 · P2 · 有绑定来源时，Observe(mode=ax)也强制截图并调用视觉模型

- 位置：`app/harness/builtin_bundle.py:425–444`；`app/agent_runtime/live_observer.py:74–96`。
- 触发：Agent只想取一个当前UIA树用于Click前校验，调用默认Observe或mode=ax。
- 实际：只要source_id可推断就无条件进LiveObserver，mode/ax_filter/pid/app不再传给结构路径；每次都抓图并调用视觉。纯文本模型会额外失败，视觉模型增加显著延迟与费用。
- 最小修法：结构观察尊重mode，只有明确需要像素/视觉问题时进入vision。证据 **B**。不是要求换独立视觉模型配置。

### CU21 · P2 · Live Observe 丢弃取消作用域，Stop不能中止视觉请求

- 位置：`app/agent_runtime/live_observer.py:54–61`、`:94–100`。
- 触发：实时视觉正在请求，用户按Stop/接管。
- 实际：入口 `del scope`，后端describe不带取消信息；已启动的感知可能持续至30s超时/完成。
- 最小修法：沿已有VisionBackend与请求层透传scope并在捕获/模型前后检查，不增加第二套取消系统。证据 **B**；不声称已测真实Stop耗时。

### CU22 · P2 · 视觉元素缓存不能感知滚动或切会话，八秒内复用旧位置

- 位置：`app/vision/visual_element_cache.py:30`、`:42–63`；使用者 `scripts/element_probe_bridge.py`。
- 触发：微信/自绘应用同窗口内滚动或切会话后，立即继续pick对象。
- 实际：cache key仅HWND和窗口bbox、TTL8秒；窗口内容变化不影响缓存，旧文字矩形仍被当成本轮元素画框。
- 最小修法：对明确的滚动/窗口内容变化事件使缓存失效，或pick提交时对局部对象重新读取；不要提高TTL或让模型猜。证据 **B**；窗口移动已覆盖，不把已修几何问题重报。

### CU23 · P2 · 日常CU结构读取没有deadline/取消，单个UIA提供者可挂住工具

- 位置：`app/desktop_actions/session.py:1301–1304`；`app/desktop_actions/uia.py:442–480`、`:496–545`。
- 触发：受支持的Office/浏览器UI线程卡顿，COM UIA属性或子节点查询不返回。
- 实际：每次新建COM自动化对象，同线程同步逐节点、多pattern跨进程调用，无deadline或scope；400节点预算只能限次数，不能限制一次阻塞。它没有经过项目已经具备的resident UIA host超时通道。
- 最小修法：把CU tree/act接到已有可超时隔离宿主，保留真实timeout而非[]；不要另造新框架。证据 **B**；当前仅定位阻塞路径，不以无头fixture冒充真实卡死测量。

### CU24 · P1 · Explorer 隐藏扩展名的准确名称可被同名前缀文件抢先匹配

- 位置：`app/grounding/explorer_adapter.py:194–206`；生产调用 `:525`、`:296–297`。
- 触发：资源管理器隐藏已知扩展名，同目录有 `report-old.txt` 和 `report.txt`，用户指向显示为 `report` 的后者；PowerShell UIA fallback 或桌面路径补全调用 resolve_child_path。
- 实际：直接 `folder / report` 不存在；遍历第一个 report-old.txt 时虽然精确名/stem不匹配，却因无条件 `startswith(trimmed)` 立即返回，根本不会到后面的精确 report.txt。
- 预期/影响：精确显示名应绑定 report.txt；当前会把别的文件路径交给Context读取、后续编辑或交付。不是只损失一个展示标签。
- 最小修法：先完整扫描精确文件名/stem匹配，再仅对真实省略号名称处理唯一前缀候选；歧义不伪造确定路径。证据 **A**：真实临时目录按当前遍历顺序返回report-old.txt，见 `explorer_hidden_extension`。

### CU25 · P1 · frozen_lease 分支绕过 deny/structured_only 的图片消费限制

- 位置：`scripts/selection_snapshot_bridge.py:2413–2446`、`:2586–2594`、`:2646–2681`、`:2710–2725`。
- 触发：正常手势已带合法FrameLease，本轮逐应用策略是deny，或structured_only禁止本地像素。
- 实际：should_capture_visual正确算出false，但紧接着的frozen_lease分支不看它，照样消费/标注图片，返回visual_context、capture_path和frame_lease。deny只让summary显示“永不捕获/hasVisual=false”，数据仍带图。
- 预期/影响：图片的存在不能绕过本轮明确策略；下游拿到的快照与用户看到的隐私状态相反。本项证明本地消费与导出绕过，**不把未实测的远程上传算作已发生**。
- 最小修法：冻结图消费同样服从allow_local_pixels；deny/structured_only不得生成视觉context/注释图或导出可读图片入口。捕获时也须遵守既有策略，但本次不重报Phase A时序。
- 证据 **A**：合法冻结fixture结果status=denied、allowLocalPixels=false、summary.hasVisual=false，同时capture_path与frame_lease非空，context.adapter=screen_region；OCR预热与其他桌面调用均被替身隔离。

### CU26 · P1 · PDF 的“结构”适配器在内部重新截实时桌面，未使用冻结帧

- 位置：`app/adapters/uia_text_adapter.py:808–814`；`app/adapters/pdf_selection_recovery.py:88–89`、`:570–585`。
- 触发：Chromium打开本地PDF并读取非空原生选区；选择完成后Stage成为前台，或本次处于structured_only模式。
- 实际：UiaTextSelectionAdapter无条件以无screen_capture参数调用recovery，后者自行全桌面ImageGrab且要求源PDF仍是前台。历史FrameLease没有传进这一层。Stage出现会让明明有效的本地PDF选区因not foreground被拒；structured_only路径仍可能拍屏。
- 预期/影响：核对高亮应基于本次冻结帧，所用证据类型/策略要真实；内部隐式实时截图导致读错时刻或无谓失败。它不同于主snapshot已修的冻结时序，也不同于CU25消费已有图。
- 最小修法：明确传入已授权冻结图及坐标原点；无法使用像素时只报告结构读取及对应限制，不在UIA reader里隐式抓屏。
- 证据 **A+B**：用真实adapter与替身UIA返回选区，拦截到一次_capture_screen；前台替换成Stage HWND后返回PDF window was not foreground。无真实截图或PDF应用操作。

### CU27 · P1 · 浏览器完整文档/搜索截断单节点正文，却报告 complete=true

- 位置：`app/adapters/browser_devtools_adapter.py:515–527`、`:534–542`；`app/context_pack/browser_reader.py:125–185`。
- 生产装配：`scripts/conversation_bridge.py:913,925` 与 `scripts/selection_bridge.py:2767,2779` 注册为web reader。
- 触发：长日志、代码块、文章等一个DOM节点超过12000字符；模型Context.read或搜索正文12000字符后的关键句。
- 实际：JS用完整text判断query命中，却返回text.slice(0,12000)。节点翻页已结束便complete=true、无nextCursor/limitation；Python reader照此上报document或query-results已完整。
- 预期/影响：遗漏的节点尾部永远无法翻页补读；搜索返回一个不包含命中关键词的截断片段，还声称没有遗漏。不是CU08 UIA前100节点/80字符索引的问题，也不是CU19把一张视口图当全文。
- 最小修法：给超长节点正文提供可继续读的字符区间/片段，或明确truncated和不完整coverage；搜索至少返回真实命中区间并保留可追踪locator。
- 证据 **A**：生产JS在纯fake DOM中读取20008字符PRE，再经真实CDP client/BrowserContextReader，返回12000字符、complete=true。位于15000处的NEEDLE命中时返回片段不含NEEDLE，仍complete=true；没有调用浏览器或网络。

## 另外确认的能力边界，不计入上述27项

- `observe_ui(mode="visual")`只把get_app_state mode改成full，仍只有UIA outline，没有图像/视觉结果；`expand_ui(depth)`返回扁平数组邻居，而非父子树。当前STATUS已经承认outline是扁平投影，应在接口说明里同样诚实。
- `Type`宣称 `used_backend=foreground_clipboard_paste`，实际驱动是SendInput Unicode。建议随输入修复一起纠正，单列数量价值不大。
- `ComputerTaskService`已经注册为服务，但搜索不到正常Runtime使用 `computer_agent.run` 的调用方。因此不能把内部UI-TARS服务完成等同于用户已可用的视觉动作闭环。
- 该内部服务的 `_visual_change_verifier` 只以任意像素hash改变认成功；`GuardedComputerOperator` 又要求模型观察到执行前两张图hash逐字节相同。动态光标/动画可能前门拒绝动作，背景变化又可能后门误验证。接入前需改成实际目标/后置条件；本次不把未接通服务的风险冒充已经发生的产品bug。
- 结构化FrameLease冻结先行、raw snapshot正文保留、set_value真实readback、输入坐标窗口边界/遮挡检查、冻结Look与live Observe区分，这些已有改进读到了，不重复报成缺失。

## Jev 建议：放在候选判断层，保留 MP 的执行权

主审已核实拿到的是文本 Choice/Score/Noul 能力；本分区不假定它能读截图，也未读取Jev权重或调用其服务。现有接入位置有三个，优先级如下：

1. **UIA/DOM候选选择**：先修CU08，让完整raw_elements可查询；把用户目标、少量父级/相邻文字、role/name/value和不透明候选ID交给Jev Choice。输出只允许选择现有候选或abstain；坐标、RuntimeId、窗口身份由MP保留。执行仍进入 `_require_snapshot/_require_unchanged_element`，不能让Jev越过CU06/07。
2. **Context.search/候选片段重排**：Jev Score 对已授权且已经读取的候选排序，提高相关性而不扩大来源权限。只重排，不删原候选；结果返回已有sourceId/locator，不能让Jev生成路径或身份。
3. **OCR/UIA冲突辅助**：可以把同一局部对象的多路文本候选交给Jev识别不一致/需进一步读图，但它无像素输入时不能裁决哪个数字“就是屏幕真值”。现有 `app/perception/fusion.py` 的窗口/覆盖/冻结与数字不一致硬约束保留；必要时交给所选视觉模型或用户。

不建议先替換主Runtime模型、另建CU循环、取消ActionLease，或让Jev输出自由坐标并直接SendInput。当前最确定的收益来自减少候选挑选错误和大树上下文，而不是修复不存在的视觉能力。

本地接入验证应先用既有脱敏UIA/OCR冻结fixture做离线比较：目标ID准确率、正确拒答率、候选越界率、p50/p95耗时；只对具体下一步会改变的样本使用模型。随后跑真实Focus→Observe→目标选择→安全临时控件输入→读回闭环，保存真实backend与回执。模型提速不能替代本文的输入与身份修复。

## 阅读记录与未覆盖范围

完整阅读的核心生产文件（包括扩读，路径大括号表示其中每一项均读完）：

- `app/desktop_actions/{session,uia,__init__}.py`
- `app/computer_operator/{windows,configured_model,service,agent,protocol,schema,ui_tars,registry,agent_cursor_channel}.py`（agent/protocol开头值对象与接口定义另外分段回读）
- `app/perception/{broker,fusion,element_handles,providers,pixel_ocr}.py`
- `app/grounding/` 当前全部11个Python文件：`__init__`、`base`、`component_source`、`evidence_binding`、`explorer_adapter`、`explorer_context`、`marked_read`、`ocr_mark_selection`、`perception_cascade`、`schema`、`terminal_evidence`。
- `app/adapters/` 当前全部9个Python文件：`__init__`、`base`、`browser_devtools_adapter`、`figma_client`、`office_adapter`、`pdf_selection_recovery`、`powerpoint_native`、`registry`、`uia_text_adapter`。
- `app/surface_adapter/{registry,manifest,protocol,adapters/wechat_adapter,adapters/dingtalk_adapter}.py`
- `app/vision/{visual_elements,visual_element_cache,image_prompt,overlay_translation}.py`
- `app/capture/__init__.py`、`app/system_context.py`、`app/uia_host_client.py`、`app/agent_runtime/live_observer.py`、`app/context_pack/browser_reader.py`、`app/fabric/capture_policy.py`
- `scripts/selection_snapshot_bridge.py`（2841行）、`scripts/frame_capture_worker.py`（435行）、`scripts/frame_lease.py`、`scripts/element_probe_bridge.py`、`scripts/record_desktop_trace.py`
- `native/macos/{README.md,MagicPointerHost.swift}`：确认其为未验证的原型边界，没有据此声称macOS已验收。

重点分段/调用链阅读：`app/harness/builtin_bundle.py`（CU装配全段）、`scripts/conversation_bridge.py`/`selection_bridge.py`（web-reader装配与相关caller）、`app/context_pack/sources.py`（来源/coverage值对象）、`tests/frame_lease_selection_bridge_test.py`（1–178）、`tests/pi_computer_use_parity_test.py`、`tests/desktop_action_tools_test.py`。这些分段未冒充全文件阅读。

事实源阅读：`MAGIC_POINTER_HARNESS_20260811.md`（按章节分块回读，历史账本与最新记录核对）、`docs/STATUS.md`当前9月状态与诚实边界、`PRD.md`来源/覆盖/实时观察契约。没有读外部参考项目。

**不能声称本分区每个文件均逐行读完**：UIA C#大型宿主、光标动画纯几何模块、Figma surface adapter、perception.visual_once、若干包初始化文件，以及多数实验/验证脚本和测试尚未作逐行完整审计。上面是已确认问题，不是对未读范围的无问题保证。现有2321项全量测试中的既知OCR几何失败未重跑，也没有运行fresh全量验证；只读审计不宣称修复或安装交付。
