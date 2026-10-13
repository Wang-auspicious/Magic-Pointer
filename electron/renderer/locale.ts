/* Studio UI locale: English-default string table with zh-CN overrides.
 *
 * The UI renders English by default; Chinese appears only after an explicit
 * switch to zh-CN. This mirrors the reference pattern of stable message ids
 * plus default text: call sites use studioT('some.id') and the table holds
 * both wordings, so neither language is scattered through render code.
 *
 * Dual-mode like chat_view.ts: a classic browser script (globals are visible
 * to the other renderer scripts) and a CommonJS module for the tsx tests.
 * chat_view.ts loads this file with a guarded require when it runs outside
 * the studio page; studio.ts relies on the studio.html script order and
 * needs one tag before chat_view.js:
 *   <script defer src="locale.js?v=1"></script>
 */

declare global {
  type StudioLanguage = 'en' | 'zh-CN';
  function studioT(
    id: string,
    params?: Record<string, string | number>,
  ): string;
  function studioTCount(
    id: string,
    count: number,
    params?: Record<string, string | number>,
  ): string;
  function getStudioLanguage(): StudioLanguage;
  function applyStudioLanguage(language: StudioLanguage): void;
}

interface StudioStringEntry {
  en: string;
  zh: string;
}

interface StudioCountEntry {
  one: string;
  other: string;
  zh: string;
}

