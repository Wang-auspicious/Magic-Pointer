# Magic Pointer Context & Prompt Compiler Alpha 设计

日期：2026-07-22  
状态：已认可方向的实施规格

## 1. 产品边界

Magic Pointer 不是另一个通用聊天浮窗，也不是购物、日历、路线等小应用的集合。这个 Alpha 要证明一条完整主链：

> 用户在任意桌面应用中指向或选中对象，用一句短指令或系统听写说明意图；Magic Pointer 把多个对象编译成带来源、空间位置和不确定性的 Context Pack，再为当前目标 Agent 生成完整 prompt，并精确填入目标输入框但不自动提交。

Windows 是当前可运行宿主。Context Pack、Prompt Compiler、Agent Profile 和 handoff proposal 保持平台无关；macOS 原生捕获层是下一宿主，不在本轮伪装成已完成。

## 2. 本轮成品标准

Alpha 必须跑通四段连续流程：

1. 在 Word、PDF、浏览器、IDE 或普通 UI 中选中内容，输入 `收集：这是什么/为什么重要`，记录为上下文条目。
2. 在图片或不可访问 UI 上框选/指向，输入同类收集指令，由视觉模型生成观察，同时保留截图、坐标、grounding 与来源。
3. 可连续收集多个对象，并通过 `生成提示词：最终任务` 得到一份可读、可追溯、对纯文本模型也有用的 prompt artifact。
4. 用户转到 Codex、Claude、Gemini、Pi 或未知 Agent 的输入区，输入 `发送到这里：最终任务`，系统锁定窗口和指针位置，填入但绝不自动发送。

语音不采用常驻录音：命令条提供麦克风按钮，Windows 上主动触发系统听写，由系统把语音写入当前输入框。

## 3. 现有代码处置

| 现有部分 | 决策 | 理由 |
|---|---|---|
| `app/review/session.py` 与 `compiler.py` | 保留并兼容，抽象出通用 Context Pack | 它已经验证“多次锚定 → 编译 prompt”的最有价值主链，但名称和文案被论文验收绑死 |
| `app/actions/draft_delivery.py` | 重构为通用 prompt delivery，保留 review 包装器 | 精确 HWND/PID/坐标、文本哈希和 no-submit 契约是可靠 handoff 的核心 |
| UIA、Office、PDF 恢复适配器 | 保留并加边界验证 | 这是 Windows 来源身份和原生文本选择能力，不应重写 |
| `interaction_episode.js` 的 THIS/THAT/THESE/HERE | 保留 | 已有短时指代基础，后续由持久 Context Pack 补足跨应用多对象记忆 |
| Overlay 的指向、截图、视觉 grounding | 保留并接入 Context Pack | 它能为无多模态 Agent 生成可追溯视觉描述 |
| 购物、假日历、路线、表格合并 | 从主流程降级为 Lab/回归夹具 | 可以继续测试动作策略，但不再定义产品首页和主文案 |
| 启动即弹 Overlay、默认鼠标摇动唤醒 | 默认关闭 | 工具应安静等待用户主动调用，避免打断和误触 |
| review-only 占位符和命令文案 | 删除/泛化 | 首屏必须表达“把当前对象交给任意 Agent”，而不是论文批注单场景 |
| Reader/Result/Dashboard 多窗口 | 本轮收敛日常入口，暂不物理删除 | 避免破坏既有回归；未来 Dashboard 重构时再删旧信息架构 |

## 4. 新增模块

### 4.1 Context Session Store

新增 `app/context_pack/session.py`。持久层使用与 review session 相同的文件锁、原子替换和 revision 模式。一个 session 包含：

- `session_id`、状态、创建/更新时间；
- 可选全局任务；
- 有顺序的 `items`；
- 最近编译的 prompt 与 artifact；
- 条目的 identity fingerprint，用于防止同一快照重复写入。

每个 item 至少保留：用户原话、模态、应用/窗口/文件/页码或 URL、选中文本及上下文、截图路径、点/框坐标、视觉观察、grounding、置信度和采集时间。字段不可用时明确为空，不由模型补造。

### 4.2 Intent Parser

新增显式命令解析，防止普通问句意外改变持久状态：

