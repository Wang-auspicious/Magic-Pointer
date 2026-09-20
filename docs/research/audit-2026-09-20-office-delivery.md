# 2026-09-20 办公动作、模型摘要与交付审计

审计对象为当前未提交开发树。此报告没有修生产代码，也没有把无头脚本当成 Office/Figma 原生验收。A 表示使用当前生产函数与合成文件/替身取得最小复现；B 表示生产调用链直接证明的缺陷，尚无真实应用复现；C 表示产品约定与当前交付之间的明确缺口。优先级 P1 为错误写入、数据/状态丢失、主路径失效；P2 为局部功能、交付或维护问题。

复现文件：`docs/research/audit-2026-09-20-probe.py`；实际输出：同名 `.json`。所有文件写入都在 TemporaryDirectory；模型配置与调用被替换；没有调用收费模型、操作真实应用或读取凭据。退出 0 表示取得了缺陷见证，不表示缺陷修好。

## OP01 · P1 · Word 局部替换在 run 边界继承了前一段格式（A）

位置：`app/actions/office_document.py:309`。

`start <= next_cursor` 在修改恰好从下一个 run 开头开始时，选择前一个 run 作为承载者。合成文件为加粗 `Keep `、斜体 `old`、下划线 ` ending`；替换后实际成为加粗 `Keep new`、空斜体 run、下划线结尾。返回 ok=true，但需要保留的替换区字体改变了。现有测试只检查未修改前后段，没有检查新文本的样式。

修法：区分边界上的插入和替换，替换由真正覆盖起始字符的 run 承载；增加混合格式边界行为例即可，不重做 OOXML 框架。

## OP02 · P1 · live Word 一次改小片段会整段重赋值（B）

位置：`app/actions/office_document.py:133`、`:142`。

live Word 路径直接 `$range.Text = $p.after`。当 locator 范围内含混合字号、强调或链接，而用户只改其中几个词，整个范围被重建，无法兑现 PRD W07/W08 的局部修改保留未改格式。离线 Word 和 PowerPoint 已有最小差异方法，但这条真正面向打开文档的路径未使用。

修法：在已验证 base 上计算实际变更区，只修改对应原生 Range；记录真正变更区及样式所需的逆操作。没有在本机 Word 上声称已测到具体格式损失。

## OP03 · P1 · live Excel 不验证 after 矩阵大小（B）

位置：`app/actions/office_document.py:176`、`:196`、`:489`。

原生脚本校验 expected 矩阵符合选区，但写入前只确认 after 是 list，没有确认其行数、每行列数。范围 B2:C3 配一行 after 是受支持公开 patch 数据形状可表达的输入，脚本仍逐个访问 `$p.after[$r-1][$c-1]`，可能清空缺失值或在已经写完前面单元格后异常；多出来的值则被忽略。

修法：在任何 COM 写入前验证 after 的二维形状与目标范围一致。这里是明确有限操作的必要输入校验，不需要复杂校验层。

## OP04 · P1 · 多步原生写入的部分失败被记成 wrote=false（B）

位置：`app/actions/office_document.py:196`、`:201`；`app/actions/powerpoint.py:267`、`:291`、`:293`。

Excel 多格写入、PPT 多属性写入都等整个循环结束才设 wrote=true。第一格/属性已经修改、后一个受保护或 COM setter 失败时，catch 返回初始化的 wrote=false。外层因此可以将实际已改的文档归为“未写入”，恢复和重试判断失真。与 OP03 不同，这是形状完全合法但第二次原生写失败的回执问题。

修法：每次成功写后记录实际前缀；错误回执保留部分修改事实，读回受影响对象后决定恢复/继续。无需承诺不存在的事务原子性。

## OP05 · P1 · 一个 PDF 副本不能应用两个批注（A）

位置：`app/actions/pdf.py:111`、`:118`、`:145`。

第一条 add_pdf_annotation 新建副本成功；同一 DocumentPatch 第二条指向同一个 outputPath 时，read_current 发现文件存在但没有第二个 annotationId，返回 output_exists，execute 也返回 output_path_exists。正常“给这两处加批注”只能完成第一处。

