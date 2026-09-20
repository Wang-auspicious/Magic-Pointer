# 2026-09-20 桌面与集成只读审计

审计对象是当前开发工作树，版本字段为 1.0.49；已有未提交修改全部保留。没有修改生产代码、启动 Electron/Figma、调用模型、发送消息或同步安装版。本报告不把协议测试称为原生应用验收，也不重复历史的 60/120 秒墙钟超时问题：当前桥已按活动续期。

证据等级：**A** = 本轮对真实模块做了隔离行为复现；**B** = 当前源码及生产调用路径明确，但未跑原生 UI；**C** = 明确产品边界与实现不一致。A 中使用 fake 原生节点的结果只能证明事务逻辑，不能证明某一 Figma 版本的具体异常频率。

本轮复现命令：`node --import tsx docs/research/audit-2026-09-20-desktop-repro.ts`，三次运行均退出 0，最新输出 19 组缺陷行为。它的断言记录当前缺陷行为，**不是修复验收绿灯**。运行前明确了检查目的：确认脏位、偏移、写入失败、等待期间 base 变化、桥容量、进度去重、重启观察、目录覆盖、历史与分支、持久化、命令超时和结果释放是否违反用户行为；补验真实 renderer 函数、Git 中文路径、实际预览读取量、延期更新接线及内嵌浏览器导航；若未出现则撤回对应结论。它只使用 fake child/node、生成后清理的系统临时目录、随机端口 loopback，未读写用户文档。

## 已确认的 21 项

### D01 · P1 · 异步保存进行中再次修改，会永久清掉待保存状态

- 位置：`electron/conversation_store.ts:409`、`:493–498`、`:458`、`:516`。生产开启 deferPersist，流式进度每 300 ms 更新 store（`electron/main.ts:2382` 附近）。
- 触发：一次磁盘写入尚未结束，新的修改到达且下一次 debounce 已触发；本机慢盘、磁盘忙或较大的会话库均可出现，不需要毫秒级竞态。
- 实际：timer 先令 `dirty=false`，`writeNowAsync()` 发现 `asyncWritePending` 后直接返回；旧写完成只清 pending，不再重排。此后 `flush()` 也认为没有工作。新内容只在内存里，正常退出也可能丢失。
- 期望及修法：pending 时保留 dirty；旧写完成后，若有后续修改，再排一次已有写入流程。无需另造持久化框架。
- 证据 **A**：人为延后一次真实 fs.writeFile 的回调，两轮已在内存，等待旧写完成并调用 flush 后磁盘仍只有一轮。脚本输出 `pendingPersistLost: {memoryTurns:2,diskTurnsAfterFlush:1}`。

### D02 · P1 · 有效进度也计入 256 KiB 累计上限，正常多步任务被杀

- 位置：`electron/python_bridge_runner.ts:97`、`:167–171`；`electron/main.ts:2437`、`:5861`；`electron/bridge_progress_lines.ts:15`。
- 触发：Studio 多次读取文件/观察屏幕，tool_result 的合法正文、reasoning 和 answer 通过 base64 stderr 进度发送。单工具结果支持 64,000 字符，几次正常读取就可能达到累计 256 KiB。
- 实际：进度已成功解析、任务持续活动，仍触发 `bridge_output_limit` 并 kill。无活动超时修复没有消除这个按输出体积的任务寿命上限。
- 期望及修法：已消费的合法进度不累计进诊断缓冲预算；诊断保留有界尾部，单条消息仍有合理上限。最终大轨迹宜以 EventSession 分页引用传输。Stage 的 `selection_worker_client.ts:184` 另有整条最终 JSON 1 MiB 上限，应一并核对，不能只扩大 stderr 数字。
- 证据 **A**：三个合法 tool_result，每条 32,000 个中文字，单记录 128,105 bytes；三个都触发 progress，随后结果为 `{error:'bridge_output_limit',stream:'stderr'}`。没有真实模型调用。

### D03 · P1 · 草稿实际补丁的 dirty 会被摘要编辑覆盖

- 位置：`electron/renderer/artifact_editor.ts:250–274`、`:304`；界面门控 `electron/renderer/studio.ts:2980–2991`。
- 触发：编辑一个 operation.after，随后在摘要栏输入再撤回原摘要，或调用正常摘要更新使它等于 savedContent。
- 实际：updatePatchPayload 置 dirty=true，但 updateContent 只比较摘要并改成 false。保存被禁用，接受旧 revision 被允许；accept 返回服务器旧补丁后，本地未保存改动直接消失。
- 期望及修法：分别保存已持久化的 content 和 patchPayload；dirty 是两者任一变化。直接比较值即可，不增加哈希。
- 证据 **A**：真实 editor 模块中将 after 改为 new 后恢复摘要，dirty=false；accept 成功后 after 回到 old。