- 收集：`收集：`、`记住：`、`加入上下文：`、`context:`；
- 编译：`生成提示词`、`整理上下文`、`compile context`；
- 交付：`发送到这里`、`填入这里`、`交给这个 Agent`、`deliver here`；
- 清理：显式 `清空上下文`，需要在 UI 中再次确认，Alpha 先返回确认需求而不静默删除。

冒号后的内容作为条目说明或最终任务。没有最终任务时，编译器只整理事实和用户逐条说明，不擅自假定任务。

### 4.3 Target-specific Prompt Compiler

目标窗口通过进程名和标题映射到 `codex`、`claude`、`gemini`、`pi` 或 `generic` profile。Profile 只调整交付说明和格式，不改变证据。生成的 prompt 包含：

1. 明确的最终任务；
2. 不可越过的事实/不确定性边界；
3. 按采集顺序排列的上下文条目；
4. 每条的用户说明、原文、来源、位置、视觉观察和定位信息；
5. 对目标 Agent 的输出约束；
6. 缺失信息清单。

Prompt artifact 写入用户数据目录，handoff proposal 只引用已落盘 artifact 和 prompt hash。

### 4.4 Agent Handoff

通用 proposal 继续使用现有 `paste_text_to_foreground` 原子动作，但语义改为 `context_prompt_delivery`。必须同时满足：

- 正的目标 HWND；
- 有效屏幕坐标；
- 捕获时窗口 PID/标题与执行时仍匹配；
- 文本哈希匹配；
- `submit=false`；
- 无 `Enter` 或发送按钮动作。

当前 UIA/粘贴只是本地 GUI fallback。未来 Pi RPC、Codex/Claude/Gemini CLI/GUI 插件应消费同一 Context Pack/Prompt artifact，而不改变上游交互。

## 5. 用户界面

日常 UI 只保留两种瞬时表面：

- 指向 Overlay：框选/涂画 + 一句指令 + 麦克风；
- 原生选择 Command Rail：来源摘要、上下文计数、一句指令、麦克风、执行按钮。

视觉采用安静、紧凑、工具化的深色浮层；强调来源状态和行为边界，不显示装饰性聊天头像、欢迎语或功能宫格。成功状态区分“已收集”“已生成”“已填入，尚未发送”。

## 6. Dashboard 后置决策

Dashboard 仍然必要，但不是日常主界面。本轮只登记，不投入主要实现。后续独立里程碑应包含：

- General：快捷键、唤醒方式、语言、启动行为；
- Agents：Codex、Claude、Gemini、Pi 和自定义 Agent profile；
- Connections：CLI、RPC、GUI 插件和本地模型端点；
- Capture & Privacy：截图范围、保留周期、敏感应用黑名单、麦克风权限；
- Recipes：提示词模板、输出契约、团队共享；
- Activity & Audit：来源、prompt、目标、执行回执、失败原因；
- Lab：购物、日历、路线等旧演示夹具，开发模式可见。

在 Dashboard 完成前，少量启动参数通过环境变量或当前配置文件暴露，不创建第二套临时设置 UI。

## 7. 错误与边界

- 未捕获到可靠来源：允许记录视觉观察，但必须标注来源未知和低置信度。
- 空 session 编译/交付：返回可读错误，不创建空 prompt。
- 目标窗口在确认前变化：拒绝写入。
- 目标输入位置无效、窗口 PID 未知或 UIA 写入后无法验证：拒绝或失败关闭，不降级为盲目发送。
- 视觉模型不可用：仍记录截图和几何信息，视觉观察标注缺失。
- 重复收集：identity fingerprint 去重并返回已有条目。
- 听写不可用：保留键盘输入，返回明确平台错误，不启动自建常驻录音。
- prompt 过长：编译器优先保留用户原话、来源和选区，截断大段周边上下文并显式标记。

## 8. 验证

自动验证包括：intent 解析、session 原子持久化与去重、native/visual item 规范化、目标 profile、prompt 边界、通用 delivery proposal、Electron policy、静态 UI/IPC 和既有 review 回归。

桌面验证至少覆盖：多次原生选区收集、一次视觉框选收集、编译 artifact、在测试输入框中精确填入且不提交、目标窗口变化时拒绝、系统听写按钮可触发。由于 macOS 宿主尚未实现，不把 schema 可移植性写成 macOS 已验证。