修法：同一已绑定产物的后续批注基于该副本继续，仍拒绝覆盖无关既有文件；批次在同一 PDF 生命周期处理并逐项记录结果。

## OP06 · P1 · PDF 读回只看标识，不检查真正批注内容（A）

位置：`app/actions/pdf.py:73`、`:111`。

找到 subject 中的 annotationId 就直接返回 operation.after。复现把实际批注文字改成 `different actual content`，read_current.value 仍等于请求中的 `wanted`。因此读回可以证明一个从未实际核验的文本/几何状态，污染完成与恢复判断。

修法：从真实 annotation 读取类型、文本、页码和对应几何后投影；不要把期望值当实测值返回。

## OP07 · P1 · Figma 文本长度改变后用旧 end 读回（A）

位置：`app/actions/figma.py:46`、`:47`、`:85`、`:151`。

`abcDEFghi` 的 [3,6) 替换为 LONGER，插件已经得到 `abcLONGERghi`，但 Python 仍读取 [3,6)，只读到 LON，报告 figma-readback-mismatch、wrote=true。常见的缩写、扩写都可触发。没有 textEnd 时，读取默认全文而插件参数默认 end=0，也属同一范围契约不一致。

修法：明确 before/after 的范围映射，写后以起点加替换长度读取并检查必要邻文；读取、写入、inverse 使用一致默认值。此项与插件内多操作偏移、rollback 问题不同。

## OP08 · P2 · XLSX 默认工作表名生成后被自己的验证拒绝（A）

位置：`app/actions/document_output.py:104`、`:211`、`:312`。

创建器允许 sheets 项不填 name，生成 Sheet1；验证器却查找空字符串工作表名。合成的单格表创建最后报告 reopen_verification_failed。超过31字名字的创建截断与验证原名也存在同类不一致。

修法：创建前一次规范化合法 sheet 名，创建和验证共同使用该结果；重复名称在创建前明确处理。

## OP09 · P1 · 生成 PPT 已有表格出界，仍被验证为成功（A）

位置：`app/actions/document_output.py:143`、`:151`、`:224`。

表格从4英寸起每个下移1.8英寸；默认幻灯片高7.5英寸，第三张表底部9.2英寸。复现返回 ok=true，实际 bottom=8,412,480 EMU > slideHeight=6,858,000。验证只读标题/正文，不检查表格内容、位置或边界。这直接落在 PRD 明确要求的“生成后明显溢出”检查内。

修法：内容超出可用空间时分页/选择合适布局，重开后验证表格和图片覆盖及页面边界；实际布局变更再做渲染验收。

## OP10 · P2 · PPT 无填充/无线条与颜色状态无法互转（B）

位置：`app/actions/powerpoint.py:186`、`:267`、`:374`。

读取把 Visible=false 表示为 null，值对象也接受 null；写入遇到 null 就跳过，写入颜色时又不设置 Visible=true。因此“去掉填充”不会去掉；给原本无填充的形状设颜色也可能仍不可见，读回持续不匹配。

修法：在同一现有 style 操作中把 null 明确解释为不可见，颜色解释为可见且设色；与实际读回状态保持对称。

## OP11 · P1 · DocumentPatch 逆操作保存了，但没有可执行的恢复通路（C）

位置：`app/artifacts/document_patch.py:286`、`:329`；`app/actions/executor.py:209`、`:302`；`app/actions/file_organizer.py:141`。

文档 patch 生成 inverseRecords；工程内搜索没有消费这些记录的恢复执行入口。executor 的公共 UndoLog 只在 result.output.undo_proposal 存在时登记，但 document_patch_operation 只返回 wrote/backend。restore_move 只有定义、导出与测试调用。用户做完本项目支持的文件移动/文档修改，现有通用撤销不能用这些记录还原，重启也不能完成承诺的精确恢复。旧 Word selection 专用 undo 是已实现的，不把它说成不存在。

修法：给现有 artifact/action bridge 增加绑定 task/artifact/当前值的 inverse 执行操作，复用原权限与读回，不新增另一套历史数据库。

## OP12 · P1 · 未调用/未完整输出的摘要仍可能替换历史（A+B）

