# 子 Agent 协作与思考流渲染修复

日期：2026-09-20。版本沿用用户要求的 1.0.50。此批接续启动 / 模型 / Work / Design 修复。

## 确认的原因

- `subagent.py` 原来只转发工具开始/结束，忽略子模型的 reasoning_chunk / model_chunk。子任务在等待模型与输出期间看起来没有工作。
- 子快照不带父工具调用 ID，Studio 猜最后一个 Agent 行。两个 readonly 子任务并行时可串行。
- 子快照只进临时 Map，没有写入父 trajectory，结束或重开后只剩工具结果摘要。
- Tasks 每个快照都 replaceChildren，丢失展开态、滚动与选择。工具输入/输出已经来自真实事件，但详情没有展示。
- Studio 每块流文本立即执行 DOM 更新和滚动测量。Chromium 中100块同步输入触发101次绘制。
- 流式思考首次为空，长度判断只做一次；结束时文本未变会跳过更新，留下 Thinking 状态和无效长文预览。

## 已实施

1. Runtime 工具分发传入真实 call.id，由 ContextVar 隔离并行调用；这个 ID 不来自模型参数。子事件使用 parentCallId 确定关联。
2. 子任务报告 thinking / writing / tool / terminal、轮次、实际耗时、最近模型文字和工具证据。首个文字和阶段变化立即发；连续增量最多约每120ms发快照，终态强制包含最后尾段。
3. `RuntimeActivitySink.subagent_progress` 同时用于 Studio / selection 两个桥，快照附着到父工具 trajectory，完成后的记录保留它。详情从当前或保存的 trajectory 投影，不用全局跨会话 Map。
4. 父调用行显示子任务最新活动和数量；并行任务各自可打开 Tasks 详情。Tasks 按任务 ID 和工具 call ID 复用 DOM，更新文字不关闭用户展开的行；显示实际工具输入/输出、backend、latency。
5. Studio 的显示提交采用33ms定时合并，文档隐藏时200ms；事件立即进入内存记录，绘制合并不丢文字，结束取消过期任务的待绘制 timer。selection 的现有300ms主进程广播保留。
6. 思考行结束时独立更新状态；长内容完成后200px预览与 Show more 生效。运行时展开内容使用320px可滚动容器，避免长思考把页面无限推长。这个运行时上限是 MP 的实现选择，不冒称 Claude 参数。

显示边界：子任务实时窗口显示当轮最近6000字符的思考和回答、最近12个工具步骤，工具输入/输出各400字符；这是有界活动预览，不宣称呈现模型隐藏状态或完整内部思维。没有加入 C2C 开关或把文本摘要称为 KV 通信。

## 参考与 C2C 决定

- Claude 真实编译产物核验见 `2026-09-20-claude-streaming-reference.md`。已取得本机编译 JS、63项带出处的片段，没取得原始TS或sourcemap。生产实现独立编写。
- C2C 的论文/实现/资源条件见 `2026-09-20-c2c-feasibility.md`。用户已确认目前只有现有云模型 API；OpenCode DS4.1 没有 KV-cache 读取/替换接口及对应 fuser，因此真正 C2C 尚未接入。当前可交付的是 MP 子 Agent 的可观测协作。

## 验证

- 先红后绿：并行子事件与父身份、无工具时即展示思考、流合并及末尾刷新、最终 trajectory 保留、保存记录投影、思考结束状态、父活动行稳定DOM。
- 真实 Chromium 离线事件回归：100块文字原101次绘制，修后首批1次；加上两个子任务及后续更新总3次。两任务各自状态、展开行/正文节点保持、工具证据展示通过。`data/runtime/subagent-streaming-20260920/witness.json` failures=[]。截图 `streaming.png` 是离线数据夹具，不能冒充真实云模型执行。
- 真实 DS4.1 探针 `scripts/probe_subagent_streaming.py`：首轮探针沿用默认短预算导致6.2s超时，修正为120s验收预算后，实际网关在34.664s返回 `backend_error:http_429`；`usedBackend=magic_pointer.messages_multiturn_streaming`，没有创建子任务。因此本批真实云模型多子任务联调尚未通过，未用假数据替代。
- 首次全量 Node 发现旧 VM 夹具缺 Inspector 状态，补齐并验证外部子任务更新可见 Tasks、隐藏时不绘制。下一轮 Node 262 文件通过；Python 2508 passed / 1 failed，唯一失败为后台任务测试轮询原子替换状态文件时收到 Windows PermissionError，实际任务元数据 exit=0/finished/notified=true。测试在原8s等待窗口内重试 PermissionError，保留全部结果断言。随后的完整结果如下。
- 最终 fresh 全量：**Node 262 test files、Python 2509 passed / 6条既有Pillow弃用提示 / 218.24s**，lint、全部TypeScript、构建通过。日志 `data/sync-subagent-streaming-1.0.50-delivery-20260920.log`。
- **交付完成**：`npm run sync` exit 0，构建 `release/sync-1.0.50-20260920-214041-17996/Magic-Pointer-1.0.50-x64.exe` 并同步安装、重启。独立核对开发树/安装版均1.0.50、21个关键交付文件内容完全相同、7个应用进程均来自安装目录、实际 profile 为 deepseek-v4.1-flash。证据 `data/runtime/subagent-streaming-20260920/installed-verification.json`。随包Python3.12.8独立导入验证通过：父调用身份、子活动投影与OCR工厂可用。
