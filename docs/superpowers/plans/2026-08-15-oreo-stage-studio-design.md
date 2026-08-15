# Oreo Stage + Studio 重构设计

**日期：** 2026-08-15  
**状态：** 用户已批准（Stage 采用方案 B，同时重做 Studio 与设置）

## 1. 要解决的产品问题

1. 划线后默认应出现横向键盘输入条，而不是语音球。
2. “关闭语音”必须具有明确语义、真实落盘并立即影响下一次唤起；失败不能伪装成成功。
3. 处理与回答面板从第一次出现起保持同一外框、同一锚点；内容变化只能发生在内部滚动区。
4. Studio、Stage 与设置必须使用用户提供的 Oreo/Vida 参考图中的同一套视觉语言，不再像三个拼起来的产品。
5. 设置必须按用户心智组织，并且每个可编辑项都有真实消费方；状态、诊断和能力目录不能伪装成设置。

## 2. 总体架构

保留已经验证过的 FrameLease、selection session、bridge、DraftArtifact、权限与写回协议。替换两层用户界面：

- `StageSurface`：一个固定尺寸 Composer 和一个固定尺寸 WorkPanel。它们是两个明确表面，不再由圆球变形而来。
- `StudioShell`：Oreo 风格的三段布局（主导航、内容工作区、可选详情面板），所有页面共享相同页头、卡片、标签、按钮和输入条。
- `SettingsController`：设置读取、补丁构造、保存确认、失败回滚的唯一入口。渲染层不能直接 fire-and-forget。

## 3. Stage 几何契约

### Composer

- 正常桌面尺寸：`480 × 132 DIP`。
- 小屏时只在首次放置时钳制到 viewport；同一会话内不再因内容、模式、OCR 或选区回填改变尺寸。
- 白色近纸面、1px 中性灰边框、18px 圆角、浅双层阴影。
- 上部为对象/来源标签与单行文本输入；下部为附件、引用、可选麦克风、模型状态和黑色圆形发送键。
- 键盘和语音共用相同矩形。语音只改变内部状态，不改变外框，不出现 40px 圆球。

### WorkPanel

- 正常桌面尺寸：`560 × 520 DIP`。
- 从处理开始第一次显示就是完整尺寸；processing/result/error/follow-up/approval 全程不改变外框。
- Header 与 Footer 固定；中间 body 独立滚动。
- anchor policy 只在本会话第一次展示 WorkPanel 时选择一侧并冻结；流式文本、结果类型、轮数和内容高度不得重新选边或重算坐标。
- 只有用户拖动或显示器拓扑变化可以产生新 placement。
- 删除 406/420/560/840 内容宽度档、球形展开、scaleY 揭示、完成态再次缩放和内容驱动的 `getBoundingClientRect()` 定位。

### 状态切换

- 划线完成：直接显示完整 Composer。
- 提交：Composer 淡出；WorkPanel 以完整尺寸淡入，允许最多 2px 位移，不允许 scale/width/height 动画。
- 完成：外框不动，只替换 header 状态、body 内容和 footer 行为。
- 长内容：body 滚动；新流内容只滚动内部 viewport。

## 4. 设置的信息架构

设置只保留八个顶层页面：

1. **通用**：开机启动、关闭窗口后驻留、完成/失败通知、更新通道。
2. **交互**：唤起方式、晃动开关和灵敏度、长按阈值、侧键、默认输入方式、四个全局快捷键、禁用应用。
3. **语音**：语音输入总开关、引擎、语言、静音结束时间、自动提交、常驻模型、专有词。总开关关闭时强制默认输入为键盘、停止常驻 worker、隐藏普通入口的麦克风按钮并禁用语音快捷键。
4. **模型与 Agent**：默认模型档案、模型列表入口、首选 Agent、交付方式和会话绑定。密钥只显示凭据状态，不回显原文。
5. **感知与隐私**：默认读取方式、是否允许上传画面、应用覆盖、敏感应用、匿名使用数据。
6. **权限**：读取、写入、外发、删除/覆盖、购买五档默认策略，以及仍有效的范围授权。
7. **存储**：收藏箱目录与剪贴板行为、截图/产物/审计保留期。标签必须与真实 schema 字段一一对应。
8. **外观与辅助功能**：主题、材质、强调色、扫线高度、减少动态、减少透明、高对比控件。

“能力目录”“连接状态”“诊断”“版本信息”是只读页面或跳转入口，不混在设置表单内。不存在消费方的旧键不重新复活。

## 5. 设置保存契约

- preload 暴露 `saveFabricSettings(patch)` Promise，通过 `ipcRenderer.invoke` 获得最终结果。
- 主进程完成磁盘写入、运行时应用、快捷键注册及必要回滚后才 resolve。
- Renderer 同一时刻只允许一个 patch in-flight；控件显示保存中状态。
- 成功后以主进程返回的 canonical settings 回填整页。
- 失败时恢复上一次 canonical 值并在当前行显示错误；不能只写日志。
- 设置切换不得因为无关的语音 warm-up 或快捷键注册失败而整体静默回滚；只有受影响的设置组失败。

## 6. Studio 视觉与布局

- 使用参考图的浅纸面、黑色主按钮、发丝边框、12–20px 圆角、低对比阴影、等宽状态 eyebrow、淡紫/淡青标签。
- 去掉彩色流体头像、营销式大标题、漂浮渐变和混杂的卡片风格。
- 左栏只保留工作入口；顶部不重复导航。
- Chat 首页使用稳定的 Oreo Prompt Composer，不随文本自动增高超过既定内部高度。
- 内容页面共用 `PageHeader + Toolbar + ContentCard`；设置使用 `SettingsNav + SettingsPage + SettingsSection`。
- 所有图标来自现有本地图标精灵，不引入在线字体、远程资源或新 UI 框架。

## 7. 验收标准

- 配置文件中 `voice_enabled=false` 且 `default_input_mode=text` 时，普通唤起永远是文本 Composer。
- 设置保存失败可见、可恢复；重新打开设置显示磁盘真值。
- Stage 的 Composer 与 WorkPanel 在各自生命周期内宽高完全不随内容改变；WorkPanel 的 `left/top` 不因 progress/result 改变。
- Stage 源码和 CSS 不再包含动态 width tier、球形 expand/collapse 或完成态 shell scale。
- Studio 与设置的 DOM 静态契约、纯设置控制器、锚点策略和状态机均有自动化测试。
- Python、Node、typecheck、lint、build 全绿后升补丁版本，运行 `npm run sync` 并核对安装版版本。

