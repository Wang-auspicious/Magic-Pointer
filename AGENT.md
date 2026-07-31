# Magic Pointer — Agent Instructions

<!-- AGENTS.md spec: https://github.com/agentsmd/agents.md -->

## 核心原则（每次修改前必读）

### 隐私优先
- **所有语音/OCR/截图本地处理**。不上传、不经过云、不训练模型。
- 唯一例外：用户主动把对象交给 Agent (Codex/Pi/Claude) 时，发送权在用户。
- API key 存在 `electron/credential_store.js`（Electron safeStorage），不落明文。
- 诊断打包 (`collect-diagnostics.js`) 强制脱敏——key/token/password 正则替换为 `<redacted>`。
- 审计事件不记录 prompt 全文，只记 recipe_id + outcome。

### API 成本
- **默认零成本**。所有 Recipe 优先本地执行（OCR/UIA/Office/文件）。
- 模型调用只在 Recipe 明确标 `model_provider` 时触发，且用 Dashboard 选的最小/本地模型。
- 不要引入需要付费 API 的依赖。SenseVoice、whisper、RapidOCR 全部免费本地。

### 速度优先
- **Overlay 出现 P50 < 120ms**。不做阻塞初始化、不在 hot path 加载模型。
- Wiggle 检测在 polling loop (16ms)，不阻塞主线程。
- Python bridge spawn 用 `PYTHON_ISOLATED` 隔离，超时按操作分级 (5s-120s)。

### 智能程度
- **不猜用户意图**。形状分类 (circle/line/freeform) 已被 Codex 重写为全轨迹打分。
- 手势必须结合：轨迹点 + UIA/DOM 候选 bbox + 语音命令 + 屏幕截图，四者一起交给模型推理。
- 见 `external/clicky` 的 `ElementLocationDetector.swift` 看元素定位模式。

### 体验
- **不写 few-shot 例子让用户改 prompt**。用户晃鼠标、说话、划线——系统自己理解。
- 每次交互 ≤ 3 步：晃→画→说。
- 多步选择 (this AND this AND here) 必须支持，见 `docs/planning/HANDOFF.md`。
- Dashboard 能关掉任何功能、任何 Recipe、任何 Agent。默认不可见，可暂停，可按应用禁用。

## 参考项目

### 项目内
| 路径 | 用处 |
|---|---|
| `PRODUCT_BLUEPRINT_20260726.md` | 产品蓝图：30 Recipe、竞品对比、交互合同、架构 |
| `FEATURE_INVENTORY_20260730.md` | 全部已实现功能清单 + 竞品差距分析 |
| `docs/planning/GAP_ANALYSIS_100_20260730.md` | 100 条漏洞清单 |
| `docs/planning/TODO_REMAINING_20260730.md` | 62 项代办 |
| `docs/planning/HANDOFF.md` 系列 | 历次 AI 对话交接 |
| `docs/planning/GOOGLE_DEMO_FRAME_ANALYSIS_20260726.md` | Google 演示逐帧分析 |
| `docs/planning/GOOGLE_MAGIC_POINTER_ALIGNMENT.md` | Google Magic Pointer 对齐分析 |
| `docs/planning/EXTERNAL_COMPONENTS.md` | 外部依赖清单与许可证 |

### 外部竞品（可读代码参考）
| 项目 | 路径 | 什么时候 copy |
|---|---|---|
| **clicky** (7k★) | `external/clicky/` | Cursor overlay 动画、ElementLocationDetector(Computer Use API)、Multi-monitor 坐标、Cloudflare Worker 代理模式、push-to-talk CGEvent。详见 `docs/planning/CLICKY_ANALYSIS_20260731.md` |
| **OmniParser** (MS) | `external/omniparser/` | 截图 → UI 元素 bbox。需要 screen parsing 时直接用 |
| **ufo/uia** (MS) | `external/ufo-schannel/` | Windows UIA/COM/Win32 选区。适配新 Windows 应用时参考 |
| **pi** (badlogic) | `external/pi/` | Agent 会话/RPC/扩展底座。对接 Pi Agent 时参考 |
| **nut.js** | `external/nut.js/` | 跨平台鼠标/键盘。需要模拟操作时参考 |

### D:\AI_Agents（外部项目参考，路径可能已变动）
- HermesAgent/HermesData — 模块化 skills/tools/providers 分层、cron/记忆/工具系统
- OpenHuman — 本地优先 harness、pnpm/Cargo 简洁依赖
- Kimi 相关 — 本地模型集成、中文 UI、本地语音/OCR
- 参考 Kimi 导出的 `d-ai_agents-mp-d-kimi-hermes-human-...-20260730.json`

## 代码规范

- JS：`.prettierrc.json` + `eslint.config.mjs`。2 空格。单引号。
- Python：`pyproject.toml` (ruff)。4 空格。`from __future__ import annotations`。
- 文件命名：`snake_case.py`、`camelCase.js`。
- 不要在一行写复杂逻辑。不需要 docstring 但如果函数名不够说明，加一行注释。
- 改了行为→同步改 `CHANGELOG.md`。改了 Recipe 契约→同步改 `PRODUCT_BLUEPRINT_20260726.md`。
- 不确定的代码不改。不确定的 bug 先用诊断日志定位（`log()` → `electron.log`）。

## 命令

```bash
npm test                               # JS 测试 (54 文件/112 测)
python -m pytest -q                    # Python 测试
npx --no-install electron electron/main.js  # 开发启动
npm run dist:win                       # 构建 Windows 安装包
npm run diag:collect                   # 诊断包
python scripts/sense_voice_setup.py    # 下载 SenseVoice 模型
```

## 架构速查

```
electron/main.js (3255 行，需要拆分)
  ├─ wiggle_detector.js      # 晃动检测
  ├─ gesture_capture.js       # 手势摘要
  ├─ selection_session.js     # 选区会话
  ├─ stage_contract.js       # Stage 气泡状态机
  ├─ security_hardening.js   # sandbox/崩溃/CSP
  ├─ observability.js        # JSONL 日志/crashReporter
  └─ update_manager.js       # 自动更新
app/fabric/
  ├─ engine.py               # Recipe 引擎
  ├─ router.py               # 命令→Recipe 路由
  ├─ catalog.py              # 30 Recipe 定义
  └─ mcp.py                 # MCP stdio server
scripts/
  ├─ fabric_bridge.py        # Electron ↔ Python 主桥
  ├─ sense_voice_bridge.py   # SenseVoice ASR 桥
  └─ _bridge_common.py       # 共享 stdio helper
```

## 自我更新

- 新增/删除源文件→更新上面的文件表
- 新增 Recipe→更新 `FEATURE_INVENTORY` 和 `PRODUCT_BLUEPRINT`
- 发现重要的外部项目→加到 "外部竞品" 表
- test 数量变化→更新上面的 `npm test` 行
