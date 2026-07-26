# Magic Pointer 当前实现状态

日期：2026-07-26（晚间更新：PointerStage 端到端接通，旧临时界面退役）

## PointerStage 单舞台（本轮完成）

- 舞台成为唯一临时表面：targeting 描边 → frozen 呼吸光 → 胶囊（语音/文字）→
  shimmer 处理 → 结果卡/错误卡 → 淡出，全部在一个透明点击穿透窗口上。
- 端到端已接通：胶囊内 Enter/语音 final 通过 `stage:submit-selection-command`
  直达 selection_bridge；partial/final 转写逐字飞入；动作按钮走
  `stage:execute-action`（携带一次性 action token）；日历/路线草稿卡的
  "审核并创建"通过 `stage:context-action` 打开 Dashboard 对应视图。
- 交互窗口默认点击穿透；仅在文字胶囊、结果卡、错误卡或 chips 可见时由
  渲染器申请 `stage:set-mouse-capture` 获取真实鼠标/键盘；Escape 或点击
  空白处即撤下并作废会话。
- 回执诚实性延续到舞台：`accepted` 渲染为"已受理(尚未完成)"，只有
  `succeeded`+verified 才显示"已写入成功"；进度条只响应真实 UIA 写入事件。
- 旧界面退役：`main.js` 不再创建 Panel/Result/Reader 窗口，
  `result.html|js|css`、`reader.html|js|css` 与对应测试已删除；overlay 仅保留
  观察者光环与运行时问题圈选，圈选结果也路由到舞台。panel 渲染器文件保留
  在仓库中但已脱离热路径。
- 不合格选区不再打开胶囊：冻结后立即在舞台上给出明确错误。

## 先说结论

当前项目已经不是演示页：Windows 上具备真实晃动检测、冻结指针对象、单气泡语音/文字
输入、30 个 Recipe 的统一规划与权限合同、本地 OCR、确定性 artifact、Agent 原生接入、
后台任务、Dashboard、签名计划、回执和审计。

但“30 个 Recipe 已进入同一系统”不等于“30 个外部应用都有一等原生连接器”。当前发布
形态有三类结果：

1. 本地确定性完成并读取回执；
2. 交给已安装 Agent，携带完整对象和安全合同；
3. 没有能力时明确返回 `capability_unavailable`。

系统禁止把第 2、3 类伪装成原生成功。

## 前台体验

- 鼠标按规定水平往返即可唤醒；快捷键只是备用入口。
- 指针对象在气泡出现之前被冻结。
- 提示面只有一个随转写/输入逐步生长的气泡。
- 默认语音/文字由 Dashboard 决定，临时气泡不再出现模式切换。
- 语音使用本地 Whisper + 麦克风，不调用 `Win+H`。
- `THIS / THAT / THESE / HERE` 由 InteractionEpisode 保存对象、时间和空间关系。

逐帧依据见 `GOOGLE_DEMO_FRAME_ANALYSIS_20260726.md`。

## 30 个 Recipe 的真实落点