const STUDIO_STRINGS: Record<string, StudioStringEntry> = {
  'patch.before': {en: 'Before', zh: '修改前'},
  'patch.after': {en: 'After', zh: '修改后'},
  'patch.cell': {en: 'Cell', zh: '单元格'},
  'patch.value_type': {en: 'Value type', zh: '值类型'},
  'patch.blank': {en: 'Blank', zh: '空值'},
  'patch.number': {en: 'Number', zh: '数字'},
  'patch.string': {en: 'Text / formula', zh: '文本 / 公式'},
  'patch.boolean': {en: 'True / false', zh: '布尔值'},
  'patch.true': {en: 'True', zh: '真'},
  'patch.false': {en: 'False', zh: '假'},
  'patch.invalid_number': {en: 'Enter a valid number, or choose Blank to clear the cell.', zh: '请输入有效数字；清空单元格请选择“空值”。'},
  'patch.invalid_boolean': {en: 'Enter true or false.', zh: '请输入 true 或 false。'},
  'patch.no_color': {en: 'No color', zh: '无颜色'},
  'patch.replace_text': {en: 'Replace text', zh: '替换文本'},
  'patch.set_cell_values': {en: 'Update cells', zh: '修改单元格'},
  'patch.set_shape_text': {en: 'Edit text', zh: '编辑文字'},
  'patch.set_shape_style': {en: 'Edit appearance', zh: '修改外观'},
  'patch.set_shape_geometry': {en: 'Resize or move', zh: '调整大小或位置'},
  'patch.set_figma_fill': {en: 'Change fill', zh: '修改填充'},
  'patch.set_figma_spacing': {en: 'Adjust spacing', zh: '调整间距'},
  'patch.set_figma_size': {en: 'Resize', zh: '调整大小'},
  'patch.set_figma_position': {en: 'Move', zh: '调整位置'},
  'patch.add_pdf_annotation': {en: 'Add annotation', zh: '添加批注'},
  'patch.create_file': {en: 'Create file', zh: '新建文件'},
  'patch.move_file': {en: 'Move file', zh: '移动文件'},
  'patch.slide': {en: 'Slide', zh: '幻灯片'},
  'patch.shape': {en: 'Shape', zh: '形状'},
  'patch.node': {en: 'Layer', zh: '图层'},
  'patch.page': {en: 'Page', zh: '页'},
  'patch.section': {en: 'Section', zh: '节'},
  'patch.header': {en: 'Header', zh: '页眉'},
  'patch.footer': {en: 'Footer', zh: '页脚'},
  'patch.body': {en: 'Document body', zh: '文档正文'},
  'patch.selection': {en: 'Selected text', zh: '选中文字'},
  'patch.item': {en: 'Item', zh: '项目'},
  'patch.text': {en: 'Text', zh: '文字'},
  'patch.path': {en: 'File location', zh: '文件位置'},
  'patch.content': {en: 'Content', zh: '内容'},
  'patch.width': {en: 'Width', zh: '宽度'},
  'patch.height': {en: 'Height', zh: '高度'},
  'patch.left': {en: 'Left', zh: '左边距'},
  'patch.top': {en: 'Top', zh: '上边距'},
  'patch.x': {en: 'Horizontal position', zh: '水平位置'},
  'patch.y': {en: 'Vertical position', zh: '垂直位置'},
  'patch.rotation': {en: 'Rotation', zh: '旋转角度'},
  'patch.fontSize': {en: 'Font size', zh: '字号'},
  'patch.fontName': {en: 'Font', zh: '字体'},
  'patch.bold': {en: 'Bold', zh: '粗体'},
  'patch.italic': {en: 'Italic', zh: '斜体'},
  'patch.underline': {en: 'Underline', zh: '下划线'},
  'patch.fillRgb': {en: 'Fill', zh: '填充色'},
  'patch.lineRgb': {en: 'Outline', zh: '边框色'},
  'patch.colorRgb': {en: 'Text color', zh: '文字颜色'},
  'patch.spacing': {en: 'Spacing', zh: '间距'},
  'patch.itemSpacing': {en: 'Item spacing', zh: '元素间距'},
  'patch.paddingLeft': {en: 'Left padding', zh: '左内边距'},
  'patch.paddingRight': {en: 'Right padding', zh: '右内边距'},
  'patch.paddingTop': {en: 'Top padding', zh: '上内边距'},
  'patch.paddingBottom': {en: 'Bottom padding', zh: '下内边距'},
  'artifact.review_changes': {en: 'Review changes', zh: '审阅修改'},
  'artifact.review_continue': {en: 'Review and apply this version in the editor. The task will continue after the changes are verified.', zh: '在编辑器中审阅并应用此版本。修改验证成功后，任务会自动继续。'},
  'preview.fit': {en: 'Fit', zh: '适应窗口'},
  'preview.image_failed': {en: 'Could not display this image. Open it in its application.', zh: '无法显示此图片，请使用关联应用打开。'},
  'dashboard.new': {en: 'New dashboard', zh: '新建数据看板'},
  'dashboard.loading': {en: 'Loading dashboard data…', zh: '正在读取看板数据…'},
  'dashboard.empty': {en: 'No dashboards yet', zh: '还没有数据看板'},
  'dashboard.empty_hint': {
    en: 'Choose CSV or XLSX files. The Agent will inspect the columns and build a dashboard from the actual data.',
    zh: '选择 CSV 或 XLSX 文件，Agent 会读取列信息，使用实际数据生成看板。',
  },
  'dashboard.open_failed': {
    en: 'Dashboard failed to open.',
    zh: '无法打开数据看板。',
  },
  'dashboard.retry': {en: 'Retry', zh: '重试'},
  'dashboard.refresh': {en: 'Refresh', zh: '刷新'},
  'dashboard.edit': {en: 'Edit with Agent', zh: '让 Agent 修改'},
  'dashboard.export_html': {en: 'Export HTML', zh: '导出 HTML'},
  'dashboard.updated': {en: 'Updated {time}', zh: '更新于 {time}'},
  'dashboard.query': {en: 'Query', zh: '计算方式'},
  'dashboard.prior': {en: 'Prior period', zh: '上一周期'},
  'dashboard.delta': {
    en: '{percent}% vs prior period',
    zh: '较上一周期 {percent}%',
  },
  'dashboard.no_values': {en: 'No measured values.', zh: '没有可计算的数值。'},
  'dashboard.no_query_values': {
    en: 'No measured values for this query.',
    zh: '此查询没有可计算的数值。',
  },
  'dashboard.no_rows': {en: 'No matching rows.', zh: '没有匹配的数据行。'},
  'dashboard.view_rows': {en: 'View source rows', zh: '查看源数据行'},
  'dashboard.choose_file': {
    en: 'Choose a CSV or XLSX file.',
    zh: '请选择 CSV 或 XLSX 文件。',
  },
  'dashboard.file_types': {
    en: 'Dashboards currently support CSV and XLSX files.',
    zh: '数据看板目前支持 CSV 和 XLSX 文件。',
  },
  'dashboard.create_prompt': {
    en: 'Build a useful dashboard from the attached tables and save it in my Dashboards library. Use the actual data for suitable summary metrics, trends, and grouped comparisons. Preserve the source files.',
    zh: '根据附件中的表格生成实用的数据看板，保存到我的数据看板库。使用实际数据选择合适的汇总指标、趋势和分组对比，保持源文件不变。',
  },
  'dashboard.edit_prompt': {
    en: 'Update the saved dashboard “{title}” (ID: {id}). Preserve its other charts and source files.\n\nChanges: ',
    zh: '修改已保存的数据看板“{title}”（ID：{id}），保留其他图表和源文件。\n\n修改要求：',
  },
  'dashboard.export_failed': {
    en: 'Dashboard export failed.',
    zh: '数据看板导出失败。',
  },
  'dashboard.reading_rows': {
    en: 'Reading source rows…',
    zh: '正在读取源数据行…',
  },
  'dashboard.rows_unavailable': {
    en: 'Source rows are unavailable.',
    zh: '无法读取源数据行。',
  },
  'dashboard.source_rows': {en: 'Source rows', zh: '源数据行'},
  'dashboard.inline_data': {en: 'Inline data', zh: '内嵌数据'},
  'dashboard.snapshot': {en: 'Snapshot', zh: '数据快照'},
  'dashboard.value': {en: 'Value', zh: '数值'},
  'dashboard.no_value': {en: 'No measured value', zh: '没有可计算的数值'},
  'dashboard.excluded': {
    en: '{count} blank or nonnumeric values were excluded.',
    zh: '已排除 {count} 个空值或非数值。',
  },
  'dashboard.source_row': {en: 'Source row', zh: '原始行号'},
  'dashboard.row_count': {
    en: '{range} of {total} contributing rows',
    zh: '参与计算的行：{range}，共 {total} 行',
  },
  'dashboard.previous': {en: 'Previous', zh: '上一页'},
  'dashboard.next': {en: 'Next', zh: '下一页'},
  'dashboard.export_csv': {
    en: 'Export all source rows as CSV',
    zh: '导出全部源数据行 CSV',
  },
  'dashboard.saved': {en: 'Saved to {path}', zh: '已保存到 {path}'},
  'routine.new': {en: 'New routine', zh: '新建例行任务'},
  'routine.edit': {en: 'Edit routine', zh: '编辑例行任务'},
  'routine.task': {en: 'Instructions', zh: '任务说明'},
  'routine.source': {en: 'Source', zh: '材料'},
  'routine.file': {en: 'Choose file', zh: '选择文件'},
  'routine.folder': {en: 'Choose folder', zh: '选择文件夹'},
  'routine.choose_source': {en: 'Choose a local file or folder.', zh: '请选择本机文件或文件夹。'},
  'routine.cadence': {en: 'Repeat', zh: '重复'},
  'routine.daily': {en: 'Daily', zh: '每天'},
  'routine.weekly': {en: 'Weekly', zh: '每周'},
  'routine.monthly': {en: 'Monthly', zh: '每月'},
  'routine.interval': {en: 'Every {minutes} minutes', zh: '每 {minutes} 分钟'},
  'routine.first_run': {en: 'First run · local time', zh: '首次运行 · 本机时间'},
  'routine.output': {en: 'Output', zh: '输出'},
  'routine.draft': {en: 'Draft', zh: '草稿'},
  'routine.report': {en: 'Report', zh: '报告'},
  'routine.hint': {en: 'Runs while Magic Pointer is open. Missed occurrences are combined into one run after reopening. Results appear in a chat; source files stay unchanged.', zh: 'Magic Pointer 打开时运行；关闭期间错过的计划会在重开后合并执行一次。结果显示在对话中，源文件保持不变。'},
  'routine.month_hint': {en: 'Uses the same day each month, or the last day of a shorter month.', zh: '每月同一天运行；较短月份改在该月最后一天运行。'},
  'routine.cancel': {en: 'Cancel', zh: '取消'},
  'routine.save': {en: 'Save changes', zh: '保存修改'},
  'routine.saving': {en: 'Saving…', zh: '正在保存…'},
  'routine.save_failed': {en: 'Could not save the routine.', zh: '无法保存例行任务。'},
  'routine.run_failed': {en: 'This run did not finish.', zh: '本次运行未完成。'},
  'routine.invalid_start': {en: 'Choose a valid first run date and time.', zh: '请选择有效的首次运行日期和时间。'},
  'routine.next': {en: 'Next run', zh: '下次运行'},
  'routine.name': {en: 'Name', zh: '名称'},
  'routine.last': {en: 'Last run', zh: '最近运行'},
  'routine.due': {en: 'Due now', zh: '现在到期'},
  'routine.paused': {en: 'Paused', zh: '已暂停'},
  'routine.pause': {en: 'Pause', zh: '暂停'},
  'routine.resume': {en: 'Resume', zh: '恢复'},
  'routine.running': {en: 'Running…', zh: '运行中…'},
  'routine.run_now': {en: 'Run now', zh: '立即运行'},
  'routine.completed': {en: 'Completed', zh: '已完成'},
  'routine.waiting': {en: 'Needs your answer', zh: '等待答复'},
  'routine.incomplete': {en: 'Needs attention', zh: '需要处理'},
  'routine.continue': {en: 'Continue', zh: '继续处理'},
  'routine.open_artifact': {en: 'Open artifact', zh: '打开产物'},
  'routine.failed': {en: 'Failed', zh: '失败'},
  'routine.history': {en: 'Run history ({count})', zh: '运行历史（{count}）'},
  'routine.open_result': {en: 'Open result', zh: '打开结果'},
  'routine.manual': {en: 'Manual', zh: '手动'},
  'routine.remove': {en: 'Delete routine', zh: '删除例行任务'},
  'routine.empty': {en: 'No routines yet', zh: '还没有例行任务'},
  'routine.empty_hint': {en: 'Choose local materials and set a daily, weekly, or monthly schedule.', zh: '选择本机材料，设置每天、每周或每月运行。'},
  'routine.suggestions': {en: 'Try a routine', zh: '试试例行任务'},
  'routine.materials': {en: 'Selected materials', zh: '所选材料'},
  'routine.brief_title': {en: 'Daily briefing', zh: '每日简报'},
  'routine.brief_prompt': {en: 'Summarize recent changes in the selected materials in a concise daily briefing.', zh: '整理所选材料最近的变化，给我一份简洁的每日简报。'},
  'routine.inbox_title': {en: 'Inbox triage', zh: '收件箱整理'},
  'routine.inbox_prompt': {en: 'Review the selected inbox exports and list items that need my reply or action.', zh: '检查所选收件箱导出材料，整理需要我回复和处理的项目。'},
  'routine.meeting_title': {en: 'Meeting prep', zh: '会议准备'},
  'routine.meeting_prompt': {en: 'Read the selected meeting materials and prepare an agenda, background, and open questions.', zh: '阅读所选会议材料，整理议程、背景和需要确认的问题。'},
  'routine.review_title': {en: 'Weekly review', zh: '每周回顾'},
  'routine.review_prompt': {en: 'Review this week’s progress, unfinished work, and next steps from the selected materials.', zh: '阅读所选工作材料，整理本周进展、未完成事项和下一步。'},
  'routine.ideas_title': {en: 'Content ideas', zh: '内容选题'},
  'routine.ideas_prompt': {en: 'Suggest actionable content ideas from the selected materials and cite their sources.', zh: '根据所选素材提出可执行的内容选题，并列出来源。'},
  'routine.monitor_title': {en: 'Monitor a topic', zh: '主题跟踪'},
  'routine.monitor_prompt': {en: 'Track changes in the selected topic materials and report new information and items requiring my attention.', zh: '跟踪所选主题材料的变化，只报告新的信息和需要我处理的事项。'},
  'common.cancel': {en: 'Cancel', zh: '取消'},
  'common.confirm': {en: 'Confirm', zh: '确定'},
  'common.save': {en: 'Save', zh: '保存'},
  'common.done': {en: 'Done', zh: '完成'},
  'common.close': {en: 'Close', zh: '关闭'},
  'common.copy': {en: 'Copy', zh: '复制'},
  'common.delete': {en: 'Delete', zh: '删除'},
  'common.notice': {en: 'Note', zh: '注意'},
  'common.none': {en: 'None', zh: '无'},
  'common.untitled': {en: 'Untitled', zh: '未命名'},
  'common.unknown_error': {en: 'Unknown error', zh: '未知错误'},
  'artifact.kind_all': {en: 'All types', zh: '全部类型'},
  'common.unknown_reason': {en: 'Unknown reason', zh: '未知原因'},
  'common.switch_failed': {en: 'Switch failed.', zh: '切换失败。'},
  'common.loading': {en: 'Loading…', zh: '正在读取…'},
  'common.remove_named': {en: 'Remove {name}', zh: '移除 {name}'},
  'search.kind.conversation': {en: 'Chat', zh: '会'},
  'search.kind.project': {en: 'Proj', zh: '项'},
  'search.kind.command': {en: '/', zh: '/'},
  'search.kind.skill': {en: 'Skill', zh: '技'},
  'search.kind.route': {en: '→', zh: '→'},
  'search.empty_hint': {
    en: 'Type to search conversations, projects, commands, skills, and settings.',
    zh: '输入内容以搜索会话、项目、命令、Skills 和设置。',
  },
  'search.no_results': {en: 'No matching results.', zh: '没有匹配结果。'},
  'search.route.new_chat': {en: 'New chat', zh: '新建对话'},
  'search.route.customize': {en: 'Customize', zh: '自定义'},
  'search.route.changes': {en: 'Worktree changes', zh: '工作树变更'},
  'search.route.browser': {en: 'Project browser', zh: '项目浏览器'},
  'search.route.tasks': {en: 'Tasks', zh: '任务'},
  'canvas.empty_title': {en: 'Canvas is empty', zh: '画布还没有素材'},
  'canvas.empty_body': {
    en: 'Brush over screen content, copy an image, or save a reference — it becomes sortable visual context here.',
    zh: '划过屏幕内容、复制图片或保存引用后，它们会在这里形成可整理的视觉上下文。',
  },
  'canvas.empty_action': {en: 'Back to chat', zh: '回到对话'},
  'canvas.empty_filtered': {
    en: 'No items in this category.',
    zh: '这个分类里还没有素材。',
  },
  'convo.row_title': {en: '{title}, {status}', zh: '{title}，{status}'},
  'convo.row_actions': {en: 'Conversation actions', zh: '会话操作'},
  'convo.rename_title': {en: 'Rename conversation', zh: '重命名对话'},
  'convo.title_empty': {en: 'Title cannot be empty.', zh: '标题不能为空。'},
  'convo.title_invalid': {en: 'Invalid title.', zh: '标题无效。'},
  'convo.rename_failed': {
    en: 'Rename failed. Please try again.',
    zh: '重命名失败，请重试。',
  },
  'convo.untitled': {en: 'Untitled conversation', zh: '未命名对话'},
  'convo.jump_to': {en: 'Jump to: {label}', zh: '跳到：{label}'},
  'prompt.group_name': {en: 'Group name', zh: '分组名称'},
  'sidebar.recent_on': {en: 'Last 7 days only (on)', zh: '只看近 7 天（已启用）'},
  'sidebar.recent_off': {en: 'Recent projects only', zh: '只看最近项目'},
  'sidebar.collapse': {en: 'Collapse sidebar', zh: '折叠侧栏'},
  'sidebar.expand': {en: 'Expand sidebar', zh: '展开侧栏'},
  'composer.selection_actions': {
    en: 'Actions for the selection',
    zh: '选中内容的操作',
  },
  'composer.peek_default': {en: 'Selection preview', zh: '选区预览'},
  'usage.system_prompt': {en: 'System prompt', zh: '系统提示词'},
  'usage.tool_definitions': {en: 'Tool definitions', zh: '工具定义'},
  'usage.messages': {en: 'Conversation messages', zh: '对话消息'},
  'usage.tool_results': {en: 'Tool results', zh: '工具结果'},
  'usage.request_input': {en: 'Request input', zh: '请求输入'},
  'usage.remaining': {en: 'Remaining', zh: '剩余空间'},
  'usage.session_cost': {en: 'This session cost (USD)', zh: '本会话费用 (USD)'},
  'usage.segment': {en: '{label}: about {value} tokens', zh: '{label}：约 {value} tokens'},
  'usage.quota_unavailable': {
    en: 'Usage · Quota API not provided by the current service',
    zh: 'Usage · 当前服务未提供额度接口',
  },
  'quota.note': {
    en: 'Billed {priced}/{reported} requests. Estimated from the official DeepSeek 2026-09-19 prices, caching, and peak/off-peak windows; the vendor bill prevails.',
    zh: '已计价 {priced}/{reported} 次请求。按 DeepSeek 官方 2026-09-19 价格、缓存与峰谷时段估算；以厂家账单为准。',
  },
  'quota.updated': {
    en: 'Quota updated at {time} · {source}',
    zh: '额度更新于 {time} · {source}',
  },
  'figma.connect': {en: 'Connect', zh: '连接'},
  'figma.current_document': {en: 'Current document', zh: '当前文档'},
  'figma.disconnect': {en: 'Disconnect', zh: '断开'},
  'figma.need_task': {
    en: 'Open and run a task first, then connect the current Figma document.',
    zh: '先打开并运行一个任务，再连接当前 Figma 文档。',
  },
  'figma.no_task': {
    en: 'This conversation has no runtime task yet; send one first.',
    zh: '这条对话尚未产生运行时任务；先发送一次任务。',
  },
  'figma.status_failed': {
    en: 'Cannot read the Figma connection status right now.',
    zh: '暂时无法读取 Figma 连接状态。',
  },
  'figma.not_connected': {
    en: 'Not connected to the current Figma document.',
    zh: '尚未连接当前 Figma 文档。',
  },
  'figma.disconnect_failed': {
    en: 'Failed to disconnect Figma.',
    zh: 'Figma 断开失败。',
  },
  'figma.pair_failed': {
    en: 'Could not start Figma pairing.',
    zh: '无法启动 Figma 配对。',
  },
  'figma.pair_hint': {
    en: 'Enter this one-time pairing code in the Magic Pointer Figma plugin.',
    zh: '在 Magic Pointer Figma 插件中输入这组一次性配对码。',
  },
  'figma.no_plugin_id': {
    en: 'The plugin code is built, but this machine has no real Figma plugin ID; create one with Create New Plugin first, then generate an importable manifest.',
    zh: '插件代码已构建，但本机没有 Figma 分配的真实插件 ID；请先用 Create New Plugin 建立 ID，再生成可导入 manifest。',
  },
  'figma.preview_unavailable': {
    en: 'Figma node preview is unavailable.',
    zh: 'Figma 节点预览不可用。',
  },
  'figma.pick_writable': {
    en: 'Select a writable node in the current Figma document first.',
    zh: '请先在当前 Figma 文档中选择一个可写节点。',
  },
  'figma.exporting': {
    en: 'Exporting the node preview from the current document…',
    zh: '正在从当前文档导出节点预览…',
  },
  'figma.preview_pending': {
    en: 'The node preview has not loaded yet.',
    zh: '节点预览尚未加载。',
  },
  'figma.refresh_preview': {en: 'Refresh preview', zh: '刷新预览'},
  'figma.use_selection': {
    en: 'Use the current selection',
    zh: '改用当前选中节点',
  },
  'figma.preview_alt': {
    en: 'Export preview of Figma node {id} in the current document',
    zh: '当前 Figma 节点 {id} 的导出预览',
  },
  'inspector.no_file_changes': {
    en: 'A plain-text draft has no external file changes.',
    zh: '普通文本草稿没有外部文件修改。',
  },
  'artifact.kind.file': {en: 'File', zh: '文件'},
  'artifact.kind.text': {en: 'Text', zh: '文本'},
  'artifact.kind.patch': {en: 'Document patch', zh: '文档补丁'},
  'artifact.kind.code': {en: 'Code', zh: '代码'},
  'artifact.kind.image': {en: 'Image', zh: '图片'},
  'artifact.untitled': {en: 'Untitled artifact', zh: '未命名产物'},
  'artifact.actions': {en: 'Artifact actions', zh: '产物操作'},
  'artifact.open': {en: 'Open artifact', zh: '打开产物'},
  'artifact.view_source': {en: 'View source conversation', zh: '查看来源对话'},
  'artifact.view_list': {en: 'Switch to list layout', zh: '切换为列表布局'},
  'artifact.view_grid': {en: 'Switch to grid layout', zh: '切换为网格布局'},
  'artifact.empty': {
    en: 'No artifacts yet. Documents, code, and drafts the agent generates and saves appear here.',
    zh: '还没有产物。Agent 生成并落盘的文档、代码与草稿会出现在这里。',
  },
  'artifact.no_match': {en: 'No matching artifacts.', zh: '没有匹配的产物。'},
  'artifact.version_number': {en: 'Version {revision}', zh: '版本 {revision}'},
  'artifact.current_version': {en: 'current', zh: '当前'},
  'artifact.version_history': {en: 'Version history', zh: '版本历史'},
  'artifact.restore_version': {en: 'Restore this version', zh: '恢复此版本'},
  'artifact.historical_preview': {
    en: 'Historical preview · read only',
    zh: '历史版本预览 · 只读',
  },
  'artifact.newer_version': {
    en: 'A newer version was saved. Reopen the artifact before restoring.',
    zh: '已有新版本保存，请重新打开产物后再恢复。',
  },
  'artifact.reading_version': {
    en: 'Reading the current version…',
    zh: '正在读取当前版本…',
  },
  'artifact.saving_version': {
    en: 'Saving the new version…',
    zh: '正在保存新版本…',
  },
  'artifact.binding_version': {
    en: 'Binding the approved version…',
    zh: '正在绑定批准版本…',
  },
  'artifact.writing_verify': {
    en: 'Writing and verifying by reading back…',
    zh: '正在写入并读回验证…',
  },
  'artifact.reverted_verified': {
    en: 'Reverted and verified by reading back.',
    zh: '已撤销并通过读回验证。',
  },
  'artifact.written_verified': {
    en: 'Written and verified by reading back.',
    zh: '已写入并通过读回验证。',
  },
  'artifact.version_accepted': {
    en: 'The current version is accepted and can be applied.',
    zh: '当前版本已接受，可以应用。',
  },
  'artifact.unsaved_edits': {
    en: 'There are unsaved edits.',
    zh: '有尚未保存的编辑。',
  },
  'artifact.invalid_json': {
    en: 'Enter a valid JSON value; invalid content is not saved.',
    zh: '请输入有效的 JSON 值；无效内容不会保存。',
  },
  'artifact.confirm_revert': {
    en: 'Revert this apply? Only parts still matching the applied result are restored; created files are kept.',
    zh: '撤销本次应用？只有当前内容仍与应用结果匹配的部分会恢复，创建的文件会保留。',
  },
  'artifact.before': {en: 'Before:', zh: '之前：'},
  'artifact.after': {en: 'After (written value)', zh: '之后（实际写入值）'},
  'artifact.edit_index': {
    en: 'Edit written value #{index}',
    zh: '编辑第 {index} 项实际写入值',
  },
  'theme.to_light': {en: 'Switch to light theme', zh: '切换到浅色主题'},
  'theme.to_dark': {en: 'Switch to dark theme', zh: '切换到深色主题'},
  'shortcuts.title': {en: 'Keyboard shortcuts', zh: '键盘快捷键'},
  'shortcuts.body': {
    en: 'Ctrl+N  New chat\nCtrl+O  Open project\nCtrl+B  Toggle sidebar\nCtrl+Shift+B  Toggle projects panel\nCtrl+J  Toggle bottom panel\nCtrl+,  Settings\nCtrl+/  Shortcuts',
    zh: 'Ctrl+N  新建对话\nCtrl+O  打开项目\nCtrl+B  切换侧栏\nCtrl+Shift+B  切换项目面板\nCtrl+J  切换底部面板\nCtrl+,  设置\nCtrl+/  快捷键',
  },
  'help.about': {en: 'About', zh: '关于'},
  'project.open_first': {en: 'Open a project first.', zh: '请先打开项目。'},
  'project.open_first_bare': {en: 'Open a project first', zh: '请先打开项目'},
  'project.no_env': {en: 'No project environment', zh: '没有项目环境'},
  'project.current': {en: 'Current project', zh: '当前项目'},
  'project.local': {en: 'Local project', zh: '本地项目'},
  'project.no_changes': {en: 'This project has no changes.', zh: '项目没有更改。'},
  'files.no_match': {en: 'No matching files.', zh: '没有匹配文件。'},
  'files.empty_project': {
    en: 'No displayable files in this project.',
    zh: '项目中没有可显示的文件。',
  },
  'files.read_failed': {en: 'Failed to read the file.', zh: '文件读取失败。'},
  'files.tree_failed': {en: 'Failed to read the file tree.', zh: '文件树读取失败。'},
  'files.truncated': {en: ' · truncated', zh: ' · 已截断'},
  'git.clean': {en: 'Worktree clean', zh: '工作树干净'},
  'git.clean_sentence': {en: 'Worktree clean.', zh: '工作树干净。'},
  'git.branch': {en: 'Git branch', zh: 'Git 分支'},
  'git.repo': {en: 'Git repository', zh: 'Git 仓库'},
  'git.not_init': {en: 'Git is not initialized', zh: '未初始化 Git'},
  'git.reading': {en: 'Reading the Git worktree…', zh: '正在读取 Git 工作树…'},
  'git.env_failed': {
    en: 'Failed to read the Git environment.',
    zh: 'Git 环境读取失败。',
  },
  'git.local_only': {en: 'Local project only', zh: '仅本地项目'},
  'git.remote_connected': {
    en: 'Connected to a remote repository',
    zh: '已连接远程仓库',
  },
  'git.staged': {en: 'Staged', zh: '已暂存'},
  'git.ahead': {en: 'Ahead {n}', zh: '领先 {n}'},
  'git.behind': {en: 'Behind {n}', zh: '落后 {n}'},
  'git.changes': {
    en: '{files} files · +{added} −{deleted}',
    zh: '{files} 个文件 · +{added} −{deleted}',
  },
  'git.read_failed': {en: 'Read failed', zh: '读取失败'},
  'materials.empty_task': {
    en: 'This task has no materials yet; connect Figma or add local files.',
    zh: '当前任务还没有材料；可连接 Figma 或添加本机文件。',
  },
  'materials.empty_started': {
    en: 'Connect Figma or add local materials after starting a task.',
    zh: '启动任务后可连接 Figma 或添加本机材料。',
  },
  'materials.empty_sources': {
    en: 'This task has no materials or web sources yet.',
    zh: '当前任务尚无材料或网页来源。',
  },
  'materials.empty_plus': {
    en: 'This task has no materials yet. Add files with +, or point at content on screen.',
    zh: '当前任务还没有材料。用 + 加入文件，或在屏幕上指向内容。',
  },
  'materials.capabilities': {en: 'Capabilities: {caps}', zh: '可用能力：{caps}'},
  'materials.refs': {en: 'References: {text}', zh: '引用：{text}'},
  'materials.no_refs': {
    en: 'No local references right now.',
    zh: '当前没有局部引用。',
  },
  'browser.stop_loading': {en: 'Stop loading', zh: '停止加载'},
  'browser.reload': {en: 'Reload', zh: '重新加载'},
  'browser.open_failed': {en: 'Failed to open the page.', zh: '网页打开失败。'},
  'tasks.collapse': {en: 'Restore the task panel', zh: '还原任务面板'},
  'tasks.expand': {en: 'Expand the task panel', zh: '展开任务面板'},
  'activity.log': {en: 'Conversation log', zh: '对话记录'},
  'terminal.start_failed': {
    en: 'Failed to start the terminal.',
    zh: '终端启动失败。',
  },
  'terminal.write_failed': {
    en: 'Failed to write to the terminal.',
    zh: '终端输入失败。',
  },
  'directory.installed_skills': {en: 'Installed skills', zh: '已安装技能'},
  'directory.available_commands': {en: 'Available commands', zh: '可用命令'},
  'directory.commands': {en: 'Commands', zh: '命令'},
  'directory.skills': {en: 'Skills', zh: '技能'},
  'directory.composer_hint': {
    en: 'Can be called in the Composer.',
    zh: '可在 Composer 中调用。',
  },
  'directory.no_match': {
    en: 'No matching commands or skills.',
    zh: '没有匹配的命令或技能。',
  },
  'directory.no_projects': {en: 'No matching projects.', zh: '没有匹配项目。'},
  'directory.loading': {en: 'Loading the directory…', zh: '正在读取目录…'},
  'directory.unavailable': {
    en: 'Directory unavailable (no local bridge).',
    zh: '目录不可用（本机未接入桥）。',
  },
  'stash.open_source': {en: 'Open source', zh: '打开来源'},
  'stash.kind.inspiration': {en: 'Idea', zh: '灵感'},
  'stash.kind.handoff': {en: 'Handoff', zh: '交接'},
  'stash.kind.credential': {en: 'Credential', zh: '凭证'},
  'stash.kind.material': {en: 'Material', zh: '素材'},
  'stash.kind.snippet': {en: 'Snippet', zh: '片段'},
  'stash.category': {en: 'Category', zh: '分类'},
  'stash.save_file_failed': {
    en: 'The file was not added to the stash.',
    zh: '文件没有加入收藏。',
  },
  'stash.note_prompt': {en: 'Write a note to stash', zh: '写下要收藏的笔记'},
  'stash.note_default': {en: 'Notes', zh: '笔记'},
  'stash.note_failed': {
    en: 'The note was not added to the stash.',
    zh: '笔记没有加入收藏。',
  },
  'stash.edit_category': {en: 'Edit category', zh: '修改分类'},
  'stash.category_failed': {en: 'The category was not updated.', zh: '分类没有更新。'},
  'stash.confirm_delete': {
    en: 'Delete this stash entry? The original file is kept.',
    zh: '删除这条收藏？原始文件不会被删除。',
  },
  'stash.delete_failed': {
    en: 'The stash entry was not deleted.',
    zh: '收藏没有删除。',
  },
  'stash.source_time': {en: '(Source: {time})', zh: '（来源时间：{time}）'},
  'stash.unreachable': {
    en: 'The original app or file is currently unreachable{when}.',
    zh: '原应用或文件当前不可达{when}。',
  },
  'stash.copy_image': {en: 'Copy image', zh: '复制图片'},
  'stash.image_default': {en: 'Stashed image', zh: '收藏图片'},
  'stash.viewing': {en: 'Looking at this image…', zh: '正在看这张图…'},
  'watch.default_task': {
    en: 'Verify material changes and draft an update.',
    zh: '核对材料变化，生成更新草稿。',
  },
  'watch.task_label': {en: 'Material watch task', zh: '材料关注任务'},
  'watch.cadence_label': {en: 'Watch cadence', zh: '关注时机'},
  'watch.on_change': {en: 'On material change', zh: '材料变化时'},
  'watch.daily': {en: 'Daily at this time', zh: '每天此时'},
  'watch.remove_source': {
    en: 'Do not use {title} in the next step',
    zh: '不在下一步使用 {title}',
  },
  'watch.follow': {en: 'Watch this material', zh: '关注此材料'},
  'watch.unfollow': {en: 'Stop watching', zh: '停止关注'},
  'watch.update': {en: 'Update watch', zh: '更新关注'},
  'watch.hint': {
    en: 'The selected materials are verified while the app runs; results appear in ordinary tasks.',
    zh: '应用运行时核对所选材料，结果出现在普通任务中。',
  },
  'watch.save_failed': {
    en: 'The watch settings were not saved.',
    zh: '关注设置未保存。',
  },
  'watch.active': {
    en: 'Watching this material; results appear in ordinary tasks.',
    zh: '正在关注此材料；结果出现在普通任务中。',
  },
  'watch.stopped': {en: 'Stopped watching.', zh: '已停止关注。'},
  'watch.draft_ready': {
    en: ' A draft was generated last time.',
    zh: ' 上次已生成草稿。',
  },
  'watch.last_incomplete': {
    en: ' Last run did not finish: {error}',
    zh: ' 上次未完成：{error}',
  },
  'watch.see_result': {en: 'see the task result', zh: '请查看任务结果'},
  'watch.save_error': {
    en: 'The watch settings were not saved: {error}',
    zh: '关注设置未保存：{error}',
  },
  'task.updating': {
    en: 'The task status is updating; please try again later.',
    zh: '任务状态正在更新，请稍后重试。',
  },
  'task.record_missing': {
    en: 'Cannot find the execution record for this request. Reopen the task and try again.',
    zh: '无法找到这条请求的执行记录。请重新打开任务后重试。',
  },
  'task.current_missing': {
    en: 'Cannot find the current task. Reopen it and try again.',
    zh: '无法找到当前任务。请重新打开后重试。',
  },
  'task.saved_not_resumed': {
    en: 'The approval reply is saved, but the background task has not resumed. {instruction}',
    zh: '审批答复已保存，后台任务尚未恢复执行。{instruction}',
  },
  'task.interrupted_idle': {
    en: 'The background task was interrupted and has not resumed. {instruction}',
    zh: '后台任务已中断，尚未继续。{instruction}',
  },
  'task.interrupted_note': {
    en: 'The background task was interrupted. The current approval reply is only saved and does not run the old action; the task still needs recovery after replying. {instruction}',
    zh: '后台任务已中断。当前审批答复只会保存，不会执行旧动作；答复后仍需恢复任务。{instruction}',
  },
  'task.continue_instruction': {
    en: 'Send "Resume background task (ID: {id}); do not create a new task" in the input box.',
    zh: '在输入框发送“继续原后台任务（ID：{id}），不要新建任务”。',
  },
  'task.allow_after_verify': {
    en: 'Allow re-execution after verification',
    zh: '核对后允许重新执行',
  },
  'task.confirm_allow': {
    en: 'Confirm you have verified the displayed read-back content and allow re-executing this operation?',
    zh: '确认已核对显示的读回内容，并允许重新执行这项操作？',
  },
  'ask.default_question': {en: 'Your decision is needed', zh: '需要你的决定'},
  'ask.save_failed': {
    en: 'Could not save this answer; please try again.',
    zh: '未能保存这次回答，请重试。',
  },
  'model.default': {en: 'Default model', zh: '默认模型'},
  'model.dir_unavailable': {
    en: 'Model directory unavailable (no local Electron bridge).',
    zh: '模型目录不可用（本机未接入 Electron 桥）。',
  },
  'model.loading': {en: 'Reading models…', zh: '正在读取模型…'},
  'model.no_models': {en: 'No models available.', zh: '没有可用模型。'},
  'run.stopping': {en: 'Stopping…', zh: '正在停止…'},
  'run.queued': {en: 'Queued…', zh: '正在排队…'},
  'run.accepted': {
    en: 'Received; it takes effect at the next safety boundary.',
    zh: '已接收，将在下一个安全边界生效。',
  },
  'run.barge_failed': {
    en: 'The interruption was not delivered: {reason}',
    zh: '插话未送达：{reason}',
  },
  'chat.empty_title': {en: 'This conversation is empty', zh: '这条对话还没有内容'},
  'chat.empty_body': {
    en: 'Keep typing a task, or brush over an object on screen as context.',
    zh: '继续输入任务，或从屏幕上划过一个对象作为上下文。',
  },
  'chat.turn_failed': {en: 'This turn did not finish.', zh: '这次没能完成。'},
  'chat.incomplete': {en: 'This turn did not complete.', zh: '这次没有答完。'},
  'chat.round_failed': {en: 'This round did not finish.', zh: '这一轮没有完成。'},
  'chat.copy': {en: 'Copy', zh: '复制'},
  'chat.resend': {en: 'Resend', zh: '重新发送'},
  'chat.fork_here': {en: 'Fork from here', zh: '从这里创建分支'},
  'chat.copy_failed': {en: 'Copy failure', zh: '复制失败'},
  'chat.time_just_now': {en: 'just now', zh: '刚刚'},
  'chat.time_minutes_ago': {en: '{n} minutes ago', zh: '{n} 分钟前'},
  'chat.time_hours_ago': {en: '{n} hours ago', zh: '{n} 小时前'},
  'chat.time_days_ago': {en: '{n} days ago', zh: '{n} 天前'},
  'chat.attachments_prefix': {en: '\n\nAttachments:\n', zh: '\n\n附件：\n'},
  'phase.runtime_boot': {en: 'Preparing the agent runtime', zh: '准备 Agent 运行环境'},
  'phase.runtime_ready': {en: 'The runtime is ready', zh: '运行环境已就绪'},
  'phase.session_ready': {en: 'The session is ready', zh: '会话已就绪'},
  'phase.agent_start': {en: 'Working on this round', zh: '开始处理本轮任务'},
  'phase.agent_turn': {en: 'Round {turn} reasoning', zh: '第 {turn} 轮推理中'},
  'phase.reasoning': {en: 'Reasoning', zh: '推理中'},
  'phase.model_first_chunk': {en: 'The model started responding', zh: '模型开始响应'},
  'phase.model_response': {en: 'Composing the result', zh: '整理结果'},
  'phase.budget_renewed': {en: 'Continuing to the next round', zh: '继续执行下一轮'},
  'phase.review_started': {
    en: 'Auto is reviewing {name}',
    zh: 'Auto 正在检查 {name}',
  },
  'phase.review_default_target': {en: 'this operation', zh: '操作'},
  'phase.review_finished': {
    en: 'Auto finished the permission review',
    zh: 'Auto 已完成权限检查',
  },
  'phase.total': {en: 'Round complete', zh: '本轮处理完成'},
  'phase.fallback': {en: 'Working', zh: '处理中'},
  'worktree.create_failed': {
    en: 'Could not create the worktree.',
    zh: '无法创建 worktree。',
  },
  'recovery.no_record': {
    en: 'No run record for this task, so execution recovery cannot be verified yet. Saved conversations are still viewable.',
    zh: '找不到此任务的运行记录，暂时无法核对执行恢复状态。已保存的对话仍可查看。',
  },
  'recovery.read_failed': {
    en: 'Cannot read the execution recovery state: {error}',
    zh: '无法读取执行恢复状态：{error}',
  },
  'recovery.pending_title': {
    en: 'Pending verification · {title}',
    zh: '待核对 · {title}',
  },
  'recovery.pick_readback': {
    en: 'Choose a read-back record for verification',
    zh: '选择用于核对的读取记录',
  },
  'recovery.read_first': {
    en: 'Let the agent read the target and verify the live state before allowing re-execution.',
    zh: '请先让 Agent 读取目标并核对现场，再允许重新执行。',
  },
  'recovery.failed': {en: 'Recovery failed', zh: '恢复失败'},
  'risk.ack': {
    en: 'I understand the risks and wish to continue',
    zh: '我已了解风险，并愿意继续',
  },
  'risk.enable_full': {en: 'Enable Full access', zh: '启用 Full access'},
};

