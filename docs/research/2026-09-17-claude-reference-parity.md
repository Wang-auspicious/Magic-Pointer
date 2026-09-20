# Claude 参考图逐图对照审计 · 2026-09-17

第 1–6 节记录修复前的证据和实现差异，保留当时发现过程；**第 7–9 节记录随后获授权实施的状态与剩余差异，覆盖前文的待修/缺件描述**。已读取 canonical harness、STATUS 和 VIDA 规格。独立验收代理负责真实 Electron 验收，父任务负责全量验证、版本与安装同步；逐图审计不等于 47 个 Claude 运行态均已重放或像素一致。

## 1. 审计覆盖与证据边界

- `参考claude设计` 根目录 **22 张** PNG，`more` **25 张** PNG，共 **47 张用户参考图**，均通过 `view_image` 独立完整查看，未用拼图替代逐图检查。
- 另外查看 `scraped/states` 全部 **6 张**抓取状态图，以及用户当前安装版截图 `C:/Users/zjz65/AppData/Roaming/magic-pointer/stash/2026-09/0917-231927-4diaw8.png` 和剪贴板附件 `C:/Users/zjz65/AppData/Local/Temp/codex-clipboard-ff45ec59-5b70-48cc-bc6a-079d7e20c7e4.jpg`。
- 界面参考有两个版本：原始浅色 **Claude Code 桌面**（Home / Code 顶部切换、底部独立工具栏）；新增深色 **Claude web/Home**（Projects / Artifacts / Scheduled / Design / Customize 导航、统一聊天输入卡）。不能将 web 首屏的 Chat / Cowork composer 当作 Code 桌面顶部切换的同一控件。
- 原始截图证明静态外观、状态前后差异，不能证明毫秒、曲线和图标运动路径。具体数值优先使用抓取 CSS、DOM、computed、字体，不从大图物理像素直接推 CSS 像素。抓取 viewport 为 **1037×879 CSS px，DPR 2**；其他参考图和当前安装版截图的窗口宽度不同，因此不能仅凭侧栏占图比例判定宽度错误。
- `scraped/README.md` 明确：当前账号为 Free，`/code` 被付费墙阻挡。工具展开/收起、命令输出、权限、workspace、usage 等 Code 状态并未完整抓到运行时 DOM/computed。已有截图足以做视觉对照，但不得声称这些状态均已抓取。
- 已有真实字体、图标和部分组件时序；未发现 Scheduled 悬停预览插画、Artifacts 模板缩略图、Projects 空态线稿、像素宠物的独立原始素材。不得把手绘替代图或任意旋转称作原版素材/动效。

## 2. 首批必须纠正的真实差异

| 编号 | 证据与现状 | 应做的修复 | 主要文件 |
|---|---|---|---|
| F01 | `studio.html:42` 左上是 Cowork / Code；原始 Code 参考是 Home / Code。`dshw-customize` 被同时用于 Artifacts 和 Customize，但 `claude_shell.css:192` 给两行都加 `margin-bottom:18px`，在连续主导航中制造断层。主导航仍为 26px 高、13px 字、6px 圆角，与已抓取 comfortable 32px/14px/8px 不符。 | 统一主导航结构和密度，间隔只放在导航组与项目组之间；按模式正确标注 Home / Code，避免把所有导航行当作独立 Customize 分组。 | `studio.html`、`claude_shell.css` |
| F02 | New 已换字体 glyph，但圆底样式只匹配 `svg`（shell:169）；字体 small 默认 533.3，而原 New 是 16px/700，外圆 22px。 | 给 New 独立 leading circle 和正确字重，不继续依赖 SVG 选择器。 | `studio.html`、`claude_shell.css`、`cds_icons.css` |
| F03 | 收起侧栏及窗口≤1020px 时，shell:2904–2905、2950–2951 隐藏所有 `span`；New、Artifacts、Customize 的真实字形本身也是 span，连图标一并消失。 | 给文字标签明确 class，只隐藏标签；保留图标 leading slot。两种收起入口都修复。 | `claude_shell.css`、`studio.html` |
| F04 | 47 图显示 More→Edit sidebar、Projects、Scheduled、Design、Customize 的独立页面。当前主导航只有 New / Artifacts / Customize；Customize 实际 `data-goto=settings` 打开设置弹窗。 | 补齐用户可达的信息架构。已有能力用真实数据；缺少服务的页面明确展示真实能力边界，不能点击无响应，更不能把设置弹窗冒充 Customize 三标签页。 | `studio.html`、shell routing、`studio.ts` |
| F05 | Artifact toolbar 只有 All / Mine；Mine 实现用 `Boolean(artifactId)` 区分来源，不代表所有权。菜单没有类型 glyph 和选择勾；list/grid 切换只改变 title/aria，SVG 始终 `ic-layout-grid`。 | 改正 scope 的语义，类型映射到实际产物；菜单加真实 glyph/选择态；网格态显示 list 图标。无共享契约时不要伪造 Shared with you 数据。 | `studio.ts:2108–2380`、`studio.html:399`、`studio_artifacts.css` |
| F06 | Artifact grid 只是小文本行加边框，缺少参考的大预览、左下重叠类型块、标题下时间/可见性；list 缺少行尾操作，使用“来源 · revision”实现细节。 | 从现有可读产物取得真正缩略预览，文档/代码用实际内容节选；主元信息呈现用户可理解的时间、来源，revision 留到细节；列表/网格均提供真实可执行操作。 | 同 F05；产物数据读取契约 |
| F07 | 图标字体有真实变形轴，但目前 `cds_icons.css` 只实现静态字形。字体元数据直接读得 `wght 400..700`、`opsz 12..32`、`ANIM 0..100`、`ANM2 0..100`。 | 对确有变形轴的 glyph 使用原字体轴实现 hover/focus，而不是任意 SVG/rotate。时序取已有组件 token；尚未抓到 JS 触发时不得声称逐毫秒一致。 | `cds_icons.css`、`cds_icons.ts` |
| F08 | 侧栏项目/会话分组已有 workspace grouping，但新增图的 Group & sort 五类子菜单、会话固定/重命名/归档/移动项目、View all 页面并未完整对应。 | 已有 store 操作接入菜单；筛选/排序由真实会话字段派生；没有持久化契约的操作先落实持久化，不能仅改 DOM。 | 侧栏 renderer、conversation store、shell views |
| F09 | 两张当前截图能证明某次 timeline 弹出菜单遮在正文左边，不能证明永远展开；`claude_chat.css:1090` 已正确规定 hover/focus-within 才显示。 | 验收分别拍指针/焦点移开及 hover 两态，若退不回去才修事件/焦点。不要删除已正确的 hover 规则或把完整菜单设常驻。 | `claude_chat.css`、conversation rail |