位置：`app/ai_client.py:559`、`:588`、`:699`；`app/agent_runtime/compaction_prompt.py:109`。

缺密钥返回的说明文字没有 AI_FAILURE_PREFIX；summarize_history_text 只用该前缀判断失败。替身复现 is_failure=false、nonempty_summary=true，明明没有调用模型仍接受为摘要。另一个同根因分支是非空文本伴随 finish_reason=length / Responses incomplete：文本函数直接 return answer，不保留未完成状态，摘要也把残段当完整交接。这里报的是输出成功协议，Runtime 分区“输入前48k裁剪”是不同问题。

修法：文本返回/摘要调用保留真实完成状态，缺配置和截断都不替换原历史；不靠扩展一串错误文案正则判断成功。

## OP13 · P1 · 干净 CI 测试先于构建，macOS 打包又漏编译（B）

位置：`.github/workflows/release.yml:58`、`:115`、`:133`、`:182`、`:200`、`:213`；`tests/studio_interaction_probe_test.js:13`；`package.json:5`。

所有 release job 都在干净 checkout 后先执行 npm test，但 studio_interaction_probe_test 明确要求 build/scripts/probe_studio_interactions.js 已存在，另有图标/配额测试也依赖构建产物；这些文件被gitignore排除，测试runner不负责编译，所以干净CI在打包之前就会失败。本机已有旧build时，该类probe还可能验证旧实现。即使绕过此门，两个mac job仍直接调用electron-builder，漏掉build:electron；Windows的dist:win虽会构建，却排在失败的测试之后。publish依赖全部三个job，交付被整体阻断。

修法：将需要的编译产物在相关probe前构建，并保证所有平台打包使用本轮源码生成的同一产物；Verify source同步当前lint/typecheck约定。没有在Windows声称执行了mac CI，也没有把本机旧build上的probe通过当作当前源码UI验收。

## OP14 · P2 · sync 只增量覆盖，开发树已删模块仍留在安装版（B）

位置：`scripts/sync_install.ps1:43`。

robocopy /E 会复制新增/修改文件，不删除目的目录多余文件。本项目近期真实删除旧路由/文件，安装版仍可留下这些 Python/JS 模块；STATUS 已有一次需要单独清理历史安装残留的记录。版本一致不意味着运行文件一致，今后的删除批次仍会复发。

修法：只同步/清理明确由安装器拥有的 runtime 目录，保留用户数据。不要向未知根目录直接加 /MIR。验收应包含一个被本次删除的旧模块已不在安装目录。

## OP15 · P2 · 当前事实源混入相互冲突的旧结论（C）

位置：`docs/STATUS.md:150`、`:169`、`:186`；`docs/design/MAGIC_POINTER_HARNESS_20260811.md:860` 的长任务正文与后续修订；`AGENTS.md` 当前阶段。

新入口说明1.0.49、统一模型和滚动长任务预算；同一事实源仍可读到1.0.32、旧模型席位、已修的固定长任务天花板。历史记录保留本来是正确的，问题是缺少清晰的“已取代”状态，且某些旧内容还在当前摘要的位置。新人/Agent按 mandatory first read 很容易重复已完成 Batch A 或按旧产品边界设计。

修法：用当前状态摘要明确版本、开发树/安装版差异和现行决策，给被取代的结论加短链接指向修订；保留历史，不整体重写旧设计。

## 阅读与证据边界

本分区完整/分段回读了 office_document、powerpoint、pdf、figma、document_output、file_organizer、document_backend、document_patch、artifact schema/projection、artifact_bridge、action_broker、draft_delivery、history、ai_client、模型 profile/runtime/capability 主要代码，以及 package/build/sync/release 配置和对应办公测试。executor 读取了公共入口、document_patch 执行、Undo 和 Word 原生实现；其日历/购物清单等段落未逐行审完。

PRD 产品要求与 canonical design/STATUS 当前记录是判断依据；Jev 两份材料另见总报告。尚未逐行读完仓库每个历史文档、测试、原生大脚本与外围功能。文件列举、搜索命中、测试通过不算完整阅读。全部原有未提交修改均保留。
