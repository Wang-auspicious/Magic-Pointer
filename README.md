# Magic Pointer

[![Release](https://github.com/Wang-auspicious/Magic-Pointer/actions/workflows/release.yml/badge.svg)](https://github.com/Wang-auspicious/Magic-Pointer/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](.nvmrc)
[![Python](https://img.shields.io/badge/python-%3E%3D3.11-blue)](.python-version)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)](README.md)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)

Magic Pointer 是一个完整的桌面 Agent Harness。它把人在桌面上的指代意图预编译成 Agent 可以直接执行的任务上下文，再用自有 Runtime 承担从一轮改写到跨小时长程作业的全部工作。感知、工具、权限、记忆、恢复和审计都是产品本体，任务执行不依赖任何外部客户端。

四个底层取向：

- 交互预编译：晃动、划线、圈选手势在 pointerup 瞬间冻结画面与窗口身份，DOM、COM、UIA、OCR 随后并发解析成对象图，Agent 醒来时直接从第一步有用工作开始，不用重新截图、扫描全屏、猜用户指向什么；
- 任务时长不是边界：短任务与长任务走同一条 loop，压缩、记忆、断点续跑、进度可见都是本体功能；
- 确定性归代码：窗口生命周期、坐标换算、权限、租约、验证都在代码里，模型只负责语义与规划，模型返回成功不等于动作成功；
- 一切可验证：每个成功动作返回校验字段，可撤销动作返回精确 undo receipt，会话全程事件溯源落盘。

## 两种入口，同一个内核

### 桌面手势

在任何应用里短促左右晃动鼠标即可唤醒。手势先完成人最擅长的高成本语义判断，明确 THIS、THAT、THESE、HERE 的指代，剩下的交给 Harness：

```text
短促左右晃动 3 次唤醒
  -> 划线圈选目标，pointerup 瞬间冻结画面、窗口身份与手势几何
  -> UIA / DOM / COM / OCR 并发解析成对象图
  -> 在单个气泡里输入指令（默认打字，语音可选）
  -> Runtime 从对象图直接开始有用工作
  -> 预览高风险动作，执行、读取回执，必要时撤销
```

晃动检测要求 250 到 600 毫秒的水平往返与多次方向反转，拖拽、滚动、窗口移动和禁用应用中不会误触发。语音转写在本机完成（SenseVoice 优先，Whisper 兜底），不经过系统听写、不上传录音；默认输入方式是打字。

### Studio 工作台

项目制对话工作面，一个确定文件夹就是一个项目：

- 会话管理：重命名、分支、导出、删除，侧栏按项目分组；
- 文件 Inspector：懒加载文件树、文本预览、外部打开、Git changes、项目终端；
- 运行轨迹：流式正文、思考流、工具调用折叠芯片、耗时与 token 统计；
- 计划卡：多步任务先出计划，批准后转执行，计划未完成不许静默收工；
- 授权条：高风险动作三选，仅这一次、本会话总是允许、拒绝；
- 插件目录：读取本机 slash 与 skill 目录，点卡片即把命令插回输入框。

## Runtime 的长任务能力

- 同一条 loop 覆盖一轮改写与几十上百轮的长程作业，预算按有效轮次持续续期，没有固定轮次上限；
- 上下文压缩按 token 口径主动触发，超长工具输出全文落盘，模型按需分页回读；
- 中断后断点续跑，崩溃后从会话记录恢复现场；
- 运行中插话写入 durable inbox，下一轮立即携带；停止按钮先优雅取消再兜底，全过程有 Receipt；
- 子代理并行处理只读任务；跨会话记忆检索与技能自进化（save_skill）内建。

## 工具面

五十余个内置工具，命名统一，默认向模型暴露 32 个，低频工具按需加载：

- 桌面动作：Observe、Click、Type、SetValue、Wait 等按元素快照绑定执行，元素失效诚实报错，写后必须读回验证；
- 文件编辑：Read、Write、Edit、Patch 带未读先写门、多级容错匹配、批量编辑、checkpoint 与 /rewind 回滚；
- Shell：run_command 在会话内保持 cwd，后台任务完成自动推送，Grep 以 ripgrep 为主路；
- 其余：Web 搜索与抓取、跨会话记忆、Todo 计划、子代理委派、MCP 双向接入、技能目录。

## 感知

- FrameLease 冻结先于一切读取，感知读到的画面就是手势看到的画面；
- UIA 宿主常驻但空闲零活动，只在唤醒或明确任务后激活；
- 结构化读取与像素 OCR 并发融合，跨来源冲突显式呈现给模型，不静默择一；
- 自绘应用走 SurfaceAdapter：容器 UIA 可用就用语义读取，否则诚实使用像素锚点。

## 权限与安全

- 动作按效果分级：只读、可逆写、本地不可逆、外发、删除、购买，各档有独立确认语义，购买默认拒绝；
- 权限预设分只读、工作区写、完全访问，配会话级授权记忆；计划模式先出计划再执行；
- 会话是磁盘上的事件溯源 JSONL（哈希链），每次工具执行按 prepared、执行、settled 三段持久化；
- 审计与账单记录 provider、耗时、token 与结算结果，失败原因逐层透传到界面，不伪造成功。

## 模型接入

- 模型目录从网关拉取，密钥只存本机 secrets；
- 流式回答与思考流，缓存命中与 token 用量可见；
- 健康端点带重试倒计时，失败时界面显示真实原因、exit code 与耗时。

## 安装与启动

要求 Windows 10/11、Python 3.11 及以上、Node.js 20 及以上。

```powershell
python -m pip install -r requirements.txt
npm install
npm run overlay
```

启动后应用安静驻留，晃动默认启用。临时关闭：

```powershell
$env:MAGIC_POINTER_ENABLE_MOUSE_SHAKE = 0
npm run overlay
```

构建 Windows 安装包（NSIS）：

```powershell
npm run dist:win
```

## 开发与验证

```powershell
npm test
npm run typecheck
npm run lint
python -m pytest -q --basetemp .pytest-local
```

Node 测试、五套 TypeScript strict 检查、ESLint、Python 全量 pytest 四道门是每个批次的交付前置。

## 架构速览

- `electron/main.ts`：Electron 壳、手势生命周期、安全 IPC；
- `electron/wiggle_detector.ts`：晃动意图检测；
- `electron/renderer/studio.html` 与 `electron/studio_shell.ts`：Studio 工作台；
- `scripts/selection_bridge.py`：手势任务桥，`scripts/conversation_bridge.py`：对话桥；
- `app/fabric/engine.py`：run_agent_turn 主入口；
- `app/agent_runtime/`：loop、工具、压缩、记忆、权限、技能；
- `app/harness/`：插件内核（builtin bundle、上下文服务、用户插件目录）；
- `app/perception/`：并发感知融合，`app/desktop_actions/`：桌面动作与 UIA；
- `native/macos/MagicPointerHost.swift`：macOS 宿主源码。

## 文档

- [`docs/STATUS.md`](docs/STATUS.md)：当前真实状态、逐批验证记录与诚实边界；
- [`docs/design/MAGIC_POINTER_HARNESS_20260811.md`](docs/design/MAGIC_POINTER_HARNESS_20260811.md)：产品定位与架构正典；
- [`docs/2026-08-29-MP-FULL-MODULE-MAP.md`](docs/2026-08-29-MP-FULL-MODULE-MAP.md)：全模块地图；
- [`docs/ROADMAP.md`](docs/ROADMAP.md)、[`docs/PRODUCT.md`](docs/PRODUCT.md)、[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；
- [`docs/AGENT_INTEGRATION.md`](docs/AGENT_INTEGRATION.md)：把任务提示投递到外部客户端的可选通道；
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)：第三方组件与许可证。

## 平台状态

- Windows：捕获、感知、动作、语音、安装包主链完整可用；
- macOS：Electron 与共享层源码就绪，Accessibility、Screen Recording、签名与公证尚未实机验证；
- Linux：Runtime 与工具层为纯 Python 与 Node 实现，系统级指针宿主尚未实现。

## 许可证

MIT，见 [`LICENSE`](LICENSE)。