## 3. 原始 22 张逐图记录

下列路径相对于 `参考claude设计/`。每一行均对应一次单独的完整图片查看。“应核对/补齐”表示本次读图确定的对应状态，不等于当前状态已在安装版验收通过。

| # | 文件 | 逐图可见细节 | 当前差异与具体修复/验收 |
|---|---|---|---|
| 01 | `008952ba378233c3b5743d61fb3f2714.png` | 浅色完整 Code 工作页；Home / Code；New / Artifacts / Customize / More 连续导航。header 左有电脑图标、标题、project badge，右有 terminal/file/globe/more。右靠灰 user bubble；选中文字浮出 Start a side chat / Reply；Bash 命令边框卡、着色命令、独立输出区和内部滚动。底部 clay 状态点、耗时/token、仓库 PR 托盘、独立输入工具条。 | F01–F04；header 当前缺电脑标记且 preview 是 play 图标，应使用语义匹配的真实 glyph。命令、输出、错误须按真实 tool event 渲染。repo 状态仅显示实际仓库和 PR 信息。 |
| 02 | `0ebc30307d5bdd63047706c28b0e5bac.png` | 折叠 Ran 3 commands (1 failed) 与展开 Ran 3 commands 同屏；展开内部行分隔而非每行大卡；文件蓝链接、行内代码淡红底；表格浅灰表头和细格线；底部渐隐托住输入框。 | 展开/折叠分别验收；失败数字不能被成功图标覆盖。Markdown table、inline code、file link 跟随参考紧凑密度，不把所有工具输出包成多层卡。 |
| 03 | `0f55eeaf1db0ed95e6725d5f6403ada9.png` | 正文宽度内的 monospace 代码块，右上 copy；段落间插入紧凑工具摘要；底部耗时 31m56s、token 9.6k、1 running task、Running tools 与 clay spark。 | 运行状态必须来自事件并持续更新，不能长任务静止空白；已存在 stream 支持不等于本次截图链路验收。统计不存在时留空，不写固定演示数值。 |
| 04 | `23227019c3e913809a7daf87b67d3117.png` | 白色设置 modal、柔灰 backdrop；左分类带图标和 search，左右独立滚动；蓝 switch；Code appearance light/dark 两预览；字体输入/分段选择及 Small/Medium/Large transcript。 | 当前设置分类为 MP 数据，保留真实语义；复用真实36×20 switch、选中/焦点、预览卡结构。滚动应在对话框内容区而非整页穿透。 |
| 05 | `3279088351cc53e2e145c151d43b6d9c.png` | user 消息 hover 工具含 timestamp/copy/rewind/branch；工具摘要 success/failed、绿色/粉色 diff counts；紧凑 artifact 行图标/标题/chevron，正文蓝 artifact 链接；表格。 | hover action 时序已在 tokens/chat CSS 实现，保留；逐项验证实际可点。diff 和产物摘要应映射 runtime 原始数值/ID，不能仅做假卡。 |
| 06 | `3b8123aff3359fd788d838035d01c62d.png` | 白色 account popover；灰 email header，settings/Language/Help、分隔、Upgrade/Get apps/changelog/Learn more、分隔 Logout；底部头像首字母/name·plan、chevron、theme 控件。 | MP account 当前 spark 与硬编码账户文案不等于该账户结构。可复刻分组、图标、间距，内容必须真实；没有 Claude 订阅不要显示 Pro/Upgrade。 |
| 07 | `4096fdd520825d1ff28904c33d8e850a.png` | 独立 Effort / High / help popover；Faster–Smarter 两端标签，离散刻度 slider，白 thumb、浅灰轨道；触发 High 有 hover 底。 | 这是 Code slider，不是新 web 的竖向菜单。滑块档位依实际模型支持；五档文字由 scraped 新 web 图确认，但不能靠这张小图目测刻度数声称相同实现。 |
| 08 | `5b956d23a7c05eea13a0a395c95cbf23.png` | Skills 设置页 search/Add 下拉；Your skills/Discover；Filter/Sort Last edited；Anthropic & Partners 和 marketplace 分组；方图标、title/作者desc、日期/ellipsis，hover 行灰底。 | 当前 directory 为 skills/commands，并非完整 Skills catalog。已有 local skills 可按此列表布局展示真实名称/描述/更新时间；安装/来源信息不可编造。 |
| 09 | `7634e7ae9fd622a1bb5df46b702c7df2.png` | 正文左上仅两短横 timeline marks；发布 artifact 两层卡，第一行 Open，第二行 globe/文件名/diff/chevron；“Edited file +17 -5”夹在正文；蓝 artifact badge。 | F09；产物卡需要区分可打开产物与纯事件，不可所有行都跳空白页面；修改统计取实际 diff。 |
| 10 | `8e18d59aa3fccb66050f2e31b85498c8.png` | 多工具栈，展开 PowerShell 语法命令白边框；灰 stdout 在下方独立区域，含403失败；Ran skill /artifact-design 的参数和结果分层；spark + Almost done thinking。 | 输出/错误分层、长输出内部滚动；不能成功动画掩盖403。skill 名、参数、返回必须分开显示。 |
| 11 | `9c7549c72b5469a83ee32a0ed8e6f5ce.png` | Model 菜单 Fable credit badge，Opus 蓝勾，Sonnet/Haiku 和数字热键，More models 子菜单，Fast mode 单独 switch。 | 真实 provider catalog 应决定选项和能力；复用 row/check/submenu/switch 外观，不抄不适用模型、credit/计费或热键。 |
| 12 | `这个图看看输入框里的这种预测话.png` | 完成回答与 artifact card、消息 actions；输入框内是灰色建议追问“01和07各给我一版完整的intro第一段差异句”，左有 caret，右有 return 提交。 | 需要区分 suggestion 与用户真实输入；接受后变成可编辑 draft，再按提交动作发送；不要硬编码参考问题，也不要将 placeholder 当作用户已写内容。 |
| 13 | `adc89e0c-7b7e-47f4-a883-130016f51011.png` | Onboarding 白底、居中 clay spark、衬线 Claude for Windows 和灰副标题、底部宽黑 Get started。 | 可取版式层级，但 MP 品牌和真实启动/配置流程必须保留。现有 boot/loading 与引导不是同一页面。 |
| 14 | `b3eff37de8b9c5d52bef56b17de5bfdf.png` | Context window 66.6k / 1M 7%，多色上下文条；5h/week 计划条和 reset 时间，底部 detailed breakdown。 | 已有 MP 上下文多色 token 可用。计划限额、重置时间只有实际 provider 数据可展示，不能把 Claude 账户配额映射到本地 Gateway。 |
| 15 | `bb0757aa18f82b069a575afb4eb23760.png` | Code attach 菜单五行：文件照片 CtrlU、folder、slash commands、Connectors 子菜单、Plugins 子菜单；leading 图标一致。 | 支持能力应分别接文件/目录选择和实际 slash/connector/plugin 数据。注意与新 web attach 图菜单不同，不能把两套同名合并成重复项。 |
| 16 | `bfd5a38fbcbd9e553a37168e422f39bf.png` | Mode 菜单 Auto/start badge/check、Manual、Accept edits、Plan；Bypass permissions 单独 Enable；每项副解释。 | MP 现权限模式不是 Claude Auto 语义。外观可对齐，但不得将 manual 仅改名 Auto；权限需真实 runtime 策略和已有审批链。 |
| 17 | `c4d8502e10c8a6c1271dbe79c372951c.png` | Plugins 设置列表，repository chip；marketplace 分组、plugin 图标/title/desc/date/ellipsis；与 Skills 同骨架。 | Customize 顶层 Plugins 与设置 Plugins 可复用数据，当前 skills/commands directory 不能冒充已安装 plugins。 |
| 18 | `eabc25b0a8110de03431a0b12a0875af.png` | timeline hover 白色浮层两行：选中 Session start、一个正文 heading；leading 短横、选中浅灰，菜单锚在正文左侧。 | CSS 已有隐藏和 hover/focus，正确；验收两态的 marks、宽度、内容 anchor 跳转即可，不能总展开。 |
| 19 | `fa6ab1df0f39bab85c000cdc04a939b8.png` | 失败工具 red Failed to fetch/search，URL 灰；展开失败红原因与灰 mono 参数；成功工具行灰+caret；PowerShell syntax。 | 失败颜色限定状态/错误，不把整张输出刷红；真实 errors 要出现在展开区和摘要，success 不应从“请求发出”推断。 |
| 20 | `ScreenShot_2026-09-16_151751_645.png` | Code 首页 spark/What's up next；Overview/Models、All/30d/7d；六指标和活动 heatmap；What's new 右上。底部 Local/workspace/branch/worktree/folder+ chips；workspace 菜单 No folder/Recent projects/check/Open folder。 | 当前已有 overview/heatmap 骨架，指标应来自真实任务与使用数据。workspace popover 状态、chip 与下方输入框关系需实机验证。 |
| 21 | `ScreenShot_2026-09-16_151821_052.png` | Branch popover main 选中蓝勾，分支文本列表、底部搜索蓝focus；branch chip 内联 worktree checkbox。 | branch 数据和 worktree 状态需要真实 git/工作目录同步；不要为了参考图虚构分支；搜索/键盘focus布局同参考。 |
| 22 | `ScreenShot_2026-09-16_152025_757.png` | 长文输入自动增高到约六行；chips 在上、工具行在下；右下 return icon，右上像素宠物；参考无常驻 @ 按钮。 | composer autoheight 与滚动边界、提交图标及外围间距需对齐。宠物原始素材/动画未抓取，列为缺件，不能手绘后称完全复刻。 |