### D04 · P2 · 实际写入值显示为普通文字，编辑时却强制 JSON.parse

- 位置：`electron/renderer/studio.ts:2919–2922`、`:2957`、`:3033`。
- 触发：打开 replace_text 等字符串补丁，将“新的说明”直接改成“更短的说明”。
- 实际：artifactValueText 原样展示字符串，不带 JSON 引号；change 统一 JSON.parse，普通中文文字报无效 JSON。即使不改值仅触发 change，已有展示值也不是合法 JSON。若用户输入 `123`，又会意外转换为数值而非字符串。
- 期望及修法：字符串字段使用原始文本编辑；对象/数组字段才用 JSON 编辑器，并按 operation 类型校验。
- 证据 **A**：提取真实 studio.ts 的 artifactValueText 和 change listener，转译后在 fake DOM 输入“更短的说明”，得到“请输入有效的 JSON 值；无效内容不会保存”。未修改被测函数。现有 artifact_editor_test 不覆盖这个入口。

### D05 · P1 · Figma 重选目标等待期间切换草稿，旧响应写入新草稿

- 位置：`electron/renderer/studio.ts:2864–2904`；对照同文件 `:2824` 附近预览已实现 latest-key 检查。
- 触发：点击“改用当前选中节点”，Figma 读取尚未返回时切换任务/另一草稿；读取可等待数秒甚至 15 秒。
- 实际：函数捕获旧 state，await 之后直接 `artifactEditor.updatePatchPayload(nextPayload)`；该方法作用于此刻选中的新草稿，没有 generation/conversation/artifact/revision 复核。旧草稿的 payload 污染当前编辑器，后续保存至少造成身份错误和编辑丢失。
- 期望及修法：等待结束后比对 selection generation 和 artifact/revision，变化则丢弃结果；复用现有 editor/preview 的隔离办法。
- 证据 **A**：提取真实 studio.ts 的 retargetFigmaArtifact，fake Data 延迟响应，等待中切换 A→B；返回后 selectedArtifact=b，patchMarker=patch-a。只隔离函数依赖，未修改其控制流，无需毫秒级竞态。未启动 GUI。

### D06 · P1 · Figma 同节点批量变长替换，后续范围使用过期 offset

- 位置：`integrations/figma/patch.ts:177–219`、`:345`、`:361–364`。
- 触发：公开 apply_patch.operations 批次在同一 text node 替换多个原文区间，前面的替换改变字符数。
- 实际：所有操作按原文预校验，然后顺序套用原 offset；第一次修改使第二次范围错位，却仍返回 appliedCount 成功。
- 期望及修法：同节点非重叠区间按原起点倒序执行，或先在内存合成最终变更；重叠区间明确拒绝/归并。不要让模型自己补偿变化后的坐标。
- 证据 **A**：`abcdef` 中 [0,1) a→AAAA 与 [4,6) ef→ZZ，实际 `AAAAZZdef`，期望 `AAAAbcdZZ`。这是插件支持的批量协议；未声称当前 Python DocumentOperationBackend 一定把两个操作同批发送。

### D07 · P1 · Figma 当前操作在一半失败时不参与回滚

- 位置：`integrations/figma/patch.ts:214–215`、`:362–368`。
- 触发：一个 replace_text 的 deleteCharacters 已完成，随后 insertCharacters 在真实 API 中失败。
- 实际：change 仅在 apply 完整成功后才 push 到 applied，因此当前已经删掉的文本不回滚。外层抛普通 `figma_patch_apply_failed`，未附当前节点部分写入/回滚失败状态；用户可能按失败重试。
- 期望及修法：事务记录在 mutation 前进入“可能已修改”状态；当前 change 失败也恢复，恢复失败则返回真实部分结果并读回节点。保留原错误，不能吞掉回滚失败的事实。
- 证据 **A（失败注入）**：fake Figma 节点删除 a 后插入抛错，`abc` 留成 `bc`。本轮证明的是异常路径缺失，不虚称已在某个 Figma 客户端版本复现字体异常。

