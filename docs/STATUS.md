# 当前状态

> 最后核实：2026-08-05。改了行为就回来改这里，别新建一份日期文件。

分支 `codex/multi-stroke-and-voice-fix`，未推送。全量测试：**Python 1026 项、Node 132 项（64 个源文件）**，ESLint 0 error 0 warning。

## 一句话

结构化应用（记事本、Edge、Office、终端）的划线读取链路已经可用；自绘应用（微信 4.x、Qt、Flutter）还缺"首笔手势直接给出像素候选框"这条生产链路。**不能宣称"任意 Windows 软件里随手一划都能稳定理解完整对象"。**

## 能用

| 能力 | 状态 |
|---|---|
| 晃动唤醒 → 划线圈选 → 气泡问答 | 可用 |
| 39 个 Recipe（数据驱动，`data/recipes/builtin.recipes.json`） | 可用，插件目录可加载 |
| 三层意图路由（L0 关键词 / L1 分类 / L2 工具调用兜底） | 可用 |
| 结构化读取：UIA / Chrome DevTools DOM / Office COM | 可用 |
| 像素读取：常驻 OCR worker + 视觉元件框 | 可用 |
| 证据高亮带（蓝＝结构层，琥珀＝像素） | 可用 |
| 「填入」把气泡答案写进别的应用输入框 | 可用，写入后读回校验 |
| Dashboard 设置 / 权限 / 审计 / 诊断 | 可用 |
| Agent 集成（Codex/Pi/Claude/Gemini/Cursor/OpenCode/Aider） | 可用 |
| MCP 双向（我们既是 server 也是 client） | 可用 |
| 语音（SenseVoice 默认，Whisper 兜底） | 可用，但默认输入是**打字** |
| Windows 安装包 + 自动更新 | 可用 |

P3 十二项能力做完十项：图转提示词、选区拉伸把手、点选追问、悬浮翻译、[POINT] 指点、记忆层、剪贴板历史、插件加载器、MCP client、零元件窗口视觉框选。

## 不能用 / 有条件

- **微信 4.x、Qt、Flutter、GPU 合成的 Electron**：UIA 只给容器，`PrintWindow` 抓不到帧，两条读取路同时断。目前靠合成截图 + OCR + 视觉分组兜过去，但**首笔手势拿不到候选框**，只能事后点选。
- **模型没有视觉**。当前后端 DeepSeek 明确说读不了图。图片请求能到端点，但**"请求成功"不等于"视觉可用"**。要视觉必须另配模型。
- **浏览器结构化读取依赖 `--remote-debugging-port`**。端口不可用时目前不回落 UIA（证据显示 UIA 树完全够用）。
- **P3 剩两项**：选中动作条、clicky 指针陪伴。两件都要一个**常驻文本选中监听**——没有会话时也在后台观察，是新的常驻组件，不是现有链路的延伸。仓库里还没有 selection-hook 集成。
- **macOS**：代码在（`native/macos/MagicPointerHost.swift`），没有实机验过权限、多屏坐标、签名公证。
- **Linux**：Fabric / MCP / Agent 层可用，没有系统级 pointer host。

## 模型后端

`secrets/`（gitignored）里三个文件：`openai_base_url.txt` = `https://api.deepseek.com/anthropic/v1`、`model.txt` = `deepseek-v4-flash[1M]`、`openai_key.txt`。Anthropic Messages 协议，已显式关闭 thinking——否则短输出预算会全被 thinking 吃掉，返回 HTTP 200 但没有正文。

文本实测约 3–6 秒。**不是流式**。

## 已知未修

1. **舞台的屏幕→窗口坐标换算在高 DPI 下存疑**：`stageOriginX/Y` 把物理像素的 `screenX` 减去 DIP 的 `x`。证据高亮带**刻意沿用了同一套换算**以保持一致——要改就两处一起改。
2. 微信首次点选 4.4 秒里，明知读不到的 UIA 探针仍白跑约 0.3 秒。已知零元件的窗口应该直接跳过探针。
3. 终端能用 `TextPattern.RangeFromPoint` 拿精确文本 + 行矩形（已验证），但生产探针的 region 模式走 `TryRegionElements` 就返回了。修完终端不需要 OCR。
4. token 热力图**没有数据**：审计事件里零个 token 字段。要做得先让 `ask_text_model` 把 usage 写进审计日志。
5. OCR worker 忙时可能返回空。忙碌不等于"屏幕上没有文字"，应该排队或明确报 `worker_busy`。
6. 真实麦克风、中文口音、噪声环境还没做人工验收。自动化通过不能替代真人语音体验。
7. 诊断页还得靠人翻 `data/runtime/electron.log`。打点数据（`bridge_progress.py`）已经在记，画出来就是页。

## 真机验收怎么跑

```bash
python -m pytest tests/ -q --basetemp=data/runtime/pytest-tmp-verify   # 不指定 basetemp 会因系统 temp 权限报 PermissionError，是环境问题
node scripts/run-node-tests.js
git grep -n "sk-"                                                     # 期望无输出

python scripts/uia_tree_dump.py --title-contains "Notepad" --all      # UIA 真相复验（只读）
python scripts/verify_marked_line_answer.py --title-contains "微信" --y <某条消息的屏幕Y>
```

划线端到端看四个字段：`source_kind`、`covers_mark`、`gap_reason`、`selection_bbox`。微信上应当是 `screen_region` / `False` / `no_structured_text`，且 `selection_bbox` **等于你画的那一笔**，不是整窗。

人眼必看两条：读到的每一块外围有跑动的亮带且**按来源分色**；气泡**不能出现在** `data/runtime/selection-captures/*.png` 里，同时气泡本身**不能发黑**（透明窗口开 display affinity 在某些 GPU 上会整窗变黑，任一条失败就把 `CAPSULE_CONTENT_PROTECTED` 翻成 false）。
