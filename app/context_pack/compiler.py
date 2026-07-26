from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

JsonDict = dict[str, Any]
MAX_PROMPT_CHARS = 60_000
DETAIL_BUDGET_CHARS = 18_000

AGENT_PROFILES: dict[str, JsonDict] = {
    "generic": {
        "id": "generic",
        "label": "Generic Agent",
        "delivery_instruction": "Use the grounded context below and obey the requested output boundary.",
    },
    "codex": {
        "id": "codex",
        "label": "Codex",
        "delivery_instruction": "Inspect the referenced workspace artifacts, make the requested change, and verify it before reporting completion.",
    },
    "claude": {
        "id": "claude",
        "label": "Claude",
        "delivery_instruction": "Use the attached evidence as source context, keep claims bounded, and execute the requested task in the current workspace.",
    },
    "gemini": {
        "id": "gemini",
        "label": "Gemini",
        "delivery_instruction": "Ground the response in the listed desktop evidence and make missing information explicit.",
    },
    "pi": {
        "id": "pi",
        "label": "Pi",
        "delivery_instruction": "Continue in the current Pi session using the listed artifacts and do not assume permissions beyond the explicit task.",
    },
}


def _default_root() -> Path:
    configured = os.environ.get("MAGIC_POINTER_USER_DATA_DIR")
    if configured:
        return Path(configured)
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "Magic Pointer"
    return Path.home() / ".magic-pointer"


def _clean(value: Any, *, limit: int) -> str:
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(text) <= limit:
        return text
    omitted = len(text) - limit
    return f"{text[:limit].rstrip()}\n[…已省略 {omitted} 个字符；原始证据仍保留在 Context Pack 中…]"


def detect_agent_profile(window: Any) -> JsonDict:
    source = window if isinstance(window, dict) else {}
    title = str(source.get("title") or "")
    process = str(source.get("process_name") or "")
    haystack = f"{process} {title}".casefold()
    if "codex" in haystack:
        profile = "codex"
    elif "claude" in haystack:
        profile = "claude"
    elif "gemini" in haystack:
        profile = "gemini"
    elif re.search(r"(?:^|[^a-z0-9])pi(?:\.exe)?(?:$|[^a-z0-9])", haystack):
        profile = "pi"
    else:
        profile = "generic"
    return dict(AGENT_PROFILES[profile])


def _resolve_profile(value: str | JsonDict | None) -> JsonDict:
    if value is None:
        return dict(AGENT_PROFILES["generic"])
    if isinstance(value, dict):
        profile_id = str(value.get("id") or "")
    else:
        profile_id = str(value)
    if profile_id not in AGENT_PROFILES:
        raise ValueError(f"unknown target profile: {profile_id or '<empty>'}")
    return dict(AGENT_PROFILES[profile_id])


def _json_line(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(", ", ": "))


def _ordered_items(session: JsonDict) -> list[JsonDict]:
    items = [dict(item) for item in session.get("items") or [] if isinstance(item, dict)]
    return sorted(items, key=lambda item: int(item.get("sequence") or 0))[:64]