### D08 · P1 · Figma 字体加载等待后不再核对原文

- 位置：`integrations/figma/patch.ts:193`、`:345–363`。
- 触发：预检通过后，异步加载字体期间用户继续编辑当前文字或移动节点；字体加载/节点访问可以持续秒级。
- 实际：base、位置、锁定状态在所有 await 前检查；await 完成直接执行预先准备的闭包，用户新内容被旧补丁覆盖。
- 期望及修法：完成字体加载后，在同步 mutation 段前重新核对节点存在、锁定、精确 base 与文档身份；改变则让用户重新接受。
- 证据 **A**：loadFont 期间将 abc 改为 xyz，原 abc→NEW 请求没有拒绝而写成 NEW。

### D09 · P1 · Figma 命令超时后仍会继续执行待派发写入

- 位置：`electron/figma_bridge.ts:274–297`、`:426–431`。
- 触发：插件暂停轮询、繁忙或暂时不可见超过请求期限，调用方看到超时；随后插件恢复轮询。
- 实际：request 抛 `figma_command_timed_out`，commands 中该记录仍为 queued；下一次 GET /commands 把它变为 dispatched。于是用户认定已失败的写入稍后发生，重试还可能再执行一次。
- 期望及修法：超时时未 dispatch 的命令取消；已 dispatch 的明确返回结果未知并等待读回，不能报普通未执行失败。已有命令状态机足够，无需新增服务。
- 证据 **A**：真实 loopback bridge，request 超时后 GET /commands 仍返回一个 apply_patch。测试并未让原生应用写入。

### D10 · P2 · Figma 已完成预览/命令结果永远留在主进程 Map

- 位置：`electron/figma_bridge.ts:120`、`:468`、`:535`，以及 `:154–169`、`:237–247`。
- 触发：反复打开/刷新节点预览，返回 PNG base64；长期运行期间不断执行查询和修改。
- 实际：命令及 result 从不 delete，结果已读取、断开连接甚至 stop 都保留。单次允许 12 MiB result body，几十/几百次预览可持续积累大量内存。
- 期望及修法：调用方消费终态后释放大 payload，最多留下有界状态摘要；断开/stop 清理已完成结果。需要重看预览时使用现有导出入口。
- 证据 **A**：loopback 完成 result、读取 result、closeConnection 后 commands.size 仍为 1；源码全文件无 commands.delete/clear。

### D11 · P1 · 创建分支只复制聊天展示，不复制材料和草稿所属 session

- 位置：`electron/conversation_store.ts:913–939`；`electron/main.ts:2208–2219`、`:2294` 附近；`electron/artifact_runtime.ts:48–49`。
- 触发：在包含 Office/Figma 材料和 DraftArtifact 的已完成回合点击“分支”，随后打开旧草稿或要求继续修改。
- 实际：turns 中 artifactId 被复制，但 agentSessionId 和 taskContext 均丢失，主进程没调用后端 EventSession fork。发送前打开草稿返回 conversation_has_no_agent_session；发送后新 session 也没有原材料和 artifact。继承最近聊天文字不能替代来源、引用、接受状态。
- 期望及修法：分支用已有 EventSession fork/copy 契约建立独立 child 归属，返回新 session 与材料投影；不复用原 session ID。若某类内容不能分支应明确提示。
- 证据 **A+B**：store 实测新分支丢这两个字段而 artifactId 仍在；GUI→artifact runtime 错误路径已核对。不是后端 fork 已修归属问题的重复报告，而是 GUI 根本没调用 fork。

### D12 · P2 · 超过 200 轮或 500 会话静默删除历史

- 位置：`electron/conversation_store.ts:16–17`、`:665`、`:718–720`、`:941`。
- 触发：同一长期任务进行第 201 次用户提交，或创建第 501 个普通任务/分支。
- 实际：直接 splice/缩短整个持久化数组，没有分页、归档入口或提示；旧用户消息、证据和草稿导航从 GUI/导出消失。Python EventSession 可能仍在，不能因此称 GUI 历史还可恢复。
- 期望及修法：限制初始加载/展示数量，历史保存在已有 store 并可分页读取；归档需可见可恢复。
- 证据 **A**：201 轮后 get 只余 200，第一问从 q0 变成 q1，flush 后同样裁剪。500 会话路径为同类明确源码行为，不拆成两个问题凑数。

### D13 · P2 · Studio 允许输入 12,000 字，发送时静默截成 4,000 字

