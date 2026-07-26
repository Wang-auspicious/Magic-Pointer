from __future__ import annotations

from app.fabric.schema import RecipeDefinition, RiskLevel


def _recipe(
    recipe_id: str,
    title: str,
    description: str,
    inputs: tuple[str, ...],
    output: str,
    providers: tuple[str, ...],
    risk: RiskLevel,
    verification: str,
    zh: tuple[str, ...],
    en: tuple[str, ...] = (),
    *,
    minimum: int = 1,
    maximum: int = 1,
) -> RecipeDefinition:
    return RecipeDefinition(
        id=recipe_id,
        title_zh=title,
        description_zh=description,
        input_kinds=inputs,
        output_kind=output,
        provider_strategies=providers,
        risk=risk,
        verification=verification,
        keywords_zh=zh,
        keywords_en=en,
        min_objects=minimum,
        max_objects=maximum,
    )


RECIPE_CATALOG: tuple[RecipeDefinition, ...] = (
    _recipe("activate.wiggle", "晃动唤醒", "用短水平往返动作冻结指针对象并唤起单一命令气泡。", ("pointer_trace",), "activation_intent", ("native_pointer_host",), RiskLevel.READ, "detector_reason_and_frozen_foreground", ("晃动", "唤醒"), ("wiggle", "wake"), minimum=0),
    _recipe("ground.this", "锁定 THIS", "从 DOM、Office、UIA/AX、文件、OCR 和视觉层锁定当前对象。", ("pointer", "foreground_window"), "grounded_object", ("structured_grounder", "vision_fallback"), RiskLevel.READ, "object_fingerprint_and_geometry", ("这个", "这段", "这张", "this"), ("this", "point at")),
    _recipe("ground.references", "绑定 THAT/THESE/HERE", "把多个时间或空间对象绑定成可复用 Episode。", ("grounded_object",), "interaction_episode", ("episode_store",), RiskLevel.READ, "object_ids_and_expiry", ("刚才那个", "这些", "这里", "那个"), ("that", "these", "here"), minimum=1, maximum=12),
    _recipe("text.ocr_copy", "一步 OCR 复制", "从不可复制的屏幕区域识别文字并直接复制。", ("image", "screen_region"), "clipboard_text", ("native_ocr", "vision_ocr"), RiskLevel.LOCAL_WRITE, "clipboard_hash", ("复制这段文字", "识别文字", "提取文字", "复制这段"), ("copy text", "ocr")),
    _recipe("text.ocr_clean", "OCR 清洗", "识别并按号码、空白或行列规则清洗文字。", ("image", "screen_region", "text"), "clipboard_text", ("native_ocr", "deterministic_text"), RiskLevel.LOCAL_WRITE, "normalized_text_hash", ("去掉空格", "清洗文字", "号码空格", "整理后复制"), ("remove spaces", "clean ocr")),
    _recipe("text.rewrite_in_place", "原位改写", "预览差异后在原应用替换选中文字。", ("text_selection",), "in_place_text", ("office_adapter", "uia_ax_writer", "model_provider"), RiskLevel.LOCAL_WRITE, "target_identity_and_readback_hash", ("改得更正式", "改写", "润色", "更简洁", "重写"), ("rewrite", "make formal")),
    _recipe("text.translate_in_place", "原位翻译", "保留段落结构翻译并写回当前应用。", ("text_selection",), "in_place_text", ("office_adapter", "uia_ax_writer", "model_provider"), RiskLevel.LOCAL_WRITE, "target_identity_and_readback_hash", ("翻成英文", "翻译成", "译成", "放回这里"), ("translate",)),
    _recipe("text.summarize_route", "摘要并路由", "把选区摘要或要点写入用户指定的草稿或笔记。", ("text_selection", "document_region"), "routed_summary", ("model_provider", "destination_adapter"), RiskLevel.LOCAL_WRITE, "source_links_and_destination_readback", ("总结", "三点", "要点", "放到邮件"), ("summarize", "bullet points")),
    _recipe("entity.quick_action", "实体快捷动作", "把日期、邮箱、电话和 URL 转为可执行实体动作。", ("text", "entity"), "entity_action", ("entity_parser", "deep_link"), RiskLevel.EXTERNAL_SEND, "normalized_entity_and_target", ("发邮件", "打电话", "打开链接", "这个日期"), ("email this", "call", "open url")),
    _recipe("table.to_spreadsheet", "表格转 Excel/CSV", "提取屏幕表格并保留单元格来源和置信度。", ("table_region", "image", "document_region"), "spreadsheet_artifact", ("native_table", "ocr_table", "vision_table"), RiskLevel.LOCAL_WRITE, "row_column_counts_and_source_map", ("放进 excel", "转成 excel", "导出 csv", "这张表"), ("to excel", "to csv")),
    _recipe("table.merge", "多表合并", "对齐字段、预览冲突后合并多个表格对象。", ("table",), "spreadsheet_artifact", ("deterministic_table_merge",), RiskLevel.LOCAL_WRITE, "schema_and_row_digest", ("两个表合并", "合并这些表", "接起来"), ("merge tables",), minimum=2, maximum=12),
    _recipe("chart.extract_data", "图表数据提取", "从图表曲线、柱形或点位导出数据和估计误差。", ("chart_image", "chart_object"), "csv_artifact", ("native_chart", "vision_digitizer"), RiskLevel.LOCAL_WRITE, "series_count_and_source_geometry", ("曲线的数据", "图表数据", "导出数据"), ("extract chart data", "digitize chart")),
    _recipe("formula.to_latex", "公式转 LaTeX", "把屏幕公式转为 LaTeX 或 MathML。", ("formula_image", "text"), "latex_text", ("native_math", "vision_math"), RiskLevel.LOCAL_WRITE, "render_roundtrip_or_confidence", ("公式", "latex", "数学式"), ("formula to latex",)),
    _recipe("image.edit_object", "图片对象处理", "去背景、擦除或模糊选中对象并产生新文件。", ("image", "image_object"), "image_artifact", ("native_image_editor", "image_model"), RiskLevel.LOCAL_WRITE, "output_image_hash_and_dimensions", ("去背景", "擦掉", "模糊这个", "移除这个"), ("remove background", "erase object", "blur")),
    _recipe("image.compose", "跨图组合", "把一个图像对象放入另一个目标场景。", ("image", "image_object"), "image_artifact", ("image_model", "canvas_adapter"), RiskLevel.LOCAL_WRITE, "source_ids_and_output_hash", ("放进这个房间", "组合这两张", "放到这张图"), ("put this in", "compose"), minimum=2, maximum=6),
    _recipe("image.style_transfer", "视觉样式迁移", "用一个对象的视觉风格变换另一个对象。", ("image", "image_object"), "image_artifact", ("image_model",), RiskLevel.LOCAL_WRITE, "source_target_ids_and_output_hash", ("用那张图的风格", "风格迁移", "变成这种风格"), ("use this style", "style transfer"), minimum=2, maximum=4),
    _recipe("canvas.transform", "画布对象变换", "移动、变色、缩放或替换画布中的选中对象。", ("canvas_object", "spatial_target"), "canvas_mutation", ("figma_plugin", "office_adapter", "canvas_agent"), RiskLevel.LOCAL_WRITE, "native_object_readback", ("移动到这里", "变成橙色", "换颜色", "挪到这里"), ("move this here", "make this orange"), minimum=1, maximum=4),
    _recipe("calendar.create_from_screen", "屏幕内容转日历", "从海报、邮件或文字生成事件草稿并检查冲突。", ("image", "text", "document_region"), "calendar_event", ("calendar_adapter", "deep_link"), RiskLevel.EXTERNAL_SEND, "event_identity_and_calendar_readback", ("加到日历", "创建日程", "安排会议", "活动日历"), ("add to calendar", "create event")),
    _recipe("map.route", "两地点路线", "用两个地点对象生成地图路线，不伪造距离。", ("location", "text", "image"), "map_route", ("maps_deep_link",), RiskLevel.EXTERNAL_SEND, "allowlisted_url_and_endpoints", ("怎么走", "路线", "从这里到", "导航"), ("directions", "route"), minimum=2, maximum=2),
    _recipe("video.place_action", "视频帧地点行动", "识别视频帧中的地点并生成地图或订位草稿。", ("video_frame", "image"), "place_action", ("vision_place", "maps_deep_link", "booking_deep_link"), RiskLevel.EXTERNAL_SEND, "place_evidence_and_user_confirmation", ("哪家店", "帮我订位", "这个餐厅", "视频里的地方"), ("what restaurant", "book a table")),
    _recipe("recipe.scale_and_route", "食谱缩放并路由", "识别配料、缩放数量并写入用户清单。", ("recipe_text", "image", "document_region"), "structured_list", ("recipe_parser", "list_adapter"), RiskLevel.LOCAL_WRITE, "item_count_units_and_destination_readback", ("配料", "做两倍", "加到清单", "购物清单"), ("double recipe", "ingredients")),
    _recipe("task.route", "任务/工单路由", "把屏幕问题路由到 GitHub、任务系统或本地待办。", ("grounded_object", "text", "image"), "task_record", ("github_adapter", "task_adapter", "local_task_store"), RiskLevel.EXTERNAL_SEND, "task_id_and_source_backlink", ("建成任务", "建工单", "提 issue", "加入待办"), ("create task", "file issue")),
    _recipe("research.evidence_card", "研究证据卡", "保存原文、页码、边框、截图、文件哈希和引用键。", ("document_region", "image", "text"), "evidence_card", ("local_note_adapter", "zotero_adapter"), RiskLevel.LOCAL_WRITE, "artifact_hash_and_source_anchor", ("保存到项目笔记", "证据卡", "保存这段和图", "研究笔记"), ("save evidence", "research note"), minimum=1, maximum=8),
    _recipe("agent.handoff", "Agent 现场交付", "把窗口、终端、仓库、截图和对象锚点直接送入现有 Agent 会话。", ("grounded_object", "runtime_context"), "agent_task", ("codex", "pi", "claude", "gemini", "cursor", "opencode", "aider", "generic"), RiskLevel.EXTERNAL_SEND, "agent_task_receipt_and_session_id", ("让 codex", "让 pi", "让 claude", "让 gemini", "agent 修", "修这个"), ("send to codex", "agent fix")),
    _recipe("vision.prompt_bridge", "无多模态模型视觉桥", "把图片转成带对象位置和布局的可验证视觉提示。", ("image", "screen_region"), "visual_context_artifact", ("native_ocr", "vision_model", "omniparser"), RiskLevel.LOCAL_WRITE, "object_map_and_image_hash", ("解释给本地模型", "图片提示词", "视觉提示", "framecue"), ("visual prompt", "describe for local model")),
    _recipe("objects.compare", "多对象比较", "比较多个文件、图片、表格或选区并保留来源。", ("grounded_object",), "comparison_artifact", ("deterministic_diff", "model_provider"), RiskLevel.LOCAL_WRITE, "source_ids_and_comparison_hash", ("比较这些", "比较这个和", "对比这些", "刚才那个"), ("compare these",), minimum=2, maximum=12),
    _recipe("voice.short_command", "语音短命令", "本地转写并绑定当前对象 Episode。", ("audio", "interaction_episode"), "command_text", ("openai_whisper", "whisper_cpp"), RiskLevel.READ, "transcript_and_episode_id", ("语音", "听写", "我说"), ("voice command", "dictate"), minimum=0, maximum=12),
    _recipe("agent.background_task", "后台 Agent 任务", "用 Pi 或用户 Agent 在后台执行并提供进度、暂停和接管。", ("grounded_object", "runtime_context"), "background_agent_task", ("pi", "codex", "claude", "gemini", "generic"), RiskLevel.EXTERNAL_SEND, "task_status_log_and_terminal_receipt", ("在后台", "交给 pi 处理", "完成后提醒", "后台处理"), ("run in background", "notify when done"), minimum=0, maximum=12),
    _recipe("integration.mcp", "Agent 接入兼容层", "原生 hook、plugin 和会话协议优先；MCP 仅供缺少这些接口的 Agent 查询对象与调用授权 Recipe。", ("agent_request",), "agent_integration", ("native_hook", "agent_plugin", "session_protocol", "mcp_fallback"), RiskLevel.READ, "event_or_request_id_and_policy_decision", ("hook", "插件", "mcp", "接入 agent", "工具接口"), ("agent hook", "plugin", "mcp fallback", "agent integration"), minimum=0, maximum=12),
    _recipe("governance.dashboard", "设置与审计 Dashboard", "管理唤醒、Agent、Recipe、连接器、隐私、活动和诊断。", ("settings_request",), "settings_state", ("electron_dashboard",), RiskLevel.LOCAL_WRITE, "settings_revision_and_audit_event", ("设置", "仪表盘", "为什么触发", "连接器"), ("settings", "dashboard", "diagnostics"), minimum=0, maximum=1),
)

_BY_ID = {recipe.id: recipe for recipe in RECIPE_CATALOG}


def get_recipe(recipe_id: str) -> RecipeDefinition:
    try:
        return _BY_ID[recipe_id]
    except KeyError as exc:
        raise KeyError(f"unknown recipe: {recipe_id}") from exc


def public_recipe_catalog() -> list[dict[str, object]]:
    return [recipe.to_public_dict() for recipe in RECIPE_CATALOG]
