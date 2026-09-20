# 2026-09-18 三处圈选、工具过程与 Claude Spark 修复

本批对应用户实际失败任务 `c1789708549905`，不把附图中的任务文字当作本轮指令。金标准为用户指定的五张 `0918-132201` 至 `0918-132329` Claude 截图，结合本地已提取组件与 Claude 2.110.0.0 的原始 SVG 帧资源。

## 已定位原因

- 原任务的三个 reference 都绑定到同一微信窗口；桌面 PDF 被当作微信上的视觉区域，只有文件名，没有真实文件路径。
- `Look` 不接受 Runtime 已分配的 `reference:` 锚点，前三次调用直接报 `invalid_anchor_format`。随后视觉端点失败，空证据又被 `Context.read` 标成成功。
- 历史文件仍含 12 次工具调用与 10 段思考。实时界面把多轮文字混在一起，完成后又丢掉逐轮思考；失败详情占据操作标题，运行阶段缺少同一套工具方框。
- 开发版使用 Roaming 下的会话目录，安装版使用 Local 下的目录，造成两组记录分离。安装版同时因模型 profile 校验误把 `defaultMaxTokens` 判为明文凭据而在启动时报错。

## 实现

- 每笔手势独立定位所属窗口与材料，保留共用的历史冻结帧；每份材料注册独立 source/reference。桌面无 UIA 节点时，经公开 `IFolderView` 取得文件路径与图标坐标，支持本机重定向到 `D:\Desktop` 的桌面目录。
- `Look(reference)` 解析到原冻结帧的区域。文件 source 使用 DocumentReader，视觉圈选只用来标识文件，不能错当 PDF 页码。不可用/错误的读取结果诚实失败。
- 冻结文字随 source 保存，重开任务后可恢复读取；真实文件保持文件读写器，不再统一覆盖成文件名的冻结文字。
- 实时共享轨迹按 message/tool 保存与渲染；失败调用保留动作名称、参数、输出及展开入口。完成后连续工具与中间思考合并为可展开的摘要；切换任务后恢复全部记录。
- 复用 Claude 原始 Spark SVG、thinking 9 帧和 writing 8 帧；每帧 90ms，按原始纵向帧条步进切换，无旋转动画。回答尾部与账户区域用原始静态标志。工具代码卡、错误输出和编辑增删计数参照截图。
- 修正 profile 校验并保留模型窗口/输出 token、transport、headers 配置。停滞任务标记失败；等待输入保留等待状态。

## 实测证据

- 原历史 Chromium 回放：12 工具、10 思考均保留；完成默认折叠、点击展开、同任务更新、重建回放通过。错误输出可见；Spark `0.81s / steps(9, jump-none)`，变化矩阵仅含帧条纵移。证据：`data/acceptance-20260918/transcript-verification.json` 与两张实际历史截图。
- 原冻结画面本地 OCR：读到微信句子“小样本脱敏后给通用人工智能和专项人工智能，判别”，文件卡片 `cvpr2027-verified-top5.html / 87.3K`；`usedBackend=local:rapidocr-onnx`。
- 原生桌面取得 `D:\Desktop\CVPR 2027 选题核验.pdf`；DocumentReader 读到 21 页、630 个文本片段、22,606 字符，11 次有游标的读取；`usedBackend=document.pdf.pymupdf`。该验证完整耗时 29.157 秒，包含两次 OCR。
- 历史合并前备份两个目录，保留原件；安装版合并为 30 会话、63 轮、3 项目，补入 3 个缺失的 Agent 会话日志。记录见 `data/acceptance-20260918/history-consolidation.json`。

## 验收边界

微信截图只能证明附件卡片的可见内容，不能证明已取得该 HTML 附件正文。生产 Runtime 回放与安装验证结果见本文件后续交付记录。视觉比较覆盖用户指出的工具过程、折叠与星芒；没有宣称整套产品所有屏幕已逐像素等同 Claude。

## 生产回放与全量验证

同一原始材料、原问题运行真实默认 Runtime，未注入预期答案：190.719 秒后 `ok=true`、`loopTerminated=false`，`usedBackend=magic_pointer.messages_multiturn_streaming`。前三个 Look 请求遇视觉端点 HTTP429，随后 Context.read 分别读出 A/B 冻结文字与 C 的 PDF，Context.search 返回 PDF 相关正文；最终形成选题比较答案。证据在 `data/acceptance-20260918/runtime-replay.json`。这证明可在视觉服务不可用时继续读取独立材料，但答案超过用户要求的 200 字，且微信附件正文未取得，因此不把“返回答案”写成完整内容质量验收。

本次 `npm run sync` 内置全量验证：lint/typecheck、Node 228 个测试文件、Python 2169 passed / 1 条既有 Pillow warning / 222.85s。完成态折叠细化后前端另行 fresh lint/typecheck/Node 228 文件通过；Chromium 实际历史回放亦通过。相关日志为 `data/sync-1.0.48-20260918.txt`、`data/ui-final-verification-20260918.txt`。

首次打包的原生桌面验证发现 `pythoncom` 未打包，立即终止该次安装器构建。把 pywin32 311 纳入 Windows 运行时依赖和既有 hash lock，并在运行时构建及缓存检查中实际导入 pythoncom / win32com.shell；重新构建后再交付，不能使用开发机 import 成功替代安装版验证。

依赖补齐后的最终 `npm run sync` 再次完整通过 lint/typecheck、Node 228 个文件、Python 2169 passed / 1 warning / 238.14s；最终打包树的自带 Python 实测原生桌面定位成功。日志：`data/sync-1.0.48-final-20260918.txt`、`data/acceptance-20260918/packaged-native-probe.log`。

## 本机交付

2026-09-18 14:55（Asia/Singapore）安装同步并重启完成，版本 **1.0.48**。安装器为 `release/sync-1.0.48-20260918-143444-42320/Magic-Pointer-1.0.48-x64.exe`。

安装版自带 Python 从安装路径导入真实模块，经 `shell:desktop-folder-view` 取得同一桌面 PDF，`document.pdf.pymupdf` 读取成功并报告 21 页。安装版历史 30 会话、63 轮，原事件的 12 次工具调用与 10 段思考仍在。9 个关键前后端/资源交付文件与开发树逐字节相同，package.json 核对版本相同（打包器会去除开发元数据）。证据：`data/acceptance-20260918/installed-verification.json`、`installed-file-parity.json`。

启动日志记录 app ready、Stage/Overlay ready、legacy model profile 迁移成功及 model health ok；原模型配置 fatal 已消失。自动更新仍提示 GitHub 尚无发布版本，符合当前以本机 sync 为准的交付边界。