## 4. 新增 `more/` 25 张逐图记录

| # | 文件（均在 `more/`） | 逐图可见细节 | 当前差异与具体修复/验收 |
|---|---|---|---|
| 23 | `04089e8953e99d84efbf0ad6e81df3e6.png` | Scheduled 的 Meeting prep hover；浅底高亮，leading 从 calendar 变 plus；右下浮出倾斜 Product review 预览。 | Scheduled 页面尚缺；hover 前后 glyph 替换可证明，倾斜预览素材和时序未抓取。不能用普通 tooltip 充当预览卡。 |
| 24 | `1c19772af2397ca4bcac0c65fab5ee8c.png` | 深色 web chat：assistant 衬线正文、user bubble 无衬线；7 个数字圆点的步骤卡，当前蓝点，View all steps / Next。 | 这是交互产物/消息 renderer，Markdown 表格不等价；只有真实 step 数据时显示可执行卡。web Chat 字体选择不应无条件覆盖 Code 字体。 |
| 25 | `1ddc9cb282c61010942549dca9c4e710.png` | Projects 空态；衬线标题，Your projects/Organization/Shared with you，search/sort/New project；中间线稿和空态文案。侧栏 New/Projects/Artifacts/Scheduled/Design/Customize/More；Artifacts hover 露 plus。 | 独立 Projects route 缺失；本地工作区可成为真实项目来源，组织/分享需明确能力。导航 trailing action 应仅 hover/focus 显示，不能常驻挤压字。 |
| 26 | `20f0088640af369d041f69e41acac9bb.png` | Customize 主页面，Skills/Connectors/Plugins 顶层；Plugins 内 Yours/Discover；空态 Discover plugins banner 和右侧线稿。 | 当前 Customize→Settings 完全不是该页面；需真实 plugin 清单/入口和标签状态。banner 插画缺原件，不能声称原版像素一致。 |
| 27 | `301942dfe00a48bdb9161d1c1b3c32e1.png` | Artifacts All types 菜单：All types 右勾；Slides 0 黄色glyph、Design 2 紫glyph、Design system 0 蓝glyph、Other 17；数字右齐；toolbar search/grid在左。 | F05；当前菜单只有文本计数、无 glyph/check。按真实 MP 产物类型分类，不把任意文件称 Slides；允许零计数类型但必须有稳定类型定义。 |
| 28 | `3d9c8a0666e3f8badba65b66abb10bd1.png` | Web 图片搜索结果：左大图+右两小图、窄缝、外角圆、原站watermark、Results from web；衬线回答；统一深色输入框 model/effort/mic/voice。 | 需要多模态结果按实际图片来源呈现，不能把 image URLs 当纯代码；界面不应编造来源。与 Code composer 模式分别验收。 |
| 29 | `435a8950a3885cf7b8afc1c629fa5e53.png` | Chats 分组菜单 Type 子菜单：All 勾选、Chat、Task；子菜单锚在父行右侧。 | 当前侧栏分组没有完整筛选链；类型来自实际 conversation/run 数据，左移/右移防溢出和父行高亮要一并实现。 |
| 30 | `45d1f3315b7594727d64d55bd65c7485.png` | Customize→Connectors→Yours；All/Connected/Not connected；表格 Connector/Type/Authorization/Status；品牌logo、Web/Custom badge、Individual、绿色连接态/Connect/Reconnect warning。 | 现 slash skills/commands 目录不能表示 connector 状态。若本地有 adapters/connector 配置，应读真实连接状态；不能把“已配置”直接写“已连接”。 |
| 31 | `5d3664dfe44c5c4c30545c3074081a44.png` | Skills→Discover；两列 cards，图标/name/desc/author/install count/+；Browse categories 三列线稿tiles与计数。 | MP 当前 skill 搜索数据能支撑列表，但类别/安装数需真实来源；不抄演示热门数字。category插画未抓取。 |
| 32 | `6220b54da28901728417c50052d08f2a.png` | 左上近景：More hover，右侧 Edit sidebar… pencil popover；主导航密度统一；Customize 选中底、More hover底和downchevron。 | F01/F04；此图是最直接的左上验收样本。先修行高/leading slot/间隙/真实字体，再补 More 和可持久化的导航编辑，不只更换三个 icon。 |
| 33 | `68bdf835a7adc7c67614b9c824c913e5.png` | Group by 子菜单 Date/Type/Unread/State/Custom groups、分隔、None 勾选。 | 筛选/分组状态要驱动当前同一会话集合；未读没有真实字段时不能伪造。自定义组需要持久保存而非刷新丢失。 |
| 34 | `6d2db4445cff04d8d3d39a90ec0d3a56.png` | Scheduled tasks 衬线标题，search、Sort by Next run、New task 下拉；stopwatch线稿No scheduled tasks；波浪分割线；六建议两列，含 clock schedule副文。 | 新页面/空态/建议入口均缺。只有确有调度执行器时创建 recurring task；可复用产品已支持的任务模板，不能显示明日运行但后台不执行。 |
| 35 | `856da7f22fa4daebe47eff644171bc88.png` | Sort by 子菜单 Name/Date created/Last activity 勾选。 | 名称、创建时间、最后活动字段应各自独立，不能createdAt复用所有排序。选择后菜单和列表立即一致。 |
| 36 | `87880354d6e5164d299b3237b225b5ac.png` | Chats and tasks 全列表页，衬线标题，search/filter/Select/New；flat rows/date右对齐/细分隔；侧栏标题hover露 View all 斜箭头tooltip。 | 独立列表页应从全部真实会话派生，不能只扩大当前sidebar列表；Select 必须有对应操作，否则不要空按钮。 |
| 37 | `90602ea8c29fc26dc692df4ac1dce3b3.png` | Pinned row hover ellipsis；菜单 Unpin P/Rename R/Change project/Remove from project、分隔、Move up/down、分隔、Delete D 红；Pinned里项目和会话可混排。 | 必须复用真实 pin/order/project 删除接口并保持上下文对象；只有本地项删除不等于删源文件。菜单结构、快捷键提示需和实际监听相符。 |
| 38 | `97bbd77369fdabbe0bb3457985c7cf87.png` | 普通chat菜单 Pin/Rename/Add to project/Move to group/Delete；Add to project 子菜单 search/create、No projects yet、Start new project。 | 新项目入口不能悬空；移动会话归属后 sidebar/page/header 都更新，并持久保存。无项目空态展示本机真实状态。 |
| 39 | `a4972153efb53fabbd7d5732c08744ce.png` | Design 页面，Designs/Design systems 标签、search/grid；迁移公告；Make something new Slides/Design/Design system 三张图；按日期列表。 | 现 Cowork/design overview 与该 Design library 不是同一页；真实 design artifacts 可汇聚。Claude 迁移公告与产品不符应删，不应为“看起来一样”复制假历史。 |
| 40 | `a9bc66c2d66817ff5ba67b005290f3c2.png` | Group & sort 主菜单 Type All / Status Active / Last activity All，分隔，Group by None / Sort by Last activity；当前值右齐并带子菜单箭头。 | 主菜单状态从统一对象渲染；不能每个子菜单各存一个不互通的 DOM 状态；5项都需相应数据行为。 |
| 41 | `e178369c211a5fd9330a27417326f2ee.png` | Artifacts list：衬线标题；All/Yours/Shared with you；search/grid/All types；公告；Make Docs/Slides/Design 预览tiles；Yesterday/Sep13/Sep11 分组，方图标/name、lock/time/ellipsis。 | F05/F06；现有日期分组方向正确；缺的创建入口应产出MP真实任务/产物，列表操作和可见性数据应真实。共享不存在不可显示假lock/share元信息。 |
| 42 | `e24afad9d8054c78737ae499c67aae92.png` | Last activity 子菜单 1/3/7/30 days/All，All check。 | 时间过滤使用统一当前时刻/真实lastactivity；All真正清除该过滤而不清除其他筛选。 |
| 43 | `ef9df46faffbf08237b57f1e848cd2cf.png` | Artifacts grid：toolbar 的布局键变成 **list glyph**；三列大内容预览，左下重叠类型块，标题、time/lock。 | 当前按钮不变和纯文本grid均为确定差异；新增实际预览及稳定卡片高度，标题截断不应截掉可辨识文件名。 |
| 44 | `f1bcf6a95d4b263838a7df0df6a1f2dc.png` | Status 子菜单 Active check / Archived / All。 | store 若只有删除没有archive，先实现真实archive语义；不可把done任务误判Archived。 |
| 45 | `f1ce72c8f1e9c367982a45a77b14c29f.png` | Scheduled New task菜单 Create with Claude 对话glyph / Set up manually gear。 | MP 可对应“与 Agent 创建/手动设置”，两个入口必须走同一可验证调度契约；不写Claude品牌替代本产品Agent。 |
| 46 | `f5ef7d43d674538cab661c6bba2f9f82.png` | Connectors Discover directory：breadcrumb、search/Filter All；Your custom connectors 两列；Top connectors品牌cards，已装绿色勾、warning/reconnect、plus。 | directory与Yours状态联动；第三方品牌资产/供应商协议缺失需记录，不用任意emoji冒充。连接按钮必须可产生实际连接/错误。 |
| 47 | `fc2a13830d8e2ae06fb06820b022c60a.png` | Skills Discover category 大滚动popover，All category check；绿色Data feature banner、New cards；右上筛选触发器。 | 类别过滤与search组合；菜单有受限高度、内部scroll和勾选态。banner内容应来自真实已安装/可用目录，缺原图暂不能原版还原。 |