def compile_context_prompt(
    session: JsonDict,
    *,
    task_instruction: str = "",
    target_profile: str | JsonDict | None = None,
) -> str:
    session_id = _clean(session.get("session_id"), limit=200)
    if not session_id:
        raise ValueError("context session id is required")
    items = _ordered_items(session)
    if not items:
        raise ValueError("context session has no items")
    profile = _resolve_profile(target_profile or session.get("target_profile") or "generic")
    task = _clean(task_instruction or session.get("task_instruction"), limit=6000)
    runtime_issue = session.get("workflow_kind") == "runtime_issue"

    lines = [
        "# Runtime UI issue" if runtime_issue else "# Grounded desktop task",
        "",
        f"目标 Agent：{profile['label']}",
        f"Context Session：{session_id}",
        f"最终任务：{task or '未提供'}",
        "",
        "## 执行边界",
        "",
        f"- {profile['delivery_instruction']}",
        "- 用户原话是意图来源；选中文本、文件路径、URL、窗口和坐标是定位证据。",
        "- 视觉观察来自模型转译，可能有误。不要把视觉观察或模型推断改写成用户事实。",
        "- 不可用字段保持未知；不要补造文件、页码、DOM、运行结果或用户意图。",
        "- 修改或执行前重新读取当前目标，避免锚点因文件或窗口变化而漂移。",
    ]
    if runtime_issue:
        lines.extend(
            [
                "- 这是用户在运行界面中指出的真实现场，不是用户提供的源码定位。",
                "- 自行检查当前工作区并定位负责源码；不要要求用户寻找文件、组件或函数。",
                "- role=issue 是待修现场；role=reference 只是期望参考，不得把参考界面描述成当前产品事实。",
                "- 优先利用可见文字、URL、窗口、截图路径、指针标注和结构化上下文建立从现场到源码的线索。",
            ]
        )
    if not task:
        lines.append("- 当前没有最终任务：先向用户确认最终任务，不要仅凭上下文条目擅自执行写操作。")

    lines.extend(["", "## Context Pack 索引（全部条目）", ""])
    for index, item in enumerate(items, 1):
        source = item.get("source") if isinstance(item.get("source"), dict) else {}
        window = source.get("window") if isinstance(source.get("window"), dict) else {}
        source_hint = (
            source.get("document_path")
            or source.get("url")
            or window.get("title")
            or source.get("document_label")
            or "未知来源"
        )
        lines.append(
            f"- {index}. {_clean(item.get('item_id'), limit=80) or 'unknown-item'}"
            f" · {_clean(item.get('modality'), limit=40) or 'desktop_evidence'}"
            f" · role={_clean(item.get('role'), limit=20) or 'context'}"
            f" · 用户说明：{_clean(item.get('instruction'), limit=100) or '未提供'}"
            f" · 来源：{_clean(source_hint, limit=160)}"
        )

    lines.extend(["", "## Context Pack 详细证据", ""])
    detail_chars = 0
    omitted_details = 0
    for index, item in enumerate(items, 1):
        source = item.get("source") if isinstance(item.get("source"), dict) else {}
        window = source.get("window") if isinstance(source.get("window"), dict) else {}
        geometry = item.get("geometry") if isinstance(item.get("geometry"), dict) else {}
        images = item.get("images") if isinstance(item.get("images"), dict) else {}
        grounding = item.get("grounding") if isinstance(item.get("grounding"), dict) else {}
        file_context = item.get("file_context") if isinstance(item.get("file_context"), dict) else {}
        app_context = item.get("app_context") if isinstance(item.get("app_context"), dict) else {}
        instruction = _clean(item.get("instruction"), limit=8000)
        selected = _clean(item.get("selected_text"), limit=3000)
        surrounding = _clean(item.get("surrounding_context"), limit=3000)
        observation = _clean(item.get("vision_observation"), limit=3000)
        vision_error = _clean(item.get("vision_error"), limit=2000)
        file_text = _clean(file_context.get("text"), limit=3000)
        role = _clean(item.get("role"), limit=20)
        role_label = (
            "待修现场（issue）"
            if role == "issue"
            else ("期望参考（reference）" if role == "reference" else (item.get("modality") or "desktop_evidence"))
        )
        block = [
                f"### {index}. {role_label} · {_clean(source.get('document_label') or window.get('title') or grounding.get('label'), limit=1000) or '未命名对象'}",
                "",
                f"- Item ID：{_clean(item.get('item_id'), limit=200)}",
                f"- 用户说明：{instruction or '未提供'}",
                f"- 应用：{_clean(source.get('app'), limit=100) or '未知'}",
                f"- 窗口：{_clean(window.get('title'), limit=1000) or '未知'}",
                f"- 文件：{_clean(source.get('document_path'), limit=4000) or '未知'}",
                f"- 页码：{source.get('page_number') if source.get('page_number') else '未知'}",
                f"- URL：{_clean(source.get('url'), limit=4000) or '未知'}",
                f"- 捕获方法：{_clean(source.get('method'), limit=300) or '未知'}",
                f"- 来源置信：{_clean(source.get('confidence'), limit=100) or '未知'}",
                f"- 几何定位：{_json_line(geometry) if geometry else '未知'}",
            ]
        if selected:
            block.extend(["- 原生选中内容：", "", "```text", selected, "```"])
        if surrounding and surrounding != selected:
            block.extend(["- 附近上下文：", "", "```text", surrounding, "```"])
        if observation:
            block.extend(["- 视觉模型观察（非用户事实）：", "", observation])
        elif vision_error:
            block.append(f"- 视觉转译失败：{vision_error}；仅使用截图、坐标和其他结构化来源，不得猜测图像内容。")
        if grounding:
            block.append(f"- Grounding：{_clean(_json_line(grounding), limit=2000)}")
        raw_image = _clean(images.get("raw"), limit=4000)
        pointer_image = _clean(images.get("pointer"), limit=4000)
        if raw_image:
            block.append(f"- 原始截图：{raw_image}")
        if pointer_image:
            block.append(f"- 指向标注图：{pointer_image}")
        if file_context:
            block.append(
                "- 文件上下文元数据："
                + _clean(_json_line({key: value for key, value in file_context.items() if key != "text"}), limit=2000)
            )
        if file_text:
            block.extend(["- 本地文件摘录：", "", "```text", file_text, "```"])
        if app_context:
            block.append(f"- 应用上下文：{_clean(_json_line(app_context), limit=2000)}")
        block.append("")
        block_chars = len("\n".join(block))
        if detail_chars + block_chars <= DETAIL_BUDGET_CHARS:
            lines.extend(block)
            detail_chars += block_chars
        else:
            omitted_details += 1

    if omitted_details:
        lines.extend(
            [
                f"详细证据预算已用尽；其余 {omitted_details} 条仅保留在上方索引。",
                "完整字段请读取原始 Context Pack 会话或 artifact；不要据此补造被截断的证据。",
                "",
            ]
        )

    if runtime_issue:
        lines.extend(
            [
                "## 输出要求",
                "",
                "1. 先根据 issue 现场、可见文字和应用线索理解问题，再自行搜索当前工作区定位负责源码。",
                "2. 不要要求用户寻找文件；若无法从当前工作区建立可靠对应关系，明确报告缺失的运行或仓库条件。",
                "3. 实现最小且完整的修复，保持 issue 与 reference 的空间和语义关系，不要机械复制无关视觉细节。",
                "4. 修改后运行与目标相匹配的测试、构建或视觉检查，并区分已验证结果与尚未验证内容。",
                "5. 报告定位到的源码、修改内容和验证证据；不要声称执行了实际没有发生的操作。",
            ]
        )
    else:
        lines.extend(
            [
                "## 输出要求",
                "",
                "1. 先复述你识别到的最终任务和直接相关条目；若最终任务缺失或有关键歧义，先提一个最小澄清问题。",
                "2. 执行时保持文件、页面、URL、窗口与空间位置的对应关系；无法定位时明确停止，不要改相似对象。",
                "3. 如发生写操作，运行与目标相匹配的测试、构建或视觉检查，并区分已验证结果与尚未验证内容。",
                "4. 完成后按 Context Item 报告处理结果；不要声称执行了实际没有发生的操作。",
            ]
        )
    prompt = "\n".join(lines).rstrip()
    if len(prompt) > MAX_PROMPT_CHARS:
        raise ValueError("compiled Context Pack exceeds the global prompt budget")
    return prompt


def write_context_prompt_artifact(
    session: JsonDict,
    prompt: str,
    *,
    root: Path | str | None = None,
) -> Path:
    session_id = _clean(session.get("session_id"), limit=200)
    if not session_id:
        raise ValueError("context session id is required")
    safe_id = re.sub(r"[^A-Za-z0-9._-]+", "-", session_id).strip("-.") or "context"
    output_root = Path(root) if root is not None else _default_root()
    artifact = output_root / "context" / "artifacts" / f"{safe_id}-prompt.md"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    temporary = artifact.with_suffix(artifact.suffix + ".tmp")
    temporary.write_text(str(prompt).rstrip() + "\n", encoding="utf-8", newline="\n")
    temporary.replace(artifact)
    return artifact
