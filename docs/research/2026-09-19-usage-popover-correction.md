# 用量弹层纠正与鼠标恢复

开发树保持 1.0.49，未运行 npm run sync，未替换安装目录。实际开发版 GUI 已打开并保留在用户的 JEV 会话。保留既有未提交修改，不改系统提示词文案。

## 已修问题

1. 明细点击后关闭主卡：原处理函数重建 DOM，点击事件继续冒泡时 target 已脱离主卡，document 的外部点击逻辑将其关闭。现在切换只改变左侧独立明细的 hidden 和 aria-expanded，停止该按钮事件冒泡；两个卡片都属于弹层内部点击区域。
2. 明细布局：独立窗口位于主卡左侧，间隔 8 CSS px。主卡保持 360 CSS px 内容宽、362 px 外宽，12/15 字体、4 px 进度条。小数 k 和 M 格式由生产函数生成，撤掉此前验证夹具里不同的格式化替身。
3. 旧会话 Context 空白：通过现有 agent_session_bridge 的只读 usage 查询，匹配最后一次有服务端用量的请求，用同一 EventSession 投影重建该次输入，沿用现有 token estimator 拆分组成。Electron 按日志 mtime 复用读取结果，显示时补充上下文快照，不修改会话日志或账单累计。旧 trajectory 的累计数据不能覆盖恢复的 contextTokens。
4. 色彩：主卡分段、左侧图例和明细条一一对应：系统提示词蓝、工具定义橙、对话消息绿、工具结果灰。账单累计另列文本。移除“旧记录只有累计消耗……”文字。
5. 鼠标：AgentCursorSurfaces 原先创建即显示透明全屏窗口，并在无 Agent 光标时也采样，转发原生 mousemove；共享样式为 cursor:none。现在空闲窗口隐藏、无采样，装饰表面不转发原生移动；实际 Agent 光标命令才显示并启动采样，clear 隐藏并停止。用户在打开的修复版 GUI 中回复：**“现在已恢复正常”**。

## 实际数据与 GUI 证据

会话 c1789745222499，EventSession agent-studio-new-5c4803113f94464e9d3dee7c0d53bee7：最后请求输入 **42,085**，最后输出 **805**；会话累计输入 **90,823**、输出 **1,481**、合计 **92,304**。当前 MP 为该模型采用 128,000 的 Runtime 窗口，界面显示 **42.1k / 128k (33%)**。组成基于本地估算比例校准，明确显示“≈”，不声称厂家提供了逐分类 token 计数。

`scripts/verify_context_usage.cjs` 运行生产 main、preload、真实 IPC 和用户本机历史文件。测试仅在主进程暴露既有 showDashboard 窗口入口以打开验证页，不替换生产渲染器、Data、计量结果或定位函数。通过真实 Electron 鼠标输入，逐次验证页脚打开、头部收起、再次打开；验证主卡一直可见、明细在左侧，四组计算样式相同。未向模型重新发送问题，也没有计费调用。

证据在 `data/runtime/context-usage-actual/`：

- `expanded.png`、`collapsed.png`：真实生产 GUI 的 JEV 存档页面。
- `witness.json`：实际坐标、完整计量、四组 RGB、原生鼠标数据和窗口显隐。
- `result.txt`：实际进程验证结果。

原生探针通过 Win32 SetCursorPos/GetCursorInfo，在 GUI 上移动并恢复原始位置：160 次样本未发现光标隐藏、未收到 cursor:none 变化。简化重建旧透明层的短测也没有稳定复现持续闪烁，所以它不被当作原症状的失败见证；旧生命周期行为在单测中先失败，用户在真实修复版上的确认是本次实际症状恢复的直接证据。

## 红绿与完整验证

- `usage-click-red-20260919.log`：生产 Studio 页面真实点击后报 **one click on details closed the main usage card**；`usage-click-green-20260919.log` 通过。颜色、定位、头部/页脚交互继续纳入现有 Studio interaction probe。
- `usage-restore-red-20260919.log`：旧日志读取接口缺失导致断言失败；新增测试通过并确认日志字节未改变。
- `tests/agent_cursor_surface_idle_test.js`：修复前空闲窗口 shown=true 导致失败；修复后隐藏/不转发/不采样/命令唤醒/clear 停止均通过。
- `usage-correction-python-20260919.log`：**2319 passed、1 failed、1 既有 Pillow warning，329.16s**。唯一失败是用户预先说明的 `tests/selection_bridge_test.py::test_screen_region_enrich_falls_back_to_full_capture_without_selection_bbox`；本批未修改该测试或相关感知代码。
- `usage-correction-node-final-20260919.log`：**234 个测试文件通过**。
- `usage-correction-typecheck-20260919.log`、`usage-correction-build-20260919.log`：TypeScript 全配置、构建通过。
- `usage-correction-eslint-20260919.log`：本批相关 TS/JS/CJS 定向 ESLint 无告警。

先前的独立离屏夹具没有带 document 外部点击处理，也没有使用旧会话真实数据，其结果不能支持实际 GUI 交互与旧记录验收。该验证脚本已替换，本记录取代旧交付文档的相应结论。
