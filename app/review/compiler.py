from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

JsonDict = dict[str, Any]


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
    return f"{text[:limit].rstrip()}\n[…已省略 {omitted} 个字符；需要时回到原始文件读取完整内容…]"


def _ordered_anchors(session: JsonDict) -> list[JsonDict]:
    anchors = [dict(item) for item in session.get("anchors") or [] if isinstance(item, dict)]
    return sorted(
        anchors,
        key=lambda item: (
            str(item.get("document_path") or item.get("document_label") or ""),
            0 if isinstance(item.get("page_number"), int) else 1,
            int(item.get("page_number") or 0),
            int(item.get("sequence") or 0),
        ),
    )


def _location(anchor: JsonDict) -> str:
    page = anchor.get("page_number")
    if isinstance(page, int) and page > 0:
        return f"第 {page} 页"
    window = anchor.get("source_window") if isinstance(anchor.get("source_window"), dict) else {}
    title = _clean(window.get("title"), limit=500)
    return title or _clean(anchor.get("document_label"), limit=500) or "当前应用中的已标记位置"


def compile_review_prompt(session: JsonDict, *, global_context: str = "") -> str:
    session_id = _clean(session.get("session_id"), limit=200)
    anchors = _ordered_anchors(session)
    if not session_id:
        raise ValueError("review session id is required")
    if not anchors:
        raise ValueError("review session has no anchors")

    artifact = session.get("artifact") if isinstance(session.get("artifact"), dict) else {}
    document_path = _clean(artifact.get("document_path"), limit=4000)
    document_label = _clean(artifact.get("document_label"), limit=1000)
    app = _clean(artifact.get("app"), limit=100) or "application"
    context = _clean(global_context, limit=6000)

    lines = [
        "# 交付物改进任务",
        "",
        "你正在继续修改一个已经交付、现由用户验收的成果。请把下面每一条锚定意见落实到真实文件中，而不是只解释应该怎么改。",
        "",
        "## 交付物与任务边界",
        "",
        f"- 验收会话：{session_id}",
        f"- 主要交付物：{document_label or document_path or '见下方逐条证据'}",
        f"- 本地路径：{document_path or '未提供；请根据当前任务上下文定位'}",
        f"- 来源应用：{app}",
        f"- 锚定意见数量：{len(anchors)}",
        "- 只修改这些意见直接涉及的内容，以及为保证一致性所必需的最小关联内容。不要修改未被指出的内容，不要擅自重写整体设计。",
        "- 用户原话具有最高优先级。下方标注为“执行性补充”的内容只是为了让任务可落地，不得覆盖或扩大用户原意。",
    ]
    if context:
        lines.extend(["", "## 全局验收背景", "", context])

    lines.extend(["", "## 按位置整理的验收意见", ""])
    for index, anchor in enumerate(anchors, 1):
        location = _location(anchor)
        selected = _clean(anchor.get("selected_text"), limit=1800)
        surrounding = _clean(anchor.get("surrounding_context"), limit=2400)
        instruction = _clean(anchor.get("instruction"), limit=8000)
        anchor_path = _clean(anchor.get("document_path"), limit=4000)
        anchor_label = _clean(anchor.get("document_label"), limit=1000)
        lines.extend([
            f"### {index}. {location} · {anchor_label or anchor.get('app') or '交付物'}",
            "",
            f"- 锚点 ID：{_clean(anchor.get('anchor_id'), limit=200)}",
            f"- 位置：{location}",
        ])
        if anchor_path and anchor_path != document_path:
            lines.append(f"- 文件：{anchor_path}")
        lines.append(f"- 用户原话：{instruction}")
        if selected:
            lines.extend(["- 选中或指向的原文/对象：", "", "```text", selected, "```"])
        if surrounding and surrounding != selected:
            lines.extend(["- 同一文档附近上下文：", "", "```text", surrounding, "```"])
        lines.extend([
            "- 执行性补充：先核对锚点与当前文件版本仍然对应，再完成修改；如果原话存在两种合理解释，优先采用改动范围更小且与现有交付目标一致的一种，并在完成报告中说明。",
            "",
        ])

    lines.extend([
        "## 执行与验收要求",
        "",
        "1. 修改前先读取当前项目、原始需求和交付物，建立对整体目标的理解；不要把这些短批注当成彼此无关的孤立命令。",
        "2. 逐条定位锚点。若文件已变化导致页码或原文漂移，应利用文件路径、原文和附近上下文重新定位，不能静默改到相似但错误的位置。",
        "3. 完成所有直接修改，并同步修正因这些修改必然受到影响的编号、交叉引用、单位、图表说明或测试；其他内容保持不动。",
        "4. 运行与交付物类型相匹配的验证，例如构建、测试、渲染、分页、引用和视觉检查。不得只声称完成而不验证。",
        "5. 完成后逐项报告：锚点位置、用户要求、实际修改、验证证据；另列出任何无法可靠完成的项目及原因。",
        "6. 保留可审计性：不要伪造测试结果、文件状态、引用或截图，也不要把推断描述成用户原话。",
        "",
        "现在开始执行修改。",
    ])
    return "\n".join(lines).rstrip()


def write_prompt_artifact(session: JsonDict, prompt: str, *, root: Path | str | None = None) -> Path:
    session_id = _clean(session.get("session_id"), limit=200)
    if not session_id:
        raise ValueError("review session id is required")
    safe_id = re.sub(r"[^A-Za-z0-9._-]+", "-", session_id).strip("-.") or "review"
    output_root = Path(root) if root is not None else _default_root()
    artifact = output_root / "review" / "artifacts" / f"{safe_id}-improvement-prompt.md"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    temporary = artifact.with_suffix(artifact.suffix + ".tmp")
    temporary.write_text(str(prompt).rstrip() + "\n", encoding="utf-8", newline="\n")
    temporary.replace(artifact)
    return artifact
