# 同类/交集开源项目扫描 — 可借鉴清单

> 目的：一次性把"和 Magic Pointer 有交集、能直接拿走一个功能或一个避坑经验"的开源项目扫出来。
> 方法：GitHub API 多轮定向检索 + Hacker News (Algolia) + Reddit (OpenCLI) + Exa。
> 日期：2026-08-03。配套阅读：`EVERYWHERE_ANALYSIS_20260803.md`。

---

## 0. 先说结论

扫到 **23 个**有实质交集的项目。其中：

- **3 个可以直接 npm/pip 装进来当依赖**（selection-hook / RapidOCR / sherpa-onnx）
- **5 个是我们某个空白能力的"参考实现"**（WritingTools 原位改写、agent-desktop 动作协议、normcap 零模型取、Flow.Launcher 插件生态、OpenAdapt 确定性回放）
- **1 个形态几乎和我们一模一样但只有 93★**（nemo-assistant）——说明这条路有人在走，但还没人走通
- **1 个社区需求的硬证据**：PowerToys issue #37343「要一个 Windows 版 PopClip」——微软自己没做

最重要的单条发现：**`theJayTea/WritingTools`（2385★）已经把"系统级原位改写"做出来了，而且明确宣称「不动剪贴板 + Ctrl+Z 可撤销 + 全系统可用」。** 这是我们 AGENT.md 里认定"全行业硬骨头"的那块——有人啃下来了，可以直接读它怎么做的。

---

## 1. 感知 / 「取」—— 把屏幕上的东西弄下来

| 项目 | ★ | 语言/许可 | 拿什么 | 对应我们的缺口 |
|---|---|---|---|---|
| **`0xfullex/selection-hook`** | 104 | C++ / **MIT** | **Node.js 原生模块**：跨平台划词监听 + 全局鼠标/键盘 hook。Everywhere 那 946 行 C# 就是移植它 | 我们**没有**"选中即感知"入口；而且我们是 Electron，**这个可以直接 npm 装**，比抄 C# 顺 10 倍 |
| `CherryHQ/cherry-studio` | 49k | TS / **AGPL-3.0** ⚠️ | `src/main/configs/SelectionConfig.ts` 里的**进程黑名单 / 延迟读剪贴板名单 / 光标形状判定** | 我们发 Ctrl+C 时不知道该躲开哪些应用（Excel/PS/Pr/终端…）。**只取配置数据，不抄代码**（AGPL 传染） |
| `hiroi-sora/Umi-OCR` | 46.4k | Python / MIT | 离线 OCR 的工程化标杆：批量、PDF、排除水印页眉页脚、多语言库管理 | 我们的 RapidOCR→Tesseract 兜底还很粗糙 |
| `RapidAI/RapidOCR` | 7.4k | Python / Apache-2.0 | 多后端（ONNX/OpenVINO/MNN/TensorRT） | **已在用**，但没用多后端加速 |
| **`dynobo/normcap`** | 2.7k | Python / 宽松 | slogan 就是 *"capture information instead of images"* ——框一下直接出文字进剪贴板 | **这就是我们下一步 #1「零模型快路径」的成品参考**（目标 <200ms、0 次模型调用） |
| **`xushengfeng/eSearch`** | 6.9k | TS(**Electron**) / GPL-3.0 | 截屏 + 离线OCR + 屏幕翻译 + 贴图 + 万向滚动截屏 | **同栈（Electron）**，遇到的坑和我们完全同构，是最可对照的工程样本 |
| `ShareX/ShareX` | 38.9k | C# / GPL-3.0 | Windows 截屏领域的事实标准（区域选择交互、热键、上传管线） | 我们的区域选择交互还在自己发明 |
| `mg-chao/snow-shot` | 4.9k | TS / — | 现代截图工具（Tauri） | 同上 |

**立刻能做的**：`npm i selection-hook`，补上"选中即感知"这个我们完全缺失的入口。

---

## 2. 动 / 「改」—— 原位写回（我们最大的差异化，也是最大的技术风险）