- 位置：`electron/renderer/studio.html:302`；`electron/renderer/studio.ts:6627`、`:6691`；`electron/main.ts:2256`；`scripts/conversation_bridge.py:76`、`:797`。
- 触发：粘贴 4,001–12,000 字任务说明或材料后补一句关键约束再发送。
- 实际：前端气泡展示完整问题，主进程不报错而 slice(0,4000)，存档与 Runtime 指令只有前半。Python 原有超长拒绝永远看不到被截去的内容。初始无 source/reference 时 timeline 不入 inbox，不能靠 timeline 恢复尾部。
- 期望及修法：跨层统一受支持长度；超限在清空输入前明确拒绝并保留全文，或按产品预算传入完整指令。不能静默删尾部授权/限制。
- 证据 **B**：从 textarea→send→payload→bridge 的完整链已阅读，双方长度常量明确不一致。

### D14 · P2 · 后台任务步骤更新数量不变时，UI 不再收到进度

- 位置：`electron/task_watcher.ts:327–330`；主进程装配 `electron/main.ts:1349` 附近。
- 触发：任务仍为 running，已有一步从 running 变 done 或更新 note/耗时，但 steps.length 和数值 progress 未变。
- 实际：去重 signature 只含 status、步骤数和 progress，步骤内容被吞；用户看到旧阶段和旧结果，直到新增步骤或终态才恢复。
- 期望及修法：比较实际对用户显示的 patch 字段或用来源事件 revision；直接比较，不新增哈希。
- 证据 **A**：两次 probe 同一条步骤 reading→complete，onPatch 只收到第一次，shownNote 仍 reading。

### D15 · P2 · 材料关注重启后漏掉应用关闭期间的文件变化

- 位置：`electron/context_trackers.ts:541–567`。
- 触发：已开启材料关注，关闭 MP 后更新文档，再启动 MP；之后不再对文件作第二次修改。
- 实际：已有 lastObserved 时 armTracker 完全不读当前文件，只重新 fs.watch；关闭期间没有事件可重放，因此变化永久漏掉。
- 期望及修法：启动/重新启用时读取当前 observation，与已有快照比较，有差异合并为一次任务。沿用现有 debounce/lastObserved，不追补每一次离线事件。
- 证据 **A**：预置旧观察、注入新的 readObservation，start/idle/stop 全程 observationReads=0、runs=0。

### D16 · P2 · “关注文件夹”无法发现子目录文档内容变化

- 位置：`electron/context_trackers.ts:200–207`、`:224–237`、`:249`。
- 触发：用 createMaterialTracker(isDirectory=true) 关注项目/材料文件夹，随后编辑 `folder/sub/report.docx`。
- 实际：fs.watch 未 recursive，观察也只 stat 一层子项；修改孙文件内容通常不改变 sub 目录的 mtime/size。即使收到上层事件，前后 observation 仍相等而不启动任务。
- 期望及修法：界面明确支持的目录范围内递归观察、或按授权材料树登记文件；如果只支持直接子项必须明确限定。无需全盘监控。
- 证据 **A**：在临时 root/sub/a.txt 写入不同长度内容，真实 readFileObservation 前后 observationsEqual=true。

### D17 · P2 · Git Changes 中普通中文文件名变成八进制文本，点击打不开

- 位置：`electron/main.ts:1831`；`electron/project_environment.ts:81–84`；`electron/renderer/studio.ts:3945–3965`。
- 触发：默认 Git core.quotepath 下，项目中新增/修改“报告.md”等中文文件。
- 实际：porcelain v1 返回引号内的 UTF-8 八进制转义；parser 只去双引号，没有解码，Changes 的 path 因而不是实际文件名。点击路径进入 readProjectFile 后找不到文件。
- 期望及修法：Git 使用 `-z` 无歧义原始路径输出并解析 NUL；或在明确范围内禁用 quotePath 并正确处理 rename。常见中文文件名不是冷门编码问题。
- 证据 **A+B**：生成后清理的临时 Git 仓库中写入“报告.md”，相同 porcelain 输出经真实 parseGitEnvironment 后为 `\346\212\245\345\221\212.md`，该路径不存在；生产点击链已核对。测试显式 core.quotepath=true 固定默认条件，不改用户 Git 配置。

### D18 · P1 · 预览文件先全量同步读入，再做 384 KiB 截断

