# 2026-09-21 Agent 流程稳定性修复

## 承接与交付范围

回读当天 09:16–12:35 的 Claude Code 工作会话，承接中午最后提交 `1172756`。既有启动画布按需分配和展开状态 Map 保留；本批针对用户已报告的新会话残留、重复恢复查询和过程展开异常，连同 Runtime 中可复现的停止、空回复及验证冲突修复。

用户 11:17 明确要求“装机版不要你管，你不用升版本”，本轮再要求“不升版本，多 git push main”。因此开发树保持 **1.0.50**，分批推送 main，**不执行 sync、不改安装目录**。未跟踪的用户参考图片不纳入提交。每项行为改动都先观察失败，再修改生产代码。

## 已修复的行为

### 会话与界面归属

- 新建对话清除旧 turns、来源对象、计划、授权选择、恢复面板及建议。慢返回的旧会话读取不能覆盖新建页面或后来打开的另一会话。
- 运行中导航解除当前界面与旧任务的绑定，后台 Runtime 保持运行。旧发送结果、异常清理和 steer ACK 不能重开旧会话、清空新任务草稿或附件，也不能让新输入被误当成旧任务插话。
- 提交前固定会话身份、权限和 effort，等待 worktree 准备时导航不会改变发送目标。正常完成、重新打开同一任务仍正常收尾。
- `/model` 成功后等待目录刷新也检查请求归属，刷新期间导航不再被旧命令拉回。
- 主进程 progress 带实际 conversationId/turnIndex，Studio 从首条进度开始使用持久的会话/回合 scope。Stage 从流式到完成/失败使用同一 selection session/turn scope。

### 恢复查询

- `conversations:recovery` 先检查实际 session JSONL，缺失时返回 `session_not_found`，不再为同一个缺失文件反复启动 Python。
- 同 session、同 mtime 的成功只读查询共用 Promise/结果；新事件、恢复决策或失败使查询失效。不同任务不共用查询。
- Studio 将恢复读取失败显示在对应会话的恢复面板，保留已存对话内容，不产生未处理 IPC rejection。

### 过程展开状态

- 工具、工具组和思考的状态按会话/回合隔离，provider 复用 call ID 不再导致会话间串状态。
- 中间思考在完成时并入工具组保留身份；原本打开的后续工具组并入第一组时保持可见，单工具组中已显示的结果体也保留可见性。
- 归并只对新并入的成员继承展开状态。用户主动关闭合并后的组，下一次重建继续保持关闭。

### Runtime 终态与写后验证

- durable Stop 在模型流事件边界检查，收到取消后不再接受后续文本或最终答案；流关闭，持久记录落 `USER_INTERRUPT` / interrupted Receipt，不伪造完成或生成最终 artifact。
- 首次空回复仍允许恢复；连续空回复共四次请求后落 `PROVIDER_UNAVAILABLE` / `backend_error:empty_response` / failed Receipt。`None`、空字符串与纯空白均覆盖，第二次正常恢复仍可成功。
- 写后验证证据从原始工具结构化结果解析。重复写警告追加的文字不再破坏成功 Write 的真实读回凭据。
- 新的有效写操作清除之前的重复读取历史，连续写入并读回多个同内容模板文件不再被误判 stalled。单纯重复读、重复写的原有停止规则保留。

## 证据与验证

新回归覆盖实际 Runtime/EventSession/Receipt、真实临时文件 Write/Read，以及提取执行的生产 Studio 函数与主进程 IPC handler。脚本化模型只控制响应时序；未把这些测试描述为云服务商验收。

- Runtime 定向集合 **124 passed / 12.94s**，验证保护相关集合 **32 passed / 7.97s**。
- 第一次完整 Python：**2514 passed / 4 failed / 275.52s**。一项旧测试期待持续空回复成功；三项成功工具 fixture 在验证门 nudge 后耗尽并返回空回复。更新为明确失败预期或补实际文字收尾，保留执行次数、授权与工具结果断言；两组定向 **25 passed / 1.62s**、**11 passed / 1.19s**。
- 实际离屏 Chromium 使用构建后的共享渲染器，真实点击思考/工具组，覆盖流式到完成、跨会话隔离、第二组合并可见性、singleton 结果体以及主动关闭后再次完成。最终 witness：`paints=3`、`children=2`、`transcriptContinuity=true`、`failures=[]`，**exit 0 / 6.84s**。
- 最终完整 Python **2518 passed / 6 条既有 Pillow 弃用提示 / 335.69s**。
- 最终完整 Node **268 test files passed**（含构建与 Chromium 回归）；全范围 ESLint、Figma/Electron/browser globals/renderer/tools/tests TypeScript 均通过。

本地证据：`data/runtime/agent-stability-python-20260921.log`、`data/runtime/agent-stability-python-final-20260921.log`、`data/runtime/agent-stability-node-final-20260921.log`、`data/runtime/agent-stability-lint-final-20260921.log`、`data/runtime/agent-stability-typecheck-final-20260921.log`。Chromium witness 与截图沿用探针输出目录 `data/runtime/subagent-streaming-20260920/`，目录日期不代表本次执行日期。

本批分段提交：`697d40c`（展开身份）、`ccd1c12`（Runtime 停止、空回复、验证冲突）、`76599ee`（会话隔离、恢复查询、实际 Studio/Stage 接线与工具归并）。前三批均已推送 main，最终回归与交付记录另行提交。

## Stop 开销与关闭边界

独立合法 EventSession 日志，每组调用真实 `cancel_interrupt_check` 500 次；测量时完整 Python 测试同时运行。

| 事件数 / 日志大小 | p50 | p95 | 最大耗时 |
| --- | --- | --- | --- |
| 1,000 / 307 KB | 1.007 ms | 1.719 ms | 3.045 ms |
| 5,000 / 1.54 MB | 2.391 ms | 3.869 ms | 7.123 ms |
| 10,000 / 3.09 MB | 2.697 ms | 4.527 ms | 5.851 ms |

每组 full load 与 incremental adopt 均为 0；没有新事件时没有打开重读日志内容。每次检查有 2 次日志 stat，含锁路径合计 4 次 stat；open turn 与 pending cancel 仍扫描内存事件。本批不为未观察到的问题引入额外缓存或节流。

使用生产 `StreamingMessagesBackend → LoopModelClient.stream_turn`，底层接 httpx `MockTransport/SyncByteStream`，首 delta 后关闭外层 generator，立即观察到 ByteStream、Response、Client 都关闭，读取 chunk 仍为 1，未依赖 GC。该路径 `usedBackend=magic_pointer.messages_multiturn_streaming`，**未访问网络**。

这证明已打开的 transport 上下文被关闭；**不能证明尚未返回的阻塞网络读取会立即被打断**，该情况仍依赖现有传输超时和 GUI 强停兜底。本批未进行真实云模型长任务、Office/Figma 原生应用或安装版验收，也不据此宣称 Agent 已无 bug。