const STUDIO_COUNT_STRINGS: Record<string, StudioCountEntry> = {
  'count.items': {one: '{n} item', other: '{n} items', zh: '{n} 项'},
  'count.selected_nodes': {
    one: '{n} selected node',
    other: '{n} selected nodes',
    zh: '{n} 个选中节点',
  },
  'count.git_changed': {
    one: '{files} changed file · +{added} −{deleted}',
    other: '{files} changed files · +{added} −{deleted}',
    zh: '{files} 个变更 · +{added} −{deleted}',
  },
  'count.git_files': {
    one: '{files} file · +{added} −{deleted}',
    other: '{files} files · +{added} −{deleted}',
    zh: '{files} 个文件 · +{added} −{deleted}',
  },
  'count.directory_entries': {
    one: '{n} entry',
    other: '{n} entries',
    zh: '{n} 项',
  },
  'chat.more_lines': {
    one: '… {n} more line',
    other: '… {n} more lines',
    zh: '… 还有 {n} 行',
  },
};

let studioLanguage: StudioLanguage = 'en';

function getStudioLanguage(): StudioLanguage {
  return studioLanguage;
}

function fillTemplate(
  template: string,
  params: Record<string, string | number> | undefined,
): string {
  if (!params) {
    return template;
  }
  let out = template;
  for (const key of Object.keys(params)) {
    out = out.split(`{${key}}`).join(String(params[key]));
  }
  return out;
}

function studioT(
  id: string,
  params?: Record<string, string | number>,
): string {
  const entry = STUDIO_STRINGS[id];
  if (!entry) {
    return id;
  }
  return fillTemplate(
    studioLanguage === 'zh-CN' ? entry.zh : entry.en,
    params,
  );
}

function studioTCount(
  id: string,
  count: number,
  params?: Record<string, string | number>,
): string {
  const entry = STUDIO_COUNT_STRINGS[id];
  const n = Number(count);
  if (!entry || !Number.isFinite(n)) {
    return String(count);
  }
  const template =
    studioLanguage === 'zh-CN' ? entry.zh : n === 1 ? entry.one : entry.other;
  return fillTemplate(template, {...params, n});
}

function applyStudioLanguage(language: StudioLanguage): void {
  studioLanguage = language;
  document.documentElement.lang = language;
  document.documentElement.dataset.language = language;
  try {
    localStorage.setItem('mp:language:v1', language);
  } catch {
    /* storage unavailable */
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STUDIO_STRINGS,
    STUDIO_COUNT_STRINGS,
    getStudioLanguage,
    studioT,
    studioTCount,
    applyStudioLanguage,
  };
}
