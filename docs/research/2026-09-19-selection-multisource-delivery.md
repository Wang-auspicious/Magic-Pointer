# 2026-09-19 三处圈选误报过大与跨窗口材料修复

交付目标是开发树 **1.0.49**。遵循本轮用户明确要求，不升版本、不运行 sync、不修改安装版 EXE。此前 Composer、模型菜单及工作区已有改动保留。

## 原始失败与原因

用户在微信消息、微信 HTML 附件卡和桌面 PDF 上画三笔，提交“基于这些信息，总结200字讲清楚你推荐的最合适选题。”得到“这次选中的内容太大了。请缩小范围再试。”

- `data/runtime/electron.log` 2026-09-19 05:32:19 UTC：`selection_bridge.py ok=false error=payload_too_large`，对应 selection session `ecf08e15-a32a-4251-897f-8c6439df8202`。失败发生在本地反序列化，尚未调用模型。
- selection 请求包含冻结帧元数据、各笔来源、UIA 元素、感知轨迹与任务上下文，却沿用了普通控制指令的 **64 KiB** 限制；这不是模型上下文窗口超限。
- 原始 `current-object.json` 出现“信息、欣喜、心系、心细、ℹ、新戏”等输入法候选。原生 UIA region 读取通过全局 `FromPoint` 起步，再向父节点扩到桌面，能把另一个窗口的文字归给原目标窗口。
- 各笔窗口归属在较慢读取之后重新取当前窗口列表，用户随后输入弹出的候选窗会影响归属。
- 前端只用整次圈选的顶层窗口建立来源，因此桌面 PDF 的那一笔也被展示/绑定成微信。视觉补读也只判断全局 coverage，一处成功可掩盖另一处失败。

## 修改

- 仅 selection 桥采用 **8 MiB** 本地请求上限；其他桥仍为 64 KiB，不裁掉材料，也不把传输字节数当模型 token 预算。已有 resident worker 本身支持 8 MiB 消息。
- 原生 UIA `FromPoint` 结果必须属于指定窗口树，按包含选区的最小祖先读取；不允许越过目标树读取其他应用。找不到结构化文本时明确返回空，使 OCR/视觉有机会接续。
- 在较慢读取开始前保存多笔窗口清单，随后每笔独立匹配其来源。
- Stage 应用标签显示多个实际窗口；各笔独立建立 SourceRef/Reference，桌面文件保留真实路径，供文档工具读取正文。
- 视觉补读逐笔判断 coverage，未覆盖材料使用自身 `reference:` 冻结画面锚点调用同一个所选模型。遵守 Look 的非并发契约及每回合额度，失败保留真实状态。

## 真机证据

用户补画笔触的截图是 `C:/Users/zjz65/AppData/Roaming/magic-pointer/stash/2026-09/0919-133307-dtesp9.png`。原始无标注冻结画面是 `data/runtime/frame-leases/frame-2dc5410ab4c44c55.png`，3120×2080。验收依据补画图重建三笔坐标，**不是原始鼠标事件录制重放**；历史窗口归属显式恢复为当时微信和桌面，结构读取仍经过真实 native adapter。

1. `scripts/probe_uia_region_scope.ps1` 用两个真实 WinForms 窗口做正反控制。修复前指定窗口 A 却圈窗口 B，可读出 `FOREIGN_SELECTION_MUST_NOT_LEAK` 及无关浏览器内容；修复后 A 返回空，指定 B 则正常读到自己的按钮。脚本启用物理像素 DPI awareness。
2. `scripts/replay_selection_materials.py` 用上述冻结帧回放。三笔分别解析为微信、微信、Desktop；桌面 native Shell 正确得到 `D:/Desktop/CVPR 2027 选题核验.pdf`，5,255,221 bytes。捕获阶段 **5403.53 ms**，JSON **16837 bytes**（Electron 紧凑序列化 15312 bytes）。
3. `scripts/verify_selection_runtime.cjs` 经过真实 Electron main → resident Python worker → MP Runtime，使用当时选择的 **kimi-k3**。结果 `ok=true`、`errors=[]`、`usedBackend=magic_pointer.messages_multiturn_streaming`；**40607 ms** 完成两次模型回合，调用 `Context.read(source_id="C", limit=100)` 补读 PDF 正文，返回“01 屏幕信念账本”的选题建议。
4. 此回放 OCR 已覆盖各笔触，故没有自动调用 Look。另用 `scripts/verify_selection_vision.py --replay-model` 显式执行真实 Look，对第二处冻结选区及同帧全景调用 **kimi-k3**，**9082.79 ms** 返回 `status=ok`，识别出微信“文件传输助手”、`cvpr2027-verified-top5.html` 和 **87.3K**。
5. 视觉验证时用户当前选择已是 **deepseek-v4.1-flash**，目录标记为纯文本。直接使用该当前模型的验收返回 `unsupported`，未伪造成功；Kimi 验收只作请求内覆盖，没有改变持久模型选择，也没有添加第二个视觉模型。

本地完整证据：`data/runtime/selection-multisource-20260919/{capture-witness.json,runtime-result.json,vision-result.json,vision-kimi-k3-result.json}`。这些数据未作为源码提交内容。

## 验收边界

- 本次已证明：大于 64 KiB 的真实形状请求可通过本地桥；UIA 不串窗；三处材料保持各自来源；桌面 PDF 正文可读取；当前 Runtime 能完成回答；视觉模型可读取该冻结附件卡。
- 微信 HTML 附件**正文未读取**，不能把看清卡片文件名说成读完附件。最终选题建议主要依据 PDF；它仍含开场文字，未严格达到 200 字，因此不把内容格式称为完整通过。
- 另发现既有删除笔触路径 `withKeptStrokes` 只过滤 strokes、未同步过滤 `selection_materials`。这影响“移除某个材料再提交”，本次三笔全部保留的复现不经过该分支；记录为后续独立修复项，未在本次扩大修改范围。
- Python 全量中有此前已记录的感知测试失败：`test_screen_region_enrich_falls_back_to_full_capture_without_selection_bbox`。该 fixture 的 OCR 返回 `rect=None`，却断言选中块数量 1；现实现报告无几何选中块 0，文本仍保留。没有为掩盖失败而改写这项既有契约。

## 验证记录

新增回归均观察预期失败后修复：多材料请求 64 KiB 截断、慢读取期间输入法抢来源、全局 coverage 掩盖单笔视觉、每笔独立来源。Stage 主进程实际函数到 SourceRef 的链路另有行为验证。

首轮 fresh 全量：Python **2321 passed / 1 项上述既有失败 / 387.59s**；Node **238 文件通过**；完整 TypeScript、lint、构建通过。补充 Look 非并发契约和 Stage 来源行为用例后的最终检查：Python **2321 passed / 1 项上述既有失败 / 318.01s**，Node **239 文件通过**，完整 TypeScript、lint 通过；前端生产代码与已验证构建一致。

最终已关闭本次验收启动的旧开发进程，使用 `--open-only` 打开最新开发主进程 **38952**，系统窗口标题 **Magic Pointer**，启动日志确认加载 `D:/Desktop/Magic Pointer/build/electron/main.js`、版本 **1.0.49**，stderr为空。没有重新执行模型请求或改动用户当前模型选择。
