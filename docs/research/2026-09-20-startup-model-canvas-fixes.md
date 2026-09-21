# 2026-09-20 启动卡顿、模型标签与 Work / Design 修复

对应用户提供的 `0920-200838-1vp4yk.png`、`0920-201356-18148z.png`、`0920-201418-kh7g4v.png`，以及任务 `01a0bde1-ee9f-7f03-8c4a-5df33c1b12a8` 的本机 rollout JSONL。保留上一任务已有修改，并沿用该任务“修后不要升版本”的要求。

## 定位与改动

1. **模型标签竞态**：初始 `refreshComposerModel` 与 `openModelMenu` 共用请求序号。打开菜单会使初始刷新失效，但菜单拿到结果后只更新菜单、未更新按钮；再点击已经选中的模型直接返回，按钮因此一直显示“默认模型”。两处现共用同一份模型状态，目录结果同步按钮；短暂读取失败保留已知选择；迟到的目录不覆盖新选择。
2. **启动路径过重**：原启动固定在 2.5 秒后启动 OCR 并热身；1.5 秒后自动探测模型，之后每分钟另起 Fabric 进程读取健康状态。现在 OCR 仅在显式识别需求时加载，健康检查保留用户主动操作入口。Studio 启动时通过 TS 主进程读取本地配置，不再为显示模型名冷启动 Python 或等待远程目录；打开菜单才发现远程模型，同一时刻的请求合并、短时间重复打开复用结果，刷新失败仍暴露错误。
3. **OCR 原生线程争用**：RapidOCR 的三个 ONNX session 默认使用大量计算线程，OpenCV 另有线程池。三个生产入口统一使用已有引擎的参数：ONNX intra-op 2 / inter-op 1，OpenCV 1。不更换 OCR 模型、坐标语义或感知融合逻辑。
4. **Canvas / 列表缺失样式**：旧样式移除后，收藏节点失去绝对定位，SVG 回到 300×150 的默认尺寸。补回限定在收藏区的画布、节点、缩略图、工具栏、列表与窄窗布局；默认 100%，仅点击“适应画布”时缩放；卡片为标题与说明预留完整高度；Canvas / Assets 高亮同步。
5. **产品入口**：Home / Code 改为 Work / Design，修正反向绑定和 Design 导航的 hidden 属性。使用本地 Claude Desktop 2.110 素材库已有的 Anthropicons Workspace U+E10C 与 Palette U+E0B8 字形。
6. **本机选择对齐**：开发版的 secrets 已是 `deepseek-v4.1-flash`，安装版 active profile 仍是旧 `mimo-v2.5`。按本次用户明确选择，将安装版 active profile 的 model 对齐为 `deepseek-v4.1-flash`，未改端点或凭据。

## 实测证据与边界

| 测量 | 修改前 | 修改后 |
|---|---:|---:|
| OCR 单进程峰值线程（含监测线程及其他原生库） | 72 | 26 |
| OCR 冷加载 + 两种 detection warm shape 的累计 CPU 时间 | 38.22 s | 8.61 s |
| 同一 OCR 测量的峰值 RSS | 270.8 MB | 291.5 MB |
| 隔离配置真实启动 + 打开 Studio 的 Python 子进程 | OCR + Fabric | 0 |
| 该启动样本最大主线程定时器延迟 | 434 ms | 338 ms |
| 该启动样本 Electron 进程工作集总和峰值 | 845 MB | 844 MB |

启动测量运行真实 main / preload / renderer 和原生 UIA / pointer host，隐藏窗口，使用隔离配置和一个明确声明的本地模型。仅禁用登录注册与外部健康探测；未运行模型任务。工作集总和来自 Electron metrics，**不含 Python，不能当作整机物理内存或总私有内存**。数据不足以认定实际 OOM，也没有把主线程延迟改善解读为彻底消除所有卡顿。

OCR 性能是实际 CPU 后端 `rapidocr-onnx`。用用户第一张截图另做真实识别，冷加载及识别 **4700 ms**，**13 个文本块**，包含 DeepSeek，errors 为空。线程限制显著降低无效 CPU 消耗，峰值内存没有下降；启动省掉的是整个不必要的 OCR 加载。首次真正需要 OCR 仍会承担冷加载时间。

实际本地收藏库通过生产 stash IPC 读取，**147 个节点 / 99 ms 渲染 / 609 px 画布高度 / 100% 缩放**。该样本含原始图片，Electron 工作集峰值约 **1104 MB**，无新增 Python 进程。来源库仅读取，未改写。

证据：

- `data/runtime/startup-resources-20260920/before.json`、`after.json`、`real-stash.json`：真实启动与收藏读取。
- `data/runtime/startup-ui-20260920/witness.json`：真实 Chromium、确定性模型竞态与 12 条布局夹具；`canvas.png` / `list.png` 是夹具截图。
- `scripts/measure_ocr_resources.py`：OCR 资源对照脚本，默认使用当前生产参数，`--default` 复现旧配置。
- `tests/studio_startup_ui_test.js`、`tests/model_catalog_startup_test.js`、`tests/startup_idle_resources_test.js`、`tests/ocr_resources_test.py`：先观察相应失败，再实施修复。

关于纯 TS：本轮证据指向启动时机、重复进程和原生线程配置。仅把同样的 ONNX 工作搬到 TS 不会自动解除线程争用。轻量模型配置路径已经留在 TS；本轮没有重写自有 Python Agent Runtime，也不将其宣称为纯 TS 迁移。

## 交付状态

定向回归、真实启动及真实 OCR 验证通过。首次全量 Node 因两条源码字符串契约仍匹配无参数 `models()` 而失败；更新为默认本地读取、菜单显式远程刷新参数，同时保留菜单先显示的断言。对应测试已定向通过。

最终 `npm run sync` 内全量验证通过：lint、全部 TypeScript、build；Node **261 test files**；Python **2507 passed / 6 条既有 Pillow 弃用提示 / 341.86s**。日志为 `data/sync-startup-canvas-1.0.50-final-20260920.log`，末尾为 `installed version: 1.0.50` / `sync done`。独立读取安装目录确认版本 1.0.50，OCR 工厂和 worker 与开发树逐字相同，收藏样式已存在于包内 build/electron/renderer，运行进程来自安装目录。沿用用户不升版本要求。