## 5. 六张本地抓取状态与原始参数来源

| 文件（`scraped/states/`） | 已逐图确认 | 可直接采用 / 限制 |
|---|---|---|
| `home-new-chat.png` | 深色 web 免费账号，288px sidebar；New/Projects/Artifacts/Code Upgrade/Customize；衬线问候、spark、统一大composer、Chat/Cowork内部分段、五提示pills。 | icon/颜色/字体/row tokens可信；不可将这个首页强行覆盖Code工作台。 |
| `popover-model.png` | model大菜单含副说明、选择态、账户相关badge。 | 菜单几何可信；模型、权限、价格受账号限制不能复制为MP事实。 |
| `popover-effort.png` | Low / Medium / High Default / Extra / Max 五档；Max usage badge。 | 可证明档名/字重/间距；不能证明MP provider支持五档或1.5×计费。 |
| `popover-attach.png` | 文件照片、screenshot、Add to project、Skills/Connectors/Design system/Plugins、Web search/Memory勾选等新web菜单。 | glyph/分组/行高可复用；缺少实际服务不要“开关已开启”冒充可用。 |
| `popover-account.png` | emailheader和三组菜单，Settings/Language/Help/Get apps/Learn more/Logout。 | 结构和真实glyph；审计不抄个人邮箱，也不把该账户用于MP。 |
| `settings-dialog.png` | 深色 web preferences，Theme三按钮、Anthropic Serif chatfont、Motion System/Reduced；Voice Language/Style/Speed、Notificationsswitch。 | 真实motion偏好可落实；功能存在才显示配置项，不能做无效控件。 |