| 范围 | 当前落点 | 状态 |
|---|---|---|
| 1–3 晃动、THIS、多对象引用 | Windows 原生指针流、WiggleDetector、GroundedObject、InteractionEpisode | Windows 已验证 |
| 4–5 OCR 与清洗 | 640×420 指针区域、RapidOCR ONNX、Tesseract fallback、剪贴板读回哈希 | 已本机实测 |
| 6–8 改写、翻译、摘要路由 | Office/UIA 目标合同 + 配置模型；无直连模型时转 Agent | 合同/回退已验证，具体模型取决于用户配置 |
| 9 实体快捷动作 | 规划与权限已接入；缺目的地时转 Agent 或明确不可用 | 非一等连接器 |
| 10–11 表格导出/合并 | 确定性 CSV、表头冲突停止、行列与哈希读回 | 已自动验证 |
| 12–13 图表/公式 | 原生 provider 插槽；当前默认转 Agent | 尚无内置专用模型 |
| 14–17 图片/画布 | image/Figma/Office provider 插槽；当前默认转 Agent | 尚无内置图像生成或 Figma 连接 |
| 18 日历 | 草稿、权限和 provider 插槽；当前无账户连接时转 Agent | 尚未连接外部日历账户 |
| 19 地图路线 | allowlist URL、起终点校验、由地图服务算距离 | 本地确定性 |
| 20 视频地点行动 | 帧对象与订位/地图计划；当前默认转 Agent | 尚无内置地点识别模型 |
| 21 食谱清单 | 确定性结构化 artifact；外部清单写入需 connector | 本地 artifact 已验证 |
| 22 任务/工单 | 本地 TaskStore 可用；GitHub/Linear 等需 connector | 本地完成，外部目的地未连接 |
| 23 研究证据卡 | 原文、应用、路径、页码、bbox、文件哈希、引用 artifact | 已自动验证 |
| 24 Agent 现场交付 | Codex/Pi/Claude/Gemini/Cursor/OpenCode/Aider/Generic | 连接参数与安全路径已验证 |
| 25 视觉提示桥 | OCR/结构/位置/来源 artifact；原始视觉不足时转多模态 Agent | 本地结构化路径已验证 |
| 26 多对象比较 | 来源对象集合和差异 artifact | 已自动验证 |
| 27 语音短命令 | sounddevice + 本地 Whisper、partial/final、静音自动提交 | 离线端到端已验证 |
| 28 后台 Agent | TaskStore、状态、steer、cancel；Pi JSONL RPC | Pi 扩展/RPC 已实载 |
| 29 Agent 接入 | Pi extension，Claude/Gemini hooks，Codex/Pi session，MCP fallback | 原生优先路径已验证 |
| 30 Dashboard | 唤醒、默认输入、Agent、Recipe、权限、隐私、活动、诊断 | 设置持久化与 UI 自动验证 |

## Agent 接入边界

- Pi：extension `before_agent_start`、`/pointer`、JSONL RPC 和 `steer`。
- Claude Code：`UserPromptSubmit` hook 注入 `additionalContext`。
- Gemini CLI：`BeforeAgent` hook 注入 `additionalContext`。
- Codex：`exec --json` 与 app-server 会话接口预留。
- Cursor、OpenCode、Aider：安全 argv/stdin 连接器。
- MCP：只作为缺少 hook/plugin/session 能力时的兼容层。

所有 CLI 调用使用 argv 数组、stdin 和 `shell=false`，不会将用户内容拼接进 shell。

## 已知未完成边界

- 本轮自动化已全绿（`npm test` 25 套、`pytest` 294 passed、Electron 冒烟启动
  无错误），但真实"晃动→语音→写回"的实机走查在本轮尚未重跑。
- macOS 原生宿主源码已存在，但没有在 Mac 实机完成 Accessibility、麦克风、Screen
  Recording、多屏坐标、签名和公证验收。
- 日历、Figma、GitHub/Linear、图像生成、图表 digitizer 和数学视觉没有在本机连接真实
  外部账户或专用 provider；会走 Agent 或明确不可用。
- Whisper 首次使用前需要已有本地模型；当前实现不会为了“看起来成功”而静默下载。
- Windows 当前验证不等于普通用户安装包、自动更新、签名和崩溃遥测已经交付。

## 验证证据

最终交付前重新执行：

```powershell
npm test
python -m pytest -q --basetemp <workspace-local-temp>
python scripts/smoke_fabric.py
```

并保留：

- 真实鼠标晃动被检测的运行日志；
- 单气泡逐字增长截图；
- 本地 Whisper 离线音频转写；
- RapidOCR 对真实指针截图的转写；
- Pi extension 实际加载；
- Claude/Gemini hook 中文上下文注入；
- Terra-high 独立边界审核和修正记录。
