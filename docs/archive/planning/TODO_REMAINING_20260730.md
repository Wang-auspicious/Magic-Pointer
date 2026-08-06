# Magic Pointer 未完成改进代办

生成时间: 2026-07-30
来源: `GAP_ANALYSIS_100_20260730.md` 中未落地条目

## 打包与分发

- [ ] #1 macOS 发布流水线 (workflow 已有，未实机跑过)
- [ ] #2 Windows 代码签名 (需接 Azure Trusted Signing)
- [ ] #3 macOS notarize (需 Apple Developer 账号)
- [ ] #6 asar 打包 (需改 Python bridge 资源路径)
- [ ] #8 beta channel 在 Dashboard UI (update_manager 后端已有)
- [ ] #9 minisign/GPG 签名 release 产物
- [ ] #12 Winget manifest
- [ ] #13 Homebrew Cask
- [ ] #63 pointer_input_state.ps1 编成 exe

## 代码拆分 (需 E2E 测试后做)

- [ ] #16 electron/main.js 拆 (3255行 → app/ipc/windows/updater/pointer)
- [ ] #17 electron/renderer/dashboard.js 拆 (2417行 → nav/sections/*)
- [ ] #18 app/fabric/engine.py 拆 (790行 → router/gate/audit)

## 安全

- [ ] #41 safeStorage 不可用时明文提示
- [ ] #42 Windows 凭据绑定 SID
- [ ] #44 PowerShell/VBS 脚本 hash 校验
- [ ] #45 MCP stdio token 鉴权
- [ ] #46 current-object.json 加密落盘
- [ ] #52 Python 桥 SHA256 校验
- [ ] #54 Semgrep (CodeQL 已有)

## 观测

- [ ] #32 遥测开关 Dashboard UI
- [ ] #33 更新错误红点 + 诊断页
- [ ] #34 preflight 一键修复
- [ ] #35 Fabric health check
- [ ] #38 审计敏感字段脱敏 (email/phone/URL)
- [ ] #39 Dashboard 日志过滤 (error/warn/info)

## 跨平台 / macOS

- [ ] #55 MagicPointerHost.swift 完善 (118行→完整 JSONL 流)
- [ ] #56 打包成 .app bundle
- [ ] #57 NSAccessibility 选区拉取
- [ ] #58 ScreenCaptureKit 接入
- [ ] #59 macOS CI 实机构建
- [ ] #60 Linux 路线图说明
- [ ] #62 macOS Universal binary (electron-builder 已配,未验证)

## Dashboard / UX

- [ ] #64 搜索高亮
- [ ] #65 虚拟滚动
- [ ] #66 深浅色主题切换按钮
- [ ] #67 Onboarding 复查入口
- [ ] #68 快捷键冲突检测
- [ ] #69 托盘"暂停 15/60 分钟"
- [ ] #70 按应用禁用白/黑名单 UI
- [ ] #71 多显示器 DPI 校准
- [ ] #72 键盘辅助 (WCAG)

## 语音 / OCR

- [ ] #73 Whisper 模型下载按钮 Dashboard
- [ ] #74 模型权重 SHA256 校验
- [ ] #77 中英混合分词修正 (text_normalization.py)
- [ ] #78 PaddleOCR / macOS Vision 后端
- [ ] #79 OCR 置信度过滤 (min_confidence 可调)
- [ ] #80 本地 TTS (SAPI / NSSpeechSynthesizer)

## Recipe / MCP / Agent

- [ ] #81 Recipe YAML 数据文件
- [ ] #82 关键词 YAML (中英分离)
- [ ] #84 Dry-run 模式
- [ ] #85 ACP connector
- [ ] #86 MCP tool 开关 Dashboard UI (后端已做)
- [ ] #88 MCP HTTP/SSE transport
- [ ] #90 Agent 后台任务暂停/取消 UI
- [ ] #91 结果 diff 预览

## 测试 / 性能

- [ ] #92 node --test 或 vitest 迁移
- [ ] #93 Python coverage + Codecov
- [ ] #94 Playwright E2E
- [ ] #95 静态测试 helper 复用
- [ ] #96 性能回归基线 (wiggle P50/P95)

## 文档 / 社区

- [ ] #99 README.en.md 与 README.md 对齐
- [ ] #100 conventional-commits + release-please

---

共 **62 项**代办，按"先补发布链→再拆代码→最后打磨 UX/测试"顺序推进。