### 参数取值表

| 组件 | 已抓取值 | 本地原始来源 |
|---|---|---|
| Sidebar | 288px；comfortable row 32px，padding 0 2px，gap8px，font14/21，radius8；leading slot28px，glyph20px；control24px；header48px。group label12px/500，group top16px(web)/14px(desktop)，后续组margin-top14px。 | `scraped/css/computed.json` 的 `sidebar.root/row/groupLabel`；`css/vendor/shared-styles-e78wt03W.css` 的 `.dframe-sidebar[data-density=comfortable]`。 |
| New | 22px circle /16px glyph /700；circle 背景text-muted15%，hover25%；web浅/深有专属neutral。 | 同vendor `.df-new-circle` 及后续 hover selector；`icons/manifest.json` `new-chat`。当前shell只匹配SVG是落差。 |
| Sidebar hover | 快 .12s、慢 .3s、`cubic-bezier(.32,.72,0,1)`；深色 hover白7.5%、selected白15%；web sidebar右界0.5px白10%。 | `computed.json` sidebar vars；tokens.json；shared-styles vendor。 |
| 字体图标 | 大20px/433.3，小16px/533.3，micro12px/577.8；字体范围400–700；new为small700特殊值。 | `icons/manifest.json`、`fonts/Anthropicons-Variable.woff2`。manifest有41个font用途映射，4个独立SVG；整个字体310glyph，而非只有41图标。 |
| Composer editor | 16px/22px，variation wght360，padding5px 0 5px8px；min54/max384；opacity/padding .2s；外层tokenradius .875rem=14px。 | `computed.json` composer；注意 editor自身radius0，不能误读为composer无圆角。 |
| Send | 32×32，radius8，disabled opacity.4；glyph20px/433.3。 | 同computed。 |
| Segment | 高28px，padding1px，radius7px；thumb var10%白；桌面pill label470。 | computed + targeted `.df-pill-label/.df-pill-indicator`。 |
| Popover | item padding6px 10px 7px 10px、gap8、radius8、font14/20；有副说明的model行高度50px。 | computed `popover.menuItem`。不能将50px套到无副说明的类型菜单。 |
| Switch | 36×20、padding2、白16px knob。 | computed。 |
| 消息action显隐 | in .12s +delay .1s；out60ms +delay0；曲线(.32,.72,0,1)；focus进入无delay；scale为none。 | targeted第1–15行及vendor原始MessageActions规则。现MP tokens/chat CSS已有该时序。 |
| Voice glyph ripple | .55s ease，一次；各bar scaleY，27.273%处乘(.966×ripple增量)，100%回1；reducedmotion取消。 | `icons/voice-activity.svg` + targeted18–27行。这是voice指定效果，不是全局icon hover规范。 |
| Timeline状态 | enter.25s，exit.15s；spark depart.42s；quiet enter.24s cubic(.3,.7,.4,1) translateY6；expand.2s cubic(.19,1,.22,1) rows0→1；三点3px、周期1.9s、错峰.15/.3s。 | targeted31–54行及vendor。共有样式抓到不等于Code对应状态已实机抓到。 |

### 原始字体确实包含图标变形，不能只做静态字形

用 fontTools 只读本地 `fvar` / `gvar` 得到：

```text
wght 400..700 (default400)
opsz 12..32 (default20)
ANIM 0..100 (default0)
ANM2 0..100 (default0)

U+E001 New:       wght
U+E017 Artifacts: ANIM, wght
U+E100 Customize: ANIM, wght
U+E0C9 Projects:  ANIM, wght
U+E043 Scheduled:wght
U+E048 Code:      ANIM, ANM2, wght
U+E0B8 Design:    ANIM, wght
U+E0D3 Search:    wght
```

主vendor存在 `[data-cds=Icon]:not(svg):not([data-cds-anim]) { font-variation-settings:normal }`，明确为动态图标留下variation控制。因此 Artifacts/Customize/Projects/Design 可以使用原字体ANIM轴，Code还可使用ANM2；New/Scheduled/Search没有ANIM不能凭空宣称具有同类字形变换。现有 `cds_icons.css` 未设置ANIM/ANM2，完整动效并未接入。

抓取没有组件JS与鼠标进入全过程，无法从这些静态文件证明每个图标的原版触发、回弹、循环和持续时间。可以使用真实字体路径及已抓取120ms/300ms easing token作有来源的实现，但须记录这是“原始字形 + 本地交互接线”，不写成“原版每个动画完全抓取”。vendor内也有artifact-block hover scale1.035/±0.065rad/duration400ms等utility；没有对应DOM时不能把它任意套在所有Artifacts导航icon上。

## 6. 分批实施建议与所有权