| 项目 | ★ | 语言/许可 | 拿什么 | 备注 |
|---|---|---|---|---|
| **`theJayTea/WritingTools`** | **2385** | Swift+Python / GPL-3.0 | **系统级原位改写**。README 明确写：*"Your text will instantly be replaced with the AI-optimized version. Use `ctrl+z` to revert."* + *"**Does not mess with your clipboard**, and works system-wide."* 跨 Windows / Linux / macOS | **这是我们"原位改写"的头号参考。** Everywhere 在 v0.5.8 把这功能删了，这个项目做成了。GPL 不能抄代码，但机制可以读 |
| **`SevenBT/nemo-assistant`** | 93 | Python / **MIT** | 形态**几乎和 Magic Pointer 一样**：选中→光标旁弹动作条→解释/翻译/润色/**原位替换**；`Ctrl+Alt+A` 截图 RapidOCR；工具调用 + 记忆 | 明确写了 *"Selection capture uses UIA with a clipboard fallback: reads directly when possible, injects Ctrl+C only when needed, and **restores the clipboard afterward**"*。**MIT，可以直接用代码** |
| **`lahfir/agent-desktop`** | 985 | Rust / **Apache-2.0** | *"Control any application through OS accessibility trees with **structured JSON output and deterministic element** location"* | **这是我们「Phase 4 统一动作协议」(read/replace/insert/set_value/invoke/verify/undo) 的现成设计**。Apache-2.0，模式可放心借 |
| `microsoft/UFO` | 9.4k | Python / MIT | 微软官方的 Windows UIA/COM GUI agent（UFO³） | 官方对 UIA 边界的理解，比我们摸索强 |
| **`OpenAdaptAI/OpenAdapt`** | 1662 | Python / MIT | *"Compile a demonstrated GUI workflow into a deterministic, locally executable program. **Zero model calls on healthy runs**; governed repair"* | **"演示一次→编译成确定性程序→正常路径零模型调用"**——这正是我们要的"快路径"哲学，而且有"受控修复"机制处理漂移 |
| `AmberSahdev/Open-Interface` | 2.7k | Python / GPL-3.0 | Control Any Computer Using LLMs | 对照实现 |
| `showlab/computer_use_ootb` | 2.0k | Python / — | 开箱即用的 Windows/macOS GUI Agent | 对照实现 |
| `bytedance/UI-TARS-desktop` | **38.4k** | TS / Apache-2.0 | 字节的多模态 Agent 栈（模型 + Agent 基建） | 目前最大的开源 GUI agent 项目，Apache-2.0 |
| `trycua/cua` | 20.9k | — / MIT | computer-use 2.0：跨 OS 驱动、fleet、benchmark | **有 benchmark**——对应我们缺的"Recipe 评分验收" |
| `pywinauto/pywinauto` | 6.1k | Python / BSD | Windows GUI 自动化 | 可能已在用 |

**立刻能做的**：把 `nemo-assistant`（MIT）的 selection→UIA→剪贴板兜底→**恢复剪贴板**这条链读一遍，和 §1 的 selection-hook 拼起来，我们的"取"就补齐了。原位改写读 WritingTools 的机制。

---

## 3. 交互形态 / 窗口 / 插件生态

| 项目 | ★ | 语言/许可 | 拿什么 |
|---|---|---|---|
| **`microsoft/PowerToys`** | **137k** | C++/C# / MIT | 键盘 hook、修饰键状态、`RegisterHotKey` vs `WH_KEYBOARD_LL` 的取舍——Everywhere 的 `ShortcutListener` 直接注明抄自它的 `CmdPalKeyboardService`。**另外 issue #37343「要一个类 PopClip 的选中弹窗」是社区需求的硬证据，微软自己没做** |
| **`Flow-Launcher/Flow.Launcher`** | 15.3k | C# / **MIT** | Windows 上最成熟的**社区插件生态**：插件清单格式、加载器、商店、权限 | **对应我们下一步 #2「Recipe 数据化 + 插件加载器」** |
| `Wox-launcher/Wox` | 27.2k | Go / MIT | 跨平台启动器，插件模型另一种范式 |
| `kunkunsh/kunkun` | 1.3k | TS / — | 跨平台可扩展启动器，TS 插件 SDK（离我们技术栈最近） |
| **`iamsrikanthnani/pluely`** | 2364 | TS(Tauri) / GPL-3.0 | Cluely 的开源替代，~10MB，常驻不可见。**Reddit 上有独立社区 r/pluely** | 形态参考 + 社区运营参考 |
| `vicinaehq/vicinae` | 8.8k | C++ / — | 原生、快、可扩展的启动器 |

---

## 4. 语音 —— 我们的护城河，去找更强的

| 项目 | ★ | 语言/许可 | 拿什么 |
|---|---|---|---|
| `k2-fsa/sherpa-onnx` | 13.9k | C++ / Apache-2.0 | **已在用**（SenseVoice）。还有 TTS / VAD / 说话人分离没用上 |
| `ggml-org/whisper.cpp` | 52.5k | C++ / MIT | **已在 external/** |
| **`Const-me/Whisper`** | **10.6k** | C++ / MPL-2.0 | **Windows 上的 GPGPU (DirectCompute) Whisper 推理**，比 CPU 快一个量级 | 我们**没用**。对应 memory 里那条"实测 p50 4.3s、根因冷加载"——GPU 推理是另一条正交的提速路径 |
| `infiniV/VoiceFlow` | 405 | Python / MIT | 本地听写 + 会议录制，**按住热键说话**，Windows+Linux | 按住说话的交互细节 |
| `qforge-dev/qspeak` | 61 | TS / MIT | WisprFlow 的开源替代，跨平台 | 形态参考 |

**注意**：Everywhere 有 6207★ 但**一行语音代码都没有**（我 grep 过 `whisper|speech|dictation|microphone`，零命中）。语音是我们能守住的地方，值得继续投。

---

## 5. 记忆 / 长上下文

| 项目 | ★ | 语言/许可 | 拿什么 |
|---|---|---|---|
| `screenpipe/screenpipe` | **20.7k** | Rust / YC S26 | 7×24 录屏 + 本地检索 + 接 agent。**我们 external/ 已有** | 对应下一步 #3「记忆层」 |
| `hvardhan878/ghostwork` | 126 | TS | Screenpipe 的 GUI + macOS 自动化 agent | 上层怎么用 screenpipe 的样例 |

---

## 6. 从社区讨论里读到的信号（不是项目，是结论）

**Reddit**：搜「Cluely alternative open source」出来 **14+ 个不同的独立作者**在 r/selfhosted / r/OpenAI / r/SideProject / r/leetcode 发自己的开源版本，最高 96 分。说明：

- 「不可见的、常驻的、能看屏幕的 AI 助手」是一个**过热赛道**，人人都在做 MVP
- 但绝大多数停在"截图 + 问模型"，**没有一个做结构化读取（UIA）+ 原位写回**
- 有独立 subreddit（r/pluely）的只有一个——**大部分项目发完帖就死了**

**Hacker News**：`Show HN` 里同类项目十几个，分数普遍是个位数（1–7 分）。唯一高分的是 AnythingLLM（368 分，但那是通用 LLM 桌面端，不是屏幕感知）。说明**这个品类目前还没有出现 HN 级别的爆款**——Everywhere 的 6.2k★ 主要来自 Trendshift / ProductHunt / HelloGitHub 而不是 HN。

**结论**：赛道拥挤但**没人做深**。拥挤的是"截图问答"，空着的是"结构化读 + 精确写回 + 跨应用"。这和 `PRODUCT_STRATEGY_20260803.md` 已有的判断一致，现在有外部数据支撑了。

---

## 7. 按"一个项目换一个功能"排的取用清单

> 用户原话：*"假设一个项目能建一个功能，那我们就能拿到 10 个功能和 10 个改进的 bug"*。按这个口径列。

| # | 从哪个项目 | 拿到什么功能 / 修掉什么 | 许可可用性 |
|---|---|---|---|
| 1 | `selection-hook` | **"选中即感知"入口**（我们完全没有），含拖拽/双击/Shift 三种触发判定 | MIT ✅ 可直接依赖 |
| 2 | `nemo-assistant` | **选中动作条 + 剪贴板兜底后恢复剪贴板**的完整实现 | MIT ✅ 可抄代码 |
| 3 | `WritingTools` | **原位改写不污染剪贴板 + Ctrl+Z 可撤销** 的机制 | GPL ⚠️ 只读机制 |
| 4 | `agent-desktop` | **统一动作协议**：无障碍树 + 结构化 JSON + 确定性元素定位（我们的 Phase 4） | Apache-2.0 ✅ |
| 5 | `normcap` | **零模型快路径「取」** 的交互与性能基准 | 宽松 ✅ |
| 6 | `OpenAdapt` | **正常路径零模型调用 + 受控修复**的架构思想 | MIT ✅ |
| 7 | `Flow.Launcher` | **插件清单 + 加载器 + 商店**（Recipe 数据化） | MIT ✅ |
| 8 | `PowerToys` | **`RegisterHotKey` 优先 / hook 兜底 / 修饰键不自维护状态** | MIT ✅ |
| 9 | `cherry-studio` | **发 Ctrl+C 的进程黑名单 + 延迟读取名单**（数据不是代码） | AGPL ⚠️ 只取数据 |
| 10 | `Const-me/Whisper` | **Windows GPU 语音推理**，正交于我们的冷加载优化 | MPL-2.0 ✅ |
| 11 | `eSearch` | **同为 Electron** 的截屏/OCR/屏幕翻译工程实践与踩坑 | GPL ⚠️ 只读 |
| 12 | `Umi-OCR` | 离线 OCR 的**工程化**（语言库管理、水印页眉排除） | MIT ✅ |
| 13 | `trycua/cua` | **benchmark 体系**（对应我们缺的 Recipe 评分验收） | MIT ✅ |
| 14 | `screenpipe` | **记忆层**（已在 external/，还没接） | 已有 |
| 15 | `UFO` / `UI-TARS-desktop` | UIA 边界的官方/大厂理解；多模态 agent 栈对照 | MIT / Apache ✅ |

---

## 8. 建议怎么处理这批东西

1. **先克隆 3 个 MIT 的**（`selection-hook` / `nemo-assistant` / `agent-desktop`）到 `external/`，这三个是可以直接用代码的。
2. **只读不抄的单独标注**：`WritingTools`(GPL) / `cherry-studio`(AGPL) / `eSearch`(GPL) / `pluely`(GPL) / `everywhere`(BSL)。
3. **更新 `docs/planning/EXTERNAL_COMPONENTS.md` 的许可证矩阵**，把这批加进去并标注「可依赖 / 可抄代码 / 仅可读思路」三档。
4. 这份清单和 `EVERYWHERE_ANALYSIS_20260803.md` 是配套的：Everywhere 给的是**产品演进经验 + 窗口/UIA 的坑**，这份给的是**具体能力的零件供应商**。

---

## 附：完整原始命中（含小项目，供后续二次挖掘）

`bertrandmbanwi/Jarvis`(29) · `martinoyovo/overlay`(10) · `SunnyLich/Wisp-AI-Assistant`(8) · `0xLoqi/AskAIv2`(5, C#) · `virenmehta10/ai-desktop-overlay`(2) · `Luthiraa/julie`(28) · `Artlands/InplaceAI`(1, macOS 原位改写) · `minerd/Orbital`(PopClip 替代) · `Dyan-Dev/loopi`(186) · `IRISX-AI/IRIS-AI`(159) · `lahfir/agent-desktop`(985) · `showlab/ShowUI`(1885) · `zai-org/CogAgent`(1190) · `OneMoreGres/ScreenTranslator`(1259) · `amebalabs/TRex`(1868) · `ianzhao/textshot`(1774) · `SnapXL/SnapX`(995) · `mnardit/beetroot-releases`(263, 剪贴板+AI+OCR)

社区线索：`r/pluely` · PowerToys issue #37343 · HN "Show HN: Pluely" 系列 · r/selfhosted 1nj8l4j · r/OpenAI 1no2mng
