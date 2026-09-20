# Composer 控件与账户菜单交付

开发树保持 **1.0.49**。按用户本轮要求只构建和打开开发版，不 bump、不 sync、不制作或替换安装器。保留接手时的其他未提交工作。

## 本机参考来源

读取 Claude Desktop **2.110.0.0** 安装资源：`C:/Program Files/WindowsApps/Claude_2.110.0.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist/assets/v1`。安装包提供的是编译后 JS/CSS，本次没有获得未发布的原始 TS 或 source map。格式化的只读工作副本位于 `.tmp/claude-composer-reference/`。

| 资源 | 提取的行为与参数 |
| --- | --- |
| `c8e04f916-B8GvIHED.js` | EffortControl 的 220px 宽、12px padding、20px 分组间隔、文案和帮助入口 |
| `c2d9b9a76-quQlAMZB.js` | 24px 滑条容器、20px 轨道、16×20px 滑块、8px 滑块边距、10px 刻度边距、拖动缩放 |
| `c992c8428-BhYRyOF5.js` | 最高档激活的紫色颗粒着色器、4px 网格、3px 颗粒、8 组波纹、颜色和明暗参数 |
| `c360a9e1c-CcvsgZCp.js` | Code 的 Mode 菜单、effort 集成 |
| `c099c328d-CAW82TFg.js` | Code 的 Add files or photos、Add folder、Slash commands、Connectors、Plugins 菜单与 Ctrl+U |
| `shared-21-BReOo3jr.js` | 17rem 账户菜单、条件项、Language/Learn more 子菜单 |
| `shared-frame-C5qE0AlO.js` / `c6a992d55-CCAJX9iv.css` | compact 24px 控件、13/19px 主文字、11/16px 描述、40.5px 双行项、12px 面板圆角、6px 行圆角、阴影和颜色 |
| `c033f8457-CMAimhil.js` | Worktree 的 XS checkbox：20px 控件、12px 方框、6px gap、11/16px 字体；选择与创建分离 |

图标继续使用仓库已经保存的 Claude 字体资源，本次补齐帮助、语言、信息、卷轴、键盘、用量六个映射。原始 GLSL 保存在 `electron/renderer/assets/claude/effort-shaders.js`，来源标注在文件头；MP 自有的生命周期控制器在 `electron/renderer/effort_particles.ts`。这些来自本机专有产品的视觉资源，不将其宣称为开源授权素材；本批按用户授权用于本机开发版，没有进行发布或分发。

## 实际改动

- Effort 卡片 **220×111 CSS px**。保留 MP 现有五档语义；最高档启动原始颗粒效果，滑块拖动带缩放，支持方向键/Home/End。延后到卡片绘制后编译 shader，关闭、页面隐藏或 reduced-motion 时停止绘制并清理监听器。
- Mode（Accept edits）卡片实测 **244×236.5 CSS px**，五项双行均 **40.5px**，主次文字、行距、对齐和选择勾采用 compact 参数。左侧与触发按钮对齐。
- `+` 先打开 **216.52×128 CSS px** 的 Code 附件菜单，五项为 Add files or photos、Add folder、Slash commands、Add connectors、Add plugins。文件项和 Ctrl+U 调用现有文件选择器；目录项调用项目选择器；命令项保留既有命令目录；连接器、插件项打开对应设置页。
- 左下账户菜单 **272×276 CSS px**，位于页脚上方 8px、侧栏左侧 8px，32px 行高，原始图标和分隔线。当前 Gateway 上下文显示 Settings、Usage、Language、Inference configuration、Get help、View changelog、Learn more。Learn more 内含本产品 About、Documentation、Check for updates、Keyboard shortcuts；键盘导航和 Esc 关闭/返回焦点可用。Language 当前只有应用实际支持的 English。未虚构 Claude 订阅、登录或退出服务；菜单中的操作接到 MP 自身能力。
- Worktree 的 checkbox 不再直接等待 Git 创建或删除。点击立即保存布尔状态；提交时才准备工作区，已有匹配工作区直接复用。取消立即回到项目根目录，保留工作区和用户修改；取消发生在准备过程中也不会强行切回新工作区。准备失败时保持输入并显示真实错误。

## 验证与证据

先运行新增布局/交互回归观察失败：旧 effort 宽 284px、旧 Mode 行高 54px、`+` 无附件菜单、Worktree 点击即请求 Git。新增 Worktree 选择测试覆盖创建、复用、取消、准备中取消和失败，再实施生产修改。旧静态契约随明确变化更新。

- **全量 Node：238 个测试文件通过。** `data/runtime/composer-menus-20260919/node-full.log`。
- **全量 Python：2318 passed，1 failed，1 个既有 Pillow warning，344.55s。** 唯一失败仍为此前已记录的 `tests/selection_bridge_test.py::test_screen_region_enrich_falls_back_to_full_capture_without_selection_bbox`（预期 OCR 数 1、实际 0），本批没有修改感知代码。记录在同目录 `python-full.log`。
- **完整 TypeScript、ESLint、Electron 构建通过。** 最终构建包含新的 shader/controller、图标映射、样式和交互。
- `scripts/probe_composer_menus.cjs` 使用真实 Chromium 布局和鼠标/键盘输入，后端数据由夹具供给。验证卡片尺寸、菜单打开后才调用文件选择器、Learn more 子菜单、Esc 返回焦点、Worktree 点击不发 Git 请求；720×480 窗口四个菜单都在标题栏下和窗口内。通过实际截图帧比较证明颗粒随时间变化，同时验证关闭后 draw 停止及 reduced-motion 不绘制。
- `scripts/verify_composer_menus.cjs` 加载**真实 main、preload、IPC、已保存项目与模型配置**，没有替换模型/统计/会话数据。全部弹层尺寸和边界通过；实际项目上 Worktree 两次切换合计 **2.6ms**（单次观测，不是基准统计），期间不执行 Git 创建/删除。最终恢复验证前 effort、项目和 worktree 偏好，保留开发窗口打开。结果 `data/runtime/composer-menus-20260919/actual/witness.json` 和 `result.txt`，截图同目录 `effort.png`、`mode.png`、`add.png`、`account.png`。
- 原有模型菜单的 Chromium 回归再次通过：主菜单 **244×139**、四项显示与替换，More **320×216** 滚动及小窗口边界未回退。

没有调用远程模型生成，也没有为 UI 验收创建或删除实际 Git worktree；真实 Git 后端沿用现有实现，新选择/提交控制通过行为测试验证。不把 Chromium 夹具验收当作实际主进程验收；两套证据分别记录。