- 位置：`electron/project_inspector.ts:49–61`；`electron/main.ts:1917–1924`；`electron/renderer/studio.ts:3804–3805`。
- 触发：项目树点击很大的日志、视频、模型权重等普通文件；当前列表没有按类型/大小排除。
- 实际：fs.readFileSync 在 Electron 主进程一次读取整个文件，之后才检查是否 binary/截断。几百 MB/GB 文件在“拒绝预览”之前就可能阻塞界面或耗尽内存。
- 期望及修法：只读取预览上限加一个字节，先做有限二进制探测；大文本按需翻页。大小上限必须约束实际 I/O 而非返回字符串。
- 证据 **A+B**：真实 readProjectText 设 32 字节预览上限，fs 读取计量仍为 1,048,576 字节；同步 IPC 调用路径明确。未为证明缺陷故意分配 GB 内存或让真实应用崩溃。

### D19 · P2 · 更新按钮承诺“下次启动时安装”，实现没有安排安装

- 位置：`electron/update_manager.ts:199–216`、`:288`。
- 触发：安装版已下载更新，用户选择“下次启动时安装”。
- 实际：仅 response=0 调用 quitAndInstall；response=1 无操作，而 start 已明确 autoInstallOnAppQuit=false。没有持久化“下次安装”选择或下一次启动处理，承诺的动作没有接线。
- 期望及修法：选择延期安装时启用 updater 已有退出安装能力并使用相符文案，或实现真正下一次启动安装入口；不能只有按钮文字。
- 证据 **A+B**：真实 createUpdateManager 配 fake updater/dialog，update-downloaded 后选择 response=1，autoInstallOnAppQuit=false、installCalls=0；完整模块无延期安装状态/消费者。未下载或安装任何更新。

### D20 · P2 · Pi 扩展仍把 MP 当外部 Harness 的上下文/执行工具

- 位置：`integrations/pi/magic_pointer_extension.ts:51–53`、`:99–113`、`:119–142`。
- 触发：按项目提供的 Pi 扩展启用方式安装，外部 Pi prompt 提到 this/屏幕等词，或调用 magic_pointer_execute。
- 实际：before_agent_start 依正则向 Pi loop 自动注入冻结对象，且把 MP plan/execute 作为外部 loop 的工具注册；没有进入 MP 自有任务后再通过用户选择的纯投递通道输出。冻结数据还以 sendUserMessage 与用户指令拼接。
- 期望及修法：按当前规范把对接收敛为 MP 完成任务后向外部输入框/客户端投递已编译产物；如保留开发者实验集成，明确与正式产品入口分离，不把它作为正式执行路径。无需另建插件框架。
- 证据 **C**：本项目自写 integration 全文与 canonical/AGENTS 的产品边界直接不一致，不引用其他项目代码。不评价用户已另开、独立 Jev/Pi 项目的目标。

### D21 · P2 · 全局导航拦截误套用内嵌浏览器，普通链接跳到外部浏览器

- 位置：`electron/security_hardening.ts:91–101`、`:190–192`；`electron/main.ts:334`、`:2016–2034`。
- 触发：在 Studio 内嵌 Browser 地址栏打开页面后，点击普通同窗口 http(s) 链接或产生页面导航。
- 实际：全局 web-contents-created 已为该 WebContentsView 注册无条件 preventDefault 的 will-navigate，并调用 shell.openExternal。Browser 自己后来添加的合法 URL 检查不能撤销 preventDefault；内嵌页面停留在原页，系统浏览器被打开。页面后退/前进、登录和阅读流程被拆开。
- 期望及修法：为已知内嵌浏览器装配允许其 http(s) 页面导航的策略，MP 自己的本地窗口保留原限制；沿用同一个 WebContentsView，不放宽 Node/IPC 权限，也无需新浏览器框架。
- 证据 **A+B**：真实 attachContentsHardening 加现有 normalizeBrowserUrl 导航回调，普通 first→second URL 导航得到 prevented=true 且 externalUrls 包含 second。全局注册→WebContentsView 创建链已阅读，未打开任何真实网页或 GUI。

## 阅读覆盖（持续补充，不能当作“全仓已逐行读完”）

已完整分块阅读：canonical `MAGIC_POINTER_HARNESS_20260811.md`、`VIDA_UI_SPEC.md`、`2026-08-19-LONG_RUN_CAPABILITY_GAP.md`。`PRD.md` 已读主张、工作包、验收和末尾约束；最早合并输出存在截断，未将其当作全行无遗漏证明。`STATUS.md` 已读最新交付边界及有关历史段，长行历史尚有未完整输出区域。