1. **可独立立即修的视觉底座**：`studio.html`、`claude_shell.css`、`cds_icons.css/ts`。处理 F01–F04 的入口、密度、New circle、收起图标，以及原始字体轴的 hover/focus/reduced-motion。不要修改其他代理已有 `icons.ts` 六行变更。
2. **Artifacts 单独代码区块**：`studio.ts:2108–2380`、`studio_artifacts.css` 和对应HTML；处理 F05/F06、layout状态glyph、类型菜单、真实preview和列表行操作。先和负责conversation的代理约定区块，避免同文件覆盖。新增预览不能在 renderer 随意拼任意文件路径，应使用已有产物读取/open能力。
3. **独立页面与侧栏行为**：Projects、Scheduled、Customize/Skills/Connectors/Plugins、Chats and tasks、Design libraries。按现有store/runtime能力逐项接通；这些是47图真实呈现的差异，不能把本轮只改三图标描述为“全量还原”。缺少真实调度/连接/共享契约时明确列剩余实现项。
4. **会话链路由父任务/共享renderer代理负责**：真实思考/工具/错误/产物事件、输入预测建议、响应过程、长期运行状态；对应图01–03、05、09–12、18–19、22、24、28。避免审计代理在同一流渲染逻辑并行编辑。
5. **安装版验收**：父任务完成全量Python/Node/typecheck、版本自增和npm sync后，在真实应用查看侧栏正常/收起，Artifacts列表/网格/类型菜单，Customize三标签，More/分组子菜单，消息hover、失败工具展开、输入建议接受和长文框。当前审计没有运行生产UI，不能把源码检查写成这些状态已经通过。

验证目标必须具体：收起侧栏验证glyph没有被隐藏；布局切换验证图标和内容布局同步；hover验证原字体轴变化且reduced-motion静止；产物preview验证显示的是打开的同一真实产物；菜单验证筛选/排序数据真的变化并可恢复。纯文档审计不运行全量测试，避免无关开销。

## 7. 2026-09-18 实施、素材补齐与验收边界

### 新发现的一手资源修正早期缺件结论

机器上已安装 Claude 2.110.0.0 的 `C:/Program Files/WindowsApps/Claude_2.110.0.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist/assets/v1/` 含完整组件包。采集代理保存到 `参考claude设计/scraped/extras/desktop-2.110.0.0/`，原始路径、完整 vendor 及提取方法均保留。此发现**不解除 `/code` 账号运行态访问限制**，但已补齐本轮如下原始素材和时序，不应继续将它们描述为缺件：

- `HandBlocks.svg`（Projects）、`HandShapes.svg`（Artifacts）、`ObjectStopwatch.svg`（Scheduled）。生产使用机械提取的原始 SVG 路径，内联继承 `currentColor` 与浅/深 highlight `#e7e6e1/#454442`。
- `icon-animation.original.css` + `icon-component.original.js.txt` 给出确切 hover/focus/active 时序。支持 ANIM 的字体 glyph 使用默认 300ms、`cubic-bezier(.34,1.3,.64,1)`；Palette 800ms ease-out/退出 0ms；Code ANM2 1s linear、100ms delay 的方波循环。按下 ANIM 回 0、80ms，并停止循环。系统或产品 reduced motion 禁止动画。New/Search/Scheduled 没有该变形轴，因此不编造同类动画。
- Scheduled 六张 hover 微预览本身是原组件 DOM，不是 PNG：按原 `Za/eo/to/no/ro/io/ao` 内容转译，128×64、bottom -20/right 12、3°、translateY 8→0、opacity 0→1、150ms ease-out，36px leading icon 与 Add 同格切换。示意文案为 aria-hidden starter illustration，未作为真实任务结果。
- Artifacts/Design 的 Docs、Slides、Design、Design system 由原 `_t/yt/Tt/At` 组件机械生成 HTML，原 `et/it/lt` WAAPI 关键帧原样保留，周期分别 9000/7000/8400ms。原 122 个 utility class 全部取得对应 CSS（提取缺失数 0），局部作用域前缀避免污染界面。原父组件 `gn` 的 136×96、13% hue 背景、12px radius、6px 纵向 gap、hover shadow、active .98 已接入。非触屏 hover/键盘可见焦点后延迟 150ms 开始，退出 cancel，reduced motion 不开始；Design system 原版静态。

生产资源为 `electron/renderer/assets/claude-reference/`；提取器、class coverage 与完整源文件在上述 extras 目录。不是手绘近似，不依赖 Claude 账户或外部网络请求。动画轨道测试验证每个 `part` 确实对应提取 HTML 中的实际节点。

### 本次实现状态

| 原问题 | 已落地的实现 | 数据/行为边界 |
|---|---|---|
| F01–F03 | Home/Code；连续 32px/14px/8px 主导航；22px New circle、16px/700 glyph；只隐藏 `.mp-nav-label` 的手动与窄窗折叠。 | 使用真实 Anthropicons；没有修改其他代理预先存在的 `icons.ts` 六行变更。 |
| F04 | Projects、Scheduled、Design、Customize、Chats 独立 route/view；More→Edit sidebar，隐藏导航仍可从 More 打开，偏好持久保存。 | Settings 保留原应用菜单/账户入口，Customize 不再冒充设置。 |
| F05 | Artifacts 类型 glyph/check、列表/网格按钮随布局切换字形，列表 ellipsis 菜单，scope 改成真实“可编辑草稿”。 | 不伪造 Mine 所有权、共享用户/锁/共享列表。原有 artifactId 的真实草稿才进入可编辑筛选。 |
| F06 | 网格大预览+重叠类型块+时间；真实产物内容节选按 ID/revision 缓存；真实打开产物/来源会话；Docs/Slides/Design 原版动画模板。 | 创建模板将明确的可编辑需求放入 MP 输入框；不自动提交，也不假称已创建内容。预览使用既有 readArtifact 契约；富格式工具专用渲染器不在此处伪造。 |
| F07 | 真实字体轴、原始时序、active/hover/focus/reduced motion；机械提取 SVG 与组件缩略图。 | 字体中不支持动画的 glyph 保持静态；不是全部 310 字形都已用于 UI。 |
| F08 | Type/Status/Last activity/Group by/Sort by 五类子菜单；名称/创建时间/活动时间排序；Pinned 上下移动；Rename/Change project/Move group/Archive/Delete；View all 真实会话列表。 | pin/archive/custom group/order 持久存为本机组织偏好；archive 不把完成任务当删除。改项目使用 main/store `conversations:set-project({id,root})`，活动任务不能换项目。 |
| Projects | 原空态线稿；真实已注册文件夹卡片、会话数；New project 调原生目录选择并注册。 | 不生成虚构云项目或合作者。 |
| Scheduled | 原空态线稿、六种原微预览、New task 菜单与可编辑配置；真实本地材料源；create/list/pause/resume/remove。 | 本轮契约为每天一次、首次创建后一天、应用需保持运行、输出 DraftArtifact 且不自动写回；没有宣称支持任意 cron 或云端运行。两个创建入口进入同一真实可编辑配置流程。 |
| Customize / Skills | Yours/Discover、搜索、来源过滤、真实 Runtime slash directory 的列表/卡片；点击真实命令送入输入框。 | 当前 Discover 是本 Runtime 发现的真实技能，不假称 Anthropic 官方 marketplace 或远程安装。 |
| Customize / Connectors | Figma 实际当前任务配对状态、MCP 本机配置清单、连接筛选；Figma 入口打开真实文件/配对面板，Manage 不误触断开。 | MCP `configured` 只表示配置有效；未测试连接不标 connected，HTTP 仅配置但当前 stdio Runtime 不支持时显示 invalid。 |
| Customize / Plugins | 实际插件目录元数据、名称/描述/configured/invalid，错误显示；插件/MCP 容器解析错误单独可见。 | 只读 inventory 不执行插件、不启动 MCP、不披露 args/env/headers/令牌，也不声称 approved/active。没有假 marketplace 安装按钮。 |
| Design | Designs/Design systems 独立筛选与真实产物列表；原 Slides/Design/Design system 预览；可编辑创建需求与真实 Figma/素材入口。 | 列出真实 image/design/design-system/Figma 或对应设计文件；不显示 Claude 迁移公告和虚构历史。 |
| F09 | 保留已正确的 timeline hover/focus 规则。 | 首轮实机分别验证 idle 隐藏与 hover 展开，未把 menu 改成常驻。 |

