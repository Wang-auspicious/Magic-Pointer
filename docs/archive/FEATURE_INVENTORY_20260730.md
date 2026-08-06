# Magic Pointer 功能清单 & 竞品差距分析

生成时间：2026-07-30 | 基础版本：`ce8d125` + 未提交工作区

---

## 一、已实现功能（按模块逐项罗列）

### 1. 唤醒与激活

| # | 功能 | 现状 |
|---|---|---|
| 1.1 | 鼠标晃动唤醒（250-600ms 窗口内水平往返 2+ 次反转） | 已实现，`wiggle_detector.js` |
| 1.2 | 晃动灵敏度滑块（0.1-1.0，默认 0.55） | Dashboard 可调 |
| 1.3 | 唤醒冷却（默认 900ms） | 自适应阈值，连续误触发自动提高 |
| 1.4 | 10 秒校准采集有意晃动样本 | `wiggle_calibration` 已实现 |
| 1.5 | 备用快捷键 `Ctrl+Alt+M` | 已实现，Dashboard 可改键 |
| 1.6 | 按应用禁用（blender/krita/photoshop 等） | Dashboard 黑名单，`disabled_apps` |
| 1.7 | 鼠标侧键唤醒（`mouse_side_button`） | 支持 none/x1/x2，默认关闭 |
| 1.8 | 拖拽/滚轮/窗口拖动时拒绝触发 | `wiggle_detector.js` 内建 |
| 1.9 | `Ctrl+Alt+P` 暂停 Magic Pointer | 全局暂停 |
| 1.10 | 托盘"暂停 15/60 分钟" + DnD 联动 | **未实现** (#69) |

### 2. 指针与对象捕获

| # | 功能 | 现状 |
|---|---|---|
| 2.1 | 晃动冻结指针对象的 `THIS` | `selection_session.js` |
| 2.2 | DOM 选区捕获（Chromium DevTools 协议） | `browser_devtools_adapter.py` |
| 2.3 | UIA 选区捕获（Windows UI Automation） | `uia_selection_probe.cs` + `uia_text_adapter.py` |
| 2.4 | Office/COM 选区捕获（Word/WPS） | `office_adapter.py` + `office_selection_probe.vbs` |
| 2.5 | PDF 选区恢复（页码 + 边框 + 哈希） | `pdf_selection_recovery.py` |
| 2.6 | OCR 屏幕文字（RapidOCR） | `rapidocr` 集成 |
| 2.7 | THAT/THESE/HERE 时序多对象绑定 | `interaction_episode.js` |
| 2.8 | 多对象比较（带来源） | Recipe `objects.compare` |
| 2.9 | 全轨迹多点 UIA/DOM 打分（非单点） | Codex 已重写 `gesture_capture.js` |
| 2.10 | 视觉兜底截图（ScreenCaptureKit/CGWindow） | macOS 未实机，Windows 有 PS 脚本 |

### 3. Overlay 划线选区

| # | 功能 | 现状 |
|---|---|---|
| 3.1 | 晃动后全屏透明 overlay | `overlay.js` Canvas 渲染 |
| 3.2 | 圆圈检测（闭合度+环绕比） | `gesture_capture.js` summarizeGesture |
| 3.3 | 线/自由形状分类 | Codex 重构为轨迹打分，不再是硬分类 |
| 3.4 | 独占透明画布模式（`exclusive_overlay`） | 默认模式，全屏膜挡住原应用 |
| 3.5 | 不阻断原应用模式（`pass_through`） | **Dashboard 灰掉标"待开发"** |
| 3.6 | 划线样式：演示 6 宽带 / 细线 | Dashboard 可选，默认 `demo6_band` |
| 3.7 | 划线宽度可调（3-40 DIP） | 默认 40 |
| 3.8 | 落笔缓冲（60-600ms 防止误画） | `gesture_arm_delay_ms` 默认 180ms |
| 3.9 | 绘制超时（1-15 秒） | `gesture_timeout_ms` 默认 5000ms |
| 3.10 | 手势完成后自动冻结对象 | `completeSelectionGesture` → `beginSelectionSession` |
| 3.11 | 第二次/第三次连续划线保持同一 episode | Codex 已实现连续 re-arm |
| 3.12 | Add this → and this → here 跨笔画指代记忆 | Codex episode 有序对象集 |

### 4. Stage 气泡与交互

| # | 功能 | 现状 |
|---|---|---|
| 4.1 | 单一气泡（不做建议动作/麦克风键/关闭键/发送键） | `stage.js` |
| 4.2 | 语音胶囊（小圆形声纹 → 转写文字横向增长） | `capsule-voice` 模式 |
| 4.3 | 文字胶囊（打字横向增长） | `capsule-text` 模式 |
| 4.4 | Processing 状态显示（同气泡内） | `stage renderer state=processing` |
| 4.5 | 结果展示（高风险动作预览差异） | `stage renderer state=result` |
| 4.6 | 失败时说明缺少哪项能力 | `stage renderer state=error` |
| 4.7 | Escape 关闭 / 右键关闭 | `dismissTemporarySurfaces` |
| 4.8 | 胶囊动画参数（生成/扩展/宽度/间隙） | Dashboard 全可调 |
| 4.9 | sweep_band 动画（高度/时长/淡出） | Dashboard 全可调 |

### 5. 语音输入

| # | 功能 | 现状 |
|---|---|---|
| 5.1 | 本地 Whisper（tiny 模型） | `openai-whisper==20250625`，默认后端 |
| 5.2 | 本地 SenseVoice Small（更准中文） | `sherpa-onnx` 集成，需手动下载模型 |
| 5.3 | 常驻语音 worker（复用模型不反复加载） | `voice_resident_runtime.js` |
| 5.4 | 语音引擎切换 Dashboard | `voice-engine` 下拉 |
| 5.5 | 停顿自动提交（600-5000ms 可调） | `voice_silence_ms` 默认 1600ms |
| 5.6 | 开始策略：自动/按住左键/驻留胶囊 | `voice_start_strategy` |
| 5.7 | 自动开始监听 | `auto` 策略 |
| 5.8 | 语音内存上限（128MB-16GB）+ 实测校验 | `voice_memory_limit_mb` |
| 5.9 | 空闲释放（10s-1h） | `voice_idle_unload_ms` 默认 300s |
| 5.10 | 静音幻觉拦截 | `voice_hallucination_guard` |
| 5.11 | 中文口述标点转换 | `voice_punctuation: smart_zh` |
| 5.12 | 简繁输出（OpenCC） | `voice_script` |
| 5.13 | 中英混排空格压缩 | `voice_mixed_spacing` |
| 5.14 | 识别语言（中/英/日/韩/法/德/西/俄/auto） | `voice_language` |
| 5.15 | 转写策略（逐字保留 / 清理空格） | `voice_output_mode` |
| 5.16 | 项目术语词典（scope/term 作用域） | `voice_glossaries` textarea |
| 5.17 | VAD 静音检测（能量阈值 + 延时） | Whisper bridge 有完整 VAD |
| 5.18 | Partial 转写（逐字飞入） | Worker 支持 `partial` 事件 |
| 5.19 | 离线工作——不上传录音 | 全程本地 |
| 5.20 | ModelScope/HuggingFace 模型下载 | `sense_voice_setup.py` (HF 需翻墙) |

### 6. 30 个 Recipe（动作配方）

| # | Recipe ID | 功能 | 状态 |
|---|---|---|---|
| 6.1 | `activate.wiggle` | 晃动唤醒 | ✅ |
| 6.2 | `ground.this` | 锁定 THIS 对象 | ✅ |
| 6.3 | `ground.references` | 绑定 THAT/THESE/HERE | ✅ |
| 6.4 | `text.ocr_copy` | 一步 OCR 复制到剪贴板 | ✅ |
| 6.5 | `text.ocr_clean` | OCR 清洗（去空格/规范化） | ✅ |
| 6.6 | `text.rewrite_in_place` | 原位改写（预览差异→写回→可撤销） | ✅ |
| 6.7 | `text.translate_in_place` | 原位翻译保留段落结构 | ✅ |
| 6.8 | `text.summarize_route` | 摘要/要点写入草稿 | ✅ |
| 6.9 | `entity.quick_action` | 实体快捷动作（日期/邮箱/电话/URL） | ✅ |
| 6.10 | `table.to_spreadsheet` | 表格转 Excel/CSV | ✅ |
| 6.11 | `table.merge` | 同结构多表合并 | ✅ |
| 6.12 | `chart.extract_data` | 图表数据提取 + 估计误差 | ✅ |
| 6.13 | `formula.to_latex` | 公式转 LaTeX/MathML | ✅ |
| 6.14 | `image.edit_object` | 图片对象处理（去背景/擦除） | ✅ |
| 6.15 | `image.compose` | 跨图组合/可视化 | ✅ |
| 6.16 | `image.style_transfer` | 视觉样式迁移 | ✅ |
| 6.17 | `canvas.transform` | 画布对象移动/样式 | ✅ |
| 6.18 | `calendar.create_from_screen` | 海报/邮件转日历+冲突检查 | ✅ |
| 6.19 | `map.route` | 两地点生成真实地图路线 | ✅ |
| 6.20 | `video.place_action` | 视频帧识别→订位/地图 | ✅ |
| 6.21 | `recipe.scale_and_route` | 食谱缩放+清单写入 | ✅ |
| 6.22 | `task.route` | 任务/工单路由到 GitHub/待办 | ✅ |
| 6.23 | `research.evidence_card` | 研究证据卡（文本/页码/边框/哈希） | ✅ |
| 6.24 | `agent.handoff` | Agent 现场交付（Codex/Pi/Claude/Gemini） | ✅ |
| 6.25 | `vision.prompt_bridge` | 无多模态模型视觉上下文包 | ✅ |
| 6.26 | `objects.compare` | 多文件/表格/选区比较 | ✅ |
| 6.27 | `voice.short_command` | 语音短命令绑定 Episode | ✅ |
| 6.28 | `agent.background_task` | 后台 Agent 任务+进度+接管 | ✅ |
| 6.29 | `integration.mcp` | Agent 接入兼容层（MCP） | ✅ |
| 6.30 | `governance.dashboard` | 设置与审计 Dashboard | ✅ |

### 7. Agent 集成

| # | 功能 | 现状 |
|---|---|---|
| 7.1 | Codex（`codex exec --json` + `app-server` Thread/Turn 协议） | ✅ |
| 7.2 | Pi（`@earendil-works/pi-coding-agent` SDK + `pi --mode rpc` JSONL） | ✅ |
| 7.3 | Claude Code（`claude -p` stream-json + prompt hooks） | ✅ |
| 7.4 | Gemini CLI（headless `gemini -p` + structured output） | ✅ |
| 7.5 | Cursor CLI（`cursor-agent -p --output-format stream-json`） | ✅ |
| 7.6 | OpenCode（`opencode serve` OpenAPI/SDK） | ✅ |
| 7.7 | Aider（`--message` / `--message-file`，默认关自动提交） | ✅ |
| 7.8 | Generic（用户配置命令模板，stdin/argv 模式） | ✅ |
| 7.9 | MCP stdio server（8 个 tool，按需开关） | ✅ |
| 7.10 | Agent hook bridge（Claude/Gemini/Cursor/Windsurf/OpenCode） | ✅ |
| 7.11 | 后台任务进度/暂停/接管/回执 | `agent_task_store` 后端已做，UI 待补 |
| 7.12 | ACP（Agent Client Protocol）统一会话层 | **预留，未实现** (#85) |

### 8. Dashboard（控制面）

| # | 功能 | 现状 |
|---|---|---|
| 8.1 | 通用（语言/开机启动/保持运行/更新通道） | ✅ |
| 8.2 | 唤醒与指向（灵敏度/冷却/禁用应用/校准/划线模式） | ✅ |
| 8.3 | 语音与输入（引擎/策略/语言/标点/简繁/术语库） | ✅ |
| 8.4 | 键盘快捷键（5 个全局热键可录制） | ✅ |
| 8.5 | 模型管理（增删改查/测试连接/设为默认） | ✅ |
| 8.6 | Agents（自动发现/配置/首选项/绑定会话） | ✅ |
| 8.7 | 能力与模板（Recipe 启用/目标应用/风险策略） | ✅ |
| 8.8 | 应用与捕获（浏览器 DevTools 端点/捕获策略） | ✅ |
| 8.9 | 动作与权限（默认读写策略/Recipe 覆写） | ✅ |
| 8.10 | 连接（日历/任务/GitHub/Figma/浏览器） | ✅ |
| 8.11 | 存储（捕获/制品/审计保留天数） | ✅ |
| 8.12 | 活动与审计（触发原因/对象来源/计划/验证/撤销） | ✅ |
| 8.13 | 隐私（截图上传/敏感应用/匿名统计） | ✅ |
| 8.14 | 外观（主题/动效/划线样式/胶囊参数/sweep 参数） | ✅ |
| 8.15 | 辅助功能（减弱动效/透明/高对比度） | ✅ |
| 8.16 | 诊断（平台宿主能力/延迟/误触/日志） | ✅ |
| 8.17 | 搜索设置（fuzzy match + 高亮） | **未实现** (#64) |
| 8.18 | 长短列表虚拟滚动 | **未实现** (#65) |
| 8.19 | 深浅主题切换按钮 | **未实现** (#66) |
| 8.20 | pass_through 模式可选择 | **灰掉标"待开发"** |

### 9. 安全与审计

| # | 功能 | 现状 |
|---|---|---|
| 9.1 | Electron sandbox（Dashboard/Onboarding 独立沙箱） | ✅ |
| 9.2 | CSP（所有渲染页面） | ✅ |
| 9.3 | will-navigate/window-open webview 拦截 | `security_hardening.js` |
| 9.4 | 致命崩溃保护（5 分钟内只重启一次） | `createFatalRecoveryGuard` |
| 9.5 | safeStorage 凭据加密 | `credential_store.js` |
| 9.6 | 权限范围指纹（SHA256） | `target_lease.py` |
| 9.7 | 操作预览→确认→执行→验证→撤销管线 | `engine.py` + `executor.py` |
| 9.8 | HMAC 签名计划 + 幂等键 | `OperationPlan.integrity_token` |
| 9.9 | 审计事件脱敏 | **部分**（日志有 meta，prompt 全文未脱敏 #38） |
| 9.10 | `shell: true` spawn 禁止 | ✅ 已全改 argv 数组 |
| 9.11 | openExternal scheme 白名单（http/https/mailto/tel） | ✅ |
| 9.12 | CSP 不含 `frame-ancestors` | `dashboard.html` + `onboarding.html` 已补 |
| 9.13 | safeStorage 不可用时明文提示 | **未实现** (#41) |
| 9.14 | MCP stdio token 鉴权 | **未实现** (#45) |
| 9.15 | anti-tamper 脚本 hash 启动前校验 | **未实现** (#52) |
| 9.16 | CodeQL + Semgrep | CodeQL 已配 CI，Semgrep 未配 (#54) |

### 10. CI/CD 与发布

| # | 功能 | 现状 |
|---|---|---|
| 10.1 | 统一 Release workflow（Windows + macOS arm64 + macOS x64） | `release.yml` |
| 10.2 | Windows NSIS 安装包（x64） | `electron-builder --win nsis` |
| 10.3 | macOS DMG + ZIP（arm64 + x64） | `electron-builder --mac dmg zip` |
| 10.4 | electron-updater 自动更新（delta package） | ✅ |
| 10.5 | 更新降级保护（semver 比较） | `update_manager.js` |
| 10.6 | macOS entitlements + hardenedRuntime | `packaging/entitlements.mac.plist` |
| 10.7 | NSIS 卸载时询问是否清用户数据 | `packaging/installer.nsh` |
| 10.8 | SBOM（CycloneDX npm + pip） | `sbom.yml` |
| 10.9 | Dependabot（npm + pip + github-actions） | ✅ |
| 10.10 | npm audit + pip-audit CI gate | `audit.yml` |
| 10.11 | macOS Python runtime 可重定位打包 | `prepare_python_runtime_macos.sh`（uv + CPython 3.12） |
| 10.12 | Windows Python runtime 打包 | `prepare_python_runtime.ps1` |
| 10.13 | 代码签名（Windows） | **未实现** (#2) |
| 10.14 | macOS notarize | **未实现** (#3) |
| 10.15 | Winget / Homebrew Cask 分发 | **未实现** (#12, #13) |
| 10.16 | Windows arm64 构建 | **未实现** (#61) |

### 11. 可观测性

| # | 功能 | 现状 |
|---|---|---|
| 11.1 | 结构化 JSONL 事件日志（按 5MB 滚动） | `observability.js` |
| 11.2 | crashReporter（本地保存 .dmp） | ✅ |
| 11.3 | 诊断打包（脱敏 zip） | `collect-diagnostics.js` |
| 11.4 | Python bridge 分级超时 + 取消 + 脱敏错误 | Codex 已加固 |
| 11.5 | 子进程崩溃计数 + 5min/3 次熔断 | **未实现** (#37) |
| 11.6 | 健康检查端点（Fabric bridge `--health`） | **未实现** (#35) |
| 11.7 | Sentry-lite 本地视图（错误/警告/信息过滤） | **未实现** (#39) |
| 11.8 | 匿名遥测开关（默认关） | **预留字段，无后端** (#32) |

### 12. 代码质量

| # | 功能 | 现状 |
|---|---|---|
| 12.1 | ESLint + Prettier | ✅ 配置已加 |
| 12.2 | ruff（Python lint + format） | ✅ `pyproject.toml` |
| 12.3 | pytest + coverage | ✅ `pyproject.toml` |
| 12.4 | pre-commit hooks | ✅ |
| 12.5 | `.editorconfig` | ✅ |
| 12.6 | Node 测试（54 文件 / 112 测试） | ✅ 全绿 |
| 12.7 | Python 静态 contract 测试（200+） | ✅ （部分受 Windows temp ACL 影响） |
| 12.8 | Playwright E2E | **未实现** (#94) |
| 12.9 | 性能回归基线（wiggle P50/P95） | **未实现** (#96) |
| 12.10 | main.js 3255 行单文件 | **未拆分** (#16) |
| 12.11 | dashboard.js 2417 行单文件 | **未拆分** (#17) |

---

## 二、与竞品对比：还差什么

### Google AI Pointer / Googlebook

| Google 有 | Magic Pointer 现状 | 差距 |
|---|---|---|
| 晃动光标唤醒 | ✅ 已实现 | — |
| THIS/THAT/HERE 指代 | ✅ 已实现 | — |
| 单气泡状态机（待命→声纹→转写增长→Processing） | ✅ 逐帧对齐演示 7-10 | — |
| 对象移动（跨应用拖拽） | ❌ 无 | **缺失**：无跨应用 DnD |
| PDF 摘要写入邮件 | ✅ `text.summarize_route` | — |
| 表格生成图表 | ❌ 只有提取，无生成 | **缺失**：`table.to_chart` Recipe |
| 食谱倍增 | ✅ `recipe.scale_and_route` | — |
| 便签转待办 | ✅ `task.route` | — |
| 暂停视频中餐厅转订位 | ✅ `video.place_action` | — |
| 跨图像组合 | ✅ `image.compose` | — |
| 画布对象移动/变色 | ✅ `canvas.transform` | Figma/Office 已有 |
| 语义理解多对象 | ⚠️ Codex 重写轨迹打分 | **不稳定**：仍无法准确圈选任意区域 |
| 连续多笔画同 episode | ✅ Codex 已实现 | 待实机验证 |
| 原生应用接口优先 | ✅ UIA/Office/DOM 三层 | macOS 缺 AX 选区 (#57) |

### Microsoft Click to Do / Copilot

| Microsoft 有 | Magic Pointer 现状 | 差距 |
|---|---|---|
| Win+单击 启动 | ⚠️ 靠晃动+快捷键，无 Win 键组合 | 可加，不紧急 |
| 屏幕文字 OCR 复制 | ✅ `text.ocr_copy` | — |
| 搜索/总结/改写 | ✅ Recipes 覆盖 | — |
| 邮件/Teams 发送 | ✅ Agent 路由 | — |
| Word/Excel 原位操作 | ✅ Office adapter | 仅 Word，WPS/Excel 待测 |
| 照片编辑 | ✅ `image.edit_object` | — |
| Copilot Vision（屏幕理解+高亮提示） | ❌ 无 | **缺失**：视觉 grounding 不展示用户下一步点击位置 |
| Agent Workspace（点击/输入/滚动） | ❌ 无 | **缺失**：无法模拟用户操作 |
| Windows App Actions（应用注册提供商） | ❌ 无 | **缺失**：无第三方应用插件体系 |
| Click to Do 依赖 NPU/Copilot+ PC | ✅ Magic Pointer 不要求 NPU | **优势** |
| 中国区可用 | ✅ 完全本地 | **优势** |

### Claude Code / Hermes / Pi

| 其他 Agent 有 | Magic Pointer 现状 | 差距 |
|---|---|---|
| Claude Code hooks（UserPromptSubmit） | ✅ agent_hook_bridge 对接 | — |
| Gemini hooks | ✅ 同 bridge | — |
| Pi Extension SDK | ✅ `integrations/pi/magic_pointer_extension.ts` | — |
| Codex app-server Thread/Turn/Item | ✅ `agent_gateway.py` 支持 resume | — |
| Cursor / OpenCode / Aider | ✅ 已对接 | — |
| ACP（Agent Client Protocol） | ❌ 预留未实现 | **缺失** (#85) |
| MCP SSE/HTTP transport | ❌ 仅 stdio | **缺失** (#88) |
| 本地 RAG / 记忆系统 | ❌ 无 | **缺失**：长对话历史+文件索引 |
| Git 工作区感知（自动 diff/commit） | ❌ 无 | **缺失**：Codex 式自动暂存 |

### 关键功能缺口排名（按影响用户感知）

| 优先级 | 缺口 | 说明 |
|---|---|---|
| **P0** | 划线选区不准 | 圈一行得到上一行；闪电不懂穿过多列；画任意形状无法映射到内容 |
| **P0** | 第二次激活指针不响应 | exclusive_overlay 模式下二次画线失败 |
| **P0** | Voice 不上传但识别太差 | Whisper tiny 中文 >10% CER，SenseVoice 需要下载模型 |
| **P1** | macOS 未实机验证 | native host 只有 118 行骨架，无 AX/SCK 选区 |
| **P1** | 无 E2E 测试 | 54 项 JS + 200+ Python 静态测试但无端到端黄金路径 |
| **P1** | 更新器 UI 体验差 | 错误不累计、无红点、无诊断页 |
| **P1** | 跨应用 DnD 对象移动 | Google 演示的核心能力，Magic Pointer 完全缺失 |
| **P2** | Windows/macOS 签名 | SmartScreen 警告 + Gatekeeper 拦截 |
| **P2** | Agent Workspace（模拟操作） | 只能交付对象给 Agent，不能替用户点击/输入/滚动 |
| **P2** | 第三方插件/App Actions | 无扩展体系 |
| **P3** | 长对话记忆/RAG | 每次交互独立，无跨 session 记忆 |
| **P3** | ACP 协议 | 预留未施工 |
| **P3** | MCP HTTP/SSE | 只 stdio，Web IDE 无法接入 |


## 三、当前可工作路径

即使用户即时可用（不修 bug）的端到端流程：

```
晃鼠标 → overlay 出 → 左键划线圈选文字区域 → 松开 → 气泡出现 →
语音/文字输入命令 → 回车 → Processing → 结果
```

已知可用场景：浏览器、Word、PDF、图片、Excel 表格、日历、食谱、地图路线。
已知不可用：第二次划线圈选（闪退）、任意手绘理解（圈上一行取到上一行）。