已经完整阅读的生产模块：

- `electron/conversation_store.ts`、`conversation_control.ts`、`task_input_transport.ts`、`session_worktree.ts`、`selection_worker_client.ts`、`task_watcher.ts`。
- `electron/settings_store.ts`、`settings_save_policy.ts`、`context_trackers.ts`（已补完最早输出截断的 normalize 区段）、`python_bridge_runner.ts`、`bridge_progress_lines.ts`。
- `electron/figma_bridge.ts`、`figma_runtime.ts`、`artifact_runtime.ts`、`stage_turn_stream.ts`。
- `electron/task_sources.ts`、`project_environment.ts`、`project_inspector.ts`、`profile_workspace.ts`、`stash_store.ts`、`stash_runtime.ts`、`update_manager.ts`。
- `electron/renderer/artifact_editor.ts`、`dsh_markdown.ts`。
- `electron/runtime_paths.ts`、`slash_trigger.ts`、`ipc_surface_policy.ts`、`pointer_dismiss_policy.ts`、`conversation_error.ts`、`stage_hit_regions.ts`、`renderer_readiness.ts`、`agent_session_id.ts`、`activation_gate.ts`、`browser_view_policy.ts`、`gesture_runtime_settings.ts`、`studio_shell.ts`、`proactive_once_store.ts`、`conversation_workspace_policy.ts`。
- `electron/route_policy.ts`、`background_learning.ts`、`clarification_chips.ts`、`mouse_activation.ts`、`pointer_polling_policy.ts`、`app_lifecycle.ts`、`stage_surface_policy.ts`、`stage_chips_policy.ts`、`python_runtime.ts`、`stage_hit_policy.ts`、`submit_gating_policy.ts`、`internal_action_policy.ts`、`answer_shape_policy.ts`、`geometry_space.ts`、`dictation_correction_policy.ts`。
- `electron/renderer/effort_levels.ts`、`popover_position.ts`。
- `electron/renderer/permission_presets.ts`、`sidebar_groups.ts`、`studio_inspector_state.ts`、`settings_model.ts`、`settings.ts`。
- `electron/element_ghost_policy.ts`、`stage_stretch_policy.ts`、`credential_store.ts`、`voice_focus_guard.ts`、`voice_trigger_policy.ts`、`stage_pick_policy.ts`、`append_log.ts`、`proactive_rules.ts`、`runtime_snapshot.ts`、`security_hardening.ts`、`model_runtime_config.ts`。
- `integrations/figma/patch.ts`、`code.ts`、`ui.ts`；`integrations/pi/magic_pointer_extension.ts`；Claude/Codex/Cursor/Gemini 四份集成配置示例。

部分/锚点阅读：`electron/main.ts` 的 tracker 装配、selection progress、项目/worktree/文件 IPC、conversation branch/send、artifact/Figma IPC、runPythonBridge、WebContentsView 创建及 Browser IPC、submit gating；`electron/renderer/studio.ts` 的 artifact 预览编辑接受应用、Figma 改绑、项目浏览/Changes、task input、Composer 提交。大型文件其余区段不冒充已全读。

测试：已完整阅读 `tests/artifact_editor_test.ts`、`tests/figma_patch_test.ts`；`tests/context_trackers_test.ts` 已读到 disabledTracker 部分，其他测试待逐文件补读。新增隔离复现脚本没有进入项目默认测试套件。

尚未完成：Electron 其他模块、其余 renderer TS/CSS/HTML、其余本项目测试和 Figma 包装配置的逐行覆盖。二进制字体/视频/光标只列出资产身份，不能称为源代码逐行阅读。外部/reference 排除项未打开；已明确保留用户的“参考其他项目的不看”约束。

这份报告只列有具体调用路径的问题。未将混合字体样式保留、更多 Git 统计边界、源码断言测试比例等待核实候选塞入 21 项。submit_gating_policy 仍有 20 秒墙钟门，但本轮未核实最新 capture 能持续超出该门的完整可达链，故不计入。已有真实做对的部分包括：编辑器 select/save/accept/apply 的 generation 检查、Figma 明确文档 task 绑定、缺字体在初次 mutation 前失败、Stage 活动续期、store 的原子文件替换；问题是这些机制的具体遗漏，不是建议重写整套 Harness。