### 定向验证与实际验收

本域按预期失败→修复→通过落实了导航路由、折叠字形、真实动画轴、列表/网格 glyph、组织偏好/筛选/排序、Pinned 顺序、定时材料来源、真实 Design 产物筛选、inventory 容器错误、原动画 part 的定向用例。`tests/claude_reference_parity_test.js`、`tests/studio_libraries_test.js`、`tests/studio_shell_test.ts` 通过；旧 shell/navigation/icon 断言按新真实契约更新，设置真实入口仍被保留。fresh renderer typecheck 与本域 ESLint 通过。

独立代理 `scripts/probe_library_acceptance.js` 使用真实 Electron main/preload、隔离的实际会话/材料 tracker 磁盘存储、真实 extensions inventory；离线模型/技能边界用固定 fixture，并没有运行调度任务或调用网络。首轮已报告 Projects 空态与注册、Scheduled 创建/暂停/恢复/删除的持久结果、Customize 三标签+真实配置读取、More隐藏/恢复与Group by、折叠 glyph、timeline idle/hover 全通过，console errors 为空。

首轮在模板 CSS 正在接入时捕获真实预览 absolute 溢出导致布局按钮被模板挡住。已补 `position:relative` 固定原始尺寸、overflow/局部 scope、preview pointer-events:none；独立代理将以最终冻结版本重建后重新验收 Artifacts/Design。**最终截图结果及全量/安装版版本由父任务交付记录补充，此处不以静态 regex 宣称 47 图全部像素一致。**

### 仍需诚实保留的边界

1. Claude account、订阅/用量/计费、共享列表/合作者、第三方市场安装和供应商认证不属于 MP 已有契约，已用真实本机能力替代，未复制假账户/假“已连接”。这些参考项不是素材缺失，而是不同产品的真实服务语义。
2. 像素宠物原始素材/完整动画在本轮资源查找中仍未提取；未画替代并宣称一致。Code 付费页面的所有运行时状态依旧没有 Claude 实机重放。
3. 47 张中消息/思考/工具失败/长任务/预测输入与 Stage 持久事件由父任务及共享 renderer 代理实施和验收；本域审计给出了逐图要求，但不代替他们的链路结果。
4. 本地 Projects 无云共享；Scheduled 支持现有 daily material tracker，非任意日历调度；Discover 展示实际可用目录而非虚构供应商 marketplace。源截图中的筛选/目录内容与 MP 数据不相同，不能把这解释成完全逐像素复刻。

## 8. 第二次逐项复核与确定余项的补修

不能将“归其他代理负责”当作已完成。读最终源码及第一轮实际截图后发现图 12 的预测仅 placeholder、图 22 的高度上限不一致、图 05 的 Edit/Write diff 只匹配旧工具名。已明确交父任务修复并要求新增实机状态；不是作为产品差异忽略。图 22 的 `#composer-mention` 确实为 `display:inline-flex`，实际截图存在常驻 @；父任务按参考隐藏它，材料入口仍在原侧栏。工具失败摘要/命令高亮/分组失败数量已有真事件实现，正确部分保留，不能为交差再造一套。

本域第二批已落地并通过定向测试、renderer typecheck 和 ESLint：

- 图 43：产物网格在 1037 CSS px 桌面宽度为三列；窄于 780px 两列。保留原始可读取产物内容，HTML/SVG 通过空 `sandbox` iframe、独立 origin、禁止脚本/表单/外网的 CSP 显示，DOMParser 移除脚本及嵌套文档等节点。图像支持实际 data URL 及本机图片路径；普通文档保持实际内容节选。不会执行生成 HTML 的 JavaScript，也不把代码截图伪造为真实页面。
- 图 25：Artifacts 右侧 hover/focus 显示独立真实 Add glyph，激活后进入可编辑创建需求，不自动发送；隐藏导航/收起侧栏时此按钮一同隐藏。
- 图 39：Designs/Design systems 的真实产物列表按 Today/Yesterday/实际日期分组，提供 list/grid 切换及同一份真实内容预览。
- 图 36：Chats 增加 Select、逐行/全选、Archive/Unarchive/Delete。归档使用真实持久本地组织偏好，删除逐项调用既有删除 API；失败项保留选择并显示错误，不以成功项吞掉失败、不再重复确认。

第二批包含 bulk 删除部分失败仍继续其余项目、archive/unarchive 不误调用删除、HTML sandbox 属性与真实内容、日期分组的行为测试。最终 Electron 补验收需明确验证 HTML 不执行 sentinel、图片确实显示、三列几何、hover 创建不触发模型、Design 切换与真实批量持久效果。

