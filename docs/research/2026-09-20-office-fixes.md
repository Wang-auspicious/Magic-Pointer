# OP01–OP15 修复记录

原审计：[audit-2026-09-20-office-delivery.md](audit-2026-09-20-office-delivery.md)。保留原审计的证据等级，不把代码修复或脚本替身升级为原生Office/Figma验收。

| 编号 | 已实施的变化 | 本批验证 |
|---|---|---|
| OP01 | Word run边界替换选择实际覆盖起始字符的run | 真实docx混合加粗/斜体/下划线，旧版红、修后保留目标格式 |
| OP02 | live Word先验证完整base，再只写最小变化Range；COM偏移使用UTF-16单位 | 捕获生产gateway实际脚本和payload，验证只改new三个字符 |
| OP03 | live Excel在任何COM调用前检查expected/after二维形状与目标地址 | 缺行、短行、多行三例红→绿，拒绝时无原生调用 |
| OP04 | Excel每格成功、PPT每个属性setter成功即标记wrote | 实际执行PowerShell生产body，第二次setter抛错仍报告已写入 |
| OP05 | PDF副本在PDF内部记录任务/来源绑定，后续批注可重开继续 | 新handler同副本两批注通过，拒绝无关已存在文件 |
| OP06 | PDF读回真实批注类型/正文/几何，写临时文件后真实复核 | 外部修改正文或移动批注后不再伪报等于期望 |
| OP07 | Figma统一默认end，按after长度读回，并核对完整未改邻文 | 扩写/缩写/删除/省略end及后续read_current均通过 |
| OP08 | XLSX写入与验证共用名称规范化，处理31字符/默认/重名/_Sources冲突 | 四组真实xlsx创建、重开、读回通过 |
| OP09 | PPT表格按最多10行分页，图片独立页；重开验证表格内容、数量、图片数量与边界 | 三表原越界复现红→绿；改坏表格内容被验证器拒绝 |
| OP10 | PPT填充/线条null对应隐藏，颜色对应显示；base按真实可见状态校验 | 生产PowerShell脚本改变Visible并读回 |
| OP11 | artifact bridge新增用户确认undo，消费对应已写入inverseRecords反序恢复；逐项base检查和读回；持久记录已撤销项 | 重启后撤销、重复拒绝、用户编辑冲突保留；真实PDF删除指定批注、文件移动恢复；GUI接线由桌面批完成 |
| OP12 | 缺配置与非完整provider完成状态统一返回失败，不能用非空残段替换历史 | 四个新增失败例红→绿，保留既有thinking空答重试契约 |
| OP13 | npm pretest先编译当前源码；三平台CI都lint/typecheck后测试，mac打包使用本轮测试前编译产物；显式dev依赖pyflakes | 新pipeline契约红→绿；最终全量验证另外记录 |
| OP14 | sync只镜像安装器拥有的app/build/scripts/python-runtime目录，保留其他数据；版本缺失/不一致直接失败 | 真实临时目录旧模块消失、当前模块存在、用户data不变 |
| OP15 | STATUS顶部增加现行版本/任务/模型边界，旧“一句话”和能力表改为历史；canonical旧长任务句改为自有Runtime | 文档直接核对，未重跑已完成FrameLease/Batch A |

新增回归位于 `tests/office_audit_fixes_test.py`、`native_office_write_receipts_test.py`、`artifact_undo_audit_test.py`、`summary_completion_audit_test.py`、`delivery_pipeline_audit_test.py`。初次16例中5例fixture误用了不受支持的file locator，修正为现有text locator后再观察xlsx/PPT预期失败；其余初始失败直接指向生产缺陷。原生PowerShell批观察2红2绿后修正PPT；Excel部分写标记已与形状校验一起修入，新增部分setter测试验证其真实脚本行为。

撤销遵循已有`retain_created_file`策略：新创建的整个文件保留，不擅自删除；PDF撤销仅删除本次且当前状态仍匹配的批注。部分写入后状态不匹配会停在冲突，不能把未恢复状态宣称已恢复。

本机`CLSIDFromProgID`检查Word.Application、Excel.Application、PowerPoint.Application均未注册，因此本批没有原生Office应用验收结论。Figma实际插件安装/应用连接亦须依真实可用环境区分；Python和插件事务回归不能代替该结论。