父任务需继续核对的具体参考状态：图 01 chat title 前电脑字形（当前标题直接文本）；图 28 原 Markdown renderer 无图片节点，图片结果不能只留下 `![...]` 文本；图 24 数字步骤导航需实际可执行 step schema，不能用参考内容假造步骤。图 08/31/47 Skills 目录目前有真实来源筛选，未假造官方 category、安装量或供应商推广；如要按类别浏览，需要 Runtime 提供真实分类字段。这些分别是已具数据的投影缺项和仍需实际数据契约的界面，不能混在“已还原”一句中。

### 工具栏、目录状态与库页刷新补齐

继续复核而非仅以“六项”结束后，已落实：

- Scheduled 的 Sort by Next run / Name / Last run。下一次时间与真实 `context_trackers.ts` 一致：有 `lastRun.dueThroughMs` 时加 `everyMs`，否则 `startAtMs`；暂停项无虚构下一次运行时间，过期项标明等待应用执行。New task 的 chevron 与两项前导图标均改真实 Anthropicons。
- Projects Sort by Last activity / Date created / Name。最近活动取真实项目 lastOpenedAt 与会话 updatedAt，创建时间使用注册记录 addedAt，不复用更新字段冒充。
- Skills Sort by Name / Source / Last edited。检查发现 SkillCatalog 原本就已持有并读取实际 SKILL.md，增加该文件 `stat().st_mtime_ns` 的毫秒投影；仅真实值存在才显示最近编辑排序。测试用真实文件 mtime 确认，不编造远程更新时间。
- Connectors Discover 独立两列卡片，使用同一真实 Figma/MCP 元数据、状态与错误；Yours 仍为表格。可用连接入口调用实际 Figma 配对面板，MCP 配置元数据不假装具备供应商市场安装操作。
- 非流式会话 change 的既有 rAF 合并刷新加入当前 library，使 Chats rename、项目归属、外部终态产物在打开库页时即时更新。回归测试执行实际回调确认终态刷新、流式 token 不重载库页。

第一轮完整真实 Electron 验收在 `artifacts/library-acceptance/acceptance.json` 记录 `ok:true`、18.78s、console errors 为空，包括四导航字体 ANIM 从 0 变化并回 0、Code ANM2 100/0 循环、reduced motion 回 0、模板 136×96 与 16 条 WAAPI 轨道、离开停止。截图等待渲染帧后重拍，已人工确认 Scheduled 不再误抓前一页。后续上述补齐项及第二批六项由同一验收 helper 增量验收，最终报告应引用最新文件而非复用旧 timing。

## 9. 最后实机回归与三项补齐

第二批实际 Electron 测试已确认三列网格、真实图像 decode、HTML/SVG sandbox frame 加载及画面、Design 两布局和日期分组、Skills/Projects/Scheduled 排序、Connectors Discover、hover 新建不自动执行。HTML/SVG 卡片使用 400% 布局画布再缩放到 25%，防止宽页面以卡片宽度重新排成窄长列；截图中的内容来自保存产物，不是图像模板。空 sandbox 不因验收工具无法跨 origin 执行 JavaScript 而放宽；验收通过实际 frame 加载、外层权限属性、页面 sentinel 未被改写和截图核验，不假称读取过跨 origin iframe 内部 DOM。

原生鼠标验收还发现右侧 Filters 的 Status 子菜单中心 x=1106，超出 1037 CSS px 窗口；测试未偷偷用 DOM click 代替原生点击。已增加依据实际菜单边界选择左右展开、反向箭头及 3px hover 重叠区。新增右缘/侧栏定位测试预期失败后通过，fresh renderer typecheck、ESLint、library 行为测试通过；由独立代理重新执行 archive/unarchive/delete 全链路并记录最终截图。

冻结后的只读复核确认三个**现有数据/契约足够、当时尚未完全匹配**的具体界面差异。已明确报父任务并继续补齐，不能归入 Claude 账户或缺失素材：

1. 图 36 Chats 顶部 search/filter/Select/New 原先位于标题下一整行，现已与标题同行；搜索图标展开真实过滤输入，关闭搜索会清空过滤。日期右齐、选择/归档/恢复/删除已有真实实现。
2. 图 17 Plugins Yours 原先使用两列大卡，现改为紧凑横向图标、名称/描述、右侧真实配置状态；Discover 保留卡片。未虚构供应商、时间和未实现的安装操作。
3. 图 38 Add/Change project 原先通过 modal/select，现改为父菜单旁可搜索项目子菜单、当前项目勾选、No project 清空归属和 Start new project 原生目录选择。选择已有项目直接调用真实持久 API；新项目真实注册后分配当前会话，失败仍显示原因并保留可操作菜单。

三项新增 heading/list/project filtering/current-check/empty 行为测试预期失败后通过；fresh renderer typecheck、ESLint、library/navigation/shell 定向检查通过。最后一次生产冻结已通知实机代理，新增同一行几何、真实搜索过滤、插件行高、已有项目搜索分配及原生选目录注册后分配验收。最终截图和 timing 以独立代理完成后的最新 `acceptance.json` 为准。

最终独立 Electron 验收已于 2026-09-18 01:25 完成：`artifacts/library-acceptance/acceptance.json` 为 `ok:true`、`timingMs:24189`、`failures:[]`、`consoleErrors:[]`，`usedBackend:local.store.fixture`。已有项目搜索分配与原生目录注册后分配均读取真实 store 确认；归档、恢复、删除三操作通过；右侧 Status All 原生点击点 x690 在 1037px 窗口内。人工逐张复核最终 `chats-heading-search.png`、`chats-project-search.png`、`customize-plugins.png`，确认本段三项真实画面已修；亦复核 `artifacts-grid.png`、`designs-grid.png` 的实际产物预览和原模板。测试 viewport 1037×879、报告 devicePixelRatio=1、capturePage 输出 2074×1758；不将捕获像素倍率误称页面 DPR。

在本次逐图证据清单中，已具 MP 数据与可用契约的明确待修项现已闭合；不宣称 47 个 Claude 原运行态逐像素认证。最终全量验证、版本号和本机安装同步由父任务记录，此处 UI 验收通过不替代交付门。

父任务最新源码已补图 12 建议按 Tab 接受后成为可编辑草稿、图 22 max-height 384 与真实输入增高、Code ArrowReturn、常驻 @ 隐藏、图 05 原生 Edit/Write diff 及图 28 Markdown 图片/连续图片布局。它们的实机链路结果由父任务对应验收记录支撑，此文不代替验收。图 24 的交互数字步骤没有实际 step schema，未用假步骤填图；像素宠物仍无原始资源，不列为“有契约但懒得修”的项。
